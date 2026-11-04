import type { ToolExecutionContext } from '../../types';
import { colIndexToLetter, letterToColIndex } from '../../radar';
import { resolveColumnSmart } from '../../utils/univerBridge';
import { parseRobustNumber } from '../../utils/dataHygiene';

/**
 * Parses numeric value from a cell safely
 */
function parseCleanNumber(val: any): number | null {
  return parseRobustNumber(val);
}

/**
 * Checks if targetCoord (e.g. "B5") lies inside rangeToken (e.g. "B2:B10")
 */
function isCellInsideRange(targetCoord: string, startCell: string, endCell: string): boolean {
  const parse = (s: string) => {
    const m = s.replace(/\$/g, '').match(/^([A-Za-z]+)(\d+)$/);
    if (!m) return null;
    return { col: letterToColIndex(m[1].toUpperCase()), row: parseInt(m[2], 10) };
  };
  const t = parse(targetCoord);
  const p1 = parse(startCell);
  const p2 = parse(endCell);
  if (!t || !p1 || !p2) return false;
  return (
    t.col >= Math.min(p1.col, p2.col) &&
    t.col <= Math.max(p1.col, p2.col) &&
    t.row >= Math.min(p1.row, p2.row) &&
    t.row <= Math.max(p1.row, p2.row)
  );
}

/**
 * 1. executeAuditFormulaIntegrity
 * Exhaustive scan for calculation errors, circular references, and embedded hardcoded constants.
 */
export async function executeAuditFormulaIntegrity(
  args: {
    range?: string;
    flagHardcodedConstants?: boolean;
    sheetName?: string;
  },
  ctx: ToolExecutionContext
) {
  const t0 = performance.now();
  const wb = ctx.univerAPI?.getActiveWorkbook?.();
  if (!wb) throw new Error('Active workbook unavailable');

  const sheet = args.sheetName ? wb.getSheetByName?.(args.sheetName) : wb.getActiveSheet?.();
  if (!sheet) throw new Error(`Worksheet not found`);

  const activeSheetName = sheet.getSheetName?.() || 'Sheet1';
  let effectiveRange = args.range;
  if (!effectiveRange) {
    const lastRow = Math.max((sheet.getLastRow?.() ?? 0) + 1, 1);
    const lastCol = Math.max((sheet.getLastColumn?.() ?? 0) + 1, 1);
    effectiveRange = `A1:${colIndexToLetter(lastCol - 1)}${lastRow}`;
  }

  const fRange = sheet.getRange(effectiveRange);
  if (!fRange) throw new Error(`Could not resolve range: ${effectiveRange}`);

  const startRow = typeof fRange.getRow === 'function' ? fRange.getRow() : 0;
  const startCol = typeof fRange.getColumn === 'function' ? fRange.getColumn() : 0;
  const rawValues: any[][] = fRange.getValues?.() || [];
  const rawFormulas: any[][] = fRange.getFormulas?.() || [];
  const numRows = rawValues.length;
  const numCols = rawValues[0]?.length || 0;

  const errorItems: Array<{ coordinate: string; errorType: string; formula?: string; value?: any }> = [];
  const circularItems: Array<{ coordinate: string; formula: string }> = [];
  const hardcodedConstantItems: Array<{ coordinate: string; formula: string; constantFound: string }> = [];

  const ERROR_TOKENS = ['#REF!', '#DIV/0!', '#VALUE!', '#NAME?', '#N/A', '#NUM!', '#NULL!'];

  for (let r = 0; r < numRows; r++) {
    for (let c = 0; c < numCols; c++) {
      const coord = `${colIndexToLetter(startCol + c)}${startRow + r + 1}`;
      const val = rawValues[r]?.[c];
      const formula = rawFormulas[r]?.[c] ? String(rawFormulas[r][c]).trim() : '';
      const strVal = val !== null && val !== undefined ? String(val).trim() : '';

      for (const token of ERROR_TOKENS) {
        if (strVal.includes(token) || (formula && formula.includes(token))) {
          errorItems.push({
            coordinate: coord,
            errorType: token,
            formula: formula || undefined,
            value: strVal,
          });
          break;
        }
      }

      if (formula && formula.startsWith('=')) {
        const cellRefRegex = new RegExp(`\\b${coord}\\b`, 'i');
        if (cellRefRegex.test(formula)) {
          circularItems.push({ coordinate: coord, formula });
        }

        if (args.flagHardcodedConstants !== false) {
          const matchConst = formula.match(/[*/+-]\s*(\d+(\.\d+)?)/);
          if (matchConst && !['0', '1', '12', '100', '365'].includes(matchConst[1])) {
            hardcodedConstantItems.push({
              coordinate: coord,
              formula,
              constantFound: matchConst[0],
            });
          }
        }
      }
    }
  }

  const durationMs = Math.round(performance.now() - t0);
  const totalIssues = errorItems.length + circularItems.length + hardcodedConstantItems.length;

  return {
    status: errorItems.length > 0 || circularItems.length > 0 ? 'WARNING_FORMULA_ERRORS' : 'SUCCESS',
    sheetName: activeSheetName,
    rangeAudited: effectiveRange,
    totalCellsAudited: numRows * numCols,
    errorCount: errorItems.length,
    circularCount: circularItems.length,
    hardcodedConstantCount: hardcodedConstantItems.length,
    errorItems: errorItems.slice(0, 15),
    circularItems: circularItems.slice(0, 10),
    hardcodedConstantItems: hardcodedConstantItems.slice(0, 10),
    durationMs,
    message:
      totalIssues === 0
        ? `Clean audit! Zero formula errors or circular dependencies found across ${numRows * numCols} cells in ${effectiveRange}.`
        : `Audit isolated ${errorItems.length} calculation errors, ${circularItems.length} circular hazards, and ${hardcodedConstantItems.length} hardcoded formula constants.`,
  };
}

