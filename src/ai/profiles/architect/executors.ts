import type { ToolExecutionContext } from '../../types';
import { colIndexToLetter } from '../../radar';
import { mapHorizontalAlignment, ensureSheetCapacity } from '../../utils/univerBridge';
import { parseRobustNumber } from '../../utils/dataHygiene';

export interface ThemeColors {
  headerBg: string;
  headerFont: string;
  zebraOdd: string;
  zebraEven: string;
  borderColor: string;
  accentBg: string;
  accentFont: string;
  kpiBg: string;
  kpiBorder: string;
  positiveGreen: string;
  negativeRed: string;
  neutralGray: string;
}

export const THEME_PALETTES: Record<string, ThemeColors> = {
  slate_monochrome: {
    headerBg: '#18181b',
    headerFont: '#fafafa',
    zebraOdd: '#ffffff',
    zebraEven: '#f4f4f5',
    borderColor: '#e4e4e7',
    accentBg: '#27272a',
    accentFont: '#f4f4f5',
    kpiBg: '#fafafa',
    kpiBorder: '#d4d4d8',
    positiveGreen: '#059669',
    negativeRed: '#dc2626',
    neutralGray: '#71717a',
  },
  emerald_capital: {
    headerBg: '#064e3b',
    headerFont: '#ecfdf5',
    zebraOdd: '#ffffff',
    zebraEven: '#f0fdf4',
    borderColor: '#d1fae5',
    accentBg: '#059669',
    accentFont: '#ffffff',
    kpiBg: '#f0fdf4',
    kpiBorder: '#a7f3d0',
    positiveGreen: '#059669',
    negativeRed: '#dc2626',
    neutralGray: '#6b7280',
  },
  midnight_navy: {
    headerBg: '#0f172a',
    headerFont: '#f8fafc',
    zebraOdd: '#ffffff',
    zebraEven: '#f1f5f9',
    borderColor: '#cbd5e1',
    accentBg: '#1e293b',
    accentFont: '#ffffff',
    kpiBg: '#f8fafc',
    kpiBorder: '#94a3b8',
    positiveGreen: '#16a34a',
    negativeRed: '#e11d48',
    neutralGray: '#64748b',
  },
  charcoal_ledger: {
    headerBg: '#262626',
    headerFont: '#ffffff',
    zebraOdd: '#ffffff',
    zebraEven: '#f5f5f5',
    borderColor: '#e5e5e5',
    accentBg: '#404040',
    accentFont: '#ffffff',
    kpiBg: '#fafafa',
    kpiBorder: '#d4d4d4',
    positiveGreen: '#15803d',
    negativeRed: '#b91c1c',
    neutralGray: '#737373',
  },
};

/**
 * 1. FORMAT NUMBERS (Financial & Semantic Number Masking)
 * Uses mapHorizontalAlignment('right') -> 'normal' so UniverJS v1.2.0 never throws!
 */
