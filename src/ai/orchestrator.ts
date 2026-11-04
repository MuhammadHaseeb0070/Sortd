import type {
  ProfileId,
  ToolExecutionLedgerItem,
  OpenAIMessage,
  ModelConfig,
  WorkbookRadar,
  StagedMutationSummary,
  CellDiffSample,
} from './types';
import { generateWorkbookRadar, formatCompactRadarForPrompt } from './radar';
import {
  getProfile,
  getActiveToolsForProfile,
  findToolAcrossAllProfiles,
} from './registry';

export interface OrchestrationOptions {
  userPrompt: string;
  history: OpenAIMessage[];
  univerAPI: any;
  currentProfileId: ProfileId;
  modelConfig: ModelConfig;
  currentSelectionA1?: string;
  signal?: AbortSignal;
  requireConfirmation?: boolean;
  onProfileSwitch?: (newProfile: ProfileId, reason: string) => void;
  onLedgerItem?: (item: ToolExecutionLedgerItem) => void;
  onRadarUpdated?: (radar: WorkbookRadar) => void;
  onWorkbookMutated?: () => void;
  onRequestConfirmation?: (summary: StagedMutationSummary) => Promise<'confirm' | 'reject'>;
}

export interface OrchestrationResult {
  finalText: string;
  activeProfileId: ProfileId;
  ledgerItems: ToolExecutionLedgerItem[];
  updatedHistory: OpenAIMessage[];
  radar: WorkbookRadar;
  aborted?: boolean;
  rejectedByUser?: boolean;
}

const READ_ONLY_TOOLS = new Set([
  'inspect_range',
  'search_workbook',
  'profile_columns',
  'switch_profile',
  'export_workbook',
  'generate_chart',
  'scan_formula_errors',
  'trace_dependencies',
  'reconcile_accounting_crossfoot',
  'check_formula_continuity',
  'detect_forensic_anomalies',
  'inspect_hidden_and_external',
]);

/**
 * Checks whether an identical (sheetName + toolName + canonicalArgs) call has already
 * been executed in the current state epoch, preventing infinite retry/read loops.
 */
export function shouldBlockDuplicateToolCall(
  callHistory: Map<string, number>,
  sheetName: string,
  toolName: string,
  args: Record<string, any>
): { blocked: boolean; key: string; count: number } {
  let effectiveSheet = sheetName;
  if (args?.rangeA1 && typeof args.rangeA1 === 'string' && args.rangeA1.includes('!')) {
    effectiveSheet = args.rangeA1.split('!')[0].replace(/^'+|'+$/g, '').trim();
  }
  const sortedArgs = Object.keys(args || {})
    .sort()
    .reduce((acc: Record<string, any>, k) => {
      acc[k] = args[k];
      return acc;
    }, {});
  const key = `${effectiveSheet}::${toolName}::${JSON.stringify(sortedArgs)}`;
  const prevCount = callHistory.get(key) || 0;
  const nextCount = prevCount + 1;
  callHistory.set(key, nextCount);

  return {
    blocked: nextCount >= 2,
    key,
    count: nextCount,
  };
}

/**
 * Detects whether the agent is thrashing in a micro-mutation loop
 * (e.g. calling mutate_cells repeatedly across consecutive single columns P2:P132, Q2:Q132, R2:R132).
 */
