import { AIToolDefinition } from '../../types';
import {
  executeGenerateChart,
  executeApplyColorScale,
  executeAddDataBars,
  executeCreateThresholdRule,
  executeRenderSparklineStrip,
  executeClearVisualFormatting,
} from './executors';

export const VISUALIZER_TOOLS: AIToolDefinition[] = [
  {
    name: 'generate_chart',
    description:
      'Generates an interactive, high-fidelity visualization card (SVG Chart) linked to spreadsheet data. Supports 15 chart types (column, horizontal bar, line, area, donut, combo_dual_axis, waterfall, scatter, bubble, pareto, histogram, box_plot, funnel, radar, treemap) or "auto" mode where AI analyzes dimensions and metrics to select the optimal visualization.',
    parameters: {
      type: 'object',
      properties: {
        range: {
          type: 'string',
          description: 'Data range to visualize, including headers (e.g. "A1:E12" or "A:D").',
        },
        chartType: {
          type: 'string',
          enum: [
            'auto',
            'column',
            'bar',
            'line',
            'area',
            'donut',
            'combo_dual_axis',
            'waterfall',
            'scatter',
            'bubble',
            'pareto',
            'histogram',
            'box_plot',
            'funnel',
            'radar',
            'treemap',
          ],
          description:
            'Target chart type, or "auto" to let the AI recommendation engine pick the optimal visual representation.',
        },
        xAxisColumn: {
          type: 'string',
          description:
            'Column letter or header name for the X-axis / primary categorical dimension (e.g. "Region" or "A").',
        },
        yAxisColumns: {
          type: 'array',
          items: { type: 'string' },
          description:
            'One or more column letters or header names for primary metrics (e.g. ["NetTotal"] or ["B", "C"]).',
        },
        secondaryYAxisColumn: {
          type: 'string',
          description:
            'Optional column letter or header for the secondary Y-axis in combo_dual_axis charts (e.g. "Margin%" or "Discount").',
        },
        title: {
          type: 'string',
          description: 'Executive title for the chart (e.g. "Monthly Revenue & Margin Trend").',
        },
        palette: {
          type: 'string',
          enum: ['slate_emerald', 'monochrome_zinc', 'ocean_blue', 'diverging_bipolar'],
          description: 'Color theme palette. Default "slate_emerald".',
        },
        showDataLabels: {
          type: 'boolean',
          description: 'Whether to show value labels directly on data points or bars. Default true.',
        },
        showLegend: {
          type: 'boolean',
          description: 'Whether to display the series legend. Default true.',
        },
        aggregation: {
          type: 'string',
          enum: ['sum', 'average', 'count', 'none'],
          description:
            'How to aggregate repeated category rows before plotting. Defaults to "sum" for volume/revenue and "average" for rates/margins/prices.',
        },
        sheetName: {
          type: 'string',
          description: 'Worksheet name. Defaults to active worksheet.',
        },
      },
      required: ['range'],
    },
    execute: executeGenerateChart,
  },
  {
    name: 'apply_color_scale',
    description:
      'Applies continuous, quantile, or diverging color heatmaps directly to cells in a range. Automatically computes min/mid/max thresholds, supports winsorization to prevent outlier distortion, and automatically ensures WCAG font contrast readability.',
    parameters: {
      type: 'object',
      properties: {
        range: {
          type: 'string',
          description: 'Target range to format (e.g. "D2:D100" or "B2:G20").',
        },
        scaleType: {
          type: 'string',
          enum: ['2_color', '3_color', 'quantile_percentile', 'diverging_zero_centered'],
          description:
            'Interpolation mode: "2_color" (min to max), "3_color" (min-mid-max), "quantile_percentile" (P10-P50-P90), or "diverging_zero_centered" (bipolar centered at 0). Default "3_color".',
        },
        palette: {
          type: 'string',
          enum: ['emerald_to_zinc', 'slate_neutral', 'red_amber_emerald', 'blue_to_slate'],
          description:
            'Color palette: "emerald_to_zinc" (performance), "red_amber_emerald" (risk/SLA), "slate_neutral" (subtle density), "blue_to_slate" (financial).',
        },
        clampOutliers: {
          type: 'boolean',
          description:
            'If true, winsorizes values at P05 and P95 so extreme anomalies do not compress the rest of the gradient. Default true.',
        },
      },
      required: ['range'],
    },
    execute: executeApplyColorScale,
  },
  {
    name: 'add_data_bars',
    description:
      'Applies proportional in-cell horizontal data bars to visualize numeric magnitudes directly inside spreadsheet cells. Supports zero-axis splitting for negative values.',
    parameters: {
      type: 'object',
      properties: {
        range: {
          type: 'string',
          description: 'Target numeric column range (e.g. "F2:F50").',
        },
        barColor: {
          type: 'string',
          description: 'Hex color for positive data bars (default "#10b981" - emerald, or "#3b82f6" - blue).',
        },
        negativeBarColor: {
          type: 'string',
          description: 'Hex color for negative values (default "#ef4444" - red).',
        },
        axisPosition: {
          type: 'string',
          enum: ['automatic', 'cell_midpoint', 'none'],
          description: 'Position of the zero axis for bipolar values. Default "automatic".',
        },
      },
      required: ['range'],
    },
    execute: executeAddDataBars,
  },
  {
    name: 'create_threshold_rule',
    description:
      'Applies conditional formatting rules to highlight cells based on mathematical thresholds, status text, or percentiles with executive soft badges.',
    parameters: {
      type: 'object',
      properties: {
        range: {
          type: 'string',
          description: 'Target cell range (e.g. "E2:E50" or "M2:M100").',
        },
        condition: {
          type: 'string',
          enum: [
            'greater_than',
            'less_than',
            'between',
            'equal_to',
            'contains_text',
            'top_n_percent',
            'below_average',
          ],
          description: 'Condition operator.',
        },
        thresholdValue: {
          description: 'Threshold boundary value or match text string.',
        },
        secondaryThresholdValue: {
          description: 'Upper boundary value if condition is "between".',
        },
        badgeStyle: {
          type: 'string',
          enum: [
            'soft_alert_red',
            'soft_warning_amber',
            'soft_success_emerald',
            'subtle_highlight_zinc',
            'subtle_accent_blue',
          ],
          description: 'Visual badge style for matching cells. Default "soft_alert_red".',
        },
      },
      required: ['range', 'condition', 'thresholdValue'],
    },
    execute: executeCreateThresholdRule,
  },
  {
    name: 'render_sparkline_strip',
    description:
      'Computes normalized in-cell trend trajectory characters (Unicode sparklines ▂▃▅▇█) across multi-period columns (e.g. Jan..Dec or Q1..Q4) and injects them into a target KPI column.',
    parameters: {
      type: 'object',
      properties: {
        sourceRange: {
          type: 'string',
          description: 'Horizontal period range for the rows (e.g. "B2:M20" or "C2:F15").',
        },
        targetColumn: {
          type: 'string',
          description: 'Column letter to write the sparkline vectors into (e.g. "N" or "G").',
        },
        sparklineType: {
          type: 'string',
          enum: ['bars', 'blocks', 'dots'],
          description: 'Sparkline glyph style: "bars" ( ▂▃▅▇█), "blocks" (░▒▓█), or "dots" (·•●). Default "bars".',
        },
        headerTitle: {
          type: 'string',
          description: 'Header text for the target column. Default "Trend".',
        },
      },
      required: ['sourceRange', 'targetColumn'],
    },
    execute: executeRenderSparklineStrip,
  },
  {
    name: 'clear_visual_formatting',
    description:
      'Surgically clears in-cell heatmaps, data bars, or threshold badge styling from a target range without removing numbers, formulas, borders, or table structure.',
    parameters: {
      type: 'object',
      properties: {
        range: {
          type: 'string',
          description: 'Target range to clear (e.g. "A1:Z100").',
        },
        target: {
          type: 'string',
          enum: ['all', 'color_scales', 'threshold_rules', 'data_bars'],
          description: 'Visual element layer to reset. Default "all".',
        },
      },
      required: ['range'],
    },
    execute: executeClearVisualFormatting,
  },
];