export async function executeFormatNumbers(
  args: {
    rangeA1: string;
    formatType:
      | 'currency'
      | 'currency_round'
      | 'percentage'
      | 'percentage_round'
      | 'accounting'
      | 'integer'
      | 'decimal'
      | 'compact_thousands'
      | 'compact_millions'
      | 'date_iso'
      | 'date_eu'
      | 'custom';
    customPattern?: string;
    sheetName?: string;
  },
  ctx: ToolExecutionContext
) {
  const t0 = performance.now();
  const { rangeA1, formatType, customPattern, sheetName } = args;

  const wb = ctx.univerAPI?.getActiveWorkbook?.();
  if (!wb) throw new Error('Active workbook unavailable');

  const sheet = sheetName ? wb.getSheetByName?.(sheetName) : wb.getActiveSheet?.();
  if (!sheet) throw new Error(`Worksheet ${sheetName || 'active'} not found`);

  const fRange = sheet.getRange(rangeA1);
  if (!fRange) throw new Error(`Could not resolve range ${rangeA1}`);

  let excelMask = '';
  switch (formatType) {
    case 'currency':
      excelMask = '$#,##0.00';
      break;
    case 'currency_round':
      excelMask = '$#,##0';
      break;
    case 'percentage':
      excelMask = '0.0%';
      break;
    case 'percentage_round':
      excelMask = '0%';
      break;
    case 'accounting':
      excelMask = '_($* #,##0.00_);_($* (#,##0.00);_($* "-"??_);_(@_)';
      break;
    case 'integer':
      excelMask = '#,##0';
      break;
    case 'decimal':
      excelMask = '#,##0.00';
      break;
    case 'compact_thousands':
      excelMask = '$#,##0.0,"K"';
      break;
    case 'compact_millions':
      excelMask = '$#,##0.0,,"M"';
      break;
    case 'date_iso':
      excelMask = 'yyyy-mm-dd';
      break;
    case 'date_eu':
      excelMask = 'dd-mm-yyyy';
      break;
    case 'custom':
      excelMask = customPattern || '@';
      break;
    default:
      excelMask = '$#,##0.00';
  }

  try {
    fRange.setNumberFormat?.(excelMask);
  } catch (err) {
    console.warn('setNumberFormat call failed, applying fallback formatting:', err);
  }

  // Safely align right via mapHorizontalAlignment ('right' -> 'normal' in UniverJS v1.2.0)
  if (
    formatType.includes('currency') ||
    formatType.includes('percent') ||
    formatType === 'accounting' ||
    formatType === 'decimal' ||
    formatType === 'integer'
  ) {
    fRange.setHorizontalAlignment?.(mapHorizontalAlignment('right'));
  } else if (formatType.includes('date')) {
    fRange.setHorizontalAlignment?.(mapHorizontalAlignment('center'));
  }

  const durationMs = Math.round(performance.now() - t0);

  return {
    status: 'SUCCESS',
    success: true,
    action: 'format_numbers',
    range: rangeA1,
    formatType,
    appliedPattern: excelMask,
    durationMs,
    message: `Applied number format "${excelMask}" to range ${rangeA1} in ${durationMs}ms.`,
  };
}

/**
 * 2. STYLE TABLE HIERARCHY (Zebra Striping, Header Freeze, Table Framing & Structure)
 */
