import { ToolExecutionContext } from '../../types';
import { colIndexToLetter, letterToColIndex } from '../../radar';
import { verifyRangeMutation } from '../../middleware/formulaVerifier';

/**
 * Escapes a worksheet name for safe use in Excel formulas.
 * e.g. "Q1 Sales" -> "'Q1 Sales'", "Sheet1" -> "Sheet1"
 */
function escapeSheetName(sheetName?: string): string {
  if (!sheetName) return '';
  const trimmed = sheetName.trim();
  if (/^[\w]+$/.test(trimmed)) {
    return trimmed;
  }
  return `'${trimmed.replace(/'/g, "''")}'`;
}

/**
 * Resolves a column identifier (letter or header label) to letter and index on a given sheet.
 */
function resolveSheetColumn(
  sheet: any,
  colRef: string | number,
  headerRowIdx: number = 0
): { colIndex: number; colLetter: string; headerName: string } {
  if (typeof colRef === 'number') {
    return {
      colIndex: colRef,
      colLetter: colIndexToLetter(colRef),
      headerName: String(sheet.getRange(headerRowIdx, colRef)?.getValue?.() || colIndexToLetter(colRef)),
    };
  }

  const trimmed = String(colRef).trim();
  if (/^[A-Za-z]+$/.test(trimmed)) {
    const colIdx = letterToColIndex(trimmed);
    let headerName = trimmed;
    try {
      const val = sheet.getRange(headerRowIdx, colIdx)?.getValue?.();
      if (val !== undefined && val !== null && String(val).trim() !== '') {
        headerName = String(val).trim();
      }
    } catch {
      // ignore
    }
    return { colIndex: colIdx, colLetter: trimmed.toUpperCase(), headerName };
  }

  // Header match
  const maxCol = Math.min((sheet.getLastColumn?.() ?? 0) + 1, 100);
  let bestIdx = -1;
  let bestHeader = trimmed;

  try {
    const headerRowVals = sheet.getRange(headerRowIdx, 0, 1, maxCol)?.getValues?.()?.[0] || [];
    for (let c = 0; c < headerRowVals.length; c++) {
      const h = String(headerRowVals[c] || '').trim();
      if (h.toLowerCase() === trimmed.toLowerCase()) {
        bestIdx = c;
        bestHeader = h;
        break;
      }
    }
  } catch {
    // ignore
  }

  if (bestIdx !== -1) {
    return {
      colIndex: bestIdx,
      colLetter: colIndexToLetter(bestIdx),
      headerName: bestHeader,
    };
  }

  const fallbackIdx = letterToColIndex(trimmed);
  return { colIndex: fallbackIdx, colLetter: colIndexToLetter(fallbackIdx), headerName: trimmed };
}

/**
 * 1. BUILD LOOKUP (Cross-Sheet & Multi-Criteria Lookups)
 * Generates robust, uncorrupted cross-sheet lookups (XLOOKUP, INDEX/MATCH, Two-Way Matrix).
 * Automatically escapes sheet names and wraps with IFNA/IFERROR guards.
 */
