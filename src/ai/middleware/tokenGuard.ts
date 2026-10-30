import { GuardedRangeOutput } from '../types';
import { colIndexToLetter } from '../radar';

/**
 * Token Safety Guard ("The Middle-Row Guillotine"):
 * Intercepts any 2D row read from Univer.
 * If total rows > 30, truncates to Head 15 + Tail 5, calculates fast in-memory
 * summary stats on the full dataset, and prevents blowing LLM token limits.
 */
export function guardRangeOutput(
  rows2D: any[][],
  formulas2D: any[][],
  rangeA1: string,
  options?: { page?: number; pageSize?: number }
): GuardedRangeOutput {
  const totalRows = rows2D ? rows2D.length : 0;

  if (totalRows <= 30) {
    return {
      range: rangeA1,
      totalRows,
      truncated: false,
      rows: rows2D || [],
      formulas: formulas2D || [],
    };
  }

  const first15 = rows2D.slice(0, 15);
  const last5 = rows2D.slice(-5);
  const omittedMiddleRows = totalRows - 20;

  // Compute fast in-memory column summary stats across the full row dataset
  const columnCount = rows2D[0] ? rows2D[0].length : 0;
  const columnStats: Record<
    string,
    {
      numericCount: number;
      min?: number;
      max?: number;
      nullCount: number;
      uniqueCount: number;
    }
  > = {};

  for (let c = 0; c < columnCount; c++) {
    const colKey = colIndexToLetter(c);
    let numericCount = 0;
    let minVal: number | undefined = undefined;
    let maxVal: number | undefined = undefined;
    let nullCount = 0;
    const uniqueValues = new Set<any>();

    for (let r = 0; r < totalRows; r++) {
      const val = rows2D[r]?.[c];
      if (val === undefined || val === null || val === '') {
        nullCount++;
      } else {
        if (uniqueValues.size < 50) {
          uniqueValues.add(val);
        }

        const num = typeof val === 'number' ? val : Number(val);
        if (!isNaN(num) && typeof val !== 'boolean') {
          numericCount++;
          if (minVal === undefined || num < minVal) minVal = num;
          if (maxVal === undefined || num > maxVal) maxVal = num;
        }
      }
    }

    columnStats[colKey] = {
      numericCount,
      min: minVal,
      max: maxVal,
      nullCount,
      uniqueCount: uniqueValues.size,
    };
  }

  return {
    range: rangeA1,
    totalRows,
    truncated: true,
    omittedMiddleRows,
    first15Rows: first15,
    last5Rows: last5,
    columnStats,
    notice: `Range contains ${totalRows} rows (middle ${omittedMiddleRows} rows omitted for token safety). DO NOT attempt to read all rows in smaller slice loops. Use 'transform_range' for bulk cleaning/casting, 'mutate_cells' with formulaTemplate for calculations, or 'inspect_range' with 'filter' / 'columns' for targeted records.`,
  };
}