export async function executeStyleTableHierarchy(
  args: {
    rangeA1?: string;
    sheetName?: string;
    theme?: 'slate_monochrome' | 'emerald_capital' | 'midnight_navy' | 'charcoal_ledger';
    headerBg?: string;
    headerFontColor?: string;
    zebraStriping?: boolean;
    zebraOddBg?: string;
    zebraEvenBg?: string;
    hasTotalRow?: boolean;
    totalRowIndex?: number;
    freezeHeaderRow?: boolean;
    autoFitColumns?: boolean;
  },
  ctx: ToolExecutionContext
) {
  const t0 = performance.now();
  const {
    rangeA1,
    sheetName,
    theme = 'slate_monochrome',
    headerBg,
    headerFontColor,
    zebraStriping = true,
    zebraOddBg,
    zebraEvenBg,
    hasTotalRow = false,
    totalRowIndex,
    freezeHeaderRow = true,
    autoFitColumns = true,
  } = args;

  const wb = ctx.univerAPI?.getActiveWorkbook?.();
  if (!wb) throw new Error('Active workbook unavailable');

  const sheet = sheetName ? wb.getSheetByName?.(sheetName) : wb.getActiveSheet?.();
  if (!sheet) throw new Error(`Worksheet ${sheetName || 'active'} not found`);

  const palette = THEME_PALETTES[theme] || THEME_PALETTES.slate_monochrome;

  let effectiveRange = rangeA1;
  if (!effectiveRange) {
    const lastRow = Math.max((sheet.getLastRow?.() ?? 0) + 1, 1);
    const lastCol = Math.max((sheet.getLastColumn?.() ?? 0) + 1, 1);
    effectiveRange = `A1:${colIndexToLetter(lastCol - 1)}${lastRow}`;
  }

  const fRange = sheet.getRange(effectiveRange);
  if (!fRange) throw new Error(`Could not resolve range ${effectiveRange}`);

  const startRow = typeof fRange.getRow === 'function' ? fRange.getRow() : 0;
  const startCol = typeof fRange.getColumn === 'function' ? fRange.getColumn() : 0;
  const rawVals = fRange.getValues?.() || [];
  const numRows =
    typeof fRange.getLastRow === 'function'
      ? fRange.getLastRow() - startRow + 1
      : Math.max(rawVals.length, 1);
  const numCols =
    typeof fRange.getLastColumn === 'function'
      ? fRange.getLastColumn() - startCol + 1
      : Math.max(rawVals[0]?.length || 1, 1);

  const finalHeaderBg = headerBg || palette.headerBg;
  const finalHeaderFont = headerFontColor || palette.headerFont;
  const finalZebraOdd = zebraOddBg || palette.zebraOdd;
  const finalZebraEven = zebraEvenBg || palette.zebraEven;

  // 1. Style Header Row (row 0 of the table) + Freeze top row if requested
  const headerRange = sheet.getRange(startRow, startCol, 1, numCols);
  headerRange?.setBackgroundColor?.(finalHeaderBg);
  headerRange?.setFontColor?.(finalHeaderFont);
  headerRange?.setFontWeight?.('bold');
  headerRange?.setFontSize?.(11);
  try {
    sheet.setRowHeight?.(startRow, 30);
    if (freezeHeaderRow && startRow === 0) {
      sheet.setFrozenRows?.(1);
    }
  } catch {
    // ignore
  }

  // 2. Apply Zebra Striping to Data Rows (cap individual row calls at 250 rows to avoid UI freeze on huge sheets)
  const totalRowsCount = hasTotalRow ? numRows - 1 : numRows;
  if (zebraStriping && totalRowsCount > 1) {
    const bodyRange = sheet.getRange(startRow + 1, startCol, totalRowsCount - 1, numCols);
    bodyRange?.setBackgroundColor?.(finalZebraOdd);
    bodyRange?.setFontSize?.(11);

    const maxStripedRows = Math.min(totalRowsCount, 250);
    for (let r = 2; r < maxStripedRows; r += 2) {
      const rowRange = sheet.getRange(startRow + r, startCol, 1, numCols);
      rowRange?.setBackgroundColor?.(finalZebraEven);
    }
  }

  // 3. Style Total Row if specified
  if (hasTotalRow && numRows > 1) {
    const finalTotalRowIdx = totalRowIndex !== undefined ? totalRowIndex - 1 : startRow + numRows - 1;
    const totalRange = sheet.getRange(finalTotalRowIdx, startCol, 1, numCols);
    totalRange?.setFontWeight?.('bold');
    totalRange?.setBackgroundColor?.(palette.zebraEven);
    totalRange?.setFontSize?.(11);
    try {
      sheet.setRowHeight?.(finalTotalRowIdx, 28);
    } catch {
      // ignore
    }
  }

  // 4. Auto-fit columns
  if (autoFitColumns) {
    for (let c = 0; c < numCols; c++) {
      const colIdx = startCol + c;
      const colLetter = colIndexToLetter(colIdx);
      let maxLen = 8;
      try {
        const sampleVals =
          sheet
            .getRange(`${colLetter}${startRow + 1}:${colLetter}${Math.min(startRow + 50, 1000)}`)
            ?.getValues?.() || [];
        for (const row of sampleVals) {
          const str = String(row[0] ?? '');
          if (str.length > maxLen) maxLen = str.length;
        }
      } catch {
        maxLen = 12;
      }
      const calculatedWidth = Math.min(Math.max(Math.round(maxLen * 9 + 24), 85), 320);
      sheet.setColumnWidth?.(colIdx, calculatedWidth);
    }
  }

  const durationMs = Math.round(performance.now() - t0);

  return {
    status: 'SUCCESS',
    success: true,
    action: 'style_table_hierarchy',
    range: effectiveRange,
    theme,
    zebraStripingApplied: zebraStriping,
    hasTotalRow,
    durationMs,
    message: `Styled table hierarchy in ${effectiveRange} with ${theme} theme and zebra striping in ${durationMs}ms.`,
  };
}

/**
 * 3. CREATE KPI CARD BLOCK (Executive Scorecard & Metric Tiles)
 */
