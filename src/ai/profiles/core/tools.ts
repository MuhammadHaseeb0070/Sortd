import { AIToolDefinition } from '../../types';
import {
  executeInspectRange,
  executeTransformRange,
  executeSearchWorkbook,
  executeProfileColumns,
  executeMutateCells,
  executeModifyStructure,
  executeStyleRange,
  executeSwitchProfile,
  executeSwitchSheet,
} from './executors';

export const CORE_TOOLS: AIToolDefinition[] = [
  {
    name: 'transform_range',
    description:
      'High-performance in-engine vector transformations across columns or ranges. Instantly cleans data, removes currency symbols ($/€/£), strips commas, parses numbers, normalizes casing, and does regex replacements across thousands of rows in 2ms without consuming context tokens.',
    parameters: {
      type: 'object',
      properties: {
        rangeA1: {
          type: 'string',
          description:
            'Target range notation (e.g. "H2:H669", "B2:B100", "A1:D50"). Can be a whole column or block.',
        },
        operations: {
          type: 'array',
          description: 'Ordered sequence of vector transformations to execute in-engine.',
          items: {
            type: 'object',
            properties: {
              type: {
                type: 'string',
                enum: [
                  'trim_whitespace',
                  'remove_currency',
                  'parse_number',
                  'replace_regex',
                  'case',
                  'fill_blanks',
                  'math_scalar',
                  'round',
                  'format_date',
                ],
                description: 'The transformation operation type.',
              },
              dateFormat: {
                type: 'string',
                enum: ['DD-MM-YYYY', 'YYYY-MM-DD', 'MM/DD/YYYY', 'DD/MM/YYYY', 'MMM DD, YYYY'],
                description: 'Target format for format_date (default "DD-MM-YYYY").',
              },
              pattern: {
                type: 'string',
                description: 'Regex pattern for replace_regex (e.g. "[$,€£]" or "\\s+").',
              },
              replacement: {
                type: 'string',
                description: 'Replacement text for replace_regex.',
              },
              flags: {
                type: 'string',
                description: 'Regex flags (e.g. "g", "gi"). Default "g".',
              },
              caseType: {
                type: 'string',
                enum: ['upper', 'lower', 'title', 'capitalize'],
                description: 'Casing type for case operation.',
              },
              fallbackValue: {
                description: 'Fallback value for fill_blanks when cell is null/empty.',
              },
              mathOperator: {
                type: 'string',
                enum: ['add', 'subtract', 'multiply', 'divide'],
                description: 'Math operator for math_scalar.',
              },
              scalarValue: {
                type: 'number',
                description: 'Numeric operand for math_scalar.',
              },
              decimalPlaces: {
                type: 'number',
                description: 'Number of decimal places for round operation.',
              },
            },
            required: ['type'],
          },
        },
        sheetName: {
          type: 'string',
          description: 'Optional worksheet name. Defaults to active worksheet.',
        },
      },
      required: ['rangeA1', 'operations'],
    },
    execute: executeTransformRange,
  },
  {
    name: 'inspect_range',
    description:
      'Reads cell values and formulas with support for column projections (e.g. ["A", "H"]), row filters (e.g. column H > 100 or contains "Pending"), sorting, and pagination. Output protected by token safety guard.',
    parameters: {
      type: 'object',
      properties: {
        rangeA1: {
          type: 'string',
          description:
            'A1 notation of target range (e.g. "A1:G20"). If omitted, defaults to occupied sheet bounds.',
        },
        columns: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Optional array of column letters to project (e.g. ["A", "D", "H"]). Omits other columns to save tokens.',
        },
        filter: {
          type: 'object',
          description: 'Filter predicate to only return matching rows.',
          properties: {
            column: {
              type: 'string',
              description: 'Column letter to filter on (e.g. "H" or "B").',
            },
            operator: {
              type: 'string',
              enum: [
                '>',
                '<',
                '>=',
                '<=',
                '==',
                '!=',
                'contains',
                'startsWith',
                'endsWith',
                'regex',
                'isNull',
                'notNull',
              ],
            },
            value: {
              description: 'Comparison value for the filter.',
            },
          },
          required: ['column', 'operator'],
        },
        sortBy: {
          type: 'object',
          description: 'Sort criteria for the returned rows.',
          properties: {
            column: { type: 'string', description: 'Column letter to sort by.' },
            direction: { type: 'string', enum: ['asc', 'desc'] },
          },
          required: ['column'],
        },
        page: {
          type: 'number',
          description: 'Page number for paginated reading (1-based).',
        },
        pageSize: {
          type: 'number',
          description: 'Rows per page when paginating (default 25).',
        },
        sheetName: {
          type: 'string',
          description: 'Optional worksheet name. Defaults to active worksheet.',
        },
        includeFormulas: {
          type: 'boolean',
          description: 'Whether to include un-evaluated formula strings. Default true.',
        },
      },
    },
    execute: executeInspectRange,
  },
  {
    name: 'search_workbook',
    description:
      'Searches the worksheet with fuzzy matching (typo tolerance), regex pattern matching, or error auditing (finds all #REF!, #DIV/0!, #VALUE!). Returns cell coordinates, values, and row previews.',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Search string or regex pattern (e.g. "Total", "INV-\\d+", "#REF!").',
        },
        findType: {
          type: 'string',
          enum: ['all', 'errors', 'formulas', 'numbers', 'empty', 'text'],
          description: 'Category filter for search. Use "errors" to find all broken formula cells.',
        },
        columns: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional array of column letters to limit the search scope.',
        },
        fuzzy: {
          type: 'boolean',
          description: 'Enable typo-tolerant fuzzy matching. Default false.',
        },
        fuzzyThreshold: {
          type: 'number',
          description: 'Fuzzy similarity score threshold between 0.0 and 1.0 (default 0.7).',
        },
        useRegex: {
          type: 'boolean',
          description: 'Whether query should be treated as a regular expression.',
        },
        matchCase: {
          type: 'boolean',
          description: 'Case sensitive matching. Default false.',
        },
        maxResults: {
          type: 'number',
          description: 'Maximum matches to return. Default 25.',
        },
        sheetName: {
          type: 'string',
          description: 'Optional worksheet name.',
        },
      },
    },
    execute: executeSearchWorkbook,
  },
  {
    name: 'mutate_cells',
    description:
      'Vectorized batch write for values and formulas. Supports 2D matrices, formulaTemplate auto-fills (e.g. "=B{row}-C{row}" across D2:D500), and conditional updates. Automatically runs formula verification to catch calculation errors.',
    parameters: {
      type: 'object',
      properties: {
        rangeA1: {
          type: 'string',
          description: 'Target cell block in A1 notation (e.g. "A1:D5", "D2:D500").',
        },
        values2D: {
          type: 'array',
          items: {
            type: 'array',
            items: { type: ['string', 'number', 'boolean', 'null'] },
          },
          description:
            '2D matrix of values. Strings starting with "=" are automatically evaluated as formulas.',
        },
        formulaTemplate: {
          type: 'string',
          description:
            'Formula pattern with {row} placeholder, e.g. "=B{row}*C{row}". Generated and written across all rows in rangeA1 in one batch.',
        },
        conditionalUpdate: {
          type: 'object',
          description: 'Update cells in targetCol only when conditionCol matches a condition.',
          properties: {
            targetCol: { type: 'string', description: 'Column to update (e.g. "D").' },
            conditionCol: { type: 'string', description: 'Column to check (e.g. "B").' },
            operator: { type: 'string', enum: ['>', '<', '>=', '<=', '==', '!='] },
            conditionVal: { description: 'Comparison value.' },
            newVal: { description: 'New value to set.' },
          },
          required: ['targetCol', 'conditionCol', 'operator', 'conditionVal', 'newVal'],
        },
        clearFirst: {
          type: 'boolean',
          description: 'Whether to clear existing cell content before writing. Default false.',
        },
      },
      required: ['rangeA1'],
    },
    execute: executeMutateCells,
  },
  {
    name: 'profile_columns',
    description:
      'Performs deep data quality and statistical profiling on specified columns. Detects dirty data signals (currency symbols, trailing spaces, commas in numbers) and recommends cleaning operations.',
    parameters: {
      type: 'object',
      properties: {
        columns: {
          type: 'array',
          items: { type: 'string' },
          description: 'Array of column letters to profile (e.g. ["A", "B", "H"]).',
        },
        startRow: {
          type: 'number',
          description: '1-indexed start row. Defaults to 1.',
        },
        endRow: {
          type: 'number',
          description: '1-indexed end row. Defaults to last occupied row.',
        },
      },
      required: ['columns'],
    },
    execute: executeProfileColumns,
  },
  {
    name: 'modify_structure',
    description:
      'Alters sheet structure and geometry: auto-fit column widths, remove empty rows, freeze rows, insert/delete rows or columns, and merge/unmerge cells.',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: [
            'auto_fit_columns',
            'delete_empty_rows',
            'insert_rows',
            'delete_rows',
            'insert_columns',
            'delete_columns',
            'merge_range',
            'unmerge_range',
            'create_sheet',
            'rename_sheet',
            'set_column_width',
          ],
          description: 'Structural action to execute.',
        },
        columns: {
          type: 'array',
          items: { type: 'string' },
          description: 'For auto_fit_columns: specific column letters to fit (e.g. ["A", "H"]).',
        },
        index: {
          type: 'number',
          description: '0-based row or column index for insertion/deletion/width setting.',
        },
        count: {
          type: 'number',
          description: 'Number of rows or columns to insert or delete. Default 1.',
        },
        rangeA1: {
          type: 'string',
          description: 'Required for merge_range and unmerge_range (e.g. "A1:D1").',
        },
        sheetName: {
          type: 'string',
          description: 'Required for create_sheet or rename_sheet.',
        },
        widthPx: {
          type: 'number',
          description: 'Required for set_column_width (width in pixels).',
        },
      },
      required: ['action'],
    },
    execute: executeModifyStructure,
  },
  {
    name: 'style_range',
    description:
      'Applies clean, high-contrast formatting in batch: background color, font color, bold, italic, font size, and text alignment.',
    parameters: {
      type: 'object',
      properties: {
        rangeA1: {
          type: 'string',
          description: 'A1 notation of range to style (e.g. "A1:F1").',
        },
        backgroundColor: {
          type: 'string',
          description: 'Hex color string (e.g. "#18181b", "#059669", "#ffffff").',
        },
        fontColor: {
          type: 'string',
          description: 'Hex font color (e.g. "#ffffff", "#e4e4e7").',
        },
        bold: {
          type: 'boolean',
          description: 'Whether text should be bold.',
        },
        italic: {
          type: 'boolean',
          description: 'Whether text should be italic.',
        },
        horizontalAlignment: {
          type: 'string',
          enum: ['left', 'center', 'right'],
          description: 'Horizontal text alignment.',
        },
        fontSize: {
          type: 'number',
          description: 'Font size in points (e.g. 11, 13).',
        },
      },
      required: ['rangeA1'],
    },
    execute: executeStyleRange,
  },
  {
    name: 'switch_profile',
    description:
      'Switches the active AI operating persona mid-session to delegate to a specialized profile.',
    parameters: {
      type: 'object',
      properties: {
        targetProfile: {
          type: 'string',
          enum: [
            'core',
            'sanitizer',
            'formula_pro',
            'architect',
            'analyst',
            'visualizer',
            'auditor',
          ],
          description: 'Target specialist profile ID to switch to.',
        },
        handoffSummary: {
          type: 'string',
          description: 'Reason for handoff and context for the receiving specialist.',
        },
      },
      required: ['targetProfile', 'handoffSummary'],
    },
    execute: executeSwitchProfile,
  },
  {
    name: 'switch_sheet',
    description:
      'Switches the active visible worksheet tab to a target sheet by name (e.g. "Customers", "Sheet2"). Updates the user screen view instantly.',
    parameters: {
      type: 'object',
      properties: {
        sheetName: {
          type: 'string',
          description: 'Name of the worksheet to switch the active view to.',
        },
      },
      required: ['sheetName'],
    },
    execute: executeSwitchSheet,
  },
];
