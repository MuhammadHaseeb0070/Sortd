import type { GuardedRangeOutput } from '../types';
import { colIndexToLetter, parseA1RangeBounds } from '../utils/univerBridge';
import { parseRobustNumber } from '../utils/dataHygiene';

/**
 * Token Safety Guard ("The Middle-Row Guillotine"):
 * Intercepts any 2D row read from Univer.
 * If total rows > 30, truncates to Head 15 + Tail 5, calculates fast in-memory
 * summary stats on the full dataset (with true cardinality and accurate offset column letters),
 * and prevents blowing LLM token limits.
 */
export function guardRangeOutput(
  rows2D: any[][],
  formulas2D: any[][],
  rangeA1: string,
  options?: { page?: number; pageSize?: number; projectedColLetters?: string[] }
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

  const parsedBounds = parseA1RangeBounds(rangeA1);
  const startColOffset = parsedBounds.startCol;

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
    const colKey =
      options?.projectedColLetters?.[c] || colIndexToLetter(startColOffset + c);
    let numericCount = 0;
    let minVal: number | undefined = undefined;
    let maxVal: number | undefined = undefined;
    let nullCount = 0;
    const uniqueValues = new Set<string>();

    for (let r = 0; r < totalRows; r++) {
      const val = rows2D[r]?.[c];
      if (val === undefined || val === null || val === '') {
        nullCount++;
      } else {
        if (uniqueValues.size < 25000) {
          uniqueValues.add(String(val).trim());
        }

        const num = parseRobustNumber(val);
        if (num !== null) {
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
    notice: `Range contains ${totalRows} rows (middle ${omittedMiddleRows} rows omitted for token safety). DO NOT attempt to read all rows in smaller slice loops. Use vectorized tools ('inspect_and_cluster_categories', 'aggregate_multilevel_groupby', 'transform_range', or 'mutate_cells' with formulaTemplate) for full-sheet operations.`,
  };
}