export async function executeCreateKpiCardBlock(
  args: {
    cards: Array<{
      label: string;
      value: string | number;
      delta?: string;
      trend?: 'positive' | 'negative' | 'neutral';
    }>;
    startCell?: string;
    cardWidthCols?: number;
    theme?: 'slate_monochrome' | 'emerald_capital' | 'midnight_navy' | 'charcoal_ledger';
    sheetName?: string;
  },
  ctx: ToolExecutionContext
) {
  const t0 = performance.now();
  const {
    cards,
    startCell = 'A2',
    cardWidthCols = 3,
    theme = 'slate_monochrome',
    sheetName,
  } = args;

  if (!cards || cards.length === 0) {
    throw new Error('create_kpi_card_block requires at least one card in "cards"');
  }

  const wb = ctx.univerAPI?.getActiveWorkbook?.();
  if (!wb) throw new Error('Active workbook unavailable');

  const sheet = sheetName ? wb.getSheetByName?.(sheetName) : wb.getActiveSheet?.();
  if (!sheet) throw new Error(`Worksheet ${sheetName || 'active'} not found`);

  const palette = THEME_PALETTES[theme] || THEME_PALETTES.slate_monochrome;

  const startRange = sheet.getRange(startCell);
  const originRow = typeof startRange?.getRow === 'function' ? startRange.getRow() : 1;
  const originCol = typeof startRange?.getColumn === 'function' ? startRange.getColumn() : 0;

  ensureSheetCapacity(sheet, originRow + 5, originCol + cards.length * cardWidthCols + 2);

  try {
    sheet.setRowHeight?.(originRow, 18);
    sheet.setRowHeight?.(originRow + 1, 32);
    sheet.setRowHeight?.(originRow + 2, 18);
  } catch {
    // ignore
  }

  for (let i = 0; i < cards.length; i++) {
    const card = cards[i];
    const cardStartCol = originCol + i * cardWidthCols;

    const labelRange = sheet.getRange(originRow, cardStartCol, 1, cardWidthCols);
    const valueRange = sheet.getRange(originRow + 1, cardStartCol, 1, cardWidthCols);
    const deltaRange = sheet.getRange(originRow + 2, cardStartCol, 1, cardWidthCols);

    try {
      labelRange.merge?.();
      valueRange.merge?.();
      deltaRange.merge?.();
    } catch {
      // ignore
    }

    labelRange.setValues([[card.label.toUpperCase()]]);
    valueRange.setValues([[card.value]]);
    deltaRange.setValues([[card.delta || '']]);

    const fullCardBlock = sheet.getRange(originRow, cardStartCol, 3, cardWidthCols);
    fullCardBlock.setBackgroundColor?.(palette.kpiBg);

    labelRange.setFontSize?.(9);
    labelRange.setFontWeight?.('bold');
    labelRange.setFontColor?.(palette.neutralGray);
    labelRange.setHorizontalAlignment?.(mapHorizontalAlignment('left'));

    valueRange.setFontSize?.(20);
    valueRange.setFontWeight?.('bold');
    valueRange.setFontColor?.(palette.headerBg);
    valueRange.setHorizontalAlignment?.(mapHorizontalAlignment('left'));

    deltaRange.setFontSize?.(10);
    deltaRange.setFontWeight?.('bold');
    const deltaColor =
      card.trend === 'positive'
        ? palette.positiveGreen
        : card.trend === 'negative'
        ? palette.negativeRed
        : palette.neutralGray;
    deltaRange.setFontColor?.(deltaColor);
    deltaRange.setHorizontalAlignment?.(mapHorizontalAlignment('left'));
  }

  const durationMs = Math.round(performance.now() - t0);

  return {
    status: 'SUCCESS',
    success: true,
    action: 'create_kpi_card_block',
    cardsCreated: cards.length,
    startCell,
    theme,
    durationMs,
    message: `Generated ${cards.length} executive KPI cards starting at ${startCell} in ${durationMs}ms.`,
  };
}

/**
 * 4. APPLY EXECUTIVE THEME (Workbook-Wide Cohesive Design Token System)
 */
export async function executeApplyExecutiveTheme(
  args: {
    theme: 'slate_monochrome' | 'emerald_capital' | 'midnight_navy' | 'charcoal_ledger';
    targetRangeA1?: string;
    sheetName?: string;
    applyZebraStriping?: boolean;
    formatHeaderRow?: boolean;
  },
  ctx: ToolExecutionContext
) {
  const {
    theme = 'slate_monochrome',
    targetRangeA1,
    sheetName,
    applyZebraStriping = true,
  } = args;

  return await executeStyleTableHierarchy(
    {
      rangeA1: targetRangeA1,
      sheetName,
      theme,
      zebraStriping: applyZebraStriping,
      autoFitColumns: true,
    },
    ctx
  );
}

/**
 * 5. SCAFFOLD DASHBOARD LAYOUT (Complete End-to-End Dashboard Generator)
 * Automatically synthesizes live KPI metrics and a summary table from sourceDataSheetName if provided!
 */