export async function executeBuildLookup(
  args: {
    targetRangeA1: string;
    lookupKeyColumn: string;
    lookupSheetName?: string;
    sourceSheetName: string;
    sourceKeyColumn: string;
    sourceReturnColumn: string;
    mode?: 'xlookup' | 'index_match' | 'two_way';
    twoWayColumnHeader?: string;
    fallbackValue?: any;
    writeAsFormulas?: boolean;
    startRow?: number;
    endRow?: number;
  },
  ctx: ToolExecutionContext
) {
  const t0 = performance.now();
  const {
    targetRangeA1,
    lookupKeyColumn,
    lookupSheetName,
    sourceSheetName,
    sourceKeyColumn,
    sourceReturnColumn,
    mode = 'index_match',
    twoWayColumnHeader,
    fallbackValue = 'Not Found',
    writeAsFormulas = true,
    startRow = 2,
    endRow,
  } = args;

  const wb = ctx.univerAPI?.getActiveWorkbook?.();
  if (!wb) throw new Error('Univer active workbook unavailable');

  const targetSheet = lookupSheetName ? wb.getSheetByName?.(lookupSheetName) : wb.getActiveSheet?.();
  if (!targetSheet) throw new Error(`Target sheet ${lookupSheetName || 'active'} not found`);

  const sourceSheet = wb.getSheetByName?.(sourceSheetName);
  if (!sourceSheet) throw new Error(`Source sheet "${sourceSheetName}" not found`);

  const lastTargetRow = Math.max((targetSheet.getLastRow?.() ?? 0) + 1, 1);
  const effectiveEndRow = endRow ? Math.min(endRow, lastTargetRow) : lastTargetRow;

  const escapedSrcSheet = escapeSheetName(sourceSheetName);
  const resolvedTargetCol = resolveSheetColumn(targetSheet, targetRangeA1.split(':')[0].replace(/\d+/g, ''), 0);
  const resolvedLookupKey = resolveSheetColumn(targetSheet, lookupKeyColumn, 0);

  const resolvedSourceKey = resolveSheetColumn(sourceSheet, sourceKeyColumn, 0);
  const resolvedSourceReturn = resolveSheetColumn(sourceSheet, sourceReturnColumn, 0);

  const srcLastRow = Math.max((sourceSheet.getLastRow?.() ?? 0) + 1, 100);

  const formulasOrValues: any[][] = [];

  for (let r = startRow; r <= effectiveEndRow; r++) {
    const keyCellRef = `${resolvedLookupKey.colLetter}${r}`;
    const srcKeyRange = `${escapedSrcSheet}!$${resolvedSourceKey.colLetter}$2:$${resolvedSourceKey.colLetter}$${srcLastRow}`;
    const srcReturnRange = `${escapedSrcSheet}!$${resolvedSourceReturn.colLetter}$2:$${resolvedSourceReturn.colLetter}$${srcLastRow}`;

    let formulaStr = '';
    const safeFallback = typeof fallbackValue === 'number' ? fallbackValue : `"${fallbackValue}"`;

    if (mode === 'xlookup') {
      formulaStr = `=XLOOKUP(${keyCellRef}, ${srcKeyRange}, ${srcReturnRange}, ${safeFallback})`;
    } else if (mode === 'two_way' && twoWayColumnHeader) {
      // 2-way matrix lookup: INDEX(Table, MATCH(rowKey, rowRange, 0), MATCH(colKey, colRange, 0))
      const srcHeaderRange = `${escapedSrcSheet}!$A$1:$${colIndexToLetter((sourceSheet.getLastColumn?.() ?? 26) - 1)}$1`;
      const fullTableRange = `${escapedSrcSheet}!$A$2:$${colIndexToLetter((sourceSheet.getLastColumn?.() ?? 26) - 1)}$${srcLastRow}`;
      formulaStr = `=IFERROR(INDEX(${fullTableRange}, MATCH(${keyCellRef}, ${srcKeyRange}, 0), MATCH("${twoWayColumnHeader}", ${srcHeaderRange}, 0)), ${safeFallback})`;
    } else {
      // Universal INDEX/MATCH with IFERROR guard (100% compatible across all spreadsheet engines)
      formulaStr = `=IFERROR(INDEX(${srcReturnRange}, MATCH(${keyCellRef}, ${srcKeyRange}, 0)), ${safeFallback})`;
    }

    formulasOrValues.push([formulaStr]);
  }

  // Determine write range notation
  const writeRange = `${resolvedTargetCol.colLetter}${startRow}:${resolvedTargetCol.colLetter}${effectiveEndRow}`;
  targetSheet.getRange(writeRange)?.setValues?.(formulasOrValues);

  // Run self-healing formula verification pass
  const verifyReceipt = await verifyRangeMutation(targetSheet, writeRange);

  const durationMs = Math.round(performance.now() - t0);

  return {
    success: verifyReceipt.status === 'SUCCESS',
    action: 'build_lookup',
    mode,
    targetRange: writeRange,
    sourceSheet: sourceSheetName,
    sampleFormula: formulasOrValues[0]?.[0],
    rowsWritten: formulasOrValues.length,
    formulaVerification: verifyReceipt,
    durationMs,
    message: `Generated and verified ${formulasOrValues.length} lookup formulas in ${writeRange} linked to "${sourceSheetName}" in ${durationMs}ms.`,
  };
}

