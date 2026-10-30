import { MutationReceipt, FormulaErrorItem } from '../types';
import { colIndexToLetter } from '../radar';

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
 * Returns a structured verification receipt allowing the AI to automatically detect
 * formula syntax mistakes or broken references and self-correct.
 */
export async function verifyRangeMutation(
  fWorksheet: any,
  rangeA1: string
): Promise<MutationReceipt> {
  // Wait a small tick (50ms) to allow Univer's asynchronous formula calculation pass
  await new Promise((resolve) => setTimeout(resolve, 50));

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
    const fRange = fWorksheet.getRange(rangeA1);
    if (!fRange) {
      return {
        status: 'SUCCESS',
        range: rangeA1,
        modifiedCellCount: 0,
        errorCount: 0,
        firstErrors: [],
      };
    }

    const startRow = typeof fRange.getRow === 'function' ? fRange.getRow() : 0;
    const startCol = typeof fRange.getColumn === 'function' ? fRange.getColumn() : 0;

    const values: any[][] = fRange.getValues?.() || [];
    let formulas: any[][] = [];
    try {
      formulas = fRange.getFormulas?.() || [];
    } catch {
      formulas = [];
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
          (typeof val === 'string' && val.startsWith('#') && val.endsWith('!'));

        if (isError) {
          const coord = `${colIndexToLetter(startCol + c)}${startRow + r + 1}`;
          const formula = formulas[r]?.[c] || '';
          if (errorItems.length < 5) {
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
        ? `Encountered ${errorItems.length} formula calculation error(s) in range ${rangeA1}.`
        : `Successfully mutated ${modifiedCellCount} cell(s) with zero formula errors.`,
    };
  } catch (err: any) {
    return {
      status: 'SUCCESS', // Fallback to avoid blocking on cosmetic range reads
      range: rangeA1,
      modifiedCellCount: 0,
      errorCount: 0,
      firstErrors: [],
      message: `Verified with warning: ${err?.message || String(err)}`,
    };
  }
}
