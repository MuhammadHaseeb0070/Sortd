import {
  ProfileId,
  ToolExecutionLedgerItem,
  OpenAIMessage,
  ModelConfig,
  WorkbookRadar,
} from './types';
import { generateWorkbookRadar } from './radar';
import { getProfile, getActiveToolsForProfile } from './registry';

export interface OrchestrationOptions {
  userPrompt: string;
  history: OpenAIMessage[];
  univerAPI: any;
  currentProfileId: ProfileId;
  modelConfig: ModelConfig;
  currentSelectionA1?: string;
  onProfileSwitch?: (newProfile: ProfileId, reason: string) => void;
  onLedgerItem?: (item: ToolExecutionLedgerItem) => void;
  onRadarUpdated?: (radar: WorkbookRadar) => void;
}

export interface OrchestrationResult {
  finalText: string;
  activeProfileId: ProfileId;
  ledgerItems: ToolExecutionLedgerItem[];
  updatedHistory: OpenAIMessage[];
  radar: WorkbookRadar;
}

const BASE_SYSTEM_PROMPT = `
You are the autonomous AI Spreadsheet Engine for Sortd Studio.
You have direct programmatic control over the Univer spreadsheet workbook in the browser.

### SKELETON & COLUMN HEALTH PROTOCOL:
1. **EXAMINE WORKBOOK RADAR & COLUMN HEALTH CARDS FIRST**:
   - Before applying ANY formula, calculation, or transformation, examine the 'columnHealthCards' in the Radar snapshot.
   - Note the 'hazardAlerts' and 'typeCensus' for every referenced column:
     * **Mixed Percentage Hazard**: If a column contains "%" strings (e.g. "10.0%") alongside decimals (e.g. 0.1), direct Excel formulas will fail or be off by 100x. You must normalize or parse them first!
     * **Currency Hazard**: If a column contains currency symbols (e.g. "$45.39"), direct Excel math will return #VALUE! or treat them as 0. Strip currency symbols using 'transform_range' before applying formulas.
     * **High Null Hazard**: Guard against blank cells (e.g. using IFBLANK/IFERROR or fallback 0).

2. **SAFE COLUMN PLACEMENT (NEVER BLINDLY OVERWRITE)**:
   - When asked to "Add a new column" (e.g. 'NetTotal'), check 'occupiedBounds' and 'nextSafeEmptyColumn' in the Radar.
   - NEVER write into an existing column that already contains data! Write into 'nextSafeEmptyColumn' or insert a new column using 'modify_structure'.

3. **ASYNC FORMULA RECALCULATION AWARENESS**:
   - In browser spreadsheets, formula evaluation happens asynchronously.
   - Do NOT immediately read cells back and falsely accuse the sheet of "stale numbers" or "wrong calculations". Trust verified formula syntax and use the self-healing formula verifier.

4. **WORKFLOW EXECUTION**:
   - Formulate and call tools decisively. Perform multi-cell operations in single vectorized batches.
   - When actions finish, summarize the precise outcomes (cells affected, formulas written, columns created) concisely.
`.trim();

/**
 * Autonomous Client-side Agent Loop (up to 6 autonomous turns):
 * Takes the user prompt, builds fresh Workbook Radar telemetry, mounts active profile tools,
 * invokes /api/chat, executes returned tool calls against univerAPI, records ledger cards,
 * and loops until the model finishes or reaches max steps.
 */