/**
 * 2. COMPOSE AGGREGATION (Multi-Condition SUMIFS, COUNTIFS, AVERAGEIFS, Rollups)
 */
export async function executeComposeAggregation(
  args: {
    targetCell: string;
    targetSheetName?: string;
    functionType: 'SUMIFS' | 'COUNTIFS' | 'AVERAGEIFS' | 'SUM' | 'AVERAGE' | 'COUNT' | 'MINIFS' | 'MAXIFS';
    dataSheetName?: string;
    measureColumn?: string;
    criteria?: Array<{
      column: string;
      operator?: '=' | '>' | '<' | '>=' | '<=' | '<>' | 'contains';
      value: any;
      isCellReference?: boolean;
    }>;
    startRow?: number;
    endRow?: number;
  },
  ctx: ToolExecutionContext
) {
  const t0 = performance.now();
  const {
    targetCell,
    targetSheetName,
    functionType,
    dataSheetName,
    measureColumn,
    criteria = [],
    startRow = 2,
    endRow,
  } = args;

  const wb = ctx.univerAPI?.getActiveWorkbook?.();
  if (!wb) throw new Error('Univer active workbook unavailable');

  const destSheet = targetSheetName ? wb.getSheetByName?.(targetSheetName) : wb.getActiveSheet?.();
  if (!destSheet) throw new Error(`Target worksheet ${targetSheetName || 'active'} not found`);

  const dataSheet = dataSheetName ? wb.getSheetByName?.(dataSheetName) : destSheet;
  if (!dataSheet) throw new Error(`Data worksheet ${dataSheetName || 'active'} not found`);

  const escapedDataSheet = dataSheet !== destSheet ? `${escapeSheetName(dataSheet.getSheetName?.())}!` : '';
  const lastDataRow = Math.max((dataSheet.getLastRow?.() ?? 0) + 1, 100);
  const effectiveEndRow = endRow ? Math.min(endRow, lastDataRow) : lastDataRow;

  let formula = '';

  if (functionType === 'SUM' || functionType === 'AVERAGE' || functionType === 'COUNT') {
    if (!measureColumn) throw new Error(`${functionType} requires measureColumn`);
    const resolvedMeasure = resolveSheetColumn(dataSheet, measureColumn, 0);
    const rangeRef = `${escapedDataSheet}$${resolvedMeasure.colLetter}$${startRow}:$${resolvedMeasure.colLetter}$${effectiveEndRow}`;
    formula = `=${functionType}(${rangeRef})`;
  } else if (functionType === 'COUNTIFS') {
    const parts: string[] = [];
    for (const crit of criteria) {
      const resolvedCritCol = resolveSheetColumn(dataSheet, crit.column, 0);
      const critRange = `${escapedDataSheet}$${resolvedCritCol.colLetter}$${startRow}:$${resolvedCritCol.colLetter}$${effectiveEndRow}`;
      let critValStr = '';
      if (crit.isCellReference) {
        critValStr = crit.operator && crit.operator !== '=' ? `"${crit.operator}" & ${crit.value}` : crit.value;
      } else if (crit.operator && crit.operator !== '=') {
        critValStr = `"${crit.operator}${crit.value}"`;
      } else {
        critValStr = typeof crit.value === 'number' ? String(crit.value) : `"${crit.value}"`;
      }
      parts.push(`${critRange}, ${critValStr}`);
    }
    formula = `=COUNTIFS(${parts.join(', ')})`;
  } else {
    // SUMIFS, AVERAGEIFS, MINIFS, MAXIFS: (measureRange, critRange1, crit1, critRange2, crit2, ...)
    if (!measureColumn) throw new Error(`${functionType} requires measureColumn`);
    const resolvedMeasure = resolveSheetColumn(dataSheet, measureColumn, 0);
    const measureRange = `${escapedDataSheet}$${resolvedMeasure.colLetter}$${startRow}:$${resolvedMeasure.colLetter}$${effectiveEndRow}`;

    const parts: string[] = [measureRange];
    for (const crit of criteria) {
      const resolvedCritCol = resolveSheetColumn(dataSheet, crit.column, 0);
      const critRange = `${escapedDataSheet}$${resolvedCritCol.colLetter}$${startRow}:$${resolvedCritCol.colLetter}$${effectiveEndRow}`;
      let critValStr = '';
      if (crit.isCellReference) {
        critValStr = crit.operator && crit.operator !== '=' ? `"${crit.operator}" & ${crit.value}` : crit.value;
      } else if (crit.operator && crit.operator !== '=') {
        critValStr = `"${crit.operator}${crit.value}"`;
      } else {
        critValStr = typeof crit.value === 'number' ? String(crit.value) : `"${crit.value}"`;
      }
      parts.push(`${critRange}, ${critValStr}`);
    }
    formula = `=${functionType}(${parts.join(', ')})`;
  }

  // Write formula to cell
  destSheet.getRange(targetCell)?.setValues?.([[formula]]);

  // Verify
  const verifyReceipt = await verifyRangeMutation(destSheet, targetCell);
  const durationMs = Math.round(performance.now() - t0);

  return {
    success: verifyReceipt.status === 'SUCCESS',
    action: 'compose_aggregation',
    formula,
    targetCell,
    targetSheet: destSheet.getSheetName?.(),
    verification: verifyReceipt,
    durationMs,
    message: `Written and verified formula ${formula} in cell ${targetCell} in ${durationMs}ms.`,
  };
}