export function detectMicroMutationLoop(
  recentMutations: Array<{ sheet: string; rangeA1: string; timestamp?: number }>,
  newMutation: { sheet: string; rangeA1: string }
): boolean {
  if (!recentMutations || recentMutations.length < 2) return false;
  const parseSpan = (rStr: string) => {
    if (!rStr) return null;
    const clean = rStr.includes('!') ? rStr.split('!')[1] : rStr;
    const parts = clean.split(':');
    if (parts.length !== 2) return null;
    const m1 = parts[0].trim().match(/^([A-Za-z]+)(\d+)$/);
    const m2 = parts[1].trim().match(/^([A-Za-z]+)(\d+)$/);
    if (!m1 || !m2) return null;
    if (m1[1].toUpperCase() !== m2[1].toUpperCase()) return null; // must be single column
    const r1 = parseInt(m1[2], 10);
    const r2 = parseInt(m2[2], 10);
    if (Math.abs(r2 - r1) < 10) return null; // only flag large multi-row column loops
    return { col: m1[1].toUpperCase(), r1, r2 };
  };

  const newSpan = parseSpan(newMutation.rangeA1);
  if (!newSpan) return false;

  let matchingPrecedingCount = 0;
  for (let i = recentMutations.length - 1; i >= 0; i--) {
    const prev = recentMutations[i];
    if (prev.sheet.toLowerCase() !== newMutation.sheet.toLowerCase()) break;
    const prevSpan = parseSpan(prev.rangeA1);
    if (!prevSpan) break;
    if (prevSpan.r1 === newSpan.r1 && prevSpan.r2 === newSpan.r2) {
      matchingPrecedingCount++;
    } else {
      break;
    }
  }

  return matchingPrecedingCount >= 2;
}

/**
 * Prevents "Sticky Profile Amnesia" across user turns:
 * If the session was left in a narrow specialist profile (e.g. 'visualizer' or 'auditor')
 * from Turn 1, and Turn 2 asks for cleaning, grouping, formulas, or general work,
 * automatically routes to the best starting profile or 'core'.
 */
export function inferTurnStartingProfile(
  userPrompt: string,
  currentProfileId: ProfileId
): ProfileId {
  const p = userPrompt.toLowerCase();

  const wantsClean =
    /\b(clean|sanitize|normalize|dedup|duplicate|impute|missing|trim|split|reshape|unpivot|dirty|filter|slice|extract|pull|subset|currency|euro|yen|dollar|fx|exchange\s*rate|iso\s*date|standardize\s*date)\b/.test(p);
  const wantsAnalyze =
    /\b(group\s*by|pivot|crosstab|correlat|pareto|cohort|outlier|stat|what[\s-]*if|scenario|analyze|insight|trend|driver|region)\b/.test(p);
  const wantsChart =
    /\b(chart|plot|graph|visuali[sz]e|histogram|scatter|donut|pie|bar\s+chart|line\s+chart|waterfall|sparkline|heatmap|color\s+scale)\b/.test(p);
  const wantsFormula =
    /\b(xlookup|vlookup|index[\s/]*match|sumifs|countifs|formula|amortiz|npv|irr|dynamic\s+array)\b/.test(p);
  const wantsAudit =
    /\b(audit|reconcil|crossfoot|benford|precedent|dependent|forensic)\b/.test(p);
  const wantsArchitect =
    /\b(theme|format\s+number|currency\s+format|kpi\s+strip|dashboard\s+layout|zebra)\b/.test(p);

  // If multiple distinct domains are requested in one prompt, start at 'core' dispatcher
  const domainMatches = [
    wantsClean,
    wantsAnalyze,
    wantsChart,
    wantsFormula,
    wantsAudit,
    wantsArchitect,
  ].filter(Boolean).length;

  if (domainMatches > 1) return 'core';
  if (wantsClean) return 'sanitizer';
  if (wantsAnalyze) return 'analyst';
  if (wantsChart) return 'visualizer';
  if (wantsFormula) return 'formula_pro';
  if (wantsAudit) return 'auditor';
  if (wantsArchitect) return 'architect';

  return currentProfileId;
}