export async function runAgentLoop(options: OrchestrationOptions): Promise<OrchestrationResult> {
  const {
    userPrompt,
    history,
    univerAPI,
    modelConfig,
    currentSelectionA1,
    onProfileSwitch,
    onLedgerItem,
    onRadarUpdated,
  } = options;

  let activeProfile = options.currentProfileId;
  const ledgerItems: ToolExecutionLedgerItem[] = [];

  // 1. Initial fresh Radar
  let radar = generateWorkbookRadar(univerAPI, currentSelectionA1);
  onRadarUpdated?.(radar);

  // 2. Build conversation context
  const conversationMessages: OpenAIMessage[] = [
    ...history,
    { role: 'user', content: userPrompt },
  ];

  const MAX_AUTONOMOUS_STEPS = 6;
  let currentStep = 0;
  let finalText = '';

  while (currentStep < MAX_AUTONOMOUS_STEPS) {
    currentStep++;

    // Refresh radar snapshot at every step to give AI latest data
    radar = generateWorkbookRadar(univerAPI, currentSelectionA1);
    onRadarUpdated?.(radar);

    const profileModule = getProfile(activeProfile);
    const availableTools = getActiveToolsForProfile(activeProfile);

    // Build composed system prompt with Radar JSON
    const systemPrompt = `
${BASE_SYSTEM_PROMPT}

[CURRENT WORKBOOK RADAR (LIVE SNAPSHOT)]:
${JSON.stringify(radar, null, 2)}

[ACTIVE PROFILE: ${profileModule.name} (${profileModule.shortBadge})]:
${profileModule.systemPromptFragment}
`.trim();

    // Prepare serializable tool schemas for API
    const toolSchemas = availableTools.map((t) => ({
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    }));

    // Call /api/chat
    const apiRes = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messages: conversationMessages,
        systemPrompt,
        tools: toolSchemas,
        modelConfig,
      }),
    });

    if (!apiRes.ok) {
      const errJson = await apiRes.json().catch(() => ({ error: 'Unknown API error' }));
      throw new Error(errJson.error || `HTTP ${apiRes.status}`);
    }

    const { message: assistantMessage } = await apiRes.json();
    conversationMessages.push(assistantMessage);

    // If no tool calls were requested, this is the final response
    const toolCalls = assistantMessage.tool_calls;
    if (!toolCalls || !Array.isArray(toolCalls) || toolCalls.length === 0) {
      finalText = assistantMessage.content || 'Task completed.';
      break;
    }

    // Execute each tool call against univerAPI
    for (const toolCall of toolCalls) {
      const toolName = toolCall.function?.name;
      let args: any = {};
      try {
        args = JSON.parse(toolCall.function?.arguments || '{}');
      } catch (e: any) {
        args = { parseError: e.message, raw: toolCall.function?.arguments };
      }

      const toolDef = availableTools.find((t) => t.name === toolName);
      const startTime = performance.now();

      let toolResult: any;
      let status: ToolExecutionLedgerItem['status'] = 'SUCCESS';
      let summary = '';
      const targetRange = args?.rangeA1 || args?.startCell || args?.query || undefined;

      try {
        if (!toolDef) {
          throw new Error(`Tool "${toolName}" is not registered or supported.`);
        }

        toolResult = await toolDef.execute(args, {
          univerAPI,
          activeProfileId: activeProfile,
          onProfileSwitch: (newProfile: ProfileId, reason: string) => {
            activeProfile = newProfile;
            onProfileSwitch?.(newProfile, reason);
          },
        });

        if (toolResult?.status === 'WARNING_FORMULA_ERRORS') {
          status = 'WARNING_FORMULA_ERRORS';
          summary = `Formula warning: ${toolResult.errorCount} calculation error(s) in ${targetRange || 'range'}`;
        } else if (toolResult?.message) {
          summary = toolResult.message;
        } else if (toolName === 'mutate_cells') {
          summary = `Mutated cells in ${targetRange || 'specified range'}`;
        } else if (toolName === 'style_range') {
          summary = `Styled range ${targetRange || ''}`;
        } else if (toolName === 'inspect_range') {
          summary = `Read ${toolResult.totalRows || 0} rows from ${targetRange || ''}`;
        } else if (toolName === 'search_workbook') {
          summary = `Found ${toolResult.totalMatchesFound || 0} matches for "${args.query}"`;
        } else {
          summary = `Executed ${toolName}`;
        }
      } catch (err: any) {
        status = 'ERROR';
        toolResult = { error: err.message || String(err) };
        summary = `Error: ${err.message || String(err)}`;
      }

      const durationMs = Math.round(performance.now() - startTime);

      const ledgerItem: ToolExecutionLedgerItem = {
        id: `ledger_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
        toolName,
        status,
        targetRange,
        durationMs,
        summary,
        inputArgs: args,
        resultData: toolResult,
        timestamp: Date.now(),
      };

      ledgerItems.push(ledgerItem);
      onLedgerItem?.(ledgerItem);

      // Append tool response to conversation messages
      conversationMessages.push({
        role: 'tool',
        tool_call_id: toolCall.id,
        name: toolName,
        content: JSON.stringify(toolResult),
      });
    }
  }

  return {
    finalText: finalText || 'Actions completed.',
    activeProfileId: activeProfile,
    ledgerItems,
    updatedHistory: conversationMessages,
    radar,
  };
}