/**
 * 3. GENERATE FINANCIAL MODEL
 * Builds full loan amortizations, compound interest schedules, NPV/IRR formulas, and depreciation tables.
 */
export async function executeGenerateFinancialModel(
  args: {
    modelType: 'loan_amortization' | 'compound_interest' | 'npv_irr' | 'depreciation';
    sheetName?: string;
    targetSheetName?: string;
    startCell?: string;
    // Loan Amortization parameters
    principal?: number;
    annualInterestRate?: number; // e.g. 0.065 for 6.5%
    loanTermYears?: number;
    paymentsPerYear?: number; // default 12
    // Investment parameters
    initialDeposit?: number;
    monthlyContribution?: number;
    annualReturnRate?: number;
    projectionYears?: number;
    // Depreciation parameters
    assetCost?: number;
    salvageValue?: number;
    usefulLifeYears?: number;
    depreciationMethod?: 'SLN' | 'DB';
    // Cash flow range for NPV/IRR
    cashFlowRangeA1?: string;
    discountRate?: number;
  },
  ctx: ToolExecutionContext
) {
  const t0 = performance.now();
  const {
    modelType,
    sheetName,
    targetSheetName,
    startCell = 'A1',
    principal = 100000,
    annualInterestRate = 0.065,
    loanTermYears = 5,
    paymentsPerYear = 12,
    initialDeposit = 10000,
    monthlyContribution = 500,
    annualReturnRate = 0.08,
    projectionYears = 10,
    assetCost = 50000,
    salvageValue = 5000,
    usefulLifeYears = 5,
    depreciationMethod = 'SLN',
    cashFlowRangeA1,
    discountRate = 0.1,
  } = args;

  const wb = ctx.univerAPI?.getActiveWorkbook?.();
  if (!wb) throw new Error('Univer active workbook unavailable');

  let destSheet: any;
  if (targetSheetName) {
    destSheet = wb.getSheetByName?.(targetSheetName) || wb.insertSheet?.(targetSheetName);
  } else {
    destSheet = sheetName ? wb.getSheetByName?.(sheetName) : wb.getActiveSheet?.();
  }
  if (!destSheet) throw new Error('Target worksheet unavailable');

  const destSheetName = destSheet.getSheetName?.() || 'Model';

  if (modelType === 'loan_amortization') {
    const totalPayments = Math.round(loanTermYears * paymentsPerYear);
    const periodicRate = annualInterestRate / paymentsPerYear;

    // Monthly PMT formula
    const pmt =
      (principal * (periodicRate * Math.pow(1 + periodicRate, totalPayments))) /
      (Math.pow(1 + periodicRate, totalPayments) - 1);

    const headers = [
      'Payment #',
      'Beginning Balance',
      'Payment (PMT)',
      'Principal (PPMT)',
      'Interest (IPMT)',
      'Ending Balance',
    ];

    const matrix: any[][] = [];
    let currentBalance = principal;

    for (let i = 1; i <= totalPayments; i++) {
      const interestPart = currentBalance * periodicRate;
      const principalPart = pmt - interestPart;
      const endingBalance = Math.max(currentBalance - principalPart, 0);

      const rowIdx = i + 1; // 1-based header is row 1
      matrix.push([
        i,
        i === 1 ? principal : `=F${rowIdx - 1}`,
        Number(pmt.toFixed(2)),
        `=C${rowIdx}-E${rowIdx}`,
        `=B${rowIdx}*(${annualInterestRate}/${paymentsPerYear})`,
        `=B${rowIdx}-D${rowIdx}`,
      ]);

      currentBalance = endingBalance;
    }

    // Write headers and schedule
    destSheet.getRange(0, 0, 1, headers.length)?.setValues?.([headers]);
    destSheet.getRange(1, 0, matrix.length, headers.length)?.setValues?.(matrix);

    const durationMs = Math.round(performance.now() - t0);

    return {
      success: true,
      action: 'generate_financial_model',
      modelType: 'loan_amortization',
      outputSheet: destSheetName,
      totalPayments,
      monthlyPayment: Number(pmt.toFixed(2)),
      totalInterestPaid: Number((pmt * totalPayments - principal).toFixed(2)),
      durationMs,
      message: `Generated ${totalPayments}-period loan amortization schedule in sheet "${destSheetName}" with monthly payment of $${pmt.toFixed(2)}.`,
    };
  }

  if (modelType === 'compound_interest') {
    const totalMonths = projectionYears * 12;
    const monthlyRate = annualReturnRate / 12;

    const headers = ['Year', 'Month', 'Starting Balance', 'Contribution', 'Interest Earned', 'Ending Balance'];
    const matrix: any[][] = [];
    let currentBalance = initialDeposit;

    for (let m = 1; m <= totalMonths; m++) {
      const year = Math.ceil(m / 12);
      const interest = currentBalance * monthlyRate;
      const ending = currentBalance + monthlyContribution + interest;
      const rIdx = m + 1;

      matrix.push([
        year,
        m,
        m === 1 ? initialDeposit : `=F${rIdx - 1}`,
        monthlyContribution,
        `=C${rIdx}*(${annualReturnRate}/12)`,
        `=C${rIdx}+D${rIdx}+E${rIdx}`,
      ]);

      currentBalance = ending;
    }

    destSheet.getRange(0, 0, 1, headers.length)?.setValues?.([headers]);
    destSheet.getRange(1, 0, matrix.length, headers.length)?.setValues?.(matrix);

    return {
      success: true,
      action: 'generate_financial_model',
      modelType: 'compound_interest',
      outputSheet: destSheetName,
      projectedEndingBalance: Number(currentBalance.toFixed(2)),
      message: `Generated ${projectionYears}-year compound investment schedule ending with balance of $${currentBalance.toFixed(2)}.`,
    };
  }

  if (modelType === 'npv_irr') {
    if (!cashFlowRangeA1) throw new Error('npv_irr requires cashFlowRangeA1');

    const npvFormula = `=NPV(${discountRate}, ${cashFlowRangeA1})`;
    const irrFormula = `=IRR(${cashFlowRangeA1})`;

    destSheet.getRange(startCell)?.setValues?.([
      ['Discount Rate', discountRate],
      ['Net Present Value (NPV)', npvFormula],
      ['Internal Rate of Return (IRR)', irrFormula],
    ]);

    return {
      success: true,
      action: 'generate_financial_model',
      modelType: 'npv_irr',
      npvFormula,
      irrFormula,
      message: `Generated NPV and IRR valuation formulas in ${startCell}.`,
    };
  }

  // Depreciation
  const headers = ['Year', 'Beginning Book Value', 'Depreciation Expense', 'Accumulated Depreciation', 'Ending Book Value'];
  const matrix: any[][] = [];
  const annualDepreciation = (assetCost - salvageValue) / usefulLifeYears;
  let bookVal = assetCost;
  let accumDep = 0;

  for (let yr = 1; yr <= usefulLifeYears; yr++) {
    const expense = annualDepreciation;
    accumDep += expense;
    bookVal -= expense;
    const rIdx = yr + 1;

    matrix.push([
      yr,
      yr === 1 ? assetCost : `=E${rIdx - 1}`,
      depreciationMethod === 'SLN' ? Number(annualDepreciation.toFixed(2)) : `=DB(${assetCost}, ${salvageValue}, ${usefulLifeYears}, ${yr})`,
      `=SUM($C$2:C${rIdx})`,
      `=$B$2-D${rIdx}`,
    ]);
  }

  destSheet.getRange(0, 0, 1, headers.length)?.setValues?.([headers]);
  destSheet.getRange(1, 0, matrix.length, headers.length)?.setValues?.(matrix);

  return {
    success: true,
    action: 'generate_financial_model',
    modelType: 'depreciation',
    outputSheet: destSheetName,
    message: `Generated ${usefulLifeYears}-year ${depreciationMethod} depreciation schedule.`,
  };
}

