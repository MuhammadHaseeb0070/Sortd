import { AIToolDefinition } from '../../types';
import {
  executeBuildLookup,
  executeComposeAggregation,
  executeGenerateFinancialModel,
  executeCascadeDynamicArrays,
  executeMatrixMathEngine,
  executeValidateAndHealFormulas,
} from './executors';

export const FORMULA_PRO_TOOLS: AIToolDefinition[] = [
  {
    name: 'build_lookup',
    description:
      'Generates bulletproof, uncorrupted cross-sheet lookups (INDEX/MATCH, XLOOKUP, Two-Way Matrix). Automatically escapes sheet names with spaces and wraps formulas inside IFERROR/IFNA guards so lookups never crash with #N/A or #REF!.',
    parameters: {
      type: 'object',
      properties: {
        targetRangeA1: {
          type: 'string',
          description: 'Destination cell range to write lookup formulas into (e.g. "D2:D500").',
        },
        lookupKeyColumn: {
          type: 'string',
          description: 'Key column letter or header on the active sheet to look up (e.g. "A" or "CustomerID").',
        },
        sourceSheetName: {
          type: 'string',
          description: 'Name of the source worksheet to look into (e.g. "Customers", "Q1 Pricing").',
        },
        sourceKeyColumn: {
          type: 'string',
          description: 'Key column on the source sheet to match against (e.g. "A" or "ID").',
        },
        sourceReturnColumn: {
          type: 'string',
          description: 'Column on the source sheet containing values to retrieve (e.g. "C" or "Email").',
        },
        mode: {
          type: 'string',
          enum: ['index_match', 'xlookup', 'two_way'],
          description:
            '"index_match" is universally supported across all engines; "xlookup" generates Excel 365 XLOOKUP; "two_way" matches both row key and column header.',
        },
        twoWayColumnHeader: {
          type: 'string',
          description: 'Required if mode is "two_way": the column header title to match across the top row.',
        },
        fallbackValue: {
          description: 'Fallback value if no match is found (default "Not Found").',
        },
        startRow: {
          type: 'number',
          description: '1-indexed start row. Default 2.',
        },
        endRow: {
          type: 'number',
          description: '1-indexed end row. Defaults to last occupied row.',
        },
        lookupSheetName: {
          type: 'string',
          description: 'Worksheet name where formulas will be placed. Defaults to active worksheet.',
        },
      },
      required: ['targetRangeA1', 'lookupKeyColumn', 'sourceSheetName', 'sourceKeyColumn', 'sourceReturnColumn'],
    },
    execute: executeBuildLookup,
  },
  {
    name: 'compose_aggregation',
    description:
      'Builds multi-condition math aggregation formulas (SUMIFS, COUNTIFS, AVERAGEIFS, MINIFS, MAXIFS) or single aggregations (SUM, AVERAGE, COUNT). Supports cross-sheet calculation, date boundaries (">=2024-01-01"), and wildcard text criteria.',
    parameters: {
      type: 'object',
      properties: {
        targetCell: {
          type: 'string',
          description: 'Destination cell coordinate for the calculation result (e.g. "G2" or "B15").',
        },
        functionType: {
          type: 'string',
          enum: ['SUMIFS', 'COUNTIFS', 'AVERAGEIFS', 'SUM', 'AVERAGE', 'COUNT', 'MINIFS', 'MAXIFS'],
          description: 'Aggregation function type to compose.',
        },
        dataSheetName: {
          type: 'string',
          description: 'Worksheet containing the source data. Defaults to target worksheet.',
        },
        measureColumn: {
          type: 'string',
          description: 'Column to sum, average, or measure (e.g. "Revenue", "Amount", "E"). Required for SUMIFS/AVERAGEIFS.',
        },
        criteria: {
          type: 'array',
          description: 'List of filter criteria for conditional aggregations.',
          items: {
            type: 'object',
            properties: {
              column: { type: 'string', description: 'Filter column letter or header (e.g. "Region" or "Date").' },
              operator: { type: 'string', enum: ['=', '>', '<', '>=', '<=', '<>', 'contains'] },
              value: { description: 'Filter comparison value or cell reference.' },
              isCellReference: { type: 'boolean', description: 'Whether value is a cell reference like "A2".' },
            },
            required: ['column', 'value'],
          },
        },
        startRow: {
          type: 'number',
          description: 'Start row of data table. Default 2.',
        },
        endRow: {
          type: 'number',
          description: 'End row of data table. Defaults to last occupied row.',
        },
        targetSheetName: {
          type: 'string',
          description: 'Worksheet name where targetCell lives. Defaults to active worksheet.',
        },
      },
      required: ['targetCell', 'functionType'],
    },
    execute: executeComposeAggregation,
  },
  {
    name: 'generate_financial_model',
    description:
      'Generates complete, professional financial models: loan amortization schedules (with PMT, PPMT, IPMT), compound interest wealth schedules, Net Present Value (NPV) & Internal Rate of Return (IRR), and straight-line or declining depreciation.',
    parameters: {
      type: 'object',
      properties: {
        modelType: {
          type: 'string',
          enum: ['loan_amortization', 'compound_interest', 'npv_irr', 'depreciation'],
          description: 'Type of financial model to construct.',
        },
        principal: {
          type: 'number',
          description: 'Loan amount or initial principal (e.g. 250000).',
        },
        annualInterestRate: {
          type: 'number',
          description: 'Annual interest rate as decimal (e.g. 0.065 for 6.5%).',
        },
        loanTermYears: {
          type: 'number',
          description: 'Duration of loan in years (e.g. 5, 15, 30).',
        },
        paymentsPerYear: {
          type: 'number',
          description: 'Payment frequency per year (default 12 for monthly).',
        },
        initialDeposit: {
          type: 'number',
          description: 'Starting balance for compound interest.',
        },
        monthlyContribution: {
          type: 'number',
          description: 'Monthly contribution for compound interest.',
        },
        annualReturnRate: {
          type: 'number',
          description: 'Expected annual return rate for compound interest (e.g. 0.08).',
        },
        projectionYears: {
          type: 'number',
          description: 'Investment projection horizon in years (default 10).',
        },
        assetCost: {
          type: 'number',
          description: 'Initial cost for depreciation model.',
        },
        salvageValue: {
          type: 'number',
          description: 'Estimated salvage value at end of asset life.',
        },
        usefulLifeYears: {
          type: 'number',
          description: 'Depreciation life in years.',
        },
        depreciationMethod: {
          type: 'string',
          enum: ['SLN', 'DB'],
          description: '"SLN" for straight-line, "DB" for declining balance.',
        },
        cashFlowRangeA1: {
          type: 'string',
          description: 'Cash flows cell range for NPV/IRR (e.g. "B2:B12").',
        },
        discountRate: {
          type: 'number',
          description: 'Discount rate for NPV (e.g. 0.10).',
        },
        targetSheetName: {
          type: 'string',
          description: 'Worksheet to output model into. If provided, creates a dedicated sheet.',
        },
        startCell: {
          type: 'string',
          description: 'Starting cell coordinate (default "A1").',
        },
      },
      required: ['modelType'],
    },
    execute: executeGenerateFinancialModel,
  },
  {
    name: 'cascade_dynamic_arrays',
    description:
      'Constructs modern spilled array formulas (UNIQUE, FILTER, SORT, SEQUENCE). Includes automatic spill collision guards to pre-clear target cells and prevent #SPILL! errors.',
    parameters: {
      type: 'object',
      properties: {
        targetCell: {
          type: 'string',
          description: 'Top-left origin cell where the dynamic array will spill from (e.g. "M2").',
        },
        formulaType: {
          type: 'string',
          enum: ['UNIQUE', 'FILTER', 'SORT', 'SEQUENCE'],
          description: 'Dynamic array formula function.',
        },
        sourceRangeA1: {
          type: 'string',
          description: 'Source array range to filter, sort, or deduplicate (e.g. "A2:E500").',
        },
        filterCondition: {
          type: 'string',
          description: 'Boolean criteria string for FILTER (e.g. "C2:C500>100" or "(B2:B500=\\"West\\")*(D2:D500>50)").',
        },
        sortIndex: {
          type: 'number',
          description: '1-based column index to sort by for SORT (default 1).',
        },
        sortOrder: {
          type: 'string',
          enum: ['asc', 'desc'],
          description: 'Sort direction (default "asc").',
        },
        sequenceRows: {
          type: 'number',
          description: 'Number of rows to generate for SEQUENCE.',
        },
        sequenceCols: {
          type: 'number',
          description: 'Number of columns for SEQUENCE (default 1).',
        },
        sequenceStart: {
          type: 'number',
          description: 'Starting number for SEQUENCE (default 1).',
        },
        sequenceStep: {
          type: 'number',
          description: 'Increment step for SEQUENCE (default 1).',
        },
        clearSpillZoneFirst: {
          type: 'boolean',
          description: 'Whether to clear downstream cells to prevent #SPILL! collision. Default true.',
        },
        sheetName: {
          type: 'string',
          description: 'Worksheet name. Defaults to active worksheet.',
        },
      },
      required: ['targetCell', 'formulaType'],
    },
    execute: executeCascadeDynamicArrays,
  },
  {
    name: 'matrix_math_engine',
    description:
      'Generates vectorized mathematical columns: expanding cumulative running totals (=SUM($C$2:C2)), percentage of column total (=C2/SUM($C$2:$C$100)), trailing moving averages (=AVERAGE(C2:C8)), and linear predictive trends (FORECAST).',
    parameters: {
      type: 'object',
      properties: {
        operation: {
          type: 'string',
          enum: ['running_total', 'percent_of_total', 'moving_average', 'trend_slope_intercept'],
          description: 'Mathematical matrix operation to execute.',
        },
        sourceColumn: {
          type: 'string',
          description: 'Numeric source column letter or header name (e.g. "Revenue" or "D").',
        },
        targetColumn: {
          type: 'string',
          description: 'Destination column letter. If omitted, inserts a new adjacent column.',
        },
        windowSize: {
          type: 'number',
          description: 'Period window size for moving_average (default 7).',
        },
        startRow: {
          type: 'number',
          description: '1-indexed start row. Default 2.',
        },
        endRow: {
          type: 'number',
          description: '1-indexed end row. Defaults to last occupied row.',
        },
        sheetName: {
          type: 'string',
          description: 'Worksheet name. Defaults to active worksheet.',
        },
      },
      required: ['operation', 'sourceColumn'],
    },
    execute: executeMatrixMathEngine,
  },
  {
    name: 'validate_and_heal_formulas',
    description:
      'The Formula Doctor. Scans a range for broken formulas (#REF!, #NAME?, #DIV/0!, #VALUE!, #N/A), diagnoses syntax errors or unquoted sheet names, wraps fragile calculations with IFERROR guards, and tests live re-evaluation.',
    parameters: {
      type: 'object',
      properties: {
        rangeA1: {
          type: 'string',
          description: 'Range of cells to scan and heal (e.g. "A1:Z100" or "D2:D500").',
        },
        autoWrapWithIfError: {
          type: 'boolean',
          description: 'Whether to automatically wrap error-throwing formulas inside IFERROR(...). Default true.',
        },
        ifErrorFallback: {
          description: 'Fallback value for IFERROR (default 0).',
        },
        sheetName: {
          type: 'string',
          description: 'Worksheet name. Defaults to active worksheet.',
        },
      },
      required: ['rangeA1'],
    },
    execute: executeValidateAndHealFormulas,
  },
];
