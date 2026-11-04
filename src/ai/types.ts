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

export interface SheetHeaderBrief {
  colLetter: string;
  header: string;
  sampleType?: string;
}

export interface SheetMetaSummary {
  name: string;
  rowCount: number;
  colCount: number;
  populatedRows?: number;
  populatedCols?: number;
  occupiedBounds?: string;
  headers?: SheetHeaderBrief[];
}

export interface ColumnHealthCard {
  colLetter: string;
  headerGuess: string;
  totalRowsScanned: number;
  nullCount: number;
  uniqueCount: number;
  detectedType:
    | 'number'
    | 'string'
    | 'date'
    | 'percentage'
    | 'currency'
    | 'formula'
    | 'mixed'
    | 'empty';
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
    median?: number;
    variance?: number;
    skewness?: number;
  } | null;
  entityCollisions?: string[];
  formulaTemplate?: string;
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
  subtotalTrapRows?: number[];
  repeatedHeaderRows?: number[];
}

export interface ToolExecutionContext {
  univerAPI: any;
  activeProfileId: ProfileId;
  onProfileSwitch: (newProfile: ProfileId, reason: string) => void;
  onWorkbookMutated?: () => void;
  onChartGenerated?: (chart: ChartPayload) => void;
  signal?: AbortSignal;
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

export interface CellDiffSample {
  sheetName: string;
  coordinate: string;
  beforeValue: any;
  afterValue: any;
  changeType: 'added' | 'modified' | 'deleted';
}

export interface StagedMutationSummary {
  id: string;
  turnPrompt: string;
  createdSheets: string[];
  modifiedRanges: Array<{
    sheetName: string;
    rangeA1: string;
    toolName: string;
    description: string;
  }>;
  sampleCellDiffs: CellDiffSample[];
  totalCellsAffected: number;
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

export type ChartType =
  | 'auto'
  | 'column'
  | 'bar'
  | 'line'
  | 'area'
  | 'donut'
  | 'scatter'
  | 'bubble'
  | 'combo_dual_axis'
  | 'waterfall'
  | 'treemap'
  | 'funnel'
  | 'radar'
  | 'pareto'
  | 'histogram'
  | 'box_plot';

export interface ChartSeries {
  name: string;
  data: number[];
  color?: string;
  yAxisIndex?: number; // 0 = primary, 1 = secondary
  type?: 'bar' | 'line' | 'area';
  scatterPoints?: Array<{ x: number; y: number; r?: number; label?: string }>;
  boxPlotStats?: Array<{
    category: string;
    min: number;
    q1: number;
    median: number;
    q3: number;
    max: number;
    outliers?: number[];
  }>;
  waterfallItems?: Array<{
    label: string;
    value: number;
    start: number;
    end: number;
    isTotal?: boolean;
  }>;
}

export interface ChartPayload {
  id: string;
  title: string;
  subtitle?: string;
  chartType: ChartType;
  categories: string[];
  series: ChartSeries[];
  xAxisLabel?: string;
  yAxisLabel?: string;
  secondaryYAxisLabel?: string;
  range: string;
  sheetName: string;
  statsSummary?: string;
  expertAdvisory?: string;
  timestamp: number;
}

export interface ModelConfig {
  provider: 'openrouter' | 'openai' | 'custom';
  model: string;
  apiKey?: string;
  adminPassword?: string;
  baseUrl?: string;
  temperature?: number;
}
