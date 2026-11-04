import type { MutationReceipt, FormulaErrorItem } from '../types';
import { colIndexToLetter, parseA1RangeBounds } from '../utils/univerBridge';

const EXCEL_ERROR_TOKENS = new Set([
  '#REF!',
  '#NAME?',
  '#VALUE!',
  '#DIV/0!',
  '#N/A',
  '#ERROR!',
  '#NUM!',
  '#NULL!',
  '#CALC!',
  '#SPILL!',
]);

/**
 * Scans a range after mutation to verify if any formulas evaluated to error tokens.
 * Never swallows null ranges or exceptions as fake SUCCESS.
 */
export async function verifyRangeMutation(
  fWorksheet: any,
  rangeA1: string
): Promise<MutationReceipt> {
  // Initial tick to allow Univer's asynchronous formula calculation pass
  await new Promise((resolve) => setTimeout(resolve, 40));

  if (!fWorksheet) {
    return {
      status: 'ERROR',
      range: rangeA1,
      modifiedCellCount: 0,
      errorCount: 1,
      firstErrors: [{ coordinate: rangeA1, value: 'Worksheet reference is unavailable' }],
      message: 'Failed to access active worksheet for verification.',
    };
  }

  try {
    const fRange = fWorksheet.getRange?.(rangeA1);
    if (!fRange) {
      return {
        status: 'ERROR',
        range: rangeA1,
        modifiedCellCount: 0,
        errorCount: 1,
        firstErrors: [{ coordinate: rangeA1, value: 'Range reference resolved to null' }],
        message: `Failed to resolve range ${rangeA1} on worksheet for verification.`,
      };
    }

    const parsedBounds = parseA1RangeBounds(rangeA1);
    const startRow = typeof fRange.getRow === 'function' ? fRange.getRow() : parsedBounds.startRow;
    const startCol =
      typeof fRange.getColumn === 'function' ? fRange.getColumn() : parsedBounds.startCol;

    let formulas: any[][] = [];
    try {
      formulas = fRange.getFormulas?.() || [];
    } catch {
      formulas = [];
    }

    let values: any[][] = fRange.getValues?.() || [];

    // If formulas exist and values are still empty/null on large ranges, wait one extra tick
    const hasAnyFormula = formulas.some((row) =>
      Array.isArray(row) && row.some((cell) => typeof cell === 'string' && cell.startsWith('='))
    );
    const hasPendingFormulaEval =
      hasAnyFormula &&
      values.some((row, rIdx) =>
        Array.isArray(row) &&
        row.some(
          (val, cIdx) =>
            formulas[rIdx]?.[cIdx] && (val === null || val === undefined || val === '')
        )
      );

    if (hasPendingFormulaEval) {
      await new Promise((resolve) => setTimeout(resolve, 60));
      values = fRange.getValues?.() || [];
    }

    let modifiedCellCount = 0;
    const errorItems: FormulaErrorItem[] = [];

    for (let r = 0; r < values.length; r++) {
      const row = values[r] || [];
      for (let c = 0; c < row.length; c++) {
        modifiedCellCount++;
        const val = row[c];
        const valStr = String(val ?? '').trim().toUpperCase();

        const isError =
          EXCEL_ERROR_TOKENS.has(valStr) ||
          (typeof val === 'string' &&
            val.startsWith('#') &&
            (val.endsWith('!') || val.endsWith('?')));

        if (isError) {
          const coord = `${colIndexToLetter(startCol + c)}${startRow + r + 1}`;
          const formula = formulas[r]?.[c] || '';
          if (errorItems.length < 10) {
            errorItems.push({
              coordinate: coord,
              formula: formula || undefined,
              value: val,
            });
          }
        }
      }
    }

    const hasErrors = errorItems.length > 0;

    return {
      status: hasErrors ? 'WARNING_FORMULA_ERRORS' : 'SUCCESS',
      range: rangeA1,
      modifiedCellCount,
      errorCount: errorItems.length,
      firstErrors: errorItems,
      sampleResultPreview: values.slice(0, 5),
      message: hasErrors
        ? `Encountered ${errorItems.length} formula calculation error(s) in range ${rangeA1}. Inspect 'firstErrors' and repair broken syntax/references.`
        : `Successfully mutated ${modifiedCellCount} cell(s) in ${rangeA1} with zero formula errors.`,
    };
  } catch (err: any) {
    return {
      status: 'ERROR',
      range: rangeA1,
      modifiedCellCount: 0,
      errorCount: 1,
      firstErrors: [{ coordinate: rangeA1, value: err?.message || String(err) }],
      message: `Verification failed on range ${rangeA1}: ${err?.message || String(err)}`,
    };
  }
}
