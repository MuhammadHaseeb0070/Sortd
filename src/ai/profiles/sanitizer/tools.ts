import { AIToolDefinition } from '../../types';
import {
  executeSynthesizeColumns,
  executeSplitColumn,
  executeDeduplicateDataset,
  executeRemoveRepeatedHeaders,
  executeFilterSliceDataset,
  executeImputeData,
  executeReshapeDataset,
  executeStandardizeDates,
  executeInspectAndClusterCategories,
  executeCleanAndImputeCurrency,
} from './executors';

export const SANITIZER_TOOLS: AIToolDefinition[] = [
  {
    name: 'synthesize_columns',
    description:
      'Merges, combines, or computes a new column from multiple source columns. Supports basic delimiter joins, string templates (e.g. "{First} {Last}"), and advanced JavaScript expressions or conditional IF/THEN rules. Operates in-engine without writing fragile Excel formulas.',
    parameters: {
      type: 'object',
      properties: {
        sourceColumns: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Array of source column letters or header names (e.g. ["A", "B"] or ["First Name", "Last Name"]).',
        },
        newHeader: {
          type: 'string',
          description: 'Header title for the synthesized column (e.g. "Full Name" or "Contact_Info").',
        },
        targetColumn: {
          type: 'string',
          description:
            'Target column letter where output will be placed. If omitted, placed directly after rightmost source column.',
        },
        insertMode: {
          type: 'string',
          enum: ['insert_new', 'overwrite', 'append'],
          description:
            'How to place the column: "insert_new" shifts existing columns right, "overwrite" replaces targetColumn, "append" adds to the end of the sheet.',
        },
        template: {
          type: 'string',
          description:
            'Basic mode: template string with column placeholders, e.g. "{First Name} {Last Name}" or "{City}, {State} {Zip}".',
        },
        delimiter: {
          type: 'string',
          description:
            'Basic mode: string delimiter to join non-empty source columns with (e.g. " " or ", "). Default " ".',
        },
        skipEmpty: {
          type: 'boolean',
          description:
            'Whether to omit null/empty source cells so no double spaces or trailing commas appear. Default true.',
        },
        expression: {
          type: 'string',
          description:
            'Advanced mode: safe JavaScript row-level expression. Use col("Header") or col("A") and row. E.g. "col(\'Middle\') ? col(\'First\') + \' \' + col(\'Middle\') + \' \' + col(\'Last\') : col(\'First\') + \' \' + col(\'Last\')".',
        },
        rules: {
          type: 'array',
          description:
            'Advanced mode: list of conditional rules evaluated in order. Each rule has a "condition" expression and either an "expression" or "template".',
          items: {
            type: 'object',
            properties: {
              condition: { type: 'string', description: 'Boolean expression (e.g. "col(\'Country\') == \'US\'").' },
              template: { type: 'string', description: 'Template to apply if condition is met.' },
              expression: { type: 'string', description: 'Expression to compute if condition is met.' },
            },
            required: ['condition'],
          },
        },
        deleteSourceColumns: {
          type: 'boolean',
          description:
            'Whether to drop the original source columns after successful synthesis. Default false.',
        },
        startRow: {
          type: 'number',
          description: '1-indexed start row for data. Default 2 (row 1 is header).',
        },
        endRow: {
          type: 'number',
          description: '1-indexed end row. Defaults to last occupied row.',
        },
        sheetName: {
          type: 'string',
          description: 'Worksheet name. Defaults to active worksheet.',
        },
        targetSheetName: {
          type: 'string',
          description: 'Optional destination worksheet. If provided, writes the synthesized column or table there.',
        },
      },
      required: ['sourceColumns', 'newHeader'],
    },
    execute: executeSynthesizeColumns,
  },
  {
    name: 'split_column',
    description:
      'Splits composite text columns into multiple separate columns. Supports basic delimiters (space, comma, dash), fixed character widths, or regular expressions with named/numbered capture groups. Automatically generates new headers and writes clean static values.',
    parameters: {
      type: 'object',
      properties: {
        sourceColumn: {
          type: 'string',
          description: 'Column letter or header name to split (e.g. "C" or "Full Name").',
        },
        newHeaders: {
          type: 'array',
          items: { type: 'string' },
          description: 'Array of new column header titles to create (e.g. ["First Name", "Last Name"]).',
        },
        splitBy: {
          type: 'string',
          enum: ['delimiter', 'fixed_width', 'regex'],
          description: 'Splitting method. Default "delimiter".',
        },
        delimiter: {
          type: 'string',
          description: 'Delimiter string for splitBy "delimiter" (e.g. " ", ",", "-", "|"). Default " ".',
        },
        widths: {
          type: 'array',
          items: { type: 'number' },
          description: 'Character segment lengths for splitBy "fixed_width" (e.g. [5, 10, 20]).',
        },
        regexPattern: {
          type: 'string',
          description:
            'Regular expression pattern with capture groups for splitBy "regex". Can use named groups like "(?<first>\\w+)\\s+(?<last>\\w+)".',
        },
        maxSplits: {
          type: 'number',
          description: 'Maximum number of splits (e.g. 2 for splitting on the first delimiter only).',
        },
        trimParts: {
          type: 'boolean',
          description: 'Whether to strip whitespace from each split token. Default true.',
        },
        fallbackMode: {
          type: 'string',
          enum: ['first_column', 'last_column', 'null'],
          description:
            'How to handle cells that do not match the delimiter/pattern. Default "first_column".',
        },
        insertMode: {
          type: 'string',
          enum: ['adjacent', 'overwrite', 'target_columns'],
          description:
            'Placement of new columns. "adjacent" inserts columns right after source; "overwrite" replaces source; "target_columns" maps to specific column letters.',
        },
        targetColumns: {
          type: 'array',
          items: { type: 'string' },
          description: 'Specific column letters if insertMode is "target_columns".',
        },
        deleteSourceColumn: {
          type: 'boolean',
          description: 'Whether to delete the original source column after splitting. Default false.',
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
      required: ['sourceColumn', 'newHeaders'],
    },
    execute: executeSplitColumn,
  },
  {
    name: 'deduplicate_dataset',
    description:
      'High-performance row-level deduplication and record conflict detection engine. Supports exact matching, fuzzy similarity matching, conflict detection (same keys but different attribute values, e.g. same Order & SKU but different Quantity), intelligent tie-breakers, coalescing, repeating pagination header cleanup, and reporting/quarantine/deletion actions.',
    parameters: {
      type: 'object',
      properties: {
        keyColumns: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Column letters or header names that define uniqueness (e.g. ["Email"] or ["OrderID", "SKU"]). If omitted, uses all occupied columns.',
        },
        conflictColumns: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Optional columns to evaluate for conflict/inconsistency. When specified, only groups where these columns have DIFFERING values are reported (e.g. keyColumns: ["OrderID", "SKU"], conflictColumns: ["Quantity"]). Conflicting rows are never deleted.',
        },
        removeExactDuplicatesFirst: {
          type: 'boolean',
          description:
            'When true alongside conflictColumns, removes 100%-identical full-row duplicates and repeated headers in-place FIRST, then reports the remaining conflicting groups with their updated row numbers in a single pass!',
        },
        matchMode: {
          type: 'string',
          enum: ['exact', 'fuzzy'],
          description: 'Matching mode. "fuzzy" uses Levenshtein similarity to catch typos. Default "exact".',
        },
        fuzzyThreshold: {
          type: 'number',
          description: 'Similarity threshold between 0.0 and 1.0 when matchMode is "fuzzy". Default 0.85.',
        },
        strategy: {
          type: 'string',
          enum: ['keep_first', 'keep_last'],
          description: 'Default resolution strategy when duplicate rows are found. Default "keep_first".',
        },
        tieBreaker: {
          type: 'object',
          description: 'Advanced resolution rule to determine the winning row among duplicates.',
          properties: {
            column: { type: 'string', description: 'Column to evaluate (e.g. "Updated_At" or "Completeness").' },
            rule: {
              type: 'string',
              enum: ['max', 'min', 'most_complete'],
              description:
                '"max" keeps highest value; "min" keeps lowest; "most_complete" keeps the row with the fewest empty cells.',
            },
          },
          required: ['rule'],
        },
        coalesceDuplicates: {
          type: 'boolean',
          description:
            'If true, merges non-null values from duplicate rows into the winning row before removing duplicates.',
        },
        action: {
          type: 'string',
          enum: ['delete_rows', 'quarantine_to_sheet', 'flag_column', 'report_only'],
          description:
            '"delete_rows" removes duplicates in-place; "quarantine_to_sheet" moves duplicates to a separate review sheet; "flag_column" adds an Is_Duplicate column; "report_only" returns full duplicate/conflict details in the receipt without modifying or deleting any rows.',
        },
        flagColumnHeader: {
          type: 'string',
          description: 'Column header for action "flag_column". Default "Is_Duplicate".',
        },
        targetSheetName: {
          type: 'string',
          description: 'Custom worksheet name for action "quarantine_to_sheet". Defaults to "{sheet}_Duplicates".',
        },
        stripRepeatedHeaders: {
          type: 'boolean',
          description:
            'When true (default), automatically detects and removes repeating pagination/export header rows matching row 1 before evaluating duplicates.',
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
    },
    execute: executeDeduplicateDataset,
  },
  {
    name: 'remove_repeated_headers',
    description:
      'Fast, vectorized cleanup of repeating pagination or multi-page export header rows (e.g. "OrderID", "Date" re-appearing at rows 500, 1000). Detects rows matching the top header and deletes them in-place in 1 call.',
    parameters: {
      type: 'object',
      properties: {
        sheetName: {
          type: 'string',
          description: 'Worksheet name. Defaults to active worksheet.',
        },
      },
    },
    execute: executeRemoveRepeatedHeaders,
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
    name: 'impute_data',
    description:
      'Fills missing values and holes in tabular data. Supports forward-fill (ffill for merged cell exports), backward-fill (bfill), static fallbacks, linear mathematical interpolation, and group-by category imputation.',
    parameters: {
      type: 'object',
      properties: {
        columns: {
          type: 'array',
          items: { type: 'string' },
          description: 'Column letters or header names to impute (e.g. ["B", "C"] or ["Category", "Price"]).',
        },
        method: {
          type: 'string',
          enum: [
            'forward_fill',
            'backward_fill',
            'constant',
            'linear_interpolation',
            'group_by',
            'expression',
          ],
          description: 'Imputation algorithm to use. Default "forward_fill".',
        },
        constantValue: {
          description: 'Fallback value when method is "constant" (e.g. 0, "N/A", "Unknown"). Default 0.',
        },
        groupByColumn: {
          type: 'string',
          description:
            'Grouping column when method is "group_by" (e.g. "Department" or "Region"). Fills missing values within each category.',
        },
        groupAgg: {
          type: 'string',
          enum: ['forward_fill', 'mean', 'mode'],
          description: 'Aggregation strategy when method is "group_by". Default "forward_fill".',
        },
        expression: {
          type: 'string',
          description: 'Safe JavaScript expression for method "expression" evaluated on blank cells.',
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
      required: ['columns'],
    },
    execute: executeImputeData,
  },
  {
    name: 'reshape_dataset',
    description:
      'Unpivots (melts) wide matrix/cross-tab tables into clean normalized relational records. Solves the spreadsheet problem where months or quarters are spread across multiple columns (e.g. Store | Jan | Feb | Mar -> Store | Month | Sales).',
    parameters: {
      type: 'object',
      properties: {
        idColumns: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Column letters or headers that serve as row identifiers (e.g. ["Store", "Region"]).',
        },
        valueColumns: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Columns to unpivot into rows (e.g. ["Jan", "Feb", "Mar", "Apr"] or ["Q1", "Q2", "Q3", "Q4"]).',
        },
        varColumnName: {
          type: 'string',
          description: 'Header name for the melted attribute column (e.g. "Month" or "Quarter"). Default "Variable".',
        },
        valColumnName: {
          type: 'string',
          description: 'Header name for the melted measurement column (e.g. "Revenue" or "Units"). Default "Value".',
        },
        targetSheetName: {
          type: 'string',
          description:
            'Destination worksheet name (e.g. "Normalized_Sales"). If omitted, creates "{sheet}_Reshaped".',
        },
        ignoreEmpty: {
          type: 'boolean',
          description: 'Whether to skip rows with null or empty values in valueColumns. Default true.',
        },
        startRow: {
          type: 'number',
          description: '1-indexed start row. Default 2.',
        },
        endRow: {
          type: 'number',
          description: '1-indexed end row. Defaults to last occupied row.',
        },
        sourceSheetName: {
          type: 'string',
          description: 'Source worksheet name. Defaults to active worksheet.',
        },
      },
      required: ['idColumns', 'valueColumns'],
    },
    execute: executeReshapeDataset,
  },
  {
    name: 'standardize_dates',
    description:
      'Normalizes and standardizes heterogenous or mixed date columns (e.g. Excel serials 44941, ISO "2023-01-15", US "01/15/2023", EU "15-01-2023", textual "Jan 15, 2023") into a uniform format like "DD-MM-YYYY" or "YYYY-MM-DD". Executes in-engine in 2ms without circular formulas or reading thousands of rows into context.',
    parameters: {
      type: 'object',
      properties: {
        column: {
          type: 'string',
          description: 'Target column letter or header name to standardize (e.g. "I" or "OrderDate").',
        },
        outputFormat: {
          type: 'string',
          enum: [
            'DD-MM-YYYY',
            'YYYY-MM-DD',
            'MM/DD/YYYY',
            'DD/MM/YYYY',
            'YYYY/MM/DD',
            'DD.MM.YYYY',
            'MMM DD, YYYY',
          ],
          description: 'Target date format. Default "DD-MM-YYYY".',
        },
        preferDayFirst: {
          type: 'boolean',
          description: 'For ambiguous dates like "05/06/2023", whether to interpret as 5th June (true) or May 6th (false). Default true.',
        },
        invalidHandling: {
          type: 'string',
          enum: ['keep_original', 'set_empty', 'flag_invalid'],
          description: 'How to handle unparseable values. Default "keep_original".',
        },
        targetColumn: {
          type: 'string',
          description: 'Optional destination column. If omitted, standardizes the source column in-place.',
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
    name: 'inspect_and_cluster_categories',
    description:
      'Scans categorical columns (e.g. Region, Department, Status, Vendor) for dirty variants, abbreviations, punctuation noise, and Jaro-Winkler typos (such as "North" vs "N", "N.", "north", or "West" vs "W"). Returns exact canonical clusters and optionally normalizes all dirty variants in-place in 1 shot.',
    parameters: {
      type: 'object',
      properties: {
        columns: {
          type: 'array',
          items: { type: 'string' },
          description: 'Array of column letters or header names to inspect/normalize (e.g. ["Region", "Status"]).',
        },
        applyNormalization: {
          type: 'boolean',
          description: 'If true (default), automatically replaces dirty variants in-place with their canonical entity name.',
        },
        customSynonyms: {
          type: 'object',
          description: 'Optional custom mapping of dirty variant -> canonical label (e.g. {"NYC": "New York"}).',
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
      required: ['columns'],
    },
    execute: executeInspectAndClusterCategories,
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
];