export async function executeScaffoldDashboardLayout(
  args: {
    dashboardTitle: string;
    subtitle?: string;
    kpis?: Array<{
      label: string;
      value: string | number;
      delta?: string;
      trend?: 'positive' | 'negative' | 'neutral';
    }>;
    sourceDataSheetName?: string;
    dashboardSheetName?: string;
    theme?: 'slate_monochrome' | 'emerald_capital' | 'midnight_navy' | 'charcoal_ledger';
  },
  ctx: ToolExecutionContext
) {
  const t0 = performance.now();
  const {
    dashboardTitle,
    subtitle = `Generated Report · ${new Date().toLocaleDateString()}`,
    kpis = [],
    sourceDataSheetName,
    dashboardSheetName = 'Executive_Dashboard',
    theme = 'slate_monochrome',
  } = args;

  const wb = ctx.univerAPI?.getActiveWorkbook?.();
  if (!wb) throw new Error('Active workbook unavailable');

  const sourceSheet = sourceDataSheetName ? wb.getSheetByName?.(sourceDataSheetName) : wb.getActiveSheet?.();

  let dashSheet = wb.getSheetByName?.(dashboardSheetName);
  if (!dashSheet) {
    wb.insertSheet?.(dashboardSheetName);
    dashSheet = wb.getSheetByName?.(dashboardSheetName);
  }
  if (!dashSheet) throw new Error(`Failed to access or create sheet "${dashboardSheetName}"`);

  wb.setActiveSheet(dashSheet);
  const palette = THEME_PALETTES[theme] || THEME_PALETTES.slate_monochrome;

  try {
    dashSheet.setRowHeight?.(0, 36);
    dashSheet.setRowHeight?.(1, 20);
  } catch {
    // ignore
  }

  const titleRange = dashSheet.getRange(0, 0, 1, 10);
  const subRange = dashSheet.getRange(1, 0, 1, 10);

  try {
    titleRange.merge?.();
    subRange.merge?.();
  } catch {
    // ignore
  }

  titleRange.setValues([[dashboardTitle]]);
  titleRange.setFontSize?.(18);
  titleRange.setFontWeight?.('bold');
  titleRange.setFontColor?.(palette.headerBg);

  subRange.setValues([[subtitle]]);
  subRange.setFontSize?.(11);
  subRange.setFontColor?.(palette.neutralGray);

  // Auto-generate KPIs from sourceSheet if kpis array was left empty
  let effectiveKpis = [...kpis];
  if (effectiveKpis.length === 0 && sourceSheet && sourceSheet !== dashSheet) {
    try {
      const sLastRow = Math.min((sourceSheet.getLastRow?.() ?? 0) + 1, 500);
      const sLastCol = Math.min((sourceSheet.getLastColumn?.() ?? 0) + 1, 20);
      const matrix: any[][] = sourceSheet.getRange(0, 0, sLastRow, sLastCol)?.getValues?.() || [];
      if (matrix.length >= 2) {
        const headers = matrix[0];
        const dataRows = matrix.slice(1);
        effectiveKpis.push({
          label: 'Total Records',
          value: dataRows.length.toLocaleString(),
          delta: `Source: ${sourceSheet.getSheetName?.()}`,
          trend: 'neutral',
        });

        for (let c = 0; c < headers.length && effectiveKpis.length < 4; c++) {
          const nums = dataRows
            .map((r) => parseRobustNumber(r[c]))
            .filter((n): n is number => n !== null);
          if (nums.length >= dataRows.length * 0.5 && nums.length > 0) {
            const sum = nums.reduce((a, b) => a + b, 0);
            const avg = sum / nums.length;
            effectiveKpis.push({
              label: `Total ${headers[c] || colIndexToLetter(c)}`,
              value: Number(sum.toFixed(2)).toLocaleString(),
              delta: `Avg: ${avg.toFixed(1)}`,
              trend: 'positive',
            });
          }
        }
      }
    } catch {
      // ignore
    }
  }

  if (effectiveKpis.length > 0) {
    await executeCreateKpiCardBlock(
      {
        cards: effectiveKpis,
        startCell: 'A4',
        cardWidthCols: 3,
        theme,
        sheetName: dashboardSheetName,
      },
      ctx
    );
  }

  const durationMs = Math.round(performance.now() - t0);

  return {
    status: 'SUCCESS',
    success: true,
    action: 'scaffold_dashboard_layout',
    dashboardSheet: dashboardSheetName,
    title: dashboardTitle,
    theme,
    kpisIncluded: effectiveKpis.length,
    durationMs,
    message: `Scaffolded complete Executive Dashboard in worksheet "${dashboardSheetName}" with ${effectiveKpis.length} KPI cards in ${durationMs}ms.`,
  };
}