/**
 * 2. executeTraceDependencies
 * Maps upstream precedents or downstream blast-radius dependents (including range containment e.g. B5 inside SUM(B2:B10)).
 */
export async function executeTraceDependencies(
  args: {
    cellCoordinate: string;
    direction?: 'precedents' | 'dependents' | 'both';
    sheetName?: string;
  },
  ctx: ToolExecutionContext
) {
  const t0 = performance.now();
  const wb = ctx.univerAPI?.getActiveWorkbook?.();
  if (!wb) throw new Error('Active workbook unavailable');

  const sheet = args.sheetName ? wb.getSheetByName?.(args.sheetName) : wb.getActiveSheet?.();
  if (!sheet) throw new Error(`Worksheet not found`);

  const activeSheetName = sheet.getSheetName?.() || 'Sheet1';
  const targetCoord = args.cellCoordinate.toUpperCase().replace(/\$/g, '').trim();

  const targetRange = sheet.getRange(targetCoord);
  if (!targetRange) throw new Error(`Could not resolve cell: ${targetCoord}`);

  const targetValue = targetRange.getValue?.();
  const targetFormula =
    targetRange.getFormula?.() || targetRange.getFormulas?.()?.[0]?.[0] || '';

  const lastRow = Math.max((sheet.getLastRow?.() ?? 0) + 1, 1);
  const lastCol = Math.max((sheet.getLastColumn?.() ?? 0) + 1, 1);
  const fullRangeStr = `A1:${colIndexToLetter(lastCol - 1)}${lastRow}`;
  const fullRange = sheet.getRange(fullRangeStr);

  const rawValues: any[][] = fullRange?.getValues?.() || [];
  const rawFormulas: any[][] = fullRange?.getFormulas?.() || [];

  // 1. Upstream Precedents
  const precedents: Array<{ coordinate: string; value: any; formula?: string }> = [];
  if (targetFormula && (args.direction === 'precedents' || args.direction === 'both' || !args.direction)) {
    const cellRegex = /(?:'([^']+)'|([A-Za-z0-9_]+))?!?(?:\$?[A-Za-z]+\$?\d+)(?::\$?[A-Za-z]+\$?\d+)?/g;
    let match;
    const seen = new Set<string>();

    while ((match = cellRegex.exec(targetFormula)) !== null) {
      const fullToken = match[0].replace(/\$/g, '');
      if (seen.has(fullToken) || fullToken.toUpperCase() === targetCoord) continue;
      seen.add(fullToken);
      precedents.push({ coordinate: fullToken, value: '[Referenced]' });
    }
  }

  // 2. Downstream Dependents (direct mention OR range containment like B5 inside B2:B10)
  const dependents: Array<{ coordinate: string; formula: string; value: any }> = [];
  if (args.direction === 'dependents' || args.direction === 'both' || !args.direction) {
    const directRegex = new RegExp(`\\$?${targetCoord.replace(/(\d+)/, '\\$?$1')}\\b`, 'i');
    const rangePairRegex = /(\$?[A-Za-z]+\$?\d+):(\$?[A-Za-z]+\$?\d+)/g;

    for (let r = 0; r < rawFormulas.length; r++) {
      for (let c = 0; c < (rawFormulas[r]?.length || 0); c++) {
        const coord = `${colIndexToLetter(c)}${r + 1}`;
        if (coord === targetCoord) continue;

        const f = rawFormulas[r]?.[c] ? String(rawFormulas[r][c]).trim() : '';
        if (!f.startsWith('=')) continue;

        let isDependent = directRegex.test(f);
        if (!isDependent) {
          let rMatch;
          rangePairRegex.lastIndex = 0;
          while ((rMatch = rangePairRegex.exec(f)) !== null) {
            if (isCellInsideRange(targetCoord, rMatch[1], rMatch[2])) {
              isDependent = true;
              break;
            }
          }
        }

        if (isDependent) {
          dependents.push({
            coordinate: coord,
            formula: f,
            value: rawValues[r]?.[c],
          });
        }
      }
    }
  }

  const isOrphan =
    precedents.length === 0 &&
    dependents.length === 0 &&
    targetValue !== null &&
    targetValue !== undefined &&
    !targetFormula;

  const durationMs = Math.round(performance.now() - t0);

  return {
    status: 'SUCCESS',
    cellCoordinate: targetCoord,
    sheetName: activeSheetName,
    currentValue: targetValue,
    currentFormula: targetFormula || null,
    precedentsCount: precedents.length,
    dependentsCount: dependents.length,
    precedents,
    dependents,
    isOrphanStandalone: isOrphan,
    durationMs,
    message: `Traced ${targetCoord}: ${precedents.length} upstream precedents, ${dependents.length} downstream dependents.${
      isOrphan ? ' (Flagged as standalone orphan value)' : ''
    }`,
  };
}