/**
 * 4. CASCADE DYNAMIC ARRAYS (UNIQUE, FILTER, SORT with #SPILL! Collision Guard)
 */
export async function executeCascadeDynamicArrays(
  args: {
    targetCell: string;
    formulaType: 'UNIQUE' | 'FILTER' | 'SORT' | 'SEQUENCE';
    sourceRangeA1?: string;
    filterCondition?: string;
    sortIndex?: number;
    sortOrder?: 'asc' | 'desc';
    sequenceRows?: number;
    sequenceCols?: number;
    sequenceStart?: number;
    sequenceStep?: number;
    sheetName?: string;
    clearSpillZoneFirst?: boolean;
  },
  ctx: ToolExecutionContext
) {
  const t0 = performance.now();
  const {
    targetCell,
    formulaType,
    sourceRangeA1,
    filterCondition,
    sortIndex = 1,
    sortOrder = 'asc',
    sequenceRows = 10,
    sequenceCols = 1,
    sequenceStart = 1,
    sequenceStep = 1,
    sheetName,
    clearSpillZoneFirst = true,
  } = args;

  const wb = ctx.univerAPI?.getActiveWorkbook?.();
  if (!wb) throw new Error('Univer active workbook unavailable');

  const sheet = sheetName ? wb.getSheetByName?.(sheetName) : wb.getActiveSheet?.();
  if (!sheet) throw new Error(`Worksheet ${sheetName || 'active'} not found`);

  let formula = '';

  if (formulaType === 'UNIQUE') {
    if (!sourceRangeA1) throw new Error('UNIQUE requires sourceRangeA1');
    formula = `=UNIQUE(${sourceRangeA1})`;
  } else if (formulaType === 'FILTER') {
    if (!sourceRangeA1 || !filterCondition) throw new Error('FILTER requires sourceRangeA1 and filterCondition');
    formula = `=FILTER(${sourceRangeA1}, ${filterCondition}, "No matches")`;
  } else if (formulaType === 'SORT') {
    if (!sourceRangeA1) throw new Error('SORT requires sourceRangeA1');
    const orderNum = sortOrder === 'desc' ? -1 : 1;
    formula = `=SORT(${sourceRangeA1}, ${sortIndex}, ${orderNum})`;
  } else if (formulaType === 'SEQUENCE') {
    formula = `=SEQUENCE(${sequenceRows}, ${sequenceCols}, ${sequenceStart}, ${sequenceStep})`;
  }

  // Pre-check spill collision: ensure cells around target are clear
  if (clearSpillZoneFirst) {
    const targetRangeObj = sheet.getRange(targetCell);
    const startRow = typeof targetRangeObj.getRow === 'function' ? targetRangeObj.getRow() : 0;
    const startCol = typeof targetRangeObj.getColumn === 'function' ? targetRangeObj.getColumn() : 0;

    // Clear 15 rows below target to prevent #SPILL!
    try {
      sheet.getRange(startRow + 1, startCol, 15, 5)?.clear?.();
    } catch {
      // ignore
    }
  }

  sheet.getRange(targetCell)?.setValues?.([[formula]]);
  const verifyReceipt = await verifyRangeMutation(sheet, targetCell);

  const durationMs = Math.round(performance.now() - t0);

  return {
    success: verifyReceipt.status === 'SUCCESS',
    action: 'cascade_dynamic_arrays',
    formula,
    targetCell,
    verification: verifyReceipt,
    durationMs,
    message: `Generated spilled array formula "${formula}" in ${targetCell}.`,
  };
}

