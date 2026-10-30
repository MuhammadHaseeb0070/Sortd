export type ProfileId =
  | 'core'
  | 'sanitizer'
  | 'formula_pro'
  | 'architect'
  | 'analyst'
  | 'visualizer'
  | 'auditor';

export interface ColumnSchema {
  colLetter: string;
  headerGuess: string;
  detectedType: 'number' | 'string' | 'date' | 'formula' | 'mixed' | 'empty';
  nullCount: number;
  sampleValues: any[];
}

export interface SheetMetaSummary {
  name: string;
  rowCount: number;
  colCount: number;
}

export interface ColumnHealthCard {
  colLetter: string;
  headerGuess: string;
  totalRowsScanned: number;
  nullCount: number;
  uniqueCount: number;
  detectedType: 'number' | 'string' | 'date' | 'percentage' | 'currency' | 'mixed' | 'empty';
  typeCensus: {
    integers: number;
    decimals: number;
    currencyStrings: number;
    percentageStrings: number;
    dates: number;
    plainStrings: number;
    booleans: number;
    nulls: number;
    formulas: number;
  };
  topFrequentValues: Array<{ value: any; count: number; percentage: number }>;
  rareOutliers: Array<{ value: any; count: number }>;
  stats?: {
    min?: number;
    max?: number;
    mean?: number;
    variance?: number;
  } | null;
  hazardAlerts: string[];
}

export interface WorkbookRadar {
  activeSheetName: string;
  allSheets: SheetMetaSummary[];
  userSelectionRange: string;
  occupiedBounds: string;
  nextSafeEmptyColumn: string;
  topRowsPreview: any[][];
  columnSchemas: ColumnSchema[];
  columnHealthCards?: Record<string, ColumnHealthCard>;
}

export interface ToolExecutionContext {
  univerAPI: any;
  activeProfileId: ProfileId;
  onProfileSwitch: (newProfile: ProfileId, reason: string) => void;
}

export interface AIToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, any>; // JSON Schema
  execute: (args: any, ctx: ToolExecutionContext) => Promise<any>;
}

export interface AIProfileModule {
  id: ProfileId;
  name: string;
  shortBadge: string;
  badgeColor?: string;
  description: string;
  systemPromptFragment: string;
  tools: AIToolDefinition[];
}

export interface ToolExecutionLedgerItem {
  id: string;
  toolName: string;
  status: 'SUCCESS' | 'WARNING_FORMULA_ERRORS' | 'ERROR';
  targetRange?: string;
  durationMs: number;
  summary: string;
  inputArgs: any;
  resultData: any;
  timestamp: number;
}

export interface FormulaErrorItem {
  coordinate: string;
  formula?: string;
  value?: any;
}

export interface MutationReceipt {
  status: 'SUCCESS' | 'WARNING_FORMULA_ERRORS' | 'ERROR';
  range: string;
  modifiedCellCount: number;
  errorCount: number;
  firstErrors: FormulaErrorItem[];
  sampleResultPreview?: any[][];
  message?: string;
}

export interface GuardedRangeOutput {
  range: string;
  totalRows: number;
  truncated: boolean;
  omittedMiddleRows?: number;
  first15Rows?: any[][];
  last5Rows?: any[][];
  rows?: any[][];
  formulas?: any[][];
  columnStats?: Record<
    string,
    {
      numericCount: number;
      min?: number;
      max?: number;
      nullCount: number;
      uniqueCount: number;
    }
  >;
  notice?: string;
}

export interface OpenAIMessage {
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string | null;
  tool_calls?: Array<{
    id: string;
    type: 'function';
    function: {
      name: string;
      arguments: string;
    };
  }>;
  tool_call_id?: string;
  name?: string;
}

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: number;
  ledgerItems?: ToolExecutionLedgerItem[];
}

export interface ModelConfig {
  provider: 'openrouter' | 'openai' | 'custom';
  model: string;
  apiKey?: string;
  baseUrl?: string;
  temperature?: number;
}