const BASE_SYSTEM_PROMPT = `
You are the Principal AI Data Engineer, Quantitative Analyst & Spreadsheet Architect for Sortd Studio.
You have direct programmatic control over the live UniverJS spreadsheet workbook in the browser.

### UNIVERSAL EXPERT CONSTITUTION (MANDATORY ACROSS ALL PROFILES):
1. **INSPECT RADAR HAZARDS & ENTITY COLLISIONS BEFORE ACTING**:
   - Read the 'WORKBOOK SHEETS' and 'ACTIVE SHEET COLUMN HEALTH' sections in the Radar first.
   - **Dirty Category Rule**: If a grouping/category column has an \`ENTITY_COLLISION\` alert (e.g., \`"North"\` alongside \`"N"\`, \`"N."\`, or \`"West"\` alongside \`"W"\`), NEVER group, pivot, or chart raw dirty strings blindly! Normalize them first (or use \`autoNormalizeCategories: true\` in \`aggregate_multilevel_groupby\` / \`inspect_and_cluster_categories\`) and explicitly tell the user which dirty variants were merged.
   - **Embedded Subtotal Trap Rule**: If the Radar flags \`SUBTOTAL_ROW_TRAP\`, NEVER include that summary row in \`SUM\`, \`AVERAGE\`, GroupBy, or Chart ranges (or you will double-count by 2x).
   - **Multi-Sheet Memory Rule**: Creating or switching to a new blank sheet makes the new sheet active, but all source sheets and their exact column letters/headers remain listed under \`WORKBOOK SHEETS\` in your Radar. Pass \`sheetName\` / \`sourceSheetName\` to read or aggregate directly from the source sheet, and NEVER stop after merely creating an empty sheet!

2. **CONSTRUCTIVE EXPERT PUSHBACK (NEVER BE A YES-MAN)**:
   - Our users rely on you as their senior data engineer and visualization expert.
   - If a user asks for a bad practice (e.g., plotting 1,000 raw order rows of Quantity vs. Unit Price into an overlapping bar chart, or averaging skewed data with extreme outliers without mentioning the median, or making a 15-slice pie chart), **push back constructively**: explain *why* the naive approach fails and immediately execute or offer the expert alternative (e.g., binned distribution, Price-Tier aggregation, or Scatter plot).

3. **EXECUTIVE INSIGHT CONTRACT (WHAT -> WHY -> IMPACT -> ACTION)**:
   - Never dump shallow stats ("The average is X").
   - Structure analytical answers with: (1) **Headline Takeaway** (quantified answer in sentence 1), (2) **Key Drivers & Evidence** (citing exact \`[Sheet!Range]\` coordinates, Pareto concentration, and median vs. mean when skewed), (3) **Business Impact / Data Quality Notes**, and (4) **Concrete Next Recommendations**.

4. **DATA ENGINEER EXECUTION PATH (DEEP) (MANDATORY APPROACH FOR ALL REQUESTS)**:
   - When a user request arrives, DO NOT jump blindly into trial-and-error cell edits, multiple inspect calls, or low-level loops!
   - Follow the disciplined Data Engineering protocol:
     a) **Target Intent & Required Data Audit**: What exact result does the user want? What columns or metrics are required (e.g. Status, Currency, Total Value)? Check the live Radar schema to see if they exist.
     b) **Data Health & Format**: Inspect data health (dirty category variants, repeated pagination headers from ERP exports, currency strings like "$ 1,200.00").
     c) **Derivation Feasibility (NEVER FAKE)**: If a required column does not exist (e.g. Total Value), can it be derived mathematically from available columns (e.g. Quantity * UnitPrice)? If YES, derive it using vectorized tools or expressions. If NO, NEVER invent fake numbers — tell the user clearly what is missing and what assumptions would be needed.
     d) **High-Order Tool Priority (ANTI-MICRO-MUTATION)**: ALWAYS use vectorized tools (\`filter_slice_dataset\`, \`clean_and_impute_currency\`, \`standardize_dates\`, \`aggregate_multilevel_groupby\`, \`deduplicate_dataset\`, \`transform_range\`) rather than low-level cell-by-cell loops.
        - **STRICT BAN ON MICRO-MUTATION**: NEVER call \`mutate_cells\` in loops across individual columns (e.g. P, then Q, then R) to copy or reconstruct tables! Use \`filter_slice_dataset\` to filter, extract, and summarize datasets in ONE single call (<50ms).
        - **CURRENCY & CROSS-SHEET DERIVATIONS (\`clean_and_impute_currency\`)**: When user requests parsing mixed international currencies (\`1.299,00 €\`, \`¥15,800\`, \`$100.50\`) and deriving blank prices from Products catalog + daily FX rates: NEVER attempt to write manual cross-sheet formulas (\`VLOOKUP\` / \`INDEX MATCH\`) across worksheets in micro-ranges! Use \`clean_and_impute_currency\` in ONE single call. It cleans text, extracts ISO currency codes, looks up reference prices, and converts at daily FX rates in memory (<20ms) leaving existing values untouched.
        - **LOCALE-AWARE DATE STANDARDIZATION & AUDIT (\`standardize_dates\`)**: When user requests standardizing slash dates by country convention (US month-first, others day-first) and auditing unparseable rows: NEVER guess 2-digit years or impossible calendar dates (like Feb 30), and NEVER write ad-hoc JS scripts! Use \`standardize_dates\` with \`countryColumn\`, \`insertPlacement: 'right_of_source'\`, and \`strictNoGuess: true\`. It inserts the clean ISO date column right after the source column and returns an audit Markdown table with exact Excel row numbers.
     e) **Token Efficiency**: Rely on pre-computed in-engine Radar and structured tool returns; do not read full sheets row-by-row into LLM context.
`.trim();