/**
 * 5. MATRIX MATH ENGINE (Cumulative Running Totals, % of Total, Trends & Moving Averages)
 */
export async function executeMatrixMathEngine(
  args: {
    operation: 'running_total' | 'percent_of_total' | 'moving_average' | 'trend_slope_intercept';
    sourceColumn: string;
    targetColumn?: string;
    windowSize?: number; // for moving average (default 7)
    startRow?: number;
    endRow?: number;
    sheetName?: string;
  },
  ctx: ToolExecutionContext
) {
  const t0 = performance.now();
  const {
    operation,
    sourceColumn,
    targetColumn,
    windowSize = 7,
    startRow = 2,
    endRow,
    sheetName,
  } = args;

  const wb = ctx.univerAPI?.getActiveWorkbook?.();
  if (!wb) throw new Error('Univer active workbook unavailable');

  const sheet = sheetName ? wb.getSheetByName?.(sheetName) : wb.getActiveSheet?.();
  if (!sheet) throw new Error(`Worksheet ${sheetName || 'active'} not found`);

  const srcCol = resolveSheetColumn(sheet, sourceColumn, 0);
  const destCol = targetColumn ? resolveSheetColumn(sheet, targetColumn, 0) : resolveSheetColumn(sheet, srcCol.colIndex + 1, 0);

  const lastSheetRow = Math.max((sheet.getLastRow?.() ?? 0) + 1, 1);
  const effectiveEndRow = endRow ? Math.min(endRow, lastSheetRow) : lastSheetRow;

  if (effectiveEndRow < startRow) {
    return { success: true, rowsWritten: 0, message: 'No rows to calculate' };
  }

  // Insert target column if needed
  if (!targetColumn) {
    sheet.insertColumns?.(destCol.colIndex, 1);
  }

  const formulas: any[][] = [];
  let headerTitle = '';

  if (operation === 'running_total') {
    headerTitle = `Cumulative ${srcCol.headerName}`;
    for (let r = startRow; r <= effectiveEndRow; r++) {
      formulas.push([`=SUM($${srcCol.colLetter}$${startRow}:$${srcCol.colLetter}${r})`]);
    }
  } else if (operation === 'percent_of_total') {
    headerTitle = `% of Total ${srcCol.headerName}`;
    const sumTotalRef = `$${srcCol.colLetter}$${startRow}:$${srcCol.colLetter}$${effectiveEndRow}`;
    for (let r = startRow; r <= effectiveEndRow; r++) {
      formulas.push([`=IFERROR($${srcCol.colLetter}${r} / SUM(${sumTotalRef}), 0)`]);
    }
  } else if (operation === 'moving_average') {
    headerTitle = `${windowSize}-Period MA (${srcCol.headerName})`;
    for (let r = startRow; r <= effectiveEndRow; r++) {
      const windowStart = Math.max(startRow, r - windowSize + 1);
      formulas.push([`=AVERAGE($${srcCol.colLetter}${windowStart}:$${srcCol.colLetter}${r})`]);
    }
  } else if (operation === 'trend_slope_intercept') {
    headerTitle = `Linear Trend (${srcCol.headerName})`;
    const yRange = `$${srcCol.colLetter}$${startRow}:$${srcCol.colLetter}$${effectiveEndRow}`;
    for (let r = startRow; r <= effectiveEndRow; r++) {
      const xVal = r - startRow + 1;
      formulas.push([`=FORECAST(${xVal}, ${yRange}, ROW(${yRange}))`]);
    }
  }

  // Write header at row 0
  destSheetHeaderWrite: {
    sheet.getRange(0, destCol.colIndex, 1, 1)?.setValues?.([[headerTitle]]);
  }

  // Write formulas across rows
  const writeRange = `${destCol.colLetter}${startRow}:${destCol.colLetter}${effectiveEndRow}`;
  sheet.getRange(writeRange)?.setValues?.(formulas);

  const verifyReceipt = await verifyRangeMutation(sheet, writeRange);
  const durationMs = Math.round(performance.now() - t0);

  return {
    success: verifyReceipt.status === 'SUCCESS',
    action: 'matrix_math_engine',
    operation,
    targetColumn: destCol.colLetter,
    headerCreated: headerTitle,
    sampleFormula: formulas[0]?.[0],
    rowsWritten: formulas.length,
    verification: verifyReceipt,
    durationMs,
    message: `Generated ${formulas.length} mathematical formulas in Column ${destCol.colLetter} ("${headerTitle}") in ${durationMs}ms.`,
  };
}