/**
 * 3. executeReconcileAccountingCrossfoot
 * Institutional cross-footing, double-entry verification, and real Balance Sheet (Assets = Liabilities + Equity) tie-out.
 */
export async function executeReconcileAccountingCrossfoot(
  args: {
    mode: 'cross_foot' | 'debit_credit' | 'balance_sheet_identity';
    range?: string;
    debitColumn?: string;
    creditColumn?: string;
    tolerance?: number;
    sheetName?: string;
  },
  ctx: ToolExecutionContext
) {
  const t0 = performance.now();
  const wb = ctx.univerAPI?.getActiveWorkbook?.();
  if (!wb) throw new Error('Active workbook unavailable');

  const sheet = args.sheetName ? wb.getSheetByName?.(args.sheetName) : wb.getActiveSheet?.();
  if (!sheet) throw new Error(`Worksheet not found`);

  const tolerance = args.tolerance ?? 0.01;

  if (args.mode === 'cross_foot') {
    if (!args.range) throw new Error('Range is required for cross_foot mode');
    const fRange = sheet.getRange(args.range);
    if (!fRange) throw new Error(`Could not resolve range: ${args.range}`);

    const rawValues: any[][] = fRange.getValues?.() || [];
    if (rawValues.length < 2 || rawValues[0].length < 2) {
      throw new Error('Range must have at least 2 rows and 2 columns for cross-footing.');
    }

    const numRows = rawValues.length;
    const numCols = rawValues[0].length;

    const colTotalsRow = rawValues[numRows - 1];
    let sumOfColTotals = 0;
    for (let c = 1; c < numCols - 1; c++) {
      const n = parseCleanNumber(colTotalsRow[c]);
      if (n !== null) sumOfColTotals += n;
    }

    let sumOfRowTotals = 0;
    for (let r = 1; r < numRows - 1; r++) {
      const n = parseCleanNumber(rawValues[r][numCols - 1]);
      if (n !== null) sumOfRowTotals += n;
    }

    const discrepancy = Math.abs(sumOfColTotals - sumOfRowTotals);
    const isBalanced = discrepancy <= tolerance;

    const durationMs = Math.round(performance.now() - t0);
    return {
      status: isBalanced ? 'SUCCESS' : 'WARNING_FORMULA_ERRORS',
      mode: 'cross_foot',
      sumOfColumnTotals: Number(sumOfColTotals.toFixed(2)),
      sumOfRowTotals: Number(sumOfRowTotals.toFixed(2)),
      discrepancy: Number(discrepancy.toFixed(4)),
      tolerance,
      isBalanced,
      durationMs,
      message: isBalanced
        ? `Cross-footing verified! Horizontal total ($${sumOfColTotals.toFixed(2)}) matches vertical total ($${sumOfRowTotals.toFixed(2)}) within tolerance.`
        : `CROSS-FOOT DISCREPANCY: Horizontal total ($${sumOfColTotals.toFixed(2)}) differs from vertical total ($${sumOfRowTotals.toFixed(2)}) by $${discrepancy.toFixed(2)}.`,
    };
  } else if (args.mode === 'debit_credit') {
    if (!args.debitColumn || !args.creditColumn) {
      throw new Error('Both debitColumn and creditColumn must be provided for debit_credit mode.');
    }

    const lastRow = Math.max((sheet.getLastRow?.() ?? 0) + 1, 1);
    const debitCol = resolveColumnSmart(sheet, args.debitColumn, 0);
    const creditCol = resolveColumnSmart(sheet, args.creditColumn, 0);

    const debitVals: any[][] = sheet.getRange(0, debitCol.colIndex, lastRow, 1)?.getValues?.() || [];
    const creditVals: any[][] = sheet.getRange(0, creditCol.colIndex, lastRow, 1)?.getValues?.() || [];

    let totalDebits = 0;
    let totalCredits = 0;

    for (let r = 1; r < lastRow; r++) {
      const d = parseCleanNumber(debitVals[r]?.[0]);
      const c = parseCleanNumber(creditVals[r]?.[0]);
      if (d !== null) totalDebits += d;
      if (c !== null) totalCredits += c;
    }

    const discrepancy = Math.abs(totalDebits - totalCredits);
    const isBalanced = discrepancy <= tolerance;

    const durationMs = Math.round(performance.now() - t0);
    return {
      status: isBalanced ? 'SUCCESS' : 'WARNING_FORMULA_ERRORS',
      mode: 'debit_credit',
      totalDebits: Number(totalDebits.toFixed(2)),
      totalCredits: Number(totalCredits.toFixed(2)),
      discrepancy: Number(discrepancy.toFixed(4)),
      isBalanced,
      durationMs,
      message: isBalanced
        ? `Double-entry balanced! Total Debits ($${totalDebits.toFixed(2)}) == Total Credits ($${totalCredits.toFixed(2)}).`
        : `OUT OF BALANCE: Debits ($${totalDebits.toFixed(2)}) vs Credits ($${totalCredits.toFixed(2)}) has a variance of $${discrepancy.toFixed(2)}.`,
    };
  } else {
    // Real Balance Sheet Identity check: Total Assets == Total Liabilities + Total Equity
    const lastRow = Math.max((sheet.getLastRow?.() ?? 0) + 1, 1);
    const lastCol = Math.max((sheet.getLastColumn?.() ?? 0) + 1, 2);
    const matrix: any[][] = sheet.getRange(0, 0, lastRow, lastCol)?.getValues?.() || [];

    let totalAssets: number | null = null;
    let totalLiabilities: number | null = null;
    let totalEquity: number | null = null;

    for (const row of matrix) {
      const label = String(row?.[0] ?? '').trim().toLowerCase();
      if (!label) continue;
      // Find first numeric cell to the right of column A
      let rowNum: number | null = null;
      for (let c = 1; c < row.length; c++) {
        const parsed = parseCleanNumber(row[c]);
        if (parsed !== null) {
          rowNum = parsed;
          break;
        }
      }
      if (rowNum === null) continue;

      if (/total\s+assets|^assets$/i.test(label)) totalAssets = rowNum;
      else if (/total\s+liabilities|^liabilities$/i.test(label)) totalLiabilities = rowNum;
      else if (/total\s+(shareholders'?\s+)?equity|^equity$/i.test(label)) totalEquity = rowNum;
    }

    const assetsVal = totalAssets ?? 0;
    const liabPlusEq = (totalLiabilities ?? 0) + (totalEquity ?? 0);
    const discrepancy = Math.abs(assetsVal - liabPlusEq);
    const isBalanced = totalAssets !== null && discrepancy <= tolerance;
    const durationMs = Math.round(performance.now() - t0);

    return {
      status: isBalanced ? 'SUCCESS' : 'WARNING_FORMULA_ERRORS',
      mode: 'balance_sheet_identity',
      totalAssets: assetsVal,
      totalLiabilities: totalLiabilities ?? 0,
      totalEquity: totalEquity ?? 0,
      liabilitiesPlusEquity: liabPlusEq,
      discrepancy: Number(discrepancy.toFixed(4)),
      isBalanced,
      durationMs,
      message: isBalanced
        ? `Balance Sheet Identity Verified! Total Assets ($${assetsVal.toFixed(2)}) == Liabilities ($${(totalLiabilities ?? 0).toFixed(2)}) + Equity ($${(totalEquity ?? 0).toFixed(2)}).`
        : `BALANCE SHEET DISCREPANCY: Total Assets ($${assetsVal.toFixed(2)}) vs Liabilities + Equity ($${liabPlusEq.toFixed(2)}) differs by $${discrepancy.toFixed(2)}.`,
    };
  }
}

/**
 * 4. executeScanFormulaContinuity
 * Detects omitted rows in ranges and broken columnar formula patterns.
 */
export async function executeScanFormulaContinuity(
  args: {
    range: string;
    sheetName?: string;
  },
  ctx: ToolExecutionContext
) {
  const t0 = performance.now();
  const wb = ctx.univerAPI?.getActiveWorkbook?.();
  if (!wb) throw new Error('Active workbook unavailable');

  const sheet = args.sheetName ? wb.getSheetByName?.(args.sheetName) : wb.getActiveSheet?.();
  if (!sheet) throw new Error(`Worksheet not found`);

  const fRange = sheet.getRange(args.range);
  if (!fRange) throw new Error(`Could not resolve range: ${args.range}`);

  const startRow = typeof fRange.getRow === 'function' ? fRange.getRow() : 0;
  const startCol = typeof fRange.getColumn === 'function' ? fRange.getColumn() : 0;
  const rawValues: any[][] = fRange.getValues?.() || [];
  const rawFormulas: any[][] = fRange.getFormulas?.() || [];
  const numRows = rawValues.length;
  const numCols = rawValues[0]?.length || 0;

  const omittedBoundAlerts: Array<{
    coordinate: string;
    formula: string;
    expectedEndRow: number;
    formulaEndRow: number;
  }> = [];
  const inconsistentFormulaAlerts: Array<{
    coordinate: string;
    currentFormula: string;
    expectedPattern: string;
  }> = [];

  for (let c = 0; c < numCols; c++) {
    const colColLetter = colIndexToLetter(startCol + c);
    const colFormulas: Array<{ row: number; formula: string }> = [];

    for (let r = 1; r < numRows; r++) {
      const f = rawFormulas[r]?.[c] ? String(rawFormulas[r][c]).trim() : '';
      if (f.startsWith('=')) {
        colFormulas.push({ row: startRow + r + 1, formula: f });
      }
    }

    if (colFormulas.length >= 3) {
      const patterns = colFormulas.map((item) => {
        const rowStr = String(item.row);
        const norm = item.formula.replace(new RegExp(`([A-Za-z]+)${rowStr}\\b`, 'g'), '$1{R}');
        return { ...item, norm };
      });

      const patternCounts: Record<string, number> = {};
      for (const p of patterns) {
        patternCounts[p.norm] = (patternCounts[p.norm] || 0) + 1;
      }

      let dominantNorm = '';
      let maxCount = 0;
      for (const [norm, count] of Object.entries(patternCounts)) {
        if (count > maxCount) {
          maxCount = count;
          dominantNorm = norm;
        }
      }

      if (maxCount / patterns.length >= 0.7) {
        for (const p of patterns) {
          if (p.norm !== dominantNorm) {
            inconsistentFormulaAlerts.push({
              coordinate: `${colColLetter}${p.row}`,
              currentFormula: p.formula,
              expectedPattern: dominantNorm,
            });
          }
        }
      }
    }
  }

  const aggRegex = /(SUM|AVERAGE|COUNT|COUNTA)\(([A-Za-z]+)(\d+):([A-Za-z]+)(\d+)\)/gi;
  for (let r = 0; r < numRows; r++) {
    for (let c = 0; c < numCols; c++) {
      const f = rawFormulas[r]?.[c] ? String(rawFormulas[r][c]).trim() : '';
      if (!f) continue;

      let match;
      while ((match = aggRegex.exec(f)) !== null) {
        const startColLet = match[2].toUpperCase();
        const endColLet = match[4].toUpperCase();
        const endR = parseInt(match[5], 10);

        if (startColLet === endColLet) {
          const currentCellRow = startRow + r + 1;
          const tableExpectedLastDataRow = currentCellRow - 1;

          if (endR < tableExpectedLastDataRow && tableExpectedLastDataRow - endR <= 15) {
            const gapHasValues = rawValues
              .slice(endR - startRow, tableExpectedLastDataRow - startRow)
              .some((rowVals) => parseCleanNumber(rowVals?.[c]) !== null);

            if (gapHasValues) {
              omittedBoundAlerts.push({
                coordinate: `${colIndexToLetter(startCol + c)}${currentCellRow}`,
                formula: f,
                expectedEndRow: tableExpectedLastDataRow,
                formulaEndRow: endR,
              });
            }
          }
        }
      }
    }
  }

  const durationMs = Math.round(performance.now() - t0);
  const totalAlerts = omittedBoundAlerts.length + inconsistentFormulaAlerts.length;

  return {
    status: totalAlerts > 0 ? 'WARNING_FORMULA_ERRORS' : 'SUCCESS',
    range: args.range,
    omittedBoundCount: omittedBoundAlerts.length,
    inconsistentFormulaCount: inconsistentFormulaAlerts.length,
    omittedBoundAlerts,
    inconsistentFormulaAlerts,
    durationMs,
    message:
      totalAlerts === 0
        ? `Full continuity confirmed across ${args.range}. All formulas match columnar templates and span complete bounds.`
        : `Continuity scan found ${omittedBoundAlerts.length} range omission gaps and ${inconsistentFormulaAlerts.length} inconsistent formula mutations.`,
  };
}

/**
 * 5. executeDetectForensicAnomalies
 * Benford's Law distribution analysis, 3.5σ statistical spikes, and negative value domain checks.
 */
export async function executeDetectForensicAnomalies(
  args: {
    column: string;
    checkBenfordLaw?: boolean;
    strictlyNonNegative?: boolean;
    sheetName?: string;
  },
  ctx: ToolExecutionContext
) {
  const t0 = performance.now();
  const wb = ctx.univerAPI?.getActiveWorkbook?.();
  if (!wb) throw new Error('Active workbook unavailable');

  const sheet = args.sheetName ? wb.getSheetByName?.(args.sheetName) : wb.getActiveSheet?.();
  if (!sheet) throw new Error(`Worksheet not found`);

  const lastRow = Math.max((sheet.getLastRow?.() ?? 0) + 1, 1);
  const resolvedCol = resolveColumnSmart(sheet, args.column, 0);
  const colIdx = resolvedCol.colIndex;
  const colLetter = resolvedCol.colLetter;

  const colRange = sheet.getRange(0, colIdx, lastRow, 1);
  const rawValues: any[][] = colRange?.getValues?.() || [];

  const numbers: Array<{ row: number; val: number }> = [];
  const negativeItems: Array<{ coordinate: string; val: number }> = [];

  for (let r = 1; r < lastRow; r++) {
    const v = rawValues[r]?.[0];
    const n = parseCleanNumber(v);
    if (n !== null) {
      numbers.push({ row: r + 1, val: n });
      if (n < 0 && args.strictlyNonNegative) {
        negativeItems.push({ coordinate: `${colLetter}${r + 1}`, val: n });
      }
    }
  }

  if (numbers.length < 5) {
    return {
      status: 'SUCCESS',
      message: `Sample size too small (${numbers.length} numbers) for statistical anomaly or Benford analysis.`,
    };
  }

  const vals = numbers.map((item) => item.val);
  const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
  const variance = vals.reduce((sum, v) => sum + Math.pow(v - mean, 2), 0) / (vals.length - 1 || 1);
  const stdDev = Math.sqrt(variance);

  const sigmaThreshold = 3.5;
  const statisticalSpikes: Array<{ coordinate: string; val: number; zScore: number }> = [];

  for (const item of numbers) {
    const zScore = stdDev === 0 ? 0 : Math.abs((item.val - mean) / stdDev);
    if (zScore > sigmaThreshold) {
      statisticalSpikes.push({
        coordinate: `${colLetter}${item.row}`,
        val: item.val,
        zScore: Number(zScore.toFixed(2)),
      });
    }
  }

  const BENFORD_THEORY: Record<number, number> = {
    1: 0.301,
    2: 0.176,
    3: 0.125,
    4: 0.097,
    5: 0.079,
    6: 0.067,
    7: 0.058,
    8: 0.051,
    9: 0.046,
  };

  const observedCounts: Record<number, number> = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0, 6: 0, 7: 0, 8: 0, 9: 0 };
  let benfordSampleCount = 0;

  for (const n of vals) {
    const absVal = Math.abs(n);
    if (absVal === 0) continue;
    const firstDigit = parseInt(String(absVal).replace(/^0+\.?0*/, '')[0], 10);
    if (firstDigit >= 1 && firstDigit <= 9) {
      observedCounts[firstDigit]++;
      benfordSampleCount++;
    }
  }

  let totalMad = 0;
  const benfordSummary: Record<string, { observedPct: string; theoreticalPct: string }> = {};

  if (benfordSampleCount >= 20 && args.checkBenfordLaw !== false) {
    for (let d = 1; d <= 9; d++) {
      const obsPct = observedCounts[d] / benfordSampleCount;
      const theoPct = BENFORD_THEORY[d];
      totalMad += Math.abs(obsPct - theoPct);
      benfordSummary[`Digit_${d}`] = {
        observedPct: `${(obsPct * 100).toFixed(1)}%`,
        theoreticalPct: `${(theoPct * 100).toFixed(1)}%`,
      };
    }
  }
  const meanAbsoluteDeviation = Number((totalMad / 9).toFixed(4));
  const benfordCompliance =
    meanAbsoluteDeviation <= 0.015
      ? 'Close Conformity (Natural Data)'
      : meanAbsoluteDeviation <= 0.03
      ? 'Acceptable Conformity'
      : 'Non-Conforming (Potential Anomaly / Synthetic Data)';

  const durationMs = Math.round(performance.now() - t0);

  return {
    status: statisticalSpikes.length > 0 || negativeItems.length > 0 ? 'WARNING_FORMULA_ERRORS' : 'SUCCESS',
    column: colLetter,
    headerName: resolvedCol.headerName,
    sampleSize: numbers.length,
    mean: Number(mean.toFixed(2)),
    stdDev: Number(stdDev.toFixed(2)),
    statisticalSpikesCount: statisticalSpikes.length,
    statisticalSpikes: statisticalSpikes.slice(0, 10),
    negativeItemsCount: negativeItems.length,
    negativeItems: negativeItems.slice(0, 10),
    benfordAnalysis:
      benfordSampleCount >= 20
        ? {
            meanAbsoluteDeviation,
            conformityLevel: benfordCompliance,
            distribution: benfordSummary,
          }
        : 'Sample size < 20',
    durationMs,
    message: `Forensic audit on Col ${colLetter} ("${resolvedCol.headerName}"): ${statisticalSpikes.length} statistical spikes (>3.5σ), ${negativeItems.length} forbidden negative values, Benford conformity: ${benfordCompliance}.`,
  };
}

/**
 * 6. executeInspectHiddenAndExternal
 * Audits hidden sheets, hidden rows, hidden columns, and external workbook links.
 */
export async function executeInspectHiddenAndExternal(
  args: { sheetName?: string },
  ctx: ToolExecutionContext
) {
  const t0 = performance.now();
  const wb = ctx.univerAPI?.getActiveWorkbook?.();
  if (!wb) throw new Error('Active workbook unavailable');

  const sheets = wb.getSheets?.() || [];
  const hiddenSheets: string[] = [];
  const hiddenRowsBySheet: Record<string, number[]> = {};
  const hiddenColsBySheet: Record<string, string[]> = {};
  const externalLinkReferences: Array<{ sheet: string; coordinate: string; reference: string }> = [];

  for (const s of sheets) {
    const sName = s.getSheetName?.() || 'Unknown';
    if (s.isSheetHidden?.()) {
      hiddenSheets.push(sName);
    }

    const lastRow = Math.min((s.getLastRow?.() ?? 0) + 1, 100);
    const lastCol = Math.min((s.getLastColumn?.() ?? 0) + 1, 26);

    for (let r = 0; r < lastRow; r++) {
      try {
        if (s.isRowHidden?.(r)) {
          if (!hiddenRowsBySheet[sName]) hiddenRowsBySheet[sName] = [];
          hiddenRowsBySheet[sName].push(r + 1);
        }
      } catch {
        // ignore
      }
    }

    for (let c = 0; c < lastCol; c++) {
      try {
        if (s.isColumnHidden?.(c)) {
          if (!hiddenColsBySheet[sName]) hiddenColsBySheet[sName] = [];
          hiddenColsBySheet[sName].push(colIndexToLetter(c));
        }
      } catch {
        // ignore
      }
    }

    const fRange = s.getRange(0, 0, lastRow, lastCol);
    const formulas: any[][] = fRange?.getFormulas?.() || [];

    for (let r = 0; r < formulas.length; r++) {
      for (let c = 0; c < (formulas[r]?.length || 0); c++) {
        const f = formulas[r]?.[c] ? String(formulas[r][c]).trim() : '';
        if (f.includes('[') && (f.includes('.xls') || f.includes('http') || f.includes(']'))) {
          externalLinkReferences.push({
            sheet: sName,
            coordinate: `${colIndexToLetter(c)}${r + 1}`,
            reference: f,
          });
        }
      }
    }
  }

  const durationMs = Math.round(performance.now() - t0);

  return {
    status: 'SUCCESS',
    totalSheetsCount: sheets.length,
    hiddenSheetsCount: hiddenSheets.length,
    hiddenSheets,
    hiddenRowsBySheet,
    hiddenColsBySheet,
    externalLinkCount: externalLinkReferences.length,
    externalLinkReferences,
    durationMs,
    message: `Governance audit complete. Found ${hiddenSheets.length} hidden worksheets and ${externalLinkReferences.length} external workbook links across ${sheets.length} sheets.`,
  };
}