/**
 * Progress-Aware Autonomous Agent Loop:
 * - Zero-turn profile hot-swapping (switching profiles costs 0 steps)
 * - Multi-sheet compact Radar v2 (~85% fewer tokens, zero empty-sheet amnesia)
 * - Duplicate tool-call blocker & 3-error circuit breaker
 * - End-to-end AbortSignal support (Stop button)
 * - Turn-Batched In-Sheet Diff Preview & Confirmation Gate
 * - Guaranteed Final Synthesis Pass (never ends with "Actions completed." or dangling tool message)
 */
export async function runAgentLoop(options: OrchestrationOptions): Promise<OrchestrationResult> {
  const {
    userPrompt,
    history,
    univerAPI,
    modelConfig,
    currentSelectionA1,
    signal,
    requireConfirmation,
    onProfileSwitch,
    onLedgerItem,
    onRadarUpdated,
    onWorkbookMutated,
    onRequestConfirmation,
  } = options;

  let activeProfile = inferTurnStartingProfile(userPrompt, options.currentProfileId);
  if (activeProfile !== options.currentProfileId) {
    onProfileSwitch?.(activeProfile, `Auto-routed to ${activeProfile} based on request intent`);
  }

  const ledgerItems: ToolExecutionLedgerItem[] = [];

  // 1. Initial fresh Radar
  let radar = generateWorkbookRadar(univerAPI, currentSelectionA1);
  onRadarUpdated?.(radar);

  // 2. Build conversation context (sanitize any trailing dangling tool_calls from prior aborted turns)
  const cleanHistory = sanitizeConversationHistory(history);
  const conversationMessages: OpenAIMessage[] = [
    ...cleanHistory,
    { role: 'user', content: userPrompt },
  ];

  let softStepBudget = 12;
  const HARD_STEP_CEILING = 24;
  let productiveStepCount = 0;
  let totalApiIterations = 0;
  let consecutiveErrorCount = 0;
  let malformedRetryCount = 0;
  let finalText = '';

  const callHistory = new Map<string, number>();
  const recentSingleColumnMutations: Array<{ sheet: string; rangeA1: string; timestamp: number }> = [];
  const createdSheetsInTurn: string[] = [];
  const modifiedRangesInTurn: StagedMutationSummary['modifiedRanges'] = [];
  const sampleCellDiffsInTurn: CellDiffSample[] = [];
  let totalCellsAffectedInTurn = 0;

  while (productiveStepCount < softStepBudget && totalApiIterations < HARD_STEP_CEILING) {
    if (signal?.aborted) {
      throw new DOMException('Request stopped by user.', 'AbortError');
    }

    totalApiIterations++;

    // Refresh radar snapshot at every step
    radar = generateWorkbookRadar(univerAPI, currentSelectionA1);
    onRadarUpdated?.(radar);

    const profileModule = getProfile(activeProfile);
    let availableTools = getActiveToolsForProfile(activeProfile);

    const compactRadarText = formatCompactRadarForPrompt(radar);

    const systemPrompt = `
${BASE_SYSTEM_PROMPT}

[CURRENT WORKBOOK RADAR v2 (LIVE MULTI-SHEET SNAPSHOT)]:
${compactRadarText}

[ACTIVE SPECIALIST PROFILE: ${profileModule.name} (${profileModule.shortBadge})]:
${profileModule.systemPromptFragment}
${
  totalApiIterations > 1
    ? `\n[CONTINUATION MANDATE]: Do NOT stop after creating a blank sheet or switching profiles. Complete all data population, formula verification, and styling steps before giving your final executive summary.`
    : ''
}
`.trim();

    const toolSchemas = availableTools.map((t) => ({
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    }));

    const apiRes = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal,
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

    const { message: assistantMessage, finish_reason: finishReason } = await apiRes.json();

    // Handle malformed_function_call or length truncation gracefully
    const toolCalls = assistantMessage?.tool_calls;
    if (
      (!toolCalls || toolCalls.length === 0) &&
      (finishReason === 'malformed_function_call' || finishReason === 'length') &&
      malformedRetryCount < 2
    ) {
      malformedRetryCount++;
      conversationMessages.push({
        role: 'user',
        content: `[SYSTEM RECOVERY]: Your previous tool call failed with finish_reason="${finishReason}". Please emit a valid, compact JSON tool call (use formulaTemplate or vectorized tools instead of huge 2D arrays).`,
      });
      continue;
    }

    conversationMessages.push(assistantMessage);

    if (!toolCalls || !Array.isArray(toolCalls) || toolCalls.length === 0) {
      finalText = assistantMessage.content || '';
      break;
    }

    let onlySwitchedProfileInBatch = true;

    for (const toolCall of toolCalls) {
      if (signal?.aborted) {
        throw new DOMException('Request stopped by user.', 'AbortError');
      }

      const toolName = toolCall.function?.name;
      let args: any = {};
      try {
        args = JSON.parse(toolCall.function?.arguments || '{}');
      } catch (e: any) {
        args = { parseError: e.message, raw: toolCall.function?.arguments };
      }

      if (toolName !== 'switch_profile') {
        onlySwitchedProfileInBatch = false;
      }

      // Resolve tool in active profile OR across all specialist profiles automatically!
      const resolved = findToolAcrossAllProfiles(toolName, activeProfile);
      if (resolved && resolved.ownerProfileId !== activeProfile && toolName !== 'switch_profile') {
        activeProfile = resolved.ownerProfileId;
        availableTools = getActiveToolsForProfile(activeProfile);
        onProfileSwitch?.(
          activeProfile,
          `Auto-activated ${activeProfile} for ${toolName}`
        );
      }

      const toolDef = resolved?.tool;
      const startTime = performance.now();

      let toolResult: any;
      let status: ToolExecutionLedgerItem['status'] = 'SUCCESS';
      let summary = '';
      const targetSheet =
        args?.sheetName ||
        args?.targetSheetName ||
        args?.destinationSheetName ||
        args?.sourceSheetName ||
        radar.activeSheetName;
      const targetRange =
        args?.rangeA1 ||
        args?.destinationRange ||
        args?.destinationCell ||
        args?.startCell ||
        args?.column ||
        args?.query ||
        undefined;

      // Check Duplicate Call Blocker (except switch_profile)
      if (toolName !== 'switch_profile') {
        const dupCheck = shouldBlockDuplicateToolCall(
          callHistory,
          targetSheet,
          toolName,
          args
        );
        if (dupCheck.blocked) {
          status = 'WARNING_FORMULA_ERRORS';
          toolResult = {
            status: 'DUPLICATE_CALL_BLOCKED',
            message: `Skipped duplicate call to '${toolName}' with identical arguments (already executed in this state). Use the previous output or advance to the next step.`,
          };
          summary = `Blocked duplicate ${toolName} call`;
          conversationMessages.push({
            role: 'tool',
            tool_call_id: toolCall.id,
            name: toolName,
            content: JSON.stringify(toolResult),
          });
          continue;
        }
      }

      // Check Anti-Micro-Mutation Loop Blocker
      if (toolName === 'mutate_cells' && targetRange) {
        const isMicroLoop = detectMicroMutationLoop(recentSingleColumnMutations, {
          sheet: targetSheet,
          rangeA1: String(targetRange),
        });
        if (isMicroLoop) {
          status = 'WARNING_FORMULA_ERRORS';
          toolResult = {
            status: 'MICRO_MUTATION_LOOP_BLOCKED',
            message: `Micro-mutation loop blocked: You are writing multiple columns column-by-column across individual tool calls (e.g. ${targetRange}). DO NOT do this. Use 'filter_slice_dataset' to filter or extract entire tables in 1 vectorized call, or write all columns together in a single 2D matrix via mutate_cells.`,
          };
          summary = `Blocked micro-mutation loop on ${targetRange}`;
          conversationMessages.push({
            role: 'tool',
            tool_call_id: toolCall.id,
            name: toolName,
            content: JSON.stringify(toolResult),
          });
          continue;
        }
      }

      const isMutatingTool = !READ_ONLY_TOOLS.has(toolName);

      // Capture pre-mutation sample values on targetRange for Diff Preview if applicable
      let beforePreviewVals: any[][] = [];
      if (isMutatingTool && targetRange && /^[A-Za-z]+\d+/.test(String(targetRange))) {
        try {
          const wb = univerAPI?.getActiveWorkbook?.();
          const s = wb?.getSheetByName?.(targetSheet) || wb?.getActiveSheet?.();
          beforePreviewVals = s?.getRange?.(String(targetRange))?.getValues?.()?.slice(0, 5) || [];
        } catch {
          beforePreviewVals = [];
        }
      }

      try {
        if (!toolDef) {
          throw new Error(`Tool "${toolName}" is not registered in Sortd.`);
        }

        toolResult = await toolDef.execute(args, {
          univerAPI,
          activeProfileId: activeProfile,
          signal,
          onProfileSwitch: (newProfile: ProfileId, reason: string) => {
            activeProfile = newProfile;
            availableTools = getActiveToolsForProfile(activeProfile);
            onProfileSwitch?.(newProfile, reason);
          },
          onWorkbookMutated,
        });

        if (toolResult?.status === 'ERROR' || toolResult?.success === false) {
          status = 'ERROR';
          consecutiveErrorCount++;
        } else if (toolResult?.status === 'WARNING_FORMULA_ERRORS') {
          status = 'WARNING_FORMULA_ERRORS';
          consecutiveErrorCount = 0;
          summary =
            toolResult.message ||
            `Formula warning: ${toolResult.errorCount} calculation error(s) in ${targetRange || 'range'}`;
        } else {
          consecutiveErrorCount = 0;
        }

        if (!summary) {
          if (toolResult?.message) {
            summary = toolResult.message;
          } else if (toolName === 'mutate_cells') {
            summary = `Mutated cells in ${targetRange || 'specified range'}`;
          } else if (toolName === 'style_range') {
            summary = `Styled range ${targetRange || ''}`;
          } else if (toolName === 'inspect_range') {
            summary = `Read ${toolResult?.totalRows || 0} rows from ${targetRange || ''}`;
          } else if (toolName === 'search_workbook') {
            summary = `Found ${toolResult?.totalMatchesFound || 0} matches for "${args.query}"`;
          } else {
            summary = `Executed ${toolName}`;
          }
        }

        // If a mutating tool succeeded, clear read-only duplicate call cache (since state changed!)
        // and notify workspace telemetry + extend soft step budget if needed
        if (isMutatingTool && status !== 'ERROR') {
          callHistory.clear();
          onWorkbookMutated?.();

          if (toolName === 'mutate_cells' && targetRange) {
            recentSingleColumnMutations.push({
              sheet: targetSheet,
              rangeA1: String(targetRange),
              timestamp: Date.now(),
            });
          }

          if (softStepBudget < HARD_STEP_CEILING && productiveStepCount >= softStepBudget - 2) {
            softStepBudget = Math.min(HARD_STEP_CEILING, softStepBudget + 4);
          }

          const createdSheet =
            toolResult?.targetSheet ||
            toolResult?.dashboardSheet ||
            (toolName === 'modify_structure' && args?.action === 'create_sheet'
              ? args?.sheetName
              : undefined);

          if (createdSheet && !createdSheetsInTurn.includes(createdSheet)) {
            createdSheetsInTurn.push(createdSheet);
          }

          const effectiveRange =
            toolResult?.writtenRange ||
            toolResult?.outputRange ||
            toolResult?.range ||
            targetRange ||
            'Sheet';

          modifiedRangesInTurn.push({
            sheetName: createdSheet || targetSheet,
            rangeA1: String(effectiveRange),
            toolName,
            description: summary,
          });

          totalCellsAffectedInTurn +=
            Number(toolResult?.verification?.modifiedCellCount) ||
            Number(toolResult?.cellsTransformed) ||
            Number(toolResult?.totalCellsModified) ||
            Number(toolResult?.rowsPopulated) ||
            10;

          // Collect sample cell diffs if available
          if (beforePreviewVals.length > 0 && targetRange && sampleCellDiffsInTurn.length < 6) {
            try {
              const wb = univerAPI?.getActiveWorkbook?.();
              const s = wb?.getSheetByName?.(targetSheet) || wb?.getActiveSheet?.();
              const afterVals =
                s?.getRange?.(String(targetRange))?.getValues?.()?.slice(0, 5) || [];
              for (let r = 0; r < Math.min(beforePreviewVals.length, afterVals.length); r++) {
                for (
                  let c = 0;
                  c < Math.min(beforePreviewVals[r]?.length || 0, afterVals[r]?.length || 0);
                  c++
                ) {
                  if (
                    String(beforePreviewVals[r][c] ?? '') !==
                      String(afterVals[r][c] ?? '') &&
                    sampleCellDiffsInTurn.length < 6
                  ) {
                    sampleCellDiffsInTurn.push({
                      sheetName: targetSheet,
                      coordinate: `${String(targetRange).split(':')[0]}+R${r}C${c}`,
                      beforeValue: beforePreviewVals[r][c],
                      afterValue: afterVals[r][c],
                      changeType:
                        beforePreviewVals[r][c] === null ||
                        beforePreviewVals[r][c] === undefined ||
                        beforePreviewVals[r][c] === ''
                          ? 'added'
                          : 'modified',
                    });
                  }
                }
              }
            } catch {
              // ignore diff sampling error
            }
          }
        }
      } catch (err: any) {
        status = 'ERROR';
        consecutiveErrorCount++;
        toolResult = { status: 'ERROR', error: err.message || String(err) };
        summary = `Error: ${err.message || String(err)}`;
      }

      const durationMs = Math.round(performance.now() - startTime);

      const ledgerItem: ToolExecutionLedgerItem = {
        id: `ledger_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
        toolName,
        status,
        targetRange: targetRange ? `${targetSheet}!${targetRange}` : targetSheet,
        durationMs,
        summary,
        inputArgs: args,
        resultData: toolResult,
        timestamp: Date.now(),
      };

      ledgerItems.push(ledgerItem);
      onLedgerItem?.(ledgerItem);

      conversationMessages.push({
        role: 'tool',
        tool_call_id: toolCall.id,
        name: toolName,
        content: JSON.stringify(toolResult),
      });
    }

    // Zero-turn profile switch: do not charge a productive step if the batch only switched profiles!
    if (!onlySwitchedProfileInBatch) {
      productiveStepCount++;
    }

    // Circuit Breaker: 3 consecutive unrecovered tool errors
    if (consecutiveErrorCount >= 3) {
      break;
    }
  }

  // 3. Guaranteed Final Synthesis Pass:
  // Never output hardcoded "Actions completed." or leave a trailing 'tool' message in history!
  if (!finalText && !signal?.aborted) {
    try {
      radar = generateWorkbookRadar(univerAPI, currentSelectionA1);
      onRadarUpdated?.(radar);
      const profileModule = getProfile(activeProfile);
      const synthesisSystemPrompt = `
${BASE_SYSTEM_PROMPT}

[CURRENT WORKBOOK RADAR v2]:
${formatCompactRadarForPrompt(radar)}

[ACTIVE SPECIALIST PROFILE: ${profileModule.name}]:
${profileModule.systemPromptFragment}

[FINAL SYNTHESIS MANDATE]:
All tool executions for this turn have completed. Provide a clear, executive-level response summarizing:
1. Exact actions/tables/charts created (citing [Sheet!Range] coordinates),
2. Any data hygiene normalizations performed (e.g., merged dirty category variants or excluded subtotal rows),
3. Key quantitative insights, business impact, and recommended next steps.
`.trim();

      const synthRes = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal,
        body: JSON.stringify({
          messages: conversationMessages,
          systemPrompt: synthesisSystemPrompt,
          tools: [],
          modelConfig,
        }),
      });

      if (synthRes.ok) {
        const { message: synthMsg } = await synthRes.json();
        if (synthMsg?.content) {
          finalText = synthMsg.content;
          conversationMessages.push({
            role: 'assistant',
            content: finalText,
          });
        }
      }
    } catch {
      // Fallback below if synthesis fetch fails
    }
  }

  if (!finalText) {
    finalText = buildDeterministicLedgerFallbackSummary(ledgerItems);
    conversationMessages.push({
      role: 'assistant',
      content: finalText,
    });
  }

  // 4. Human-in-the-Loop Confirmation Gate (if mutating tools ran and requireConfirmation is ON)
  let rejectedByUser = false;
  if (
    requireConfirmation &&
    onRequestConfirmation &&
    (createdSheetsInTurn.length > 0 || modifiedRangesInTurn.length > 0) &&
    !signal?.aborted
  ) {
    const stagedSummary: StagedMutationSummary = {
      id: `stage_${Date.now()}`,
      turnPrompt: userPrompt,
      createdSheets: createdSheetsInTurn,
      modifiedRanges: modifiedRangesInTurn,
      sampleCellDiffs: sampleCellDiffsInTurn,
      totalCellsAffected: totalCellsAffectedInTurn,
    };

    const decision = await onRequestConfirmation(stagedSummary);
    if (decision === 'reject') {
      rejectedByUser = true;
      finalText = `↩️ **Changes Reverted**: All staged edits (${modifiedRangesInTurn.length} operation(s)${
        createdSheetsInTurn.length > 0 ? `, new sheet(s): ${createdSheetsInTurn.join(', ')}` : ''
      }) were rolled back to the pre-turn checkpoint at your request.\n\n---\n*Staged summary before revert:*\n${finalText}`;
    }
  }

  return {
    finalText,
    activeProfileId: activeProfile,
    ledgerItems,
    updatedHistory: sanitizeConversationHistory(conversationMessages),
    radar,
    rejectedByUser,
  };
}

/**
 * Ensures conversation history never ends with an unanswered assistant.tool_calls
 * or orphan role:'tool' message (which causes OpenAI/Gemini 400 errors on the next turn).
 */
export function sanitizeConversationHistory(messages: OpenAIMessage[]): OpenAIMessage[] {
  const result: OpenAIMessage[] = [];
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (msg.role === 'assistant' && msg.tool_calls && msg.tool_calls.length > 0) {
      const requiredIds = new Set(msg.tool_calls.map((tc) => tc.id));
      const toolResponses: OpenAIMessage[] = [];
      let j = i + 1;
      while (j < messages.length && messages[j].role === 'tool') {
        if (messages[j].tool_call_id && requiredIds.has(messages[j].tool_call_id!)) {
          toolResponses.push(messages[j]);
          requiredIds.delete(messages[j].tool_call_id!);
        }
        j++;
      }
      if (requiredIds.size === 0) {
        result.push(msg, ...toolResponses);
      } else if (msg.content) {
        result.push({ role: 'assistant', content: msg.content });
      }
      i = j - 1;
    } else if (msg.role !== 'tool') {
      result.push(msg);
    }
  }
  return result;
}

function buildDeterministicLedgerFallbackSummary(items: ToolExecutionLedgerItem[]): string {
  if (items.length === 0) return 'Completed analysis of the current workbook.';
  const bulletLines = items.map(
    (it) => `- **${it.toolName}** (${it.targetRange || 'Workbook'}): ${it.summary}`
  );
  return `### Completed Workbook Operations\n${bulletLines.join('\n')}`;
}