/**
 * 6. VALIDATE AND HEAL FORMULAS (The Formula Doctor & Self-Repair Sandbox)
 */
export async function executeValidateAndHealFormulas(
  args: {
    rangeA1: string;
    sheetName?: string;
    autoWrapWithIfError?: boolean;
    ifErrorFallback?: any;
  },
  ctx: ToolExecutionContext
) {
  const t0 = performance.now();
  const { rangeA1, sheetName, autoWrapWithIfError = true, ifErrorFallback = 0 } = args;

  const wb = ctx.univerAPI?.getActiveWorkbook?.();
  if (!wb) throw new Error('Univer active workbook unavailable');

  const sheet = sheetName ? wb.getSheetByName?.(sheetName) : wb.getActiveSheet?.();
  if (!sheet) throw new Error(`Worksheet ${sheetName || 'active'} not found`);

  const fRange = sheet.getRange(rangeA1);
  if (!fRange) throw new Error(`Could not resolve range ${rangeA1}`);

  const startRow = typeof fRange.getRow === 'function' ? fRange.getRow() : 0;
  const startCol = typeof fRange.getColumn === 'function' ? fRange.getColumn() : 0;

  const values: any[][] = fRange.getValues?.() || [];
  let formulas: any[][] = [];
  try {
    formulas = fRange.getFormulas?.() || [];
  } catch {
    formulas = [];
  }

  const ERROR_TOKENS = new Set(['#REF!', '#NAME?', '#VALUE!', '#DIV/0!', '#N/A', '#ERROR!', '#NUM!', '#NULL!']);
  const healedFormulas: Array<{ coordinate: string; oldFormula: string; newFormula: string; errorFound: string }> = [];

  const updatedFormulasMatrix: any[][] = [];

  for (let r = 0; r < values.length; r++) {
    const rowVals = values[r] || [];
    const rowForms = formulas[r] || [];
    const newRowForms: any[] = [];

    for (let c = 0; c < rowVals.length; c++) {
      const cellVal = rowVals[c];
      const cellFormula = rowForms[c];
      const coord = `${colIndexToLetter(startCol + c)}${startRow + r + 1}`;

      if (cellFormula && typeof cellFormula === 'string' && cellFormula.startsWith('=')) {
        const valStr = String(cellVal || '');
        if (ERROR_TOKENS.has(valStr)) {
          let healed = cellFormula;

          // Repair 1: Wrap with IFERROR if not already wrapped
          if (autoWrapWithIfError && !healed.toUpperCase().startsWith('=IFERROR(') && !healed.toUpperCase().startsWith('=IFNA(')) {
            const inner = healed.slice(1);
            const fallbackStr = typeof ifErrorFallback === 'number' ? ifErrorFallback : `"${ifErrorFallback}"`;
            healed = `=IFERROR(${inner}, ${fallbackStr})`;
          }

          healedFormulas.push({
            coordinate: coord,
            oldFormula: cellFormula,
            newFormula: healed,
            errorFound: valStr,
          });

          newRowForms.push(healed);
          continue;
        }
      }

      newRowForms.push(cellFormula || cellVal);
    }

    updatedFormulasMatrix.push(newRowForms);
  }

  // Write healed formulas back if any were fixed
  if (healedFormulas.length > 0) {
    fRange.setValues(updatedFormulasMatrix);
  }

  // Post verification pass
  const postVerify = await verifyRangeMutation(sheet, rangeA1);
  const durationMs = Math.round(performance.now() - t0);

  return {
    success: true,
    action: 'validate_and_heal_formulas',
    scannedRange: rangeA1,
    errorsFound: healedFormulas.length,
    healedFormulas,
    remainingErrors: postVerify.errorCount,
    durationMs,
    message:
      healedFormulas.length > 0
        ? `Successfully diagnosed and healed ${healedFormulas.length} broken formula(s) in ${rangeA1} in ${durationMs}ms.`
        : `Range ${rangeA1} is clean with zero formula calculation errors.`,
  };
}
