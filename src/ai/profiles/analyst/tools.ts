import { AIToolDefinition } from '../../types';
import {
  executeAggregateMultilevelGroupby,
  executeGenerateCrosstabPivot,
  executeTemporalTrendAnalyzer,
  executeParetoAndSegmentation,
  executeStatisticalDeepDive,
  executeWhatIfScenarioModeler,
} from './executors';

export const ANALYST_TOOLS: AIToolDefinition[] = [
  {
    name: 'aggregate_multilevel_groupby',
    description:
      'Performs multidimensional hierarchical grouping and aggregations across one or more categorical dimensions. Simultaneously computes sums, averages, counts, distinct counts (unique_count), mins, and maxes. Supports sorting, Top-N limits, and automatic grand totals.',
    parameters: {
      type: 'object',
      properties: {
        groupByColumns: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Column letters or header names to group by (e.g. ["Region"] or ["Region", "ProductCategory"]).',
        },
        metrics: {
          type: 'array',
          description: 'Array of metrics to calculate for each group.',
          items: {
            type: 'object',
            properties: {
              column: { type: 'string', description: 'Target column letter or header name.' },
              agg: {
                type: 'string',
                enum: ['sum', 'average', 'count', 'unique_count', 'min', 'max'],
                description: 'Aggregation function.',
              },
              operation: {
                type: 'string',
                enum: ['sum', 'average', 'count', 'unique_count', 'min', 'max'],
                description: 'Alias for agg (aggregation function).',
              },
              alias: { type: 'string', description: 'Custom header title for the calculated metric column.' },
            },
            required: ['column'],
          },
        },
        autoNormalizeCategories: {
          type: 'boolean',
          description:
            'If true (default), automatically clusters and merges dirty category variants (e.g. "North" vs "N", "N."; "West" vs "W") before grouping.',
        },
        excludeSubtotalRows: {
          type: 'boolean',
          description:
            'If true (default), detects and excludes embedded Subtotal / Grand Total rows so totals are never double-counted.',
        },
        outputMode: {
          type: 'string',
          enum: ['values', 'formulas'],
          description:
            'Whether to write computed static values ("values", default) or live Excel =SUMIFS/=AVERAGEIFS/=COUNTIFS formulas ("formulas").',
        },
        sortByMetricIndex: {
          type: 'number',
          description: '0-based index of the metric to sort by (e.g. 0 for first metric).',
        },
        sortDirection: {
          type: 'string',
          enum: ['asc', 'desc'],
          description: 'Sort direction. Default "desc".',
        },
        topN: {
          type: 'number',
          description: 'Optional row limit to return (e.g. Top 10 categories).',
        },
        includeGrandTotal: {
          type: 'boolean',
          description: 'Whether to add an executive Grand Total summary row at the bottom. Default true.',
        },
        sourceSheetName: {
          type: 'string',
          description: 'Source worksheet name. Defaults to active worksheet.',
        },
        targetSheetName: {
          type: 'string',
          description: 'Destination worksheet name for the summary table. Defaults to "{sheet}_GroupBy".',
        },
        startRow: {
          type: 'number',
          description: '1-indexed data start row. Default 2.',
        },
        endRow: {
          type: 'number',
          description: '1-indexed data end row. Defaults to last occupied row.',
        },
      },
      required: ['groupByColumns', 'metrics'],
    },
    execute: executeAggregateMultilevelGroupby,
  },
  {
    name: 'generate_crosstab_pivot',
    description:
      'Generates a full 2-dimensional cross-tabulation pivot matrix (e.g. Rows = Region, Columns = ProductCategory, Values = Sum of NetTotal). Computes row totals, column totals, grand totals, and supports normalized ratios (% of row, % of col, % of grand total).',
    parameters: {
      type: 'object',
      properties: {
        rowDimension: {
          type: 'string',
          description: 'Column letter or header for the vertical row dimension (e.g. "Region" or "D").',
        },
        colDimension: {
          type: 'string',
          description: 'Column letter or header for the horizontal column dimension (e.g. "ProductCategory" or "E").',
        },
        valColumn: {
          type: 'string',
          description: 'Column letter or header containing numeric values to aggregate (e.g. "NetTotal" or "P").',
        },
        valAgg: {
          type: 'string',
          enum: ['sum', 'count', 'average'],
          description: 'Matrix value aggregation function. Default "sum".',
        },
        displayMode: {
          type: 'string',
          enum: ['raw', 'percent_of_row', 'percent_of_col', 'percent_of_grand_total'],
          description: 'How to display numbers: "raw" numbers, or normalized % shares.',
        },
        emptyCellValue: {
          description: 'Fallback value for empty matrix intersections (e.g. 0 or "-"). Default 0.',
        },
        includeRowTotals: {
          type: 'boolean',
          description: 'Whether to calculate rightmost Total column. Default true.',
        },
        includeColTotals: {
          type: 'boolean',
          description: 'Whether to calculate bottom Total row. Default true.',
        },
        sourceSheetName: {
          type: 'string',
          description: 'Source worksheet name. Defaults to active worksheet.',
        },
        targetSheetName: {
          type: 'string',
          description: 'Target worksheet name. Defaults to "{sheet}_Pivot".',
        },
        startRow: {
          type: 'number',
          description: '1-indexed start row. Default 2.',
        },
        endRow: {
          type: 'number',
          description: '1-indexed end row. Defaults to last occupied row.',
        },
      },
      required: ['rowDimension', 'colDimension', 'valColumn'],
    },
    execute: executeGenerateCrosstabPivot,
  },
  {
    name: 'temporal_trend_analyzer',
    description:
      'Time-series and velocity analytics on date-stamped datasets. Groups dates by month, quarter, or year, and calculates Period-over-Period growth velocity (% change), volume, averages, and trailing rolling moving averages.',
    parameters: {
      type: 'object',
      properties: {
        dateColumn: {
          type: 'string',
          description: 'Date column letter or header name (e.g. "OrderDate" or "I").',
        },
        measureColumn: {
          type: 'string',
          description: 'Numeric metric column letter or header name (e.g. "NetTotal" or "P").',
        },
        interval: {
          type: 'string',
          enum: ['month', 'quarter', 'year'],
          description: 'Time bucket interval. Default "month".',
        },
        calculateGrowth: {
          type: 'boolean',
          description: 'Whether to compute Period-over-Period percentage growth. Default true.',
        },
        rollingWindow: {
          type: 'number',
          description: 'Number of periods for moving average (default 3).',
        },
        sourceSheetName: {
          type: 'string',
          description: 'Source worksheet name.',
        },
        targetSheetName: {
          type: 'string',
          description: 'Target worksheet name. Defaults to "{sheet}_Trends".',
        },
        startRow: {
          type: 'number',
          description: '1-indexed start row. Default 2.',
        },
        endRow: {
          type: 'number',
          description: '1-indexed end row. Defaults to last occupied row.',
        },
      },
      required: ['dateColumn', 'measureColumn'],
    },
    execute: executeTemporalTrendAnalyzer,
  },
  {
    name: 'pareto_and_segmentation',
    description:
      'Performs 80/20 Pareto analysis and customer/product tier segmentation. Computes cumulative percentage distributions, identifies the vital few driving 80% of revenue, and classifies records into Class A/B/C or custom tiers (Platinum, Gold, Silver, Bronze).',
    parameters: {
      type: 'object',
      properties: {
        entityColumn: {
          type: 'string',
          description: 'Entity column letter or header to rank (e.g. "CustomerName" or "ProductName").',
        },
        valueColumn: {
          type: 'string',
          description: 'Value metric column letter or header (e.g. "NetTotal" or "Quantity").',
        },
        analysisType: {
          type: 'string',
          enum: ['pareto_80_20', 'customer_tiering'],
          description: 'Type of classification to generate. Default "pareto_80_20".',
        },
        tierThresholds: {
          type: 'array',
          description: 'Custom threshold tiers if analysisType is "customer_tiering".',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string' },
              minVal: { type: 'number' },
            },
            required: ['name', 'minVal'],
          },
        },
        sourceSheetName: {
          type: 'string',
          description: 'Source worksheet name.',
        },
        targetSheetName: {
          type: 'string',
          description: 'Target worksheet name. Defaults to "{sheet}_Pareto".',
        },
        startRow: {
          type: 'number',
          description: '1-indexed start row. Default 2.',
        },
        endRow: {
          type: 'number',
          description: '1-indexed end row. Defaults to last occupied row.',
        },
      },
      required: ['entityColumn', 'valueColumn'],
    },
    execute: executeParetoAndSegmentation,
  },
  {
    name: 'statistical_deep_dive',
    description:
      'Deep statistical analysis across numeric columns: computes descriptive stats, percentiles (p10, p25, median p50, p75, p90, p99), Interquartile Range (IQR), flags outliers using the Tukey Boxplot rule, and computes a pairwise Pearson correlation matrix between variables.',
    parameters: {
      type: 'object',
      properties: {
        columns: {
          type: 'array',
          items: { type: 'string' },
          description: 'Array of numerical column letters or headers to analyze (e.g. ["UnitPrice", "Discount", "NetTotal"]).',
        },
        calculateCorrelation: {
          type: 'boolean',
          description: 'Whether to compute pairwise Pearson correlation matrix between columns. Default true.',
        },
        outlierThresholdIqr: {
          type: 'number',
          description: 'IQR multiplier for outlier detection (default 1.5).',
        },
        sourceSheetName: {
          type: 'string',
          description: 'Source worksheet name.',
        },
        targetSheetName: {
          type: 'string',
          description: 'Target worksheet name. Defaults to "{sheet}_Stats".',
        },
        startRow: {
          type: 'number',
          description: '1-indexed start row. Default 2.',
        },
        endRow: {
          type: 'number',
          description: '1-indexed end row. Defaults to last occupied row.',
        },
      },
      required: ['columns'],
    },
    execute: executeStatisticalDeepDive,
  },
  {
    name: 'what_if_scenario_modeler',
    description:
      'Constructs sensitivity and what-if multi-scenario forecasting models. Evaluates potential changes (e.g. Sales -10%, ShippingCost +15%) against current Base Case actuals and outputs a comparative delta variance table.',
    parameters: {
      type: 'object',
      properties: {
        scenarios: {
          type: 'array',
          description: 'List of business scenarios to compare against the Base Case.',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string', description: 'Scenario title (e.g. "Bull Case", "Supply Chain Shock").' },
              assumptions: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    column: { type: 'string', description: 'Target column header or letter.' },
                    percentChange: { type: 'number', description: 'Percentage change to model (e.g. -10 for -10%, +15 for +15%).' },
                  },
                  required: ['column', 'percentChange'],
                },
              },
            },
            required: ['name', 'assumptions'],
          },
        },
        baseMetricColumn: {
          type: 'string',
          description: 'Primary financial metric column to model (e.g. "NetTotal" or "P").',
        },
        sourceSheetName: {
          type: 'string',
          description: 'Source worksheet name.',
        },
        targetSheetName: {
          type: 'string',
          description: 'Destination worksheet name. Defaults to "{sheet}_Scenarios".',
        },
        startRow: {
          type: 'number',
          description: '1-indexed start row. Default 2.',
        },
        endRow: {
          type: 'number',
          description: '1-indexed end row. Defaults to last occupied row.',
        },
      },
      required: ['scenarios', 'baseMetricColumn'],
    },
    execute: executeWhatIfScenarioModeler,
  },
];
