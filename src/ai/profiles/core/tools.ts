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
import {
  executeFilterSliceDataset,
  executeStandardizeDates,
  executeCleanAndImputeCurrency,
} from '../sanitizer/executors';

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
    name: 'filter_slice_dataset',
    description:
      'Filters, extracts, and slices rows from a dataset into a target worksheet in ONE single vectorized call. Supports multi-condition filtering (e.g. Status == "Cancelled"), automatic target sheet creation, ERP pagination header stripping, column projection, and in-memory currency/metric aggregations (count and total sums grouped by Currency) with executive summary tables. Always use this instead of manually mutating cells in loops!',
    parameters: {
      type: 'object',
      properties: {
        sourceSheetName: {
          type: 'string',
          description: 'Source worksheet containing the dataset. Defaults to active worksheet.',
        },
        targetSheetName: {
          type: 'string',
          description:
            'Target worksheet name where matching rows will be extracted (e.g. "Cancelled"). Created automatically if it does not exist.',
        },
        filterConditions: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              column: {
                type: 'string',
                description: 'Column header name or letter (e.g. "Status" or "Order_Status" or "G").',
              },
              operator: {
                type: 'string',
                enum: [
                  '==',
                  '!=',
                  '>',
                  '<',
                  '>=',
                  '<=',
                  'contains',
                  'in',
                  'startsWith',
                  'endsWith',
                  'regex',
                  'isNull',
                  'notNull',
                ],
                description: 'Comparison operator. Default "==".',
              },
              value: {
                description: 'Value to compare against (e.g. "Cancelled", or ["Cancelled", "Refunded"]).',
              },
              matchCase: {
                type: 'boolean',
                description: 'Whether string comparisons are case-sensitive. Default false.',
              },
            },
            required: ['column', 'operator'],
          },
          description: 'Array of filter criteria to evaluate against rows.',
        },
        conditionLogic: {
          type: 'string',
          enum: ['AND', 'OR'],
          description: 'Combine multiple filter conditions with "AND" or "OR". Default "AND".',
        },
        columns: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Optional subset of column headers or letters to project into the target sheet. Defaults to all columns.',
        },
        action: {
          type: 'string',
          enum: ['copy_to_target', 'move_to_target', 'report_only'],
          description:
            'Action to perform: "copy_to_target" (default), "move_to_target" (deletes matching rows from source), or "report_only" (dry run preview).',
        },
        summarizeMetrics: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              groupBy: {
                type: 'string',
                description: 'Column to group summaries by (e.g. "Currency" or "Region").',
              },
              metricColumn: {
                type: 'string',
                description: 'Column to aggregate (e.g. "Total" or "Total Value" or "Quantity").',
              },
              derivedFormula: {
                type: 'string',
                description:
                  'Optional expression to derive metric if column does not exist (e.g. "Quantity * UnitPrice").',
              },
              aggregate: {
                type: 'string',
                enum: ['count', 'sum', 'average', 'min', 'max'],
                description: 'Aggregation function.',
              },
              alias: {
                type: 'string',
                description: 'Custom label for the metric column in the summary table.',
              },
            },
            required: ['aggregate'],
          },
          description:
            'Optional metrics to compute over the filtered dataset (e.g. count and sum of Total Value grouped by Currency).',
        },
        writeSummaryBlock: {
          type: 'boolean',
          description:
            'Whether to write an executive summary table on the target worksheet beside the extracted rows. Default true.',
        },
        stripSourceRepeatedHeaders: {
          type: 'boolean',
          description:
            'Whether to detect and skip repeating pagination header rows from ERP exports. Default true.',
        },
      },
      required: ['filterConditions'],
    },
    execute: executeFilterSliceDataset,
  },
  {
    name: 'standardize_dates',
    description:
      'Parses inconsistent date formats into uniform ISO YYYY-MM-DD (or other formats). Accurately resolves country-specific conventions (US month-first vs international day-first) per row, aligns new columns right after the date column in the true header row, and produces an audit Markdown table of unparseable row numbers.',
    parameters: {
      type: 'object',
      properties: {
        column: {
          type: 'string',
          description: 'Source column letter or header name (e.g. "Order Date" or "C").',
        },
        outputFormat: {
          type: 'string',
          enum: [
            'YYYY-MM-DD',
            'DD-MM-YYYY',
            'MM/DD/YYYY',
            'DD/MM/YYYY',
            'YYYY/MM/DD',
            'DD.MM.YYYY',
            'MMM DD, YYYY',
          ],
          description: 'Target date format. Default "YYYY-MM-DD".',
        },
        preferDayFirst: {
          type: 'boolean',
          description:
            'For ambiguous dates like "05/06/2023", whether to interpret as 5th June (true) or May 6th (false). Default true.',
        },
        invalidHandling: {
          type: 'string',
          enum: ['keep_original', 'set_empty', 'flag_invalid'],
          description: 'How to handle unparseable values. Default "keep_original".',
        },
        targetColumn: {
          type: 'string',
          description:
            'Optional destination column. If omitted, standardizes the source column in-place.',
        },
        countryColumn: {
          type: 'string',
          description:
            'Optional column specifying customer country (e.g. "Country" or "CustomerCountry"). Automatically evaluates US customers as month-first (MM/DD/YYYY) and all other countries as day-first (DD/MM/YYYY).',
        },
        insertPlacement: {
          type: 'string',
          enum: ['inplace', 'right_of_source', 'append'],
          description:
            'How to place the standardized date column: "right_of_source" inserts a new column right next to the date column with header in the true table header row; "inplace" overwrites; "append" places at the end of the sheet.',
        },
        newHeader: {
          type: 'string',
          description:
            'Header name for the new date column (e.g. "Order Date (ISO)").',
        },
        strictNoGuess: {
          type: 'boolean',
          description:
            'When true, never guesses 2-digit years or impossible calendar dates (e.g. Feb 30), leaving them blank and listing every unparseable row with its exact Excel row number.',
        },
        startRow: {
          type: 'number',
          description: '1-indexed start row. Default 2 (row 1 is header).',
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
      required: ['column'],
    },
    execute: executeStandardizeDates,
  },
  {
    name: 'clean_and_impute_currency',
    description:
      'Parses mixed international currency strings (e.g. "1.299,00 €", "¥15,800", "$100.50"), separates numeric amounts and clean ISO currency codes (EUR, JPY, USD), and derives/imputes blank prices from a reference product sheet (e.g. Products list price) converted at daily exchange rates (e.g. FX_Rates). Existing values are NEVER overwritten by reference prices. Executes in-engine in 1 vectorized call without writing fragile cross-sheet formulas.',
    parameters: {
      type: 'object',
      properties: {
        sheetName: {
          type: 'string',
          description: 'Name of the worksheet to clean (e.g. "Orders").',
        },
        sourceColumn: {
          type: 'string',
          description: 'Source column containing currency strings or blank values (e.g. "UnitPrice" or "D").',
        },
        targetColumn: {
          type: 'string',
          description:
            'Optional destination column for clean numeric amounts. If omitted, cleans sourceColumn in-place.',
        },
        currencyColumnName: {
          type: 'string',
          description:
            'Name of the currency code column (e.g. "Currency" or "CurrencyCode"). If not present in the sheet, creates a new column right next to the price column.',
        },
        imputeBlanks: {
          type: 'object',
          description:
            'Optional configuration to derive blank prices from reference product catalog and daily FX rates.',
          properties: {
            keyColumn: {
              type: 'string',
              description:
                'Key column in current sheet to join with reference catalog (e.g. "SKU" or "ProductID").',
            },
            lookupSheetName: {
              type: 'string',
              description: 'Name of worksheet containing reference list prices (e.g. "Products").',
            },
            lookupKeyColumn: {
              type: 'string',
              description: 'Key column in reference catalog (e.g. "SKU" or "ProductID").',
            },
            lookupPriceColumn: {
              type: 'string',
              description: 'List price column in reference catalog (e.g. "ListPrice" or "Price").',
            },
            dateColumn: {
              type: 'string',
              description:
                'Date column in current sheet used for FX rate matching (e.g. "OrderDate" or "Date").',
            },
            fxSheetName: {
              type: 'string',
              description: 'Name of worksheet containing daily FX rates (e.g. "FX_Rates").',
            },
            fxDateColumn: {
              type: 'string',
              description: 'Date column in FX rates sheet (e.g. "Date").',
            },
            baseCurrency: {
              type: 'string',
              description:
                'Base currency of reference list prices (e.g. "USD"). Defaults to "USD".',
            },
          },
          required: ['keyColumn', 'lookupSheetName', 'lookupKeyColumn', 'lookupPriceColumn'],
        },
        headerRowIndex: {
          type: 'number',
          description:
            'Optional 1-indexed table header row. If omitted, auto-detected even with report title banners.',
        },
        startRow: {
          type: 'number',
          description:
            'Optional 1-indexed data start row. Defaults to row after detected header.',
        },
        endRow: {
          type: 'number',
          description: 'Optional 1-indexed end row. Defaults to last occupied row.',
        },
      },
      required: ['sheetName', 'sourceColumn'],
    },
    execute: executeCleanAndImputeCurrency,
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
        sheetName: {
          type: 'string',
          description: 'Optional target worksheet name. Defaults to active sheet.',
        },
      },
      required: ['rangeA1'],
    },
    execute: executeMutateCells,
  },
  {
    name: 'profile_columns',
    description:
      'Performs deep data quality, entity-collision clustering (e.g. "North" vs "N", "N."), and statistical profiling on specified columns. Accepts column letters OR header names.',
    parameters: {
      type: 'object',
      properties: {
        columns: {
          type: 'array',
          items: { type: 'string' },
          description: 'Array of column letters or header names to profile (e.g. ["A", "Region", "Sales"]).',
        },
        startRow: {
          type: 'number',
          description: '1-indexed start row. Defaults to 1.',
        },
        endRow: {
          type: 'number',
          description: '1-indexed end row. Defaults to last occupied row.',
        },
        sheetName: {
          type: 'string',
          description: 'Optional worksheet name. Defaults to active sheet.',
        },
      },
      required: ['columns'],
    },
    execute: executeProfileColumns,
  },
  {
    name: 'modify_structure',
    description:
      'Alters sheet structure and geometry: auto-fit column widths, remove empty rows, freeze/unfreeze rows & columns, sort range in-place, insert/delete rows or columns, create/rename/delete sheets, and merge/unmerge cells.',
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
            'delete_sheet',
            'freeze_panes',
            'unfreeze_panes',
            'sort_range',
            'set_column_width',
          ],
          description: 'Structural action to execute.',
        },
        columns: {
          type: 'array',
          items: { type: 'string' },
          description: 'For auto_fit_columns: specific column letters or headers to fit.',
        },
        index: {
          type: 'number',
          description: '0-based row or column index for insertion/deletion/width setting, or number of rows to freeze for freeze_panes (default 1).',
        },
        count: {
          type: 'number',
          description: 'Number of rows or columns to insert or delete. Default 1.',
        },
        rangeA1: {
          type: 'string',
          description: 'Required for merge_range, unmerge_range, or sort_range (e.g. "A1:D50").',
        },
        sortColumn: {
          type: 'string',
          description: 'For sort_range: column letter or header name to sort by.',
        },
        sortAscending: {
          type: 'boolean',
          description: 'For sort_range: true for ascending (default), false for descending.',
        },
        sheetName: {
          type: 'string',
          description: 'Worksheet name to create, rename, delete, or target.',
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
      'Low-level single cell or range styling (background color, font color, bold, font size, text alignment). Supports cross-sheet targeting via sheetName.',
    parameters: {
      type: 'object',
      properties: {
        rangeA1: {
          type: 'string',
          description: 'A1 notation of range to style (e.g. "A1:F1").',
        },
        sheetName: {
          type: 'string',
          description: 'Optional target worksheet name. Defaults to active sheet.',
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
