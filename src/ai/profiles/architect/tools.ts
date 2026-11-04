import { AIToolDefinition } from '../../types';
import {
  executeFormatNumbers,
  executeStyleTableHierarchy,
  executeCreateKpiCardBlock,
  executeApplyExecutiveTheme,
  executeScaffoldDashboardLayout,
} from './executors';

export const ARCHITECT_TOOLS: AIToolDefinition[] = [
  {
    name: 'format_numbers',
    description:
      'Applies professional spreadsheet number formatting masks without converting numbers to strings. Supports currency ($1,234.56), percentage (12.5%), accounting format with negative parentheses, integers with commas, and compact notation ($1.5M).',
    parameters: {
      type: 'object',
      properties: {
        rangeA1: {
          type: 'string',
          description: 'Target range to format (e.g. "H2:H669", "D2:D100").',
        },
        formatType: {
          type: 'string',
          enum: [
            'currency',
            'currency_round',
            'percentage',
            'percentage_round',
            'accounting',
            'integer',
            'decimal',
            'compact_thousands',
            'compact_millions',
            'date_iso',
            'date_eu',
            'custom',
          ],
          description: 'Semantic number format to apply.',
        },
        customPattern: {
          type: 'string',
          description: 'Custom Excel format mask if formatType is "custom".',
        },
        sheetName: {
          type: 'string',
          description: 'Worksheet name. Defaults to active worksheet.',
        },
      },
      required: ['rangeA1', 'formatType'],
    },
    execute: executeFormatNumbers,
  },
  {
    name: 'style_table_hierarchy',
    description:
      'Instantly turns an unformatted data block into a publication-ready executive table. Automatically styles the header row with high-contrast typography, applies alternating zebra striping across data rows, styles summary/total rows with accounting borders, and auto-fits columns.',
    parameters: {
      type: 'object',
      properties: {
        rangeA1: {
          type: 'string',
          description: 'Table range (e.g. "A1:Q669"). If omitted, uses all occupied sheet bounds.',
        },
        theme: {
          type: 'string',
          enum: ['slate_monochrome', 'emerald_capital', 'midnight_navy', 'charcoal_ledger'],
          description: 'Executive theme palette to apply. Default "slate_monochrome".',
        },
        zebraStriping: {
          type: 'boolean',
          description: 'Whether to apply alternating row shading. Default true.',
        },
        hasTotalRow: {
          type: 'boolean',
          description: 'Whether the last row is a Total / Summary row that should receive bold accounting styling.',
        },
        totalRowIndex: {
          type: 'number',
          description: '1-indexed row number of total row if not the last row.',
        },
        autoFitColumns: {
          type: 'boolean',
          description: 'Whether to auto-fit column widths to content length. Default true.',
        },
        sheetName: {
          type: 'string',
          description: 'Worksheet name.',
        },
      },
    },
    execute: executeStyleTableHierarchy,
  },
  {
    name: 'create_kpi_card_block',
    description:
      'Constructs executive metric scorecard tiles (e.g. Total Revenue, Active Orders, Average Margin) with large bold numbers, uppercase category labels, and colored trend badges (+12.4% MoM).',
    parameters: {
      type: 'object',
      properties: {
        cards: {
          type: 'array',
          description: 'List of metric cards to construct.',
          items: {
            type: 'object',
            properties: {
              label: { type: 'string', description: 'Metric title (e.g. "TOTAL REVENUE", "CONVERSION RATE").' },
              value: { type: ['string', 'number'], description: 'Primary metric value (e.g. "$1,482,900" or "84.2%").' },
              delta: { type: 'string', description: 'Comparison delta (e.g. "+12.4% MoM", "-3.2% vs target").' },
              trend: { type: 'string', enum: ['positive', 'negative', 'neutral'], description: 'Trend indicator color.' },
            },
            required: ['label', 'value'],
          },
        },
        startCell: {
          type: 'string',
          description: 'Top-left origin cell for the scorecard row (e.g. "A2" or "A4"). Default "A2".',
        },
        cardWidthCols: {
          type: 'number',
          description: 'Number of columns wide each card should span. Default 3.',
        },
        theme: {
          type: 'string',
          enum: ['slate_monochrome', 'emerald_capital', 'midnight_navy', 'charcoal_ledger'],
          description: 'Visual theme. Default "slate_monochrome".',
        },
        sheetName: {
          type: 'string',
          description: 'Worksheet name.',
        },
      },
      required: ['cards'],
    },
    execute: executeCreateKpiCardBlock,
  },
  {
    name: 'apply_executive_theme',
    description:
      'Applies a curated, publication-grade corporate theme across the entire sheet or table. Eliminates harsh or saturated colors, harmonizing headers, zebra rows, borders, and typography into a cohesive executive palette.',
    parameters: {
      type: 'object',
      properties: {
        theme: {
          type: 'string',
          enum: ['slate_monochrome', 'emerald_capital', 'midnight_navy', 'charcoal_ledger'],
          description:
            '"slate_monochrome" for modern neutral tech; "emerald_capital" for fintech and investment; "midnight_navy" for corporate consulting; "charcoal_ledger" for accounting.',
        },
        targetRangeA1: {
          type: 'string',
          description: 'Range to theme (e.g. "A1:Q669"). If omitted, applies to all occupied cells.',
        },
        applyZebraStriping: {
          type: 'boolean',
          description: 'Whether to enable alternating row shading. Default true.',
        },
        sheetName: {
          type: 'string',
          description: 'Worksheet name.',
        },
      },
      required: ['theme'],
    },
    execute: executeApplyExecutiveTheme,
  },
  {
    name: 'scaffold_dashboard_layout',
    description:
      'Builds an end-to-end Executive Dashboard page from scratch: title banner, subtitle, top KPI metric scorecards, summary data grid with zebra striping, and layout dimensioning.',
    parameters: {
      type: 'object',
      properties: {
        dashboardTitle: {
          type: 'string',
          description: 'Main report title (e.g. "Q3 Executive E-Commerce Performance").',
        },
        subtitle: {
          type: 'string',
          description: 'Subtitle / metadata banner (e.g. "Regional Sales & Fulfillment Overview · 2024").',
        },
        kpis: {
          type: 'array',
          description: 'Optional list of KPI scorecards to render at the top of the dashboard.',
          items: {
            type: 'object',
            properties: {
              label: { type: 'string' },
              value: { type: ['string', 'number'] },
              delta: { type: 'string' },
              trend: { type: 'string', enum: ['positive', 'negative', 'neutral'] },
            },
            required: ['label', 'value'],
          },
        },
        dashboardSheetName: {
          type: 'string',
          description: 'Name for the new dashboard sheet. Default "Executive_Dashboard".',
        },
        theme: {
          type: 'string',
          enum: ['slate_monochrome', 'emerald_capital', 'midnight_navy', 'charcoal_ledger'],
          description: 'Executive theme palette. Default "slate_monochrome".',
        },
      },
      required: ['dashboardTitle'],
    },
    execute: executeScaffoldDashboardLayout,
  },
];
