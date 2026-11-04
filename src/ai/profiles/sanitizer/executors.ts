import type { ToolExecutionContext } from '../../types';
import { colIndexToLetter, letterToColIndex } from '../../radar';
import {
  resolveColumnSmart,
  resolveWorksheet,
  ensureSheetCapacity,
  detectTableHeaderRow,
  parseA1RangeBounds,
} from '../../utils/univerBridge';
import {
  jaroWinklerSimilarity,
  parseRobustNumber,
  clusterCategoryValues,
  detectEmbeddedSubtotalRows,
} from '../../utils/dataHygiene';

// Safe fuzzy string similarity (0.0 to 1.0) without the broken substring includes() shortcut!
function calculateStringSimilarity(s1: string, s2: string): number {
  const str1 = String(s1 || '').toLowerCase().trim();
  const str2 = String(s2 || '').toLowerCase().trim();
  if (str1 === str2) return 1.0;
  if (!str1 || !str2) return 0.0;

  // Never merge strings with different word counts (e.g. "North" vs "North America")
  // or short 3-letter names vs 4-letter names ("Jan" vs "Jane")
  const words1 = str1.split(/\s+/);
  const words2 = str2.split(/\s+/);
  if (words1.length !== words2.length) return 0.0;
  if (Math.min(str1.length, str2.length) <= 3 && str1.length !== str2.length) {
    return 0.0;
  }

  return jaroWinklerSimilarity(str1, str2);
}

/**
 * Resolves a column identifier (Row 1 header name FIRST, then Excel letter like "A" / "BC")
 */
function resolveColumn(
  sheet: any,
  ref: string | number,
  headerRowIdx: number = 0
): { colIndex: number; colLetter: string; headerName: string } {
  return resolveColumnSmart(sheet, ref, headerRowIdx);
}

/**
 * Safe client-side dynamic expression evaluator with col(...) helper.
 */
function evaluateExpression(
  expressionStr: string,
  rowValues: Record<string, any>,
  rowNumber: number
): any {
  try {
    const colGetter = (key: string) => {
      const normKey = String(key).trim().toLowerCase();
      // Look up by letter or header
      for (const [k, v] of Object.entries(rowValues)) {
        if (k.toLowerCase() === normKey) return v;
      }
      return undefined;
    };

    const fn = new Function('col', 'row', 'data', `
      try {
        with (data) {
          return (${expressionStr});
        }
      } catch (err) {
        return null;
      }
    `);

    return fn(colGetter, rowNumber, rowValues);
  } catch {
    return null;
  }
}

/**
 * 1. SYNTHESIZE COLUMNS
 * Merge, compute, and synthesize multiple columns into a unified target column
 * using templates, delimiters, or custom JavaScript expressions.
 */
export async function executeSynthesizeColumns(
  args: {
    sheetName?: string;
    sourceColumns: string[];
    newHeader: string;
    targetColumn?: string;
    insertMode?: 'insert_new' | 'overwrite' | 'append';
    template?: string;
    delimiter?: string;
    skipEmpty?: boolean;
    expression?: string;
    rules?: Array<{ condition: string; template?: string; expression?: string }>;
    deleteSourceColumns?: boolean;
    startRow?: number;
    endRow?: number;
    targetSheetName?: string;
  },
  ctx: ToolExecutionContext
) {
  const t0 = performance.now();
  const {
    sheetName,
    sourceColumns,
    newHeader,
    targetColumn,
    insertMode = 'insert_new',
    template,
    delimiter = ' ',
    skipEmpty = true,
    expression,
    rules,
    deleteSourceColumns = false,
    startRow = 2,
    endRow,
    targetSheetName,
  } = args;

  const wb = ctx.univerAPI?.getActiveWorkbook?.();
  if (!wb) throw new Error('Univer active workbook unavailable');

  const srcSheet = sheetName ? wb.getSheetByName?.(sheetName) : wb.getActiveSheet?.();
  if (!srcSheet) throw new Error(`Worksheet ${sheetName || 'active'} not found`);

  const destSheet = targetSheetName
    ? wb.getSheetByName?.(targetSheetName) || wb.insertSheet?.(targetSheetName) || srcSheet
    : srcSheet;

  const lastSheetRow = Math.max((srcSheet.getLastRow?.() ?? 0) + 1, 1);
  const effectiveEndRow = endRow ? Math.min(endRow, lastSheetRow) : lastSheetRow;
  if (effectiveEndRow < startRow) {
    return { success: true, rowsSynthesized: 0, message: 'No data rows in specified range' };
  }

  // Resolve source columns and read all source columns BEFORE inserting any new column!
  const resolvedSources = sourceColumns.map((colRef) => resolveColumn(srcSheet, colRef, 0));
  const numDataRows = effectiveEndRow - startRow + 1;

  const sourceColumnData: Map<number, any[]> = new Map();
  for (const src of resolvedSources) {
    const rangeNotation = `${src.colLetter}${startRow}:${src.colLetter}${effectiveEndRow}`;
    const vals = srcSheet.getRange(rangeNotation)?.getValues?.() || [];
    sourceColumnData.set(
      src.colIndex,
      vals.map((r: any[]) => r[0])
    );
  }

  // Determine target column index
  let targetColIdx: number;
  if (insertMode === 'append') {
    targetColIdx = (destSheet.getLastColumn?.() ?? 0) + 1;
  } else if (targetColumn) {
    targetColIdx = resolveColumn(destSheet, targetColumn, 0).colIndex;
  } else {
    const maxSourceIdx = Math.max(...resolvedSources.map((s) => s.colIndex));
    targetColIdx = maxSourceIdx + 1;
  }

  if (insertMode === 'insert_new') {
    destSheet.insertColumns?.(targetColIdx, 1);
  }
  ensureSheetCapacity(destSheet, effectiveEndRow, targetColIdx + 1);

  const escapeRegExp = (str: string) => str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  const synthesizedValues: any[][] = [];
  const samplesPreview: any[] = [];

  for (let i = 0; i < numDataRows; i++) {
    const currentRowNum = startRow + i;
    const rowDict: Record<string, any> = {};

    for (const src of resolvedSources) {
      const val = sourceColumnData.get(src.colIndex)?.[i];
      rowDict[src.colLetter] = val;
      if (src.headerName) rowDict[src.headerName] = val;
    }

    let resultValue: any = null;

    // Advanced Mode 1: Rule-based conditional branching
    if (rules && rules.length > 0) {
      for (const rule of rules) {
        if (!rule.condition || evaluateExpression(rule.condition, rowDict, currentRowNum)) {
          if (rule.expression) {
            resultValue = evaluateExpression(rule.expression, rowDict, currentRowNum);
          } else if (rule.template) {
            let compiled = rule.template;
            for (const [k, v] of Object.entries(rowDict)) {
              compiled = compiled.replace(
                new RegExp(`\\{${escapeRegExp(k)}\\}`, 'g'),
                v !== undefined && v !== null ? String(v) : ''
              );
            }
            resultValue = compiled;
          }
          break;
        }
      }
    }
    // Advanced Mode 2: Custom JavaScript expression
    else if (expression) {
      resultValue = evaluateExpression(expression, rowDict, currentRowNum);
    }
    // Mode 3: String template e.g. "{A} - {B}" or "{First Name} {Last Name}"
    else if (template) {
      let compiled = template;
      for (const [k, v] of Object.entries(rowDict)) {
        compiled = compiled.replace(
          new RegExp(`\\{${escapeRegExp(k)}\\}`, 'g'),
          v !== undefined && v !== null ? String(v) : ''
        );
      }
      resultValue = compiled;
    }
    // Mode 4: Basic delimiter join
    else {
      const parts = resolvedSources
        .map((src) => rowDict[src.colLetter])
        .filter((val) => !skipEmpty || (val !== undefined && val !== null && String(val).trim() !== ''))
        .map((val) => String(val).trim());
      resultValue = parts.join(delimiter);
    }

    synthesizedValues.push([resultValue]);
    if (samplesPreview.length < 5 && resultValue !== null && resultValue !== undefined && resultValue !== '') {
      samplesPreview.push(resultValue);
    }
  }

  // Write new Header
  const targetColLetter = colIndexToLetter(targetColIdx);
  destSheet.getRange(0, targetColIdx, 1, 1)?.setValues?.([[newHeader]]);

  // Write batch values
  const writeRange = `${targetColLetter}${startRow}:${targetColLetter}${effectiveEndRow}`;
  destSheet.getRange(writeRange)?.setValues?.(synthesizedValues);

  // If requested, clean up source columns (delete in descending order to preserve indexes)
  let deletedCols: string[] = [];
  if (deleteSourceColumns && srcSheet === destSheet) {
    const sortedIndicesDesc = [...new Set(resolvedSources.map((s) => s.colIndex))]
      .filter((idx) => idx !== targetColIdx)
      .sort((a, b) => b - a);

    for (const idx of sortedIndicesDesc) {
      srcSheet.deleteColumns?.(idx, 1);
      deletedCols.push(colIndexToLetter(idx));
    }
  }

  const durationMs = Math.round(performance.now() - t0);

  return {
    success: true,
    action: 'synthesize_columns',
    targetColumn: targetColLetter,
    headerCreated: newHeader,
    rowsSynthesized: synthesizedValues.length,
    samplesPreview,
    deletedSourceColumns: deletedCols.length > 0 ? deletedCols : undefined,
    durationMs,
    message: `Synthesized ${synthesizedValues.length} rows into Column ${targetColLetter} ("${newHeader}") in ${durationMs}ms.`,
  };
}

/**
 * 2. SPLIT COLUMN
 * Splits composite text columns into multiple new columns using delimiters,
 * fixed character widths, or regex capture groups.
 */
export async function executeSplitColumn(
  args: {
    sheetName?: string;
    sourceColumn: string;
    newHeaders: string[];
    splitBy?: 'delimiter' | 'fixed_width' | 'regex';
    delimiter?: string;
    widths?: number[];
    regexPattern?: string;
    maxSplits?: number;
    trimParts?: boolean;
    fallbackMode?: 'first_column' | 'last_column' | 'null';
    insertMode?: 'adjacent' | 'overwrite' | 'target_columns';
    targetColumns?: string[];
    deleteSourceColumn?: boolean;
    startRow?: number;
    endRow?: number;
  },
  ctx: ToolExecutionContext
) {
  const t0 = performance.now();
  const {
    sheetName,
    sourceColumn,
    newHeaders,
    splitBy = 'delimiter',
    delimiter = ' ',
    widths,
    regexPattern,
    maxSplits,
    trimParts = true,
    fallbackMode = 'first_column',
    insertMode = 'adjacent',
    targetColumns,
    deleteSourceColumn = false,
    startRow = 2,
    endRow,
  } = args;

  const wb = ctx.univerAPI?.getActiveWorkbook?.();
  if (!wb) throw new Error('Univer active workbook unavailable');

  const sheet = sheetName ? wb.getSheetByName?.(sheetName) : wb.getActiveSheet?.();
  if (!sheet) throw new Error(`Worksheet ${sheetName || 'active'} not found`);

  const src = resolveColumn(sheet, sourceColumn, 0);
  const lastSheetRow = Math.max((sheet.getLastRow?.() ?? 0) + 1, 1);
  const effectiveEndRow = endRow ? Math.min(endRow, lastSheetRow) : lastSheetRow;
  if (effectiveEndRow < startRow) {
    return { success: true, rowsSplit: 0, message: 'No rows to split' };
  }

  const numColsToCreate = newHeaders.length;
  if (numColsToCreate === 0) {
    throw new Error('split_column requires at least one header in "newHeaders"');
  }

  // Determine placement of new columns
  let startTargetColIdx: number;
  if (insertMode === 'adjacent') {
    startTargetColIdx = src.colIndex + 1;
    sheet.insertColumns?.(startTargetColIdx, numColsToCreate);
  } else if (insertMode === 'target_columns' && targetColumns && targetColumns.length > 0) {
    startTargetColIdx = resolveColumn(sheet, targetColumns[0], 0).colIndex;
  } else {
    // overwrite mode starts directly at source
    startTargetColIdx = src.colIndex;
  }

  // Read source column data
  const srcRange = `${src.colLetter}${startRow}:${src.colLetter}${effectiveEndRow}`;
  const rawValues = sheet.getRange(srcRange)?.getValues?.() || [];

  const splitMatrix: any[][] = [];
  const samplesPreview: any[] = [];
  const compiledRegex = regexPattern ? new RegExp(regexPattern) : null;

  for (let r = 0; r < rawValues.length; r++) {
    const rawCell = rawValues[r]?.[0];
    const cellStr = rawCell !== undefined && rawCell !== null ? String(rawCell) : '';

    let parts: string[] = [];

    if (!cellStr.trim()) {
      parts = new Array(numColsToCreate).fill('');
    } else if (splitBy === 'regex' && compiledRegex) {
      const match = compiledRegex.exec(cellStr);
      if (match) {
        if (match.groups && Object.keys(match.groups).length > 0) {
          // Use named capture groups matching newHeaders
          parts = newHeaders.map((h) => match.groups?.[h] || match.groups?.[h.toLowerCase()] || '');
        } else {
          // Use numbered capture groups match[1], match[2]...
          parts = [];
          for (let g = 1; g < match.length; g++) {
            parts.push(match[g] || '');
          }
        }
      } else {
        // No regex match fallback
        if (fallbackMode === 'last_column') {
          parts = new Array(numColsToCreate - 1).fill('').concat([cellStr]);
        } else if (fallbackMode === 'null') {
          parts = new Array(numColsToCreate).fill('');
        } else {
          parts = [cellStr].concat(new Array(numColsToCreate - 1).fill(''));
        }
      }
    } else if (splitBy === 'fixed_width' && widths && widths.length > 0) {
      let cursor = 0;
      parts = [];
      for (const w of widths) {
        parts.push(cellStr.slice(cursor, cursor + w));
        cursor += w;
      }
      if (cursor < cellStr.length) {
        parts.push(cellStr.slice(cursor));
      }
    } else {
      // Basic Delimiter Split
      if (maxSplits && maxSplits > 1) {
        const splitRaw = cellStr.split(delimiter);
        parts = splitRaw.slice(0, maxSplits - 1);
        parts.push(splitRaw.slice(maxSplits - 1).join(delimiter));
      } else {
        parts = cellStr.split(delimiter);
      }
    }

    if (trimParts) {
      parts = parts.map((p) => String(p || '').trim());
    }

    // Pad or truncate to exact column length
    while (parts.length < numColsToCreate) parts.push('');
    if (parts.length > numColsToCreate) parts = parts.slice(0, numColsToCreate);

    splitMatrix.push(parts);
    if (samplesPreview.length < 5 && parts.some((p) => p !== '')) {
      samplesPreview.push(parts);
    }
  }

  // Write new column headers at row 0
  const headerMatrix = [newHeaders];
  sheet
    .getRange(0, startTargetColIdx, 1, numColsToCreate)
    ?.setValues?.(headerMatrix);

  // Write split matrix to cells
  const firstTargetLetter = colIndexToLetter(startTargetColIdx);
  const lastTargetLetter = colIndexToLetter(startTargetColIdx + numColsToCreate - 1);
  const writeRange = `${firstTargetLetter}${startRow}:${lastTargetLetter}${effectiveEndRow}`;
  sheet.getRange(writeRange)?.setValues?.(splitMatrix);

  // Optionally delete original source column
  let deletedSource = false;
  if (deleteSourceColumn && insertMode !== 'overwrite') {
    // If we inserted columns to the right, source column index is unchanged
    // If we inserted to the left, adjust accordingly
    const actualSrcIdx = startTargetColIdx <= src.colIndex ? src.colIndex + numColsToCreate : src.colIndex;
    sheet.deleteColumns?.(actualSrcIdx, 1);
    deletedSource = true;
  }

  const durationMs = Math.round(performance.now() - t0);

  return {
    success: true,
    action: 'split_column',
    sourceColumn: src.colLetter,
    createdColumns: newHeaders.map((h, i) => `${colIndexToLetter(startTargetColIdx + i)} ("${h}")`),
    rowsSplit: splitMatrix.length,
    samplesPreview,
    deletedSourceColumn: deletedSource,
    durationMs,
    message: `Split column ${src.colLetter} into ${numColsToCreate} columns (${newHeaders.join(', ')}) across ${splitMatrix.length} rows in ${durationMs}ms.`,
  };
}

/**
 * 3. DEDUPLICATE DATASET
 * Robust duplicate row detection with exact/fuzzy matching, tie-breaker sorting,
 * duplicate coalescing (merging incomplete records), and quarantine/flagging actions.
 */
/**
 * Fast vectorized row deletion:
 * For <= 3 rows, deletes individually in descending order.
 * For > 3 rows, compacts the surviving table in-memory and writes back in 1 batch setValues call + 1 contiguous deleteRows call,
 * reducing 50+ row deletions from ~7,200ms down to ~40ms!
 */
function deleteRowsVectorized(
  sheet: any,
  fullTableValues: any[][],
  rowsToDeleteIndices: number[],
  lastSheetCol: number
): void {
  const uniqueDesc = [...new Set(rowsToDeleteIndices)].sort((a, b) => b - a);
  if (uniqueDesc.length === 0) return;

  if (uniqueDesc.length <= 3) {
    for (const rIdx of uniqueDesc) {
      sheet.deleteRows?.(rIdx, 1);
    }
    return;
  }

  const deleteSet = new Set(uniqueDesc);
  const survivingRows: any[][] = [];
  for (let r = 0; r < fullTableValues.length; r++) {
    if (!deleteSet.has(r)) {
      const row = fullTableValues[r] || [];
      const paddedRow: any[] = [];
      for (let c = 0; c < lastSheetCol; c++) {
        paddedRow.push(row[c] ?? null);
      }
      survivingRows.push(paddedRow);
    }
  }

  const deletedCount = uniqueDesc.length;
  if (survivingRows.length > 0) {
    sheet.getRange(0, 0, survivingRows.length, lastSheetCol)?.setValues?.(survivingRows);
  }
  try {
    sheet.getRange(survivingRows.length, 0, deletedCount, lastSheetCol)?.clear?.();
  } catch {
    // ignore
  }
  sheet.deleteRows?.(survivingRows.length, deletedCount);
}

export async function executeDeduplicateDataset(
  args: {
    sheetName?: string;
    keyColumns?: string[];
    conflictColumns?: string[];
    removeExactDuplicatesFirst?: boolean;
    matchMode?: 'exact' | 'fuzzy';
    fuzzyThreshold?: number;
    strategy?: 'keep_first' | 'keep_last';
    tieBreaker?: {
      column?: string;
      rule: 'max' | 'min' | 'most_complete' | 'expression';
      expression?: string;
    };
    coalesceDuplicates?: boolean;
    action?: 'delete_rows' | 'quarantine_to_sheet' | 'flag_column' | 'report_only';
    flagColumnHeader?: string;
    targetSheetName?: string;
    stripRepeatedHeaders?: boolean;
    startRow?: number;
    endRow?: number;
  },
  ctx: ToolExecutionContext
) {
  const t0 = performance.now();
  const {
    sheetName,
    keyColumns,
    conflictColumns,
    removeExactDuplicatesFirst,
    matchMode = 'exact',
    fuzzyThreshold = 0.85,
    strategy = 'keep_first',
    tieBreaker,
    coalesceDuplicates = false,
    action = 'delete_rows',
    flagColumnHeader = 'Is_Duplicate',
    targetSheetName,
    stripRepeatedHeaders = true,
    startRow,
    endRow,
  } = args;

  const wb = ctx.univerAPI?.getActiveWorkbook?.();
  if (!wb) throw new Error('Univer active workbook unavailable');

  const sheet = sheetName ? wb.getSheetByName?.(sheetName) : wb.getActiveSheet?.();
  if (!sheet) throw new Error(`Worksheet ${sheetName || 'active'} not found`);

  const lastSheetRow = Math.max((sheet.getLastRow?.() ?? 0) + 1, 1);
  const lastSheetCol = Math.max((sheet.getLastColumn?.() ?? 0) + 1, 1);
  const effectiveEndRow = endRow ? Math.min(endRow, lastSheetRow) : lastSheetRow;

  // Read full occupied table
  const fullRangeNotation = `A1:${colIndexToLetter(lastSheetCol - 1)}${effectiveEndRow}`;
  const fullTableValues: any[][] = sheet.getRange(fullRangeNotation)?.getValues?.() || [];

  // Auto-detect actual table header row (e.g. Row 4 when Row 1 is an ERP report title banner)
  const { headerRowIdx, headerVals: detectedHeaders } = detectTableHeaderRow(fullTableValues);
  const headers = detectedHeaders.length > 0 ? detectedHeaders : fullTableValues[0] || [];
  const effectiveStartRow = startRow !== undefined ? Math.max(startRow, headerRowIdx + 2) : headerRowIdx + 2;

  if (effectiveEndRow < effectiveStartRow) {
    return { success: true, duplicatesFound: 0, message: 'No rows to evaluate' };
  }

  // Exclude embedded subtotal / grand total rows from duplicate/conflict evaluation
  const subtotalTrapRows1Based = detectEmbeddedSubtotalRows(fullTableValues, true);
  const subtotalTrapZeroSet = new Set(subtotalTrapRows1Based.map((r1) => r1 - 1));

  let dataRowsWithIdx: Array<{ originalRowIdx: number; rowNumber: number; values: any[] }> = [];

  for (let r = effectiveStartRow - 1; r < fullTableValues.length; r++) {
    if (subtotalTrapZeroSet.has(r)) continue;
    const rowVals = fullTableValues[r] || [];
    const isCompletelyBlank = rowVals.every(
      (v: any) => v === undefined || v === null || String(v).trim() === ''
    );
    if (isCompletelyBlank) continue;

    dataRowsWithIdx.push({
      originalRowIdx: r,
      rowNumber: r + 1,
      values: rowVals,
    });
  }

  // Strip repeated header rows (e.g. from pagination or multi-page exports)
  let repeatedHeadersRemovedCount = 0;
  const repeatedRowIndices: number[] = [];
  if (stripRepeatedHeaders && headers.length >= 2) {
    for (const r of dataRowsWithIdx) {
      let matchCount = 0;
      let nonBlankCount = 0;
      for (let c = 0; c < headers.length; c++) {
        const hVal = String(headers[c] ?? '').trim().toLowerCase();
        const cellVal = String(r.values[c] ?? '').trim().toLowerCase();
        if (!hVal) continue;
        if (cellVal !== '') {
          nonBlankCount++;
          if (cellVal === hVal) matchCount++;
        }
      }
      if (nonBlankCount >= 2 && matchCount / nonBlankCount >= 0.7) {
        repeatedRowIndices.push(r.originalRowIdx);
      }
    }

    if (repeatedRowIndices.length > 0) {
      repeatedHeadersRemovedCount = repeatedRowIndices.length;
      const repeatedSet = new Set(repeatedRowIndices);
      dataRowsWithIdx = dataRowsWithIdx.filter((r) => !repeatedSet.has(r.originalRowIdx));
    }
  }

  // Resolve key column indices against the detected table header row
  let keyIndices: number[] = [];
  if (keyColumns && keyColumns.length > 0) {
    keyIndices = keyColumns.map((colRef) => resolveColumn(sheet, colRef, headerRowIdx).colIndex);
  } else {
    keyIndices = Array.from({ length: lastSheetCol }, (_, i) => i);
  }

  // Resolve conflict column indices if specified
  let conflictIndices: number[] = [];
  if (conflictColumns && conflictColumns.length > 0) {
    conflictIndices = conflictColumns.map((colRef) => resolveColumn(sheet, colRef, headerRowIdx).colIndex);
  }

  // If conflictColumns is specified AND (removeExactDuplicatesFirst is true OR action === 'delete_rows'),
  // automatically remove 100%-exact full-row duplicates FIRST (and strip repeated headers),
  // while keeping the conflicting rows intact for reporting!
  let exactDuplicatesRemovedBeforeConflict = 0;
  const preDeleteExactIndices: number[] = [];
  const shouldPreCleanExactDups =
    conflictIndices.length > 0 && (removeExactDuplicatesFirst === true || action === 'delete_rows');

  if (shouldPreCleanExactDups) {
    const seenExactRows = new Set<string>();
    const survivingDataRows: typeof dataRowsWithIdx = [];
    for (const r of dataRowsWithIdx) {
      const fullRowKey = Array.from({ length: lastSheetCol }, (_, c) =>
        String(r.values[c] ?? '').trim().toLowerCase()
      ).join('|||');
      if (seenExactRows.has(fullRowKey)) {
        preDeleteExactIndices.push(r.originalRowIdx);
      } else {
        seenExactRows.add(fullRowKey);
        survivingDataRows.push(r);
      }
    }
    exactDuplicatesRemovedBeforeConflict = preDeleteExactIndices.length;
    dataRowsWithIdx = survivingDataRows;
  }

  // Group duplicate / conflict rows
  const duplicateGroups: Array<Array<{ originalRowIdx: number; rowNumber: number; values: any[] }>> = [];
  const processedRowIndices = new Set<number>();

  for (let i = 0; i < dataRowsWithIdx.length; i++) {
    if (processedRowIndices.has(i)) continue;

    const baseRow = dataRowsWithIdx[i];
    const currentGroup = [baseRow];
    processedRowIndices.add(i);

    const baseKeyParts = keyIndices.map((kIdx) => String(baseRow.values[kIdx] ?? '').trim().toLowerCase());
    const baseKeyStr = baseKeyParts.join('|||');

    for (let j = i + 1; j < dataRowsWithIdx.length; j++) {
      if (processedRowIndices.has(j)) continue;

      const compareRow = dataRowsWithIdx[j];
      const compareKeyParts = keyIndices.map((kIdx) => String(compareRow.values[kIdx] ?? '').trim().toLowerCase());
      const compareKeyStr = compareKeyParts.join('|||');

      let isDuplicate = false;
      if (matchMode === 'exact') {
        isDuplicate = baseKeyStr === compareKeyStr;
      } else {
        const sim = calculateStringSimilarity(baseKeyStr, compareKeyStr);
        if (sim >= fuzzyThreshold) isDuplicate = true;
      }

      if (isDuplicate) {
        currentGroup.push(compareRow);
        processedRowIndices.add(j);
      }
    }

    if (currentGroup.length > 1) {
      if (conflictIndices.length > 0) {
        const hasConflict = conflictIndices.some((cIdx) => {
          const firstVal = String(currentGroup[0].values[cIdx] ?? '').trim().toLowerCase();
          return currentGroup.some(
            (r) => String(r.values[cIdx] ?? '').trim().toLowerCase() !== firstVal
          );
        });
        if (!hasConflict) {
          continue;
        }
      }

      duplicateGroups.push(currentGroup);
    }
  }

  // When conflictColumns are provided and action was 'delete_rows', we ONLY delete the exact duplicates & repeated headers,
  // and NEVER delete the conflicting rows themselves!
  const effectiveAction =
    conflictIndices.length > 0 && action === 'delete_rows' ? 'report_only' : action;

  // If we pre-cleaned exact duplicates or repeated headers during a conflict audit, commit those deletions now
  // and recompute post-deletion rowNumbers so the conflict report has 100% accurate Excel row numbers!
  const preCleanDeleteList = [...new Set([...repeatedRowIndices, ...preDeleteExactIndices])].sort(
    (a, b) => a - b
  );
  let preCleanCommitted = false;
  if (shouldPreCleanExactDups && preCleanDeleteList.length > 0) {
    deleteRowsVectorized(sheet, fullTableValues, preCleanDeleteList, lastSheetCol);
    preCleanCommitted = true;
    // Adjust rowNumber of each row in duplicateGroups to reflect deleted rows above it
    for (const grp of duplicateGroups) {
      for (const r of grp) {
        const deletedAbove = preCleanDeleteList.filter((delIdx) => delIdx < r.originalRowIdx).length;
        r.rowNumber = r.originalRowIdx + 1 - deletedAbove;
      }
    }
  }

  // Build structured duplicate groups for receipt
  const structuredGroups = duplicateGroups.slice(0, 50).map((grp) => {
    const keyValues: Record<string, any> = {};
    keyIndices.forEach((kIdx) => {
      const header = headers[kIdx] ? String(headers[kIdx]).trim() : colIndexToLetter(kIdx);
      keyValues[header] = grp[0].values[kIdx];
    });

    const varyingColumns: string[] = [];
    for (let c = 0; c < headers.length; c++) {
      const firstVal = String(grp[0].values[c] ?? '').trim();
      const differs = grp.some((r) => String(r.values[c] ?? '').trim() !== firstVal);
      if (differs) {
        varyingColumns.push(headers[c] ? String(headers[c]).trim() : colIndexToLetter(c));
      }
    }

    const records = grp.map((r) => {
      const rowData: Record<string, any> = { rowNumber: r.rowNumber };
      headers.forEach((h: any, cIdx: number) => {
        const colName = h ? String(h).trim() : colIndexToLetter(cIdx);
        rowData[colName] = r.values[cIdx];
      });
      return rowData;
    });

    return {
      keyValues,
      varyingColumns,
      records,
    };
  });

  // Format concise markdown summary table
  const summaryRows: string[] = [];
  if (structuredGroups.length > 0) {
    const displayCols = Array.from(
      new Set([
        ...keyIndices.map((k) => (headers[k] ? String(headers[k]).trim() : colIndexToLetter(k))),
        ...conflictIndices.map((c) => (headers[c] ? String(headers[c]).trim() : colIndexToLetter(c))),
      ])
    );
    summaryRows.push(`| Row | ${displayCols.join(' | ')} |`);
    summaryRows.push(`| --- | ${displayCols.map(() => '---').join(' | ')} |`);
    let renderedCount = 0;
    for (const grp of structuredGroups) {
      for (const rec of grp.records) {
        if (renderedCount >= 40) break;
        const vals = displayCols.map((c) => String(rec[c] ?? ''));
        summaryRows.push(`| ${rec.rowNumber} | ${vals.join(' | ')} |`);
        renderedCount++;
      }
      if (renderedCount >= 40) break;
    }
  }
  const formattedSummaryTable = summaryRows.join('\n');

  if (duplicateGroups.length === 0) {
    if (
      (effectiveAction === 'delete_rows' || effectiveAction === 'quarantine_to_sheet') &&
      repeatedRowIndices.length > 0 &&
      !preCleanCommitted
    ) {
      deleteRowsVectorized(sheet, fullTableValues, repeatedRowIndices, lastSheetCol);
    }
    const durationMs = Math.round(performance.now() - t0);
    const remainingRows = dataRowsWithIdx.length;
    return {
      success: true,
      duplicateGroupsFound: 0,
      duplicateRowsIdentified: 0,
      duplicatesRemovedOrFlagged: exactDuplicatesRemovedBeforeConflict,
      exactDuplicatesRemoved: exactDuplicatesRemovedBeforeConflict,
      rowsKept: remainingRows,
      repeatedHeadersRemoved: repeatedHeadersRemovedCount,
      detectedHeaderRow: headerRowIdx + 1,
      remainingRows,
      newLastRow: effectiveEndRow - repeatedHeadersRemovedCount - exactDuplicatesRemovedBeforeConflict,
      actionTaken: effectiveAction,
      durationMs,
      message:
        repeatedHeadersRemovedCount > 0 || exactDuplicatesRemovedBeforeConflict > 0
          ? `Cleaned ${repeatedHeadersRemovedCount} repeated header row(s) and removed ${exactDuplicatesRemovedBeforeConflict} exact duplicate row(s). Zero remaining duplicate or conflicting rows detected.`
          : 'Zero duplicate or conflicting rows detected across the specified key columns.',
    };
  }

  // Resolve winners and losers for each duplicate group
  const rowsToDelete: number[] = [];
  const quarantinedRows: any[][] = [];
  const rowsToUpdateCoalesced: Array<{ rowIdx: number; coalescedValues: any[] }> = [];
  const duplicateFlagMap = new Map<number, boolean>();

  let tieBreakerColIdx = -1;
  if (tieBreaker?.column) {
    tieBreakerColIdx = resolveColumn(sheet, tieBreaker.column, headerRowIdx).colIndex;
  }

  for (const group of duplicateGroups) {
    let winner = group[0];
    let losers: typeof group = [];

    if (tieBreaker) {
      group.sort((a, b) => {
        if (tieBreaker.rule === 'most_complete') {
          const compA = a.values.filter((v) => v !== undefined && v !== null && v !== '').length;
          const compB = b.values.filter((v) => v !== undefined && v !== null && v !== '').length;
          return compB - compA;
        }
        if (tieBreakerColIdx !== -1) {
          const rawA = a.values[tieBreakerColIdx];
          const rawB = b.values[tieBreakerColIdx];
          const numA = parseRobustNumber(rawA);
          const numB = parseRobustNumber(rawB);
          if (numA !== null && numB !== null) {
            if (tieBreaker.rule === 'max') return numB - numA;
            if (tieBreaker.rule === 'min') return numA - numB;
          }
          if (tieBreaker.rule === 'max') return String(rawA) < String(rawB) ? 1 : -1;
          if (tieBreaker.rule === 'min') return String(rawA) > String(rawB) ? 1 : -1;
        }
        return 0;
      });
      winner = group[0];
      losers = group.slice(1);
    } else if (strategy === 'keep_last') {
      winner = group[group.length - 1];
      losers = group.slice(0, group.length - 1);
    } else {
      winner = group[0];
      losers = group.slice(1);
    }

    if (coalesceDuplicates) {
      const coalesced = [...winner.values];
      for (const loser of losers) {
        for (let col = 0; col < coalesced.length; col++) {
          if (
            (coalesced[col] === undefined || coalesced[col] === null || coalesced[col] === '') &&
            loser.values[col] !== undefined &&
            loser.values[col] !== null &&
            loser.values[col] !== ''
          ) {
            coalesced[col] = loser.values[col];
          }
        }
      }
      rowsToUpdateCoalesced.push({ rowIdx: winner.originalRowIdx, coalescedValues: coalesced });
    }

    for (const loser of losers) {
      rowsToDelete.push(loser.originalRowIdx);
      quarantinedRows.push(loser.values);
      duplicateFlagMap.set(loser.rowNumber, true);
    }
  }

  // Execute Action
  let actionResultMsg = '';

  if (effectiveAction === 'report_only') {
    const totalIdentified = duplicateGroups.reduce((acc, g) => acc + g.length, 0);
    const preCleanNote =
      exactDuplicatesRemovedBeforeConflict > 0 || repeatedHeadersRemovedCount > 0
        ? `Deleted ${exactDuplicatesRemovedBeforeConflict} exact duplicate row(s) and ${repeatedHeadersRemovedCount} repeated header row(s) in-place; then `
        : '';
    actionResultMsg = `${preCleanNote}reported ${duplicateGroups.length} duplicate/conflict group(s) with ${totalIdentified} total row(s) (kept intact for review).`;
  } else if (effectiveAction === 'delete_rows') {
    for (const update of rowsToUpdateCoalesced) {
      fullTableValues[update.rowIdx] = update.coalescedValues;
      sheet.getRange(update.rowIdx, 0, 1, update.coalescedValues.length)?.setValues?.([update.coalescedValues]);
    }
    const rowsToDeleteCombined = [...new Set([...rowsToDelete, ...repeatedRowIndices])];
    deleteRowsVectorized(sheet, fullTableValues, rowsToDeleteCombined, lastSheetCol);
    actionResultMsg = `Deleted ${rowsToDelete.length} duplicate row(s)${repeatedHeadersRemovedCount > 0 ? ` and cleaned ${repeatedHeadersRemovedCount} repeated header row(s)` : ''} in-place.`;
  } else if (effectiveAction === 'quarantine_to_sheet') {
    const qSheetName = targetSheetName || `${sheet.getSheetName?.() || 'Sheet'}_Duplicates`;
    const qSheet = wb.getSheetByName?.(qSheetName) || wb.insertSheet?.(qSheetName);
    if (qSheet) {
      ensureSheetCapacity(qSheet, quarantinedRows.length + 2, headers.length);
      qSheet.getRange(0, 0, 1, headers.length)?.setValues?.([headers]);
      qSheet.getRange(1, 0, quarantinedRows.length, headers.length)?.setValues?.(quarantinedRows);
    }
    const rowsToDeleteCombined = [...new Set([...rowsToDelete, ...repeatedRowIndices])];
    deleteRowsVectorized(sheet, fullTableValues, rowsToDeleteCombined, lastSheetCol);
    actionResultMsg = `Moved ${quarantinedRows.length} duplicate row(s) to worksheet "${qSheetName}" and removed them from source.`;
  } else if (effectiveAction === 'flag_column') {
    const flagColIdx = lastSheetCol;
    ensureSheetCapacity(sheet, effectiveEndRow, flagColIdx + 1);
    sheet.insertColumns?.(flagColIdx, 1);
    sheet.getRange(headerRowIdx, flagColIdx, 1, 1)?.setValues?.([[flagColumnHeader]]);

    const flags: any[][] = [];
    for (let r = effectiveStartRow; r <= effectiveEndRow; r++) {
      flags.push([duplicateFlagMap.get(r) === true]);
    }
    const flagColLetter = colIndexToLetter(flagColIdx);
    sheet.getRange(`${flagColLetter}${effectiveStartRow}:${flagColLetter}${effectiveEndRow}`)?.setValues?.(flags);
    actionResultMsg = `Flagged duplicate rows in new column ${flagColLetter} ("${flagColumnHeader}").`;
  }

  const durationMs = Math.round(performance.now() - t0);
  const totalDeletedRows =
    effectiveAction === 'delete_rows' || effectiveAction === 'quarantine_to_sheet'
      ? rowsToDelete.length + repeatedHeadersRemovedCount
      : preCleanDeleteList.length;
  const remainingDataRows =
    effectiveAction === 'delete_rows' || effectiveAction === 'quarantine_to_sheet'
      ? dataRowsWithIdx.length - rowsToDelete.length
      : dataRowsWithIdx.length;

  return {
    success: true,
    action: 'deduplicate_dataset',
    detectedHeaderRow: headerRowIdx + 1,
    duplicateGroupsFound: duplicateGroups.length,
    duplicateRowsIdentified:
      effectiveAction === 'report_only'
        ? duplicateGroups.reduce((acc, g) => acc + g.length, 0)
        : rowsToDelete.length,
    duplicatesRemovedOrFlagged:
      effectiveAction === 'report_only'
        ? exactDuplicatesRemovedBeforeConflict
        : rowsToDelete.length,
    exactDuplicatesRemoved:
      effectiveAction === 'delete_rows'
        ? rowsToDelete.length
        : exactDuplicatesRemovedBeforeConflict,
    coalescedRowsUpdated: rowsToUpdateCoalesced.length,
    repeatedHeadersRemoved: repeatedHeadersRemovedCount,
    actionExecuted: effectiveAction,
    groups: structuredGroups,
    formattedSummaryTable,
    remainingRows: remainingDataRows,
    newLastRow: effectiveEndRow - totalDeletedRows,
    durationMs,
    message: `${actionResultMsg} (Evaluated ${dataRowsWithIdx.length} rows in ${durationMs}ms)`,
  };
}

/**
 * 3B. REMOVE REPEATED HEADERS
 * Vectorized detection and removal of repeated pagination/export header rows
 * (e.g. OrderID, SKU repeated every 500 rows from CSV/portal splits).
 */
export async function executeRemoveRepeatedHeaders(
  args: {
    sheetName?: string;
  },
  ctx: ToolExecutionContext
) {
  const t0 = performance.now();
  const { sheetName } = args;

  const wb = ctx.univerAPI?.getActiveWorkbook?.();
  if (!wb) throw new Error('Univer active workbook unavailable');

  const sheet = sheetName ? wb.getSheetByName?.(sheetName) : wb.getActiveSheet?.();
  if (!sheet) throw new Error(`Worksheet ${sheetName || 'active'} not found`);

  const lastSheetRow = Math.max((sheet.getLastRow?.() ?? 0) + 1, 1);
  const lastSheetCol = Math.max((sheet.getLastColumn?.() ?? 0) + 1, 1);

  if (lastSheetRow <= 1) {
    return {
      success: true,
      removedCount: 0,
      newLastRow: lastSheetRow,
      durationMs: 0,
      message: 'Worksheet has no data rows to evaluate.',
    };
  }

  const fullRangeNotation = `A1:${colIndexToLetter(lastSheetCol - 1)}${lastSheetRow}`;
  const tableValues: any[][] = sheet.getRange(fullRangeNotation)?.getValues?.() || [];
  const { headerRowIdx, headerVals } = detectTableHeaderRow(tableValues);
  const headers = headerVals.length > 0 ? headerVals : tableValues[0] || [];

  if (headers.filter((h: any) => h !== undefined && h !== null && String(h).trim() !== '').length < 2) {
    return {
      success: true,
      removedCount: 0,
      newLastRow: lastSheetRow,
      durationMs: 0,
      message: 'Header row has fewer than 2 columns.',
    };
  }

  const repeatedRowIndices: number[] = [];
  for (let r = headerRowIdx + 1; r < tableValues.length; r++) {
    const row = tableValues[r];
    if (!row) continue;
    let matchCount = 0;
    let nonBlankCount = 0;
    for (let c = 0; c < headers.length; c++) {
      const hVal = String(headers[c] ?? '').trim().toLowerCase();
      const cellVal = String(row[c] ?? '').trim().toLowerCase();
      if (!hVal) continue;
      if (cellVal !== '') {
        nonBlankCount++;
        if (cellVal === hVal) matchCount++;
      }
    }
    if (nonBlankCount >= 2 && matchCount / nonBlankCount >= 0.7) {
      repeatedRowIndices.push(r);
    }
  }

  deleteRowsVectorized(sheet, tableValues, repeatedRowIndices, lastSheetCol);

  const durationMs = Math.round(performance.now() - t0);
  const newLastRow = lastSheetRow - repeatedRowIndices.length;

  return {
    success: true,
    action: 'remove_repeated_headers',
    detectedHeaderRow: headerRowIdx + 1,
    removedCount: repeatedRowIndices.length,
    removedExcelRows: repeatedRowIndices.map((r) => r + 1),
    newLastRow,
    durationMs,
    message:
      repeatedRowIndices.length > 0
        ? `Removed ${repeatedRowIndices.length} repeating header row(s) (matching Row ${headerRowIdx + 1}) in-place in ${durationMs}ms. Sheet now has ${newLastRow} rows.`
        : `Zero repeating header rows detected. Sheet is clean.`,
  };
}

export interface FilterCondition {
  column: string | number;
  operator:
    | '=='
    | '!='
    | '>'
    | '<'
    | '>='
    | '<='
    | 'contains'
    | 'in'
    | 'startsWith'
    | 'endsWith'
    | 'regex'
    | 'isNull'
    | 'notNull';
  value?: any;
  matchCase?: boolean;
}

export interface SummarizeMetric {
  groupBy?: string | number;
  metricColumn?: string | number;
  derivedFormula?: string;
  aggregate: 'count' | 'sum' | 'average' | 'min' | 'max';
  alias?: string;
}

/**
 * 3C. FILTER & SLICE DATASET (Flagship In-Engine Filtering, Extraction & Summary)
 * Vectorized filtering and row extraction from a source sheet into a target sheet.
 * Supports multi-condition filtering, ERP header skipping, in-memory currency & metric
 * aggregations (e.g. counts and sums grouped by Currency), and executive summary blocks.
 */
export async function executeFilterSliceDataset(
  args: {
    sourceSheetName?: string;
    sheetName?: string;
    rangeA1?: string;
    filterConditions?: FilterCondition[];
    conditionLogic?: 'AND' | 'OR';
    columns?: string[];
    targetSheetName?: string;
    targetStartCell?: string;
    action?: 'copy_to_target' | 'move_to_target' | 'report_only';
    summarizeMetrics?: SummarizeMetric[];
    writeSummaryBlock?: boolean;
    stripSourceRepeatedHeaders?: boolean;
  },
  ctx: ToolExecutionContext
) {
  const t0 = performance.now();
  const {
    sourceSheetName,
    sheetName,
    filterConditions = [],
    conditionLogic = 'AND',
    columns,
    targetSheetName,
    targetStartCell = 'A1',
    action = 'copy_to_target',
    summarizeMetrics,
    writeSummaryBlock = true,
    stripSourceRepeatedHeaders = true,
  } = args;

  const wb = ctx.univerAPI?.getActiveWorkbook?.();
  if (!wb) throw new Error('Univer active workbook unavailable');

  const srcSheet = resolveWorksheet(wb, sourceSheetName || sheetName);
  if (!srcSheet) {
    throw new Error(`Source worksheet "${sourceSheetName || sheetName || 'active'}" not found`);
  }

  const lastSheetRow = Math.max((srcSheet.getLastRow?.() ?? 0) + 1, 1);
  const lastSheetCol = Math.max((srcSheet.getLastColumn?.() ?? 0) + 1, 1);

  if (lastSheetRow <= 1) {
    return {
      success: true,
      totalSourceRows: 0,
      matchingRowsCount: 0,
      targetSheetName: targetSheetName || srcSheet.getSheetName?.() || 'Sheet',
      message: 'Source worksheet has no data rows to filter.',
    };
  }

  const fullRangeNotation = `A1:${colIndexToLetter(lastSheetCol - 1)}${lastSheetRow}`;
  const fullTableValues: any[][] = srcSheet.getRange(fullRangeNotation)?.getValues?.() || [];

  const { headerRowIdx, headerVals } = detectTableHeaderRow(fullTableValues);
  const headers = headerVals.length > 0 ? headerVals : fullTableValues[headerRowIdx] || [];

  // Identify repeating pagination header rows to skip
  const repeatedRowIndices = new Set<number>();
  if (stripSourceRepeatedHeaders) {
    for (let r = headerRowIdx + 1; r < fullTableValues.length; r++) {
      const row = fullTableValues[r];
      if (!row) continue;
      let matchCount = 0;
      let nonBlankCount = 0;
      for (let c = 0; c < headers.length; c++) {
        const hVal = String(headers[c] ?? '').trim().toLowerCase();
        const cellVal = String(row[c] ?? '').trim().toLowerCase();
        if (!hVal) continue;
        if (cellVal !== '') {
          nonBlankCount++;
          if (cellVal === hVal) matchCount++;
        }
      }
      if (nonBlankCount >= 2 && matchCount / nonBlankCount >= 0.7) {
        repeatedRowIndices.add(r);
      }
    }
  }

  // Pre-resolve column indices for filter conditions
  const resolvedConditions = (filterConditions || []).map((cond) => {
    const resolved = resolveColumnSmart(srcSheet, cond.column, headerRowIdx);
    return {
      ...cond,
      colIndex: resolved.colIndex,
      headerName: resolved.headerName,
    };
  });

  // Evaluate conditions on data rows
  const matchingDataRows: any[][] = [];
  const matchingOriginalIndices: number[] = [];

  for (let r = headerRowIdx + 1; r < fullTableValues.length; r++) {
    if (repeatedRowIndices.has(r)) continue;
    const row = fullTableValues[r];
    if (!row || row.every((c) => c === undefined || c === null || String(c).trim() === '')) {
      continue;
    }

    if (resolvedConditions.length === 0) {
      matchingDataRows.push(row);
      matchingOriginalIndices.push(r);
      continue;
    }

    const conditionResults: boolean[] = resolvedConditions.map((cond) => {
      const cellVal = row[cond.colIndex];
      const matchCase = cond.matchCase === true;
      const cellStr = cellVal !== undefined && cellVal !== null ? String(cellVal).trim() : '';
      const targetStr = cond.value !== undefined && cond.value !== null ? String(cond.value).trim() : '';

      const cmpCellStr = matchCase ? cellStr : cellStr.toLowerCase();
      const cmpTargetStr = matchCase ? targetStr : targetStr.toLowerCase();

      const numCell = parseRobustNumber(cellVal);
      const numTarget = parseRobustNumber(cond.value);

      switch (cond.operator) {
        case '==':
          if (numCell !== null && numTarget !== null) return numCell === numTarget;
          return cmpCellStr === cmpTargetStr;
        case '!=':
          if (numCell !== null && numTarget !== null) return numCell !== numTarget;
          return cmpCellStr !== cmpTargetStr;
        case '>':
          return numCell !== null && numTarget !== null && numCell > numTarget;
        case '<':
          return numCell !== null && numTarget !== null && numCell < numTarget;
        case '>=':
          return numCell !== null && numTarget !== null && numCell >= numTarget;
        case '<=':
          return numCell !== null && numTarget !== null && numCell <= numTarget;
        case 'contains':
          return cmpCellStr.includes(cmpTargetStr);
        case 'startsWith':
          return cmpCellStr.startsWith(cmpTargetStr);
        case 'endsWith':
          return cmpCellStr.endsWith(cmpTargetStr);
        case 'in': {
          let list: string[] = [];
          if (Array.isArray(cond.value)) {
            list = cond.value.map((v) => (matchCase ? String(v).trim() : String(v).trim().toLowerCase()));
          } else {
            list = String(cond.value)
              .split(/[,|]/)
              .map((v) => (matchCase ? v.trim() : v.trim().toLowerCase()));
          }
          return list.includes(cmpCellStr);
        }
        case 'regex':
          try {
            const reg = new RegExp(targetStr, matchCase ? '' : 'i');
            return reg.test(cellStr);
          } catch {
            return false;
          }
        case 'isNull':
          return cellVal === undefined || cellVal === null || String(cellVal).trim() === '';
        case 'notNull':
          return cellVal !== undefined && cellVal !== null && String(cellVal).trim() !== '';
        default:
          return cmpCellStr === cmpTargetStr;
      }
    });

    const isMatch =
      conditionLogic === 'OR'
        ? conditionResults.some(Boolean)
        : conditionResults.every(Boolean);

    if (isMatch) {
      matchingDataRows.push(row);
      matchingOriginalIndices.push(r);
    }
  }

  // Column Projection
  let targetColIndices: number[] = [];
  if (columns && Array.isArray(columns) && columns.length > 0) {
    targetColIndices = columns.map(
      (colRef) => resolveColumnSmart(srcSheet, colRef, headerRowIdx).colIndex
    );
  } else {
    targetColIndices = Array.from({ length: lastSheetCol }, (_, i) => i);
  }

  const projectedHeaders = targetColIndices.map(
    (cIdx) => (headers[cIdx] ? String(headers[cIdx]).trim() : colIndexToLetter(cIdx))
  );

  const projectedMatchingRows = matchingDataRows.map((row) =>
    targetColIndices.map((cIdx) => row[cIdx] ?? '')
  );

  // Summarize Metrics Calculation
  const summaryGroups: Record<string, Record<string, any>> = {};
  if (summarizeMetrics && summarizeMetrics.length > 0) {
    for (const metric of summarizeMetrics) {
      let groupColIdx = -1;
      let groupColName = '';
      if (metric.groupBy !== undefined && metric.groupBy !== null) {
        const resolvedGroup = resolveColumnSmart(srcSheet, metric.groupBy, headerRowIdx);
        groupColIdx = resolvedGroup.colIndex;
        groupColName = resolvedGroup.headerName;
      }

      let metricColIdx = -1;
      let metricColName = '';
      if (metric.metricColumn !== undefined && metric.metricColumn !== null) {
        try {
          const resolvedMetric = resolveColumnSmart(srcSheet, metric.metricColumn, headerRowIdx);
          metricColIdx = resolvedMetric.colIndex;
          metricColName = resolvedMetric.headerName;
        } catch {
          metricColName = String(metric.metricColumn);
        }
      }

      const metricKey =
        metric.alias ||
        (metric.aggregate === 'count' && !metric.metricColumn
          ? 'count'
          : `${metricColName || 'metric'}_${metric.aggregate}`);

      for (let i = 0; i < matchingDataRows.length; i++) {
        const row = matchingDataRows[i];
        const groupKey =
          groupColIdx >= 0 ? String(row[groupColIdx] ?? '').trim() || '(Blank)' : 'Total';

        if (!summaryGroups[groupKey]) {
          summaryGroups[groupKey] = {};
        }

        let val: number | null = null;
        if (metric.derivedFormula) {
          const rowDict: Record<string, any> = {};
          headers.forEach((h: any, c: number) => {
            const colName = h ? String(h).trim() : colIndexToLetter(c);
            rowDict[colName] = row[c];
            rowDict[colIndexToLetter(c)] = row[c];
          });
          val = parseRobustNumber(evaluateExpression(metric.derivedFormula, rowDict, i + 1));
        } else if (metricColIdx >= 0) {
          val = parseRobustNumber(row[metricColIdx]);
        }

        if (metric.aggregate === 'count') {
          summaryGroups[groupKey][metricKey] = (summaryGroups[groupKey][metricKey] || 0) + 1;
        } else if (val !== null) {
          if (metric.aggregate === 'sum') {
            summaryGroups[groupKey][metricKey] =
              (summaryGroups[groupKey][metricKey] || 0) + val;
          } else if (metric.aggregate === 'average') {
            if (!summaryGroups[groupKey][`__vals_${metricKey}`]) {
              summaryGroups[groupKey][`__vals_${metricKey}`] = [];
            }
            summaryGroups[groupKey][`__vals_${metricKey}`].push(val);
          } else if (metric.aggregate === 'min') {
            const cur = summaryGroups[groupKey][metricKey];
            summaryGroups[groupKey][metricKey] = cur === undefined ? val : Math.min(cur, val);
          } else if (metric.aggregate === 'max') {
            const cur = summaryGroups[groupKey][metricKey];
            summaryGroups[groupKey][metricKey] = cur === undefined ? val : Math.max(cur, val);
          }
        }
      }

      // Compute averages
      if (metric.aggregate === 'average') {
        for (const [gKey, gData] of Object.entries(summaryGroups)) {
          const vals: number[] = gData[`__vals_${metricKey}`] || [];
          if (vals.length > 0) {
            const sum = vals.reduce((a, b) => a + b, 0);
            gData[metricKey] = Math.round((sum / vals.length) * 100) / 100;
          } else {
            gData[metricKey] = 0;
          }
          delete gData[`__vals_${metricKey}`];
        }
      }
    }
  }

  // Format Markdown Summary Table
  let formattedSummaryTable = '';
  const groupKeys = Object.keys(summaryGroups);
  if (groupKeys.length > 0) {
    const metricKeys = Array.from(
      new Set(groupKeys.flatMap((g) => Object.keys(summaryGroups[g])))
    );
    const mdRows: string[] = [];
    const headerCols = ['Group', ...metricKeys];
    mdRows.push(`| ${headerCols.join(' | ')} |`);
    mdRows.push(`| ${headerCols.map(() => '---').join(' | ')} |`);
    for (const g of groupKeys) {
      const vals = metricKeys.map((k) => {
        const raw = summaryGroups[g][k];
        if (typeof raw === 'number') {
          return raw.toLocaleString('en-US', { maximumFractionDigits: 2 });
        }
        return String(raw ?? '');
      });
      mdRows.push(`| ${g} | ${vals.join(' | ')} |`);
    }
    formattedSummaryTable = mdRows.join('\n');
  }

  // Destination Worksheet Writing
  const effectiveTargetSheet = targetSheetName || `${srcSheet.getSheetName?.() || 'Sheet'}_Filtered`;
  let targetBoundsNotation = '';

  if (action === 'copy_to_target' || action === 'move_to_target') {
    let destSheet = wb.getSheetByName?.(effectiveTargetSheet);
    if (!destSheet) {
      destSheet = wb.insertSheet?.(effectiveTargetSheet);
    }
    if (!destSheet) {
      throw new Error(`Failed to create or access target worksheet "${effectiveTargetSheet}"`);
    }

    const parsedTarget = parseA1RangeBounds(targetStartCell);
    const targetStartR = parsedTarget.startRow;
    const targetStartC = parsedTarget.startCol;

    const totalTargetRows = targetStartR + 1 + projectedMatchingRows.length;
    const totalTargetCols = targetStartC + projectedHeaders.length + 8;
    ensureSheetCapacity(destSheet, totalTargetRows + 5, totalTargetCols);

    // 1. Write Header Row
    destSheet
      .getRange(targetStartR, targetStartC, 1, projectedHeaders.length)
      ?.setValues?.([projectedHeaders]);

    // 2. Write Matching Rows
    if (projectedMatchingRows.length > 0) {
      destSheet
        .getRange(
          targetStartR + 1,
          targetStartC,
          projectedMatchingRows.length,
          projectedHeaders.length
        )
        ?.setValues?.(projectedMatchingRows);
    }

    const endRowCoord = targetStartR + 1 + Math.max(projectedMatchingRows.length, 1);
    const endColCoord = colIndexToLetter(targetStartC + projectedHeaders.length - 1);
    targetBoundsNotation = `${effectiveTargetSheet}!${colIndexToLetter(targetStartC)}${targetStartR + 1}:${endColCoord}${endRowCoord}`;

    // 3. Write Summary KPI / Aggregation Table on target sheet if metrics were computed
    if (writeSummaryBlock && groupKeys.length > 0) {
      const summaryStartCol = targetStartC + projectedHeaders.length + 1; // 1 column spacing
      const metricKeys = Array.from(
        new Set(groupKeys.flatMap((g) => Object.keys(summaryGroups[g])))
      );
      const summaryHeaderRow = ['Group', ...metricKeys];
      const summaryRows: any[][] = [summaryHeaderRow];
      for (const g of groupKeys) {
        const rowVals = [g, ...metricKeys.map((k) => summaryGroups[g][k] ?? '')];
        summaryRows.push(rowVals);
      }
      ensureSheetCapacity(
        destSheet,
        targetStartR + summaryRows.length + 2,
        summaryStartCol + summaryHeaderRow.length + 1
      );
      destSheet
        .getRange(targetStartR, summaryStartCol, summaryRows.length, summaryHeaderRow.length)
        ?.setValues?.(summaryRows);
    }

    // 4. If action is move_to_target, delete matching rows from source sheet
    if (action === 'move_to_target' && matchingOriginalIndices.length > 0) {
      deleteRowsVectorized(srcSheet, fullTableValues, matchingOriginalIndices, lastSheetCol);
    }
  }

  const durationMs = Math.round(performance.now() - t0);

  return {
    success: true,
    action,
    sourceSheetName: srcSheet.getSheetName?.() || 'Source',
    targetSheetName: effectiveTargetSheet,
    targetRange: targetBoundsNotation,
    totalSourceRows: fullTableValues.length - headerRowIdx - 1 - repeatedRowIndices.size,
    matchingRowsCount: matchingDataRows.length,
    repeatedHeadersSkipped: repeatedRowIndices.size,
    detectedHeaderRow: headerRowIdx + 1,
    summaryGroups,
    formattedSummaryTable,
    durationMs,
    message: `Filtered ${matchingDataRows.length} matching row(s) into worksheet "${effectiveTargetSheet}" in ${durationMs}ms.${repeatedRowIndices.size > 0 ? ` (Skipped ${repeatedRowIndices.size} repeated header rows).` : ''}`,
  };
}

/**
 * 4. IMPUTE DATA
 * Vectorized gap filling, forward/backward fill, linear interpolation,
 * and group-by imputation across columns.
 */
export async function executeImputeData(
  args: {
    sheetName?: string;
    columns: string[];
    method?: 'forward_fill' | 'backward_fill' | 'constant' | 'linear_interpolation' | 'group_by' | 'expression';
    constantValue?: any;
    groupByColumn?: string;
    groupAgg?: 'forward_fill' | 'mean' | 'mode';
    expression?: string;
    startRow?: number;
    endRow?: number;
  },
  ctx: ToolExecutionContext
) {
  const t0 = performance.now();
  const {
    sheetName,
    columns,
    method = 'forward_fill',
    constantValue = 0,
    groupByColumn,
    groupAgg = 'forward_fill',
    expression,
    startRow = 2,
    endRow,
  } = args;

  const wb = ctx.univerAPI?.getActiveWorkbook?.();
  if (!wb) throw new Error('Univer active workbook unavailable');

  const sheet = sheetName ? wb.getSheetByName?.(sheetName) : wb.getActiveSheet?.();
  if (!sheet) throw new Error(`Worksheet ${sheetName || 'active'} not found`);

  const lastSheetRow = Math.max((sheet.getLastRow?.() ?? 0) + 1, 1);
  const effectiveEndRow = endRow ? Math.min(endRow, lastSheetRow) : lastSheetRow;

  if (effectiveEndRow < startRow) {
    return { success: true, cellsImputed: 0, message: 'No rows to impute' };
  }

  const resolvedCols = columns.map((colRef) => resolveColumn(sheet, colRef, 0));
  let groupByColIdx = -1;
  let groupLabels: any[] = [];

  if (method === 'group_by' && groupByColumn) {
    groupByColIdx = resolveColumn(sheet, groupByColumn, 0).colIndex;
    const groupColLetter = colIndexToLetter(groupByColIdx);
    groupLabels = sheet
      .getRange(`${groupColLetter}${startRow}:${groupColLetter}${effectiveEndRow}`)
      ?.getValues?.()
      ?.map((r: any[]) => r[0]) || [];
  }

  let totalImputedCells = 0;
  const imputedReports: Record<string, any> = {};

  // Pre-read full row dictionary when method === 'expression'
  let allColumnsMatrix: any[][] = [];
  let allColMeta: Array<{ colLetter: string; headerName: string }> = [];
  if (method === 'expression' && expression) {
    const maxColCount = Math.min((sheet.getLastColumn?.() ?? 0) + 1, 50);
    const headerRow = sheet.getRange(0, 0, 1, maxColCount)?.getValues?.()?.[0] || [];
    allColMeta = [];
    for (let c = 0; c < maxColCount; c++) {
      const colLetter = colIndexToLetter(c);
      const headerName = String(headerRow[c] || colLetter).trim();
      allColMeta.push({ colLetter, headerName });
    }
    allColumnsMatrix =
      sheet.getRange(startRow - 1, 0, effectiveEndRow - startRow + 1, maxColCount)?.getValues?.() || [];
  }

  for (const col of resolvedCols) {
    const rangeNotation = `${col.colLetter}${startRow}:${col.colLetter}${effectiveEndRow}`;
    const rawValues = sheet.getRange(rangeNotation)?.getValues?.() || [];
    const flatVals = rawValues.map((r: any[]) => r[0]);

    let filledCount = 0;
    const resultVals = [...flatVals];

    if (method === 'constant') {
      for (let i = 0; i < resultVals.length; i++) {
        if (resultVals[i] === undefined || resultVals[i] === null || resultVals[i] === '') {
          resultVals[i] = constantValue;
          filledCount++;
        }
      }
    } else if (method === 'forward_fill') {
      let lastKnown: any = undefined;
      for (let i = 0; i < resultVals.length; i++) {
        const val = resultVals[i];
        if (val !== undefined && val !== null && val !== '') {
          lastKnown = val;
        } else if (lastKnown !== undefined) {
          resultVals[i] = lastKnown;
          filledCount++;
        }
      }
    } else if (method === 'backward_fill') {
      let nextKnown: any = undefined;
      for (let i = resultVals.length - 1; i >= 0; i--) {
        const val = resultVals[i];
        if (val !== undefined && val !== null && val !== '') {
          nextKnown = val;
        } else if (nextKnown !== undefined) {
          resultVals[i] = nextKnown;
          filledCount++;
        }
      }
    } else if (method === 'linear_interpolation') {
      let i = 0;
      while (i < resultVals.length) {
        if (resultVals[i] === undefined || resultVals[i] === null || resultVals[i] === '' || isNaN(Number(resultVals[i]))) {
          const gapStart = i;
          while (i < resultVals.length && (resultVals[i] === undefined || resultVals[i] === null || resultVals[i] === '' || isNaN(Number(resultVals[i])))) {
            i++;
          }
          const gapEnd = i;
          const prevVal = gapStart > 0 && !isNaN(Number(resultVals[gapStart - 1])) ? Number(resultVals[gapStart - 1]) : null;
          const nextVal = gapEnd < resultVals.length && !isNaN(Number(resultVals[gapEnd])) ? Number(resultVals[gapEnd]) : null;

          if (prevVal !== null && nextVal !== null) {
            const step = (nextVal - prevVal) / (gapEnd - gapStart + 1);
            for (let g = gapStart; g < gapEnd; g++) {
              resultVals[g] = Number((prevVal + step * (g - gapStart + 1)).toFixed(2));
              filledCount++;
            }
          } else if (prevVal !== null) {
            for (let g = gapStart; g < gapEnd; g++) {
              resultVals[g] = prevVal;
              filledCount++;
            }
          } else if (nextVal !== null) {
            for (let g = gapStart; g < gapEnd; g++) {
              resultVals[g] = nextVal;
              filledCount++;
            }
          }
        } else {
          i++;
        }
      }
    } else if (method === 'group_by' && groupByColIdx !== -1) {
      if (groupAgg === 'mean' || groupAgg === 'mode') {
        const groupBucket = new Map<any, any[]>();
        for (let i = 0; i < resultVals.length; i++) {
          const grp = groupLabels[i];
          const val = resultVals[i];
          if (val !== undefined && val !== null && val !== '') {
            if (!groupBucket.has(grp)) groupBucket.set(grp, []);
            groupBucket.get(grp)!.push(val);
          }
        }
        const groupFillVal = new Map<any, any>();
        for (const [grp, vals] of groupBucket.entries()) {
          if (groupAgg === 'mean') {
            const nums = vals.map(parseRobustNumber).filter((n): n is number => n !== null);
            if (nums.length > 0) {
              groupFillVal.set(grp, Number((nums.reduce((a, b) => a + b, 0) / nums.length).toFixed(2)));
            }
          } else {
            const counts = new Map<any, number>();
            for (const v of vals) counts.set(v, (counts.get(v) || 0) + 1);
            let bestVal = vals[0];
            let bestCnt = 0;
            for (const [v, cnt] of counts.entries()) {
              if (cnt > bestCnt) {
                bestCnt = cnt;
                bestVal = v;
              }
            }
            groupFillVal.set(grp, bestVal);
          }
        }
        for (let i = 0; i < resultVals.length; i++) {
          const val = resultVals[i];
          const grp = groupLabels[i];
          if ((val === undefined || val === null || val === '') && groupFillVal.has(grp)) {
            resultVals[i] = groupFillVal.get(grp);
            filledCount++;
          }
        }
      } else {
        // Default group_by forward_fill
        const groupMap = new Map<any, any>();
        for (let i = 0; i < resultVals.length; i++) {
          const grp = groupLabels[i];
          const val = resultVals[i];
          if (val !== undefined && val !== null && val !== '') {
            groupMap.set(grp, val);
          } else if (groupMap.has(grp)) {
            resultVals[i] = groupMap.get(grp);
            filledCount++;
          }
        }
      }
    } else if (method === 'expression' && expression) {
      for (let i = 0; i < resultVals.length; i++) {
        if (resultVals[i] === undefined || resultVals[i] === null || resultVals[i] === '') {
          const rowNum = startRow + i;
          const rowDict: Record<string, any> = {};
          const rowSlice = allColumnsMatrix[i] || [];
          for (let c = 0; c < allColMeta.length; c++) {
            rowDict[allColMeta[c].colLetter] = rowSlice[c];
            rowDict[allColMeta[c].headerName] = rowSlice[c];
          }
          const computed = evaluateExpression(expression, rowDict, rowNum);
          if (computed !== null && computed !== undefined) {
            resultVals[i] = computed;
            filledCount++;
          }
        }
      }
    }

    if (filledCount > 0) {
      const outputMatrix = resultVals.map((v) => [v]);
      sheet.getRange(rangeNotation)?.setValues?.(outputMatrix);
    }

    totalImputedCells += filledCount;
    imputedReports[col.colLetter] = {
      column: col.colLetter,
      header: col.headerName,
      filledCells: filledCount,
    };
  }

  const durationMs = Math.round(performance.now() - t0);

  return {
    status: 'SUCCESS',
    success: true,
    action: 'impute_data',
    method,
    totalImputedCells,
    columnsUpdated: imputedReports,
    durationMs,
    message: `Imputed ${totalImputedCells} blank cell(s) across ${resolvedCols.length} column(s) using "${method}" in ${durationMs}ms.`,
  };
}

/**
 * 5. RESHAPE DATASET (Wide-to-Tall Unpivot / Melt)
 * Normalizes cross-tab matrix tables into clean relational records.
 */
export async function executeReshapeDataset(
  args: {
    sourceSheetName?: string;
    idColumns: string[];
    valueColumns: string[];
    varColumnName?: string;
    valColumnName?: string;
    targetSheetName?: string;
    ignoreEmpty?: boolean;
    startRow?: number;
    endRow?: number;
  },
  ctx: ToolExecutionContext
) {
  const t0 = performance.now();
  const {
    sourceSheetName,
    idColumns,
    valueColumns,
    varColumnName = 'Variable',
    valColumnName = 'Value',
    targetSheetName,
    ignoreEmpty = true,
    startRow = 2,
    endRow,
  } = args;

  const wb = ctx.univerAPI?.getActiveWorkbook?.();
  if (!wb) throw new Error('Univer active workbook unavailable');

  const srcSheet = sourceSheetName ? wb.getSheetByName?.(sourceSheetName) : wb.getActiveSheet?.();
  if (!srcSheet) throw new Error(`Worksheet ${sourceSheetName || 'active'} not found`);

  const destSheetName = targetSheetName || `${srcSheet.getSheetName?.() || 'Sheet'}_Reshaped`;
  let destSheet = wb.getSheetByName?.(destSheetName);
  if (!destSheet) {
    wb.insertSheet?.(destSheetName);
    destSheet = wb.getSheetByName?.(destSheetName);
  }
  if (!destSheet) throw new Error(`Could not access or create target worksheet "${destSheetName}"`);

  const lastSheetRow = Math.max((srcSheet.getLastRow?.() ?? 0) + 1, 1);
  const effectiveEndRow = endRow ? Math.min(endRow, lastSheetRow) : lastSheetRow;

  // Resolve ID and Value columns
  const resolvedIds = idColumns.map((colRef) => resolveColumn(srcSheet, colRef, 0));
  const resolvedValues = valueColumns.map((colRef) => resolveColumn(srcSheet, colRef, 0));

  // Build target header row: [...idHeaders, varColumnName, valColumnName]
  const targetHeaders = [...resolvedIds.map((id) => id.headerName), varColumnName, valColumnName];

  // Read source matrix in one vectorized batch call
  const maxColIdx = Math.max(
    ...resolvedIds.map((c) => c.colIndex),
    ...resolvedValues.map((c) => c.colIndex),
    0
  );
  const numRows = Math.max(0, effectiveEndRow - startRow + 1);
  const sourceMatrix: any[][] =
    numRows > 0
      ? srcSheet.getRange(startRow - 1, 0, numRows, maxColIdx + 1)?.getValues?.() || []
      : [];

  const reshapedMatrix: any[][] = [];

  for (let i = 0; i < sourceMatrix.length; i++) {
    const rowSlice = sourceMatrix[i] || [];
    const idVals = resolvedIds.map((id) => rowSlice[id.colIndex]);

    for (const valCol of resolvedValues) {
      const cellVal = rowSlice[valCol.colIndex];
      if (ignoreEmpty && (cellVal === undefined || cellVal === null || cellVal === '')) {
        continue;
      }
      reshapedMatrix.push([...idVals, valCol.headerName, cellVal]);
    }
  }

  ensureSheetCapacity(destSheet, reshapedMatrix.length + 2, targetHeaders.length);

  // Write headers to target sheet
  destSheet.getRange(0, 0, 1, targetHeaders.length)?.setValues?.([targetHeaders]);

  // Write reshaped rows
  if (reshapedMatrix.length > 0) {
    destSheet.getRange(1, 0, reshapedMatrix.length, targetHeaders.length)?.setValues?.(reshapedMatrix);
  }

  const durationMs = Math.round(performance.now() - t0);

  return {
    status: 'SUCCESS',
    success: true,
    action: 'reshape_dataset',
    outputSheet: destSheetName,
    sourceRows: effectiveEndRow - startRow + 1,
    reshapedRowsGenerated: reshapedMatrix.length,
    columnsEmitted: targetHeaders,
    samplesPreview: reshapedMatrix.slice(0, 5),
    durationMs,
    message: `Reshaped table from ${effectiveEndRow - startRow + 1} wide rows into ${reshapedMatrix.length} normalized records in worksheet "${destSheetName}" in ${durationMs}ms.`,
  };
}

/**
 * Robust date parser handling Excel serials, ISO dates, US/EU slashes & dashes, and textual months.
 */
function isValidDate(y: number, m: number, d: number): boolean {
  if (m < 1 || m > 12 || d < 1 || d > 31) return false;
  const dt = new Date(y, m - 1, d);
  return dt.getFullYear() === y && dt.getMonth() + 1 === m && dt.getDate() === d;
}

export function parseFlexibleDate(
  val: any,
  preferDayFirst: boolean = true,
  options?: {
    strictNoGuess?: boolean;
    allowedYearMin?: number;
    allowedYearMax?: number;
  }
): { date: Date; year: number; month: number; day: number } | null {
  if (val === undefined || val === null || val === '') return null;

  if (val instanceof Date && !isNaN(val.getTime())) {
    const y = val.getFullYear();
    const m = val.getMonth() + 1;
    const d = val.getDate();
    return isValidDate(y, m, d) ? { date: val, year: y, month: m, day: d } : null;
  }

  // 1. Numeric Excel Serial Number (e.g. 44941)
  if (typeof val === 'number' || /^\d{5}(\.\d+)?$/.test(String(val).trim())) {
    const num = Number(val);
    if (!isNaN(num) && num > 1000 && num < 100000) {
      const ms = Math.round((num - 25569) * 86400 * 1000);
      const d = new Date(ms);
      if (!isNaN(d.getTime())) {
        const y = d.getUTCFullYear();
        const m = d.getUTCMonth() + 1;
        const day = d.getUTCDate();
        if (isValidDate(y, m, day)) {
          return { date: d, year: y, month: m, day };
        }
      }
    }
  }

  const str = String(val).trim();
  if (!str) return null;

  // 2. ISO or YYYY-MM-DD / YYYY/MM/DD / YYYY.MM.DD
  const ymdMatch = str.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/);
  if (ymdMatch) {
    const y = parseInt(ymdMatch[1], 10);
    const m = parseInt(ymdMatch[2], 10);
    const d = parseInt(ymdMatch[3], 10);
    if (isValidDate(y, m, d)) {
      if (options?.allowedYearMin && y < options.allowedYearMin) return null;
      if (options?.allowedYearMax && y > options.allowedYearMax) return null;
      return { date: new Date(y, m - 1, d), year: y, month: m, day: d };
    }
    return null;
  }

  // 3. Two-segment day/month or month/day with 2-4 digit year: DD-MM-YYYY or MM-DD-YYYY
  const dmyMatch = str.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})$/);
  if (dmyMatch) {
    let p1 = parseInt(dmyMatch[1], 10);
    let p2 = parseInt(dmyMatch[2], 10);
    const rawYear = dmyMatch[3];
    if (options?.strictNoGuess && rawYear.length === 2) {
      return null;
    }
    let y = parseInt(rawYear, 10);
    if (y < 100) y += y > 50 ? 1900 : 2000;

    let d: number, m: number;
    if (p1 > 12 && p2 <= 12) {
      d = p1;
      m = p2;
    } else if (p2 > 12 && p1 <= 12) {
      m = p1;
      d = p2;
    } else {
      if (preferDayFirst) {
        d = p1;
        m = p2;
      } else {
        m = p1;
        d = p2;
      }
    }

    if (isValidDate(y, m, d)) {
      if (options?.allowedYearMin && y < options.allowedYearMin) return null;
      if (options?.allowedYearMax && y > options.allowedYearMax) return null;
      return { date: new Date(y, m - 1, d), year: y, month: m, day: d };
    }
    return null;
  }

  // 4. Textual month format: "15 Jan 2023", "January 15, 2023", "15-Jan-2023"
  const MONTHS: Record<string, number> = {
    jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3, apr: 4, april: 4,
    may: 5, jun: 6, june: 6, jul: 7, july: 7, aug: 8, august: 8, sep: 9, september: 9,
    oct: 10, october: 10, nov: 11, november: 11, dec: 12, december: 12,
  };

  const textMatch =
    str.match(/^([a-zA-Z]+)[,\s-]+(\d{1,2})[,\s-]+(\d{2,4})$/) ||
    str.match(/^(\d{1,2})[,\s-]+([a-zA-Z]+)[,\s-]+(\d{2,4})$/);
  if (textMatch) {
    const isFirstMonth = isNaN(Number(textMatch[1]));
    const monthStr = (isFirstMonth ? textMatch[1] : textMatch[2]).toLowerCase();
    const dayNum = parseInt(isFirstMonth ? textMatch[2] : textMatch[1], 10);
    const rawY = textMatch[3];
    if (options?.strictNoGuess && rawY.length === 2) return null;
    let y = parseInt(rawY, 10);
    if (y < 100) y += y > 50 ? 1900 : 2000;

    const m = MONTHS[monthStr];
    if (m && isValidDate(y, m, dayNum)) {
      return { date: new Date(y, m - 1, dayNum), year: y, month: m, day: dayNum };
    }
    return null;
  }

  if (options?.strictNoGuess) {
    return null;
  }

  // Native parse fallback for non-strict mode
  const native = new Date(str);
  if (!isNaN(native.getTime()) && native.getFullYear() > 1900 && native.getFullYear() < 2100) {
    const y = native.getFullYear();
    const m = native.getMonth() + 1;
    const d = native.getDate();
    if (isValidDate(y, m, d)) {
      return { date: native, year: y, month: m, day: d };
    }
  }

  return null;
}

/**
 * Formats parsed date components into requested target format.
 */
export function formatFormattedDate(
  parts: { year: number; month: number; day: number },
  targetFormat: string
): string {
  const y = String(parts.year);
  const m = String(parts.month).padStart(2, '0');
  const d = String(parts.day).padStart(2, '0');
  const SHORT_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const mName = SHORT_MONTHS[parts.month - 1] || m;

  switch (targetFormat) {
    case 'DD-MM-YYYY':
      return `${d}-${m}-${y}`;
    case 'YYYY-MM-DD':
      return `${y}-${m}-${d}`;
    case 'MM/DD/YYYY':
      return `${m}/${d}/${y}`;
    case 'DD/MM/YYYY':
      return `${d}/${m}/${y}`;
    case 'YYYY/MM/DD':
      return `${y}/${m}/${d}`;
    case 'DD.MM.YYYY':
      return `${d}.${m}.${y}`;
    case 'MMM DD, YYYY':
      return `${mName} ${d}, ${y}`;
    default:
      return `${d}-${m}-${y}`;
  }
}

/**
 * 6. STANDARDIZE DATES (Multi-Format Temporal Normalizer)
 * Parses mixed date formats (Excel serials, US slashes, EU dashes, ISO, textual months)
 * and standardizes the entire column in-engine in milliseconds without writing circular formulas.
 * Supports row-by-row customer country conventions (US month-first vs EU day-first),
 * placement right of source column, strict no-guess mode, and unparseable audit tracking.
 */
export async function executeStandardizeDates(
  args: {
    sheetName?: string;
    column: string;
    countryColumn?: string;
    localeColumn?: string;
    outputFormat?:
      | 'DD-MM-YYYY'
      | 'YYYY-MM-DD'
      | 'MM/DD/YYYY'
      | 'DD/MM/YYYY'
      | 'YYYY/MM/DD'
      | 'DD.MM.YYYY'
      | 'MMM DD, YYYY';
    preferDayFirst?: boolean;
    invalidHandling?: 'keep_original' | 'set_empty' | 'flag_invalid';
    targetColumn?: string;
    insertPlacement?: 'inplace' | 'right_of_source' | 'append';
    newHeader?: string;
    strictNoGuess?: boolean;
    allowedYearRange?: [number, number];
    startRow?: number;
    endRow?: number;
  },
  ctx: ToolExecutionContext
) {
  const t0 = performance.now();
  const {
    sheetName,
    column,
    countryColumn,
    localeColumn,
    outputFormat = 'DD-MM-YYYY',
    preferDayFirst = true,
    invalidHandling = 'keep_original',
    targetColumn,
    insertPlacement = 'inplace',
    newHeader,
    strictNoGuess = false,
    allowedYearRange,
    startRow,
    endRow,
  } = args;

  const wb = ctx.univerAPI?.getActiveWorkbook?.();
  if (!wb) throw new Error('Univer active workbook unavailable');

  const sheet = resolveWorksheet(wb, sheetName);
  if (!sheet) throw new Error(`Worksheet ${sheetName || 'active'} not found`);

  const lastSheetRow = Math.max((sheet.getLastRow?.() ?? 0) + 1, 1);
  const lastSheetCol = Math.max((sheet.getLastColumn?.() ?? 0) + 1, 1);

  const fullRangeNotation = `A1:${colIndexToLetter(lastSheetCol - 1)}${lastSheetRow}`;
  const fullTableValues: any[][] = sheet.getRange(fullRangeNotation)?.getValues?.() || [];

  const { headerRowIdx, headerVals } = detectTableHeaderRow(fullTableValues);
  const effectiveHeaderRow = headerRowIdx;
  const effectiveStartRow = startRow !== undefined ? startRow : effectiveHeaderRow + 2;
  const effectiveEndRow = endRow ? Math.min(endRow, lastSheetRow) : lastSheetRow;

  if (effectiveEndRow < effectiveStartRow) {
    return {
      success: true,
      rowsStandardized: 0,
      detectedHeaderRow: effectiveHeaderRow + 1,
      message: 'No data rows to standardize.',
    };
  }

  const srcCol = resolveColumnSmart(sheet, column, effectiveHeaderRow);

  let countryCol: any = null;
  const countryColRef = countryColumn || localeColumn;
  if (countryColRef) {
    countryCol = resolveColumnSmart(sheet, countryColRef, effectiveHeaderRow);
  }

  // Determine target column and handle insertion placement if requested
  let destColIndex = srcCol.colIndex;
  let destColLetter = srcCol.colLetter;

  if (insertPlacement === 'right_of_source') {
    destColIndex = srcCol.colIndex + 1;
    sheet.insertColumns?.(destColIndex, 1);
    ensureSheetCapacity(sheet, effectiveEndRow + 2, destColIndex + 1);
    const targetHeaderTitle =
      newHeader || (srcCol.headerName ? `${srcCol.headerName} (ISO)` : 'Date (ISO)');
    sheet.getRange(effectiveHeaderRow, destColIndex, 1, 1)?.setValues?.([[targetHeaderTitle]]);
    destColLetter = colIndexToLetter(destColIndex);
  } else if (insertPlacement === 'append') {
    destColIndex = lastSheetCol;
    ensureSheetCapacity(sheet, effectiveEndRow + 2, destColIndex + 1);
    const targetHeaderTitle = newHeader || 'Date (ISO)';
    sheet.getRange(effectiveHeaderRow, destColIndex, 1, 1)?.setValues?.([[targetHeaderTitle]]);
    destColLetter = colIndexToLetter(destColIndex);
  } else if (targetColumn) {
    const resolvedTarget = resolveColumnSmart(sheet, targetColumn, effectiveHeaderRow);
    destColIndex = resolvedTarget.colIndex;
    destColLetter = resolvedTarget.colLetter;
    if (newHeader) {
      sheet.getRange(effectiveHeaderRow, destColIndex, 1, 1)?.setValues?.([[newHeader]]);
    }
  }

  const numDataRows = effectiveEndRow - effectiveStartRow + 1;
  const standardizedValues: any[][] = [];
  const samplesBefore: any[] = [];
  const samplesAfter: any[] = [];
  const unparseableAudit: Array<{
    rowNumber: number;
    rawValue: any;
    country?: string;
    reason: string;
  }> = [];

  let convertedCount = 0;
  let unparsedCount = 0;

  for (let i = 0; i < numDataRows; i++) {
    const excelRowNum = effectiveStartRow + i;
    const originalVal = fullTableValues[excelRowNum - 1]?.[srcCol.colIndex];
    const countryRaw = countryCol ? fullTableValues[excelRowNum - 1]?.[countryCol.colIndex] : undefined;
    const countryStr = countryRaw !== undefined && countryRaw !== null ? String(countryRaw).trim() : '';

    if (samplesBefore.length < 5 && originalVal !== undefined && originalVal !== null && originalVal !== '') {
      samplesBefore.push(originalVal);
    }

    if (originalVal === undefined || originalVal === null || String(originalVal).trim() === '') {
      unparsedCount++;
      unparseableAudit.push({
        rowNumber: excelRowNum,
        rawValue: originalVal ?? '',
        country: countryStr || undefined,
        reason: 'Empty / blank cell',
      });
      standardizedValues.push(['']);
      continue;
    }

    // Determine row-level preferDayFirst based on country convention
    let rowPreferDayFirst = preferDayFirst;
    if (countryStr) {
      const cUpper = countryStr.toUpperCase();
      if (cUpper === 'US' || cUpper === 'USA' || cUpper === 'UNITED STATES') {
        rowPreferDayFirst = false; // US is month-first!
      } else {
        rowPreferDayFirst = true; // everyone else is day-first!
      }
    }

    const parsed = parseFlexibleDate(originalVal, rowPreferDayFirst, {
      strictNoGuess,
      allowedYearMin: allowedYearRange?.[0],
      allowedYearMax: allowedYearRange?.[1],
    });

    if (parsed) {
      const formatted = formatFormattedDate(parsed, outputFormat);
      standardizedValues.push([formatted]);
      convertedCount++;

      if (samplesAfter.length < 5) {
        samplesAfter.push(formatted);
      }
    } else {
      unparsedCount++;
      const reason =
        String(originalVal).includes('/') || String(originalVal).includes('-')
          ? 'Invalid or impossible calendar date'
          : 'Non-date text or unrecognized format';

      unparseableAudit.push({
        rowNumber: excelRowNum,
        rawValue: originalVal,
        country: countryStr || undefined,
        reason,
      });

      if (invalidHandling === 'set_empty') {
        standardizedValues.push(['']);
      } else if (invalidHandling === 'flag_invalid') {
        standardizedValues.push(['[INVALID_DATE]']);
      } else {
        standardizedValues.push([originalVal]);
      }
    }
  }

  // Write standardized values into target column
  ensureSheetCapacity(sheet, effectiveEndRow + 2, destColIndex + 1);
  const destRangeNotation = `${destColLetter}${effectiveStartRow}:${destColLetter}${effectiveEndRow}`;
  sheet.getRange(destRangeNotation)?.setValues?.(standardizedValues);

  // Format Markdown Audit Table for unparseable dates
  let formattedAuditTable = '';
  if (unparseableAudit.length > 0) {
    const mdLines: string[] = [];
    mdLines.push(`| Row | Raw Value | Country | Reason |`);
    mdLines.push(`| --- | --- | --- | --- |`);
    for (const item of unparseableAudit.slice(0, 30)) {
      mdLines.push(
        `| ${item.rowNumber} | ${String(item.rawValue || '(blank)')} | ${item.country || 'N/A'} | ${item.reason} |`
      );
    }
    if (unparseableAudit.length > 30) {
      mdLines.push(`| ... | ... and ${unparseableAudit.length - 30} more row(s) | ... | ... |`);
    }
    formattedAuditTable = mdLines.join('\n');
  }

  const durationMs = Math.round(performance.now() - t0);

  return {
    status: 'SUCCESS',
    success: true,
    action: 'standardize_dates',
    detectedHeaderRow: effectiveHeaderRow + 1,
    sourceColumn: srcCol.colLetter,
    targetColumn: destColLetter,
    outputFormat,
    rowsProcessed: numDataRows,
    convertedCount,
    unparsedCount,
    unparseableAudit,
    formattedAuditTable,
    samplesBefore,
    samplesAfter,
    durationMs,
    message: `Standardized ${convertedCount} date(s) in Column ${destColLetter} to format "${outputFormat}" in ${durationMs}ms.${unparsedCount > 0 ? ` (Found ${unparsedCount} unparseable/blank date(s)).` : ''}`,
  };
}

/**
 * 7. INSPECT AND CLUSTER CATEGORIES (Entity Resolution & Categorical Normalizer)
 * Scans categorical columns for dirty abbreviations, punctuation, casing, and Jaro-Winkler
 * typos (e.g. "North" vs "N", "N.", "north"), clusters them into canonical entities,
 * and optionally normalizes them in-place or to a target column.
 */
export async function executeInspectAndClusterCategories(
  args: {
    sheetName?: string;
    columns: string[];
    applyNormalization?: boolean;
    customSynonyms?: Record<string, string>;
    startRow?: number;
    endRow?: number;
  },
  ctx: ToolExecutionContext
) {
  const t0 = performance.now();
  const {
    sheetName,
    columns,
    applyNormalization = true,
    customSynonyms = {},
    startRow = 2,
    endRow,
  } = args;

  const wb = ctx.univerAPI?.getActiveWorkbook?.();
  if (!wb) throw new Error('Univer active workbook unavailable');

  const sheet = resolveWorksheet(wb, sheetName);
  const lastSheetRow = Math.max((sheet.getLastRow?.() ?? 0) + 1, 1);
  const effectiveEndRow = endRow ? Math.min(endRow, lastSheetRow) : lastSheetRow;

  const columnReports: Record<string, any> = {};
  let totalNormalizedCells = 0;

  for (const colRef of columns) {
    const col = resolveColumnSmart(sheet, colRef, 0);
    const rangeNotation = `${col.colLetter}${startRow}:${col.colLetter}${effectiveEndRow}`;
    const rawMatrix: any[][] = sheet.getRange(rangeNotation)?.getValues?.() || [];
    const flatVals = rawMatrix.map((r) => r?.[0]);

    const clustering = clusterCategoryValues(flatVals);

    // Apply any explicit customSynonyms on top
    const customMap: Record<string, string> = { ...clustering.mapping };
    for (const [variant, canonical] of Object.entries(customSynonyms)) {
      customMap[variant.trim()] = canonical.trim();
    }

    let cellsChangedInCol = 0;
    if (applyNormalization && (clustering.hasCollisions || Object.keys(customSynonyms).length > 0)) {
      const updatedMatrix = flatVals.map((val) => {
        if (val === undefined || val === null || String(val).trim() === '') return [val];
        const rawStr = String(val).trim();
        const canonical = customMap[rawStr] || customMap[String(val)] || rawStr;
        if (canonical !== val) cellsChangedInCol++;
        return [canonical];
      });

      if (cellsChangedInCol > 0) {
        sheet.getRange(rangeNotation)?.setValues?.(updatedMatrix);
        totalNormalizedCells += cellsChangedInCol;
      }
    }

    columnReports[col.headerName] = {
      columnLetter: col.colLetter,
      headerName: col.headerName,
      distinctBefore: clustering.totalDistinctRaw,
      distinctAfter: clustering.totalCanonicalGroups,
      hasCollisions: clustering.hasCollisions,
      cellsNormalized: cellsChangedInCol,
      clusters: clustering.clusters,
      collisionSummary: clustering.collisionSummary,
    };
  }

  const durationMs = Math.round(performance.now() - t0);

  return {
    status: 'SUCCESS',
    success: true,
    action: 'inspect_and_cluster_categories',
    applyNormalization,
    totalNormalizedCells,
    columns: columnReports,
    durationMs,
    message: applyNormalization
      ? `Inspected ${columns.length} categorical column(s) and normalized ${totalNormalizedCells} dirty variant cell(s) in ${durationMs}ms.`
      : `Inspected ${columns.length} categorical column(s) and identified entity clusters in ${durationMs}ms.`,
  };
}

// ============================================================================
// CLEAN & IMPUTE CURRENCY EXECUTOR
// ============================================================================

const ISO_CURRENCY_REGEX =
  /\b(USD|EUR|JPY|GBP|CHF|CAD|AUD|CNY|INR|NZD|SEK|NOK|DKK|BRL|MXN|SGD|HKD|KRW|ZAR|RUB|TRY|PLN|TWD|THB|IDR|MYR|PHP)\b/i;

const CURRENCY_SYMBOL_MAP: Array<[RegExp, string]> = [
  [/CA\$|C\$/i, 'CAD'],
  [/AU\$|A\$/i, 'AUD'],
  [/NZ\$/i, 'NZD'],
  [/HK\$/i, 'HKD'],
  [/SG\$/i, 'SGD'],
  [/R\$/i, 'BRL'],
  [/€/, 'EUR'],
  [/£/, 'GBP'],
  [/¥/, 'JPY'],
  [/₹/, 'INR'],
  [/₩/, 'KRW'],
  [/₪/, 'ILS'],
  [/₫/, 'VND'],
  [/฿/, 'THB'],
  [/\$/, 'USD'],
];

function parseCurrencyAndAmount(val: any): { amount: number | null; currency: string | null } {
  if (val === null || val === undefined || typeof val === 'boolean') {
    return { amount: null, currency: null };
  }
  if (typeof val === 'number') {
    return { amount: Number.isFinite(val) ? val : null, currency: null };
  }

  let str = String(val).trim();
  if (
    !str ||
    str === '-' ||
    str === '--' ||
    str === 'n/a' ||
    str === 'null' ||
    str === 'nil' ||
    str.toLowerCase() === 'undefined'
  ) {
    return { amount: null, currency: null };
  }

  let detectedCurrency: string | null = null;

  // 1. Check for 3-letter ISO code
  const isoMatch = str.match(ISO_CURRENCY_REGEX);
  if (isoMatch) {
    detectedCurrency = isoMatch[1].toUpperCase();
    str = str.replace(new RegExp(`\\b${isoMatch[1]}\\b`, 'gi'), '').trim();
  }

  // 2. Check for symbols
  for (const [pattern, code] of CURRENCY_SYMBOL_MAP) {
    if (pattern.test(str)) {
      if (!detectedCurrency) {
        detectedCurrency = code;
      }
      str = str.replace(pattern, '').trim();
      break;
    }
  }

  const amount = parseRobustNumber(str);
  return { amount, currency: detectedCurrency };
}

function normalizeDateKey(val: any): string {
  if (val === null || val === undefined || val === '') return '';
  if (val instanceof Date) {
    const y = val.getFullYear();
    const m = String(val.getMonth() + 1).padStart(2, '0');
    const d = String(val.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }
  const s = String(val).trim();
  const isoMatch = s.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})/);
  if (isoMatch) {
    return `${isoMatch[1]}-${String(isoMatch[2]).padStart(2, '0')}-${String(isoMatch[3]).padStart(2, '0')}`;
  }
  const slashMatch = s.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{4})/);
  if (slashMatch) {
    return `${slashMatch[3]}-${String(slashMatch[1]).padStart(2, '0')}-${String(slashMatch[2]).padStart(2, '0')}`;
  }
  return s;
}

export interface CleanAndImputeCurrencyParams {
  sheetName: string;
  sourceColumn: string;
  targetColumn?: string;
  currencyColumnName?: string;
  imputeBlanks?: {
    keyColumn: string;
    lookupSheetName: string;
    lookupKeyColumn: string;
    lookupPriceColumn: string;
    dateColumn?: string;
    fxSheetName?: string;
    fxDateColumn?: string;
    baseCurrency?: string;
  };
  headerRowIndex?: number;
  startRow?: number;
  endRow?: number;
}

/**
 * Parses mixed international currency formatting (e.g. 1.299,00 € vs ¥15,800 vs $100.50),
 * splits amounts into numeric values and ISO currency codes, and derives/imputes blank
 * prices from reference product sheets and daily FX rate sheets in 1 vectorized call.
 * Existing values are NEVER overwritten by reference list prices.
 */
export async function executeCleanAndImputeCurrency(
  params: CleanAndImputeCurrencyParams,
  ctx: ToolExecutionContext
): Promise<any> {
  const t0 = performance.now();
  const {
    sheetName,
    sourceColumn,
    targetColumn,
    currencyColumnName = 'Currency',
    imputeBlanks,
    headerRowIndex,
    startRow,
    endRow,
  } = params;

  const wb = ctx.univerAPI?.getActiveWorkbook?.();
  if (!wb) throw new Error('Univer active workbook unavailable');

  const sheet = resolveWorksheet(wb, sheetName);
  const detected = detectTableHeaderRow(sheet);
  const effectiveHeaderRow =
    headerRowIndex !== undefined ? Math.max(headerRowIndex - 1, 0) : detected.headerRowIdx;
  const effectiveStartRow =
    startRow !== undefined ? Math.max(startRow, 1) : effectiveHeaderRow + 2;
  const lastSheetRow = Math.max((sheet.getLastRow?.() ?? 0) + 1, effectiveStartRow);
  const effectiveEndRow = endRow ? Math.min(endRow, lastSheetRow) : lastSheetRow;
  const lastSheetCol = Math.max((sheet.getLastColumn?.() ?? 0) + 1, 15);

  // Read full table in memory before any insertions
  const readRangeNotation = `A1:${colIndexToLetter(lastSheetCol - 1)}${effectiveEndRow}`;
  const fullTableValues: any[][] = sheet.getRange(readRangeNotation)?.getValues?.() || [];

  const sourceCol = resolveColumnSmart(sheet, sourceColumn, effectiveHeaderRow);

  // Resolve target column (where clean numeric price goes)
  let targetCol = sourceCol;
  if (targetColumn && targetColumn !== sourceColumn) {
    const existingTargetHeader = detected.headerVals.find(
      (h) => String(h || '').trim().toLowerCase() === targetColumn.trim().toLowerCase()
    );
    if (existingTargetHeader) {
      targetCol = resolveColumnSmart(sheet, targetColumn, effectiveHeaderRow);
    } else {
      const newColIndex = sourceCol.colIndex + 1;
      sheet.insertColumns?.(newColIndex, 1);
      ensureSheetCapacity(sheet, effectiveEndRow + 2, newColIndex + 1);
      sheet.getRange(effectiveHeaderRow, newColIndex, 1, 1)?.setValues?.([[targetColumn]]);
      targetCol = {
        colIndex: newColIndex,
        colLetter: colIndexToLetter(newColIndex),
        headerName: targetColumn,
      };
    }
  }

  // Resolve currency column (where clean ISO code goes)
  let currencyCol: { colIndex: number; colLetter: string; headerName: string } | null = null;
  if (currencyColumnName) {
    const existingCurrencyHeader = detected.headerVals.find(
      (h) => String(h || '').trim().toLowerCase() === currencyColumnName.trim().toLowerCase()
    );
    if (existingCurrencyHeader) {
      currencyCol = resolveColumnSmart(sheet, currencyColumnName, effectiveHeaderRow);
    } else {
      const newColIndex = targetCol.colIndex + 1;
      sheet.insertColumns?.(newColIndex, 1);
      ensureSheetCapacity(sheet, effectiveEndRow + 2, newColIndex + 1);
      sheet.getRange(effectiveHeaderRow, newColIndex, 1, 1)?.setValues?.([[currencyColumnName]]);
      currencyCol = {
        colIndex: newColIndex,
        colLetter: colIndexToLetter(newColIndex),
        headerName: currencyColumnName,
      };
    }
  }

  // Build in-memory cache for Products and FX_Rates if imputeBlanks is provided
  const productPriceMap = new Map<string, number>();
  const fxRatesMap = new Map<string, Map<string, number>>();
  let keyCol: any = null;
  let dateCol: any = null;

  if (imputeBlanks) {
    if (imputeBlanks.keyColumn) {
      keyCol = resolveColumnSmart(sheet, imputeBlanks.keyColumn, effectiveHeaderRow);
    }
    if (imputeBlanks.dateColumn) {
      dateCol = resolveColumnSmart(sheet, imputeBlanks.dateColumn, effectiveHeaderRow);
    }

    // 1. Build product reference prices map
    if (imputeBlanks.lookupSheetName) {
      const lookupSheet = resolveWorksheet(wb, imputeBlanks.lookupSheetName);
      const lookupDetected = detectTableHeaderRow(lookupSheet);
      const lookupKeyCol = resolveColumnSmart(
        lookupSheet,
        imputeBlanks.lookupKeyColumn,
        lookupDetected.headerRowIdx
      );
      const lookupPriceCol = resolveColumnSmart(
        lookupSheet,
        imputeBlanks.lookupPriceColumn,
        lookupDetected.headerRowIdx
      );

      const lookupStartRow0 = lookupDetected.headerRowIdx + 1;
      const lookupLastRow = Math.max(
        (lookupSheet.getLastRow?.() ?? 0) + 1,
        lookupStartRow0 + 1
      );
      const lookupLastCol = Math.max((lookupSheet.getLastColumn?.() ?? 0) + 1, 10);
      const lookupMatrix: any[][] =
        lookupSheet
          .getRange(`A1:${colIndexToLetter(lookupLastCol - 1)}${lookupLastRow}`)
          ?.getValues?.() || [];

      for (let r = lookupStartRow0; r < lookupMatrix.length; r++) {
        const row = lookupMatrix[r];
        if (!row) continue;
        const k = String(row[lookupKeyCol.colIndex] || '').trim();
        if (!k) continue;
        const p = parseRobustNumber(row[lookupPriceCol.colIndex]);
        if (p !== null) {
          productPriceMap.set(k, p);
          productPriceMap.set(k.toUpperCase(), p);
        }
      }
    }

    // 2. Build daily FX rates map
    if (imputeBlanks.fxSheetName) {
      const fxSheet = resolveWorksheet(wb, imputeBlanks.fxSheetName);
      const fxDetected = detectTableHeaderRow(fxSheet);
      const fxDateCol = resolveColumnSmart(
        fxSheet,
        imputeBlanks.fxDateColumn || 'Date',
        fxDetected.headerRowIdx
      );

      const fxStartRow0 = fxDetected.headerRowIdx + 1;
      const fxLastRow = Math.max((fxSheet.getLastRow?.() ?? 0) + 1, fxStartRow0 + 1);
      const fxLastCol = Math.max((fxSheet.getLastColumn?.() ?? 0) + 1, 10);
      const fxMatrix: any[][] =
        fxSheet.getRange(`A1:${colIndexToLetter(fxLastCol - 1)}${fxLastRow}`)?.getValues?.() || [];

      const headerRow = fxMatrix[fxDetected.headerRowIdx] || [];
      const currencyColMap: Record<string, number> = {};
      for (let c = 0; c < headerRow.length; c++) {
        if (c === fxDateCol.colIndex) continue;
        const h = String(headerRow[c] || '').trim().toUpperCase();
        if (h) {
          currencyColMap[h] = c;
        }
      }

      // Handle matrix format: headers are ISO codes (USD, EUR, JPY, GBP)
      for (let r = fxStartRow0; r < fxMatrix.length; r++) {
        const row = fxMatrix[r];
        if (!row) continue;
        const rawDate = row[fxDateCol.colIndex];
        const dateKey = normalizeDateKey(rawDate);
        if (!dateKey) continue;

        if (!fxRatesMap.has(dateKey)) {
          fxRatesMap.set(dateKey, new Map<string, number>());
        }
        const rates = fxRatesMap.get(dateKey)!;

        for (const [currCode, colIdx] of Object.entries(currencyColMap)) {
          const rate = parseRobustNumber(row[colIdx]);
          if (rate !== null) {
            rates.set(currCode, rate);
          }
        }
      }

      // Handle relational format: Currency / Rate columns
      const currColIdx =
        currencyColMap['CURRENCY'] ?? currencyColMap['TO'] ?? currencyColMap['TOCURRENCY'];
      const rateColIdx =
        currencyColMap['RATE'] ?? currencyColMap['FXRATE'] ?? currencyColMap['EXCHANGERATE'];
      if (currColIdx !== undefined && rateColIdx !== undefined) {
        for (let r = fxStartRow0; r < fxMatrix.length; r++) {
          const row = fxMatrix[r];
          if (!row) continue;
          const dateKey = normalizeDateKey(row[fxDateCol.colIndex]);
          const curr = String(row[currColIdx] || '').trim().toUpperCase();
          const rate = parseRobustNumber(row[rateColIdx]);
          if (dateKey && curr && rate !== null) {
            if (!fxRatesMap.has(dateKey)) fxRatesMap.set(dateKey, new Map<string, number>());
            fxRatesMap.get(dateKey)!.set(curr, rate);
          }
        }
      }
    }
  }

  // Iterate over data rows
  const numDataRows = effectiveEndRow - effectiveStartRow + 1;
  const targetValues: any[][] = [];
  const currencyValues: any[][] = [];

  let existingCleanedCount = 0;
  let derivedCount = 0;
  let untouchedCount = 0;
  let unresolvedCount = 0;

  for (let i = 0; i < numDataRows; i++) {
    const excelRowNum = effectiveStartRow + i;
    const row = fullTableValues[excelRowNum - 1];

    // Detect repeating header row and skip
    if (
      row &&
      String(row[sourceCol.colIndex] || '').trim().toLowerCase() ===
        sourceCol.headerName.toLowerCase()
    ) {
      targetValues.push([row[targetCol.colIndex]]);
      if (currencyCol) currencyValues.push([row[currencyCol.colIndex]]);
      continue;
    }

    const rawVal = row ? row[sourceCol.colIndex] : undefined;
    const existingCurrencyRaw = currencyCol && row ? row[currencyCol.colIndex] : undefined;
    const existingCurr =
      existingCurrencyRaw !== undefined && existingCurrencyRaw !== null
        ? String(existingCurrencyRaw).trim().toUpperCase()
        : '';

    const { amount, currency: parsedCurr } = parseCurrencyAndAmount(rawVal);

    if (amount !== null) {
      // Cell already had a value: Clean and preserve in-place. DO NOT OVERWRITE WITH LIST PRICE.
      const finalCurr = parsedCurr || existingCurr || '';
      targetValues.push([amount]);
      currencyValues.push([finalCurr]);

      if (typeof rawVal === 'number' && rawVal === amount && existingCurr === finalCurr) {
        untouchedCount++;
      } else {
        existingCleanedCount++;
      }
    } else {
      // Cell is blank
      if (imputeBlanks) {
        const keyVal = keyCol && row ? String(row[keyCol.colIndex] || '').trim() : '';
        const basePrice =
          productPriceMap.get(keyVal) ?? productPriceMap.get(keyVal.toUpperCase());
        const baseCurrency = (imputeBlanks.baseCurrency || 'USD').toUpperCase();
        const rowCurrency = existingCurr || baseCurrency;

        if (basePrice !== undefined && basePrice !== null) {
          let finalPrice = basePrice;
          if (imputeBlanks.fxSheetName && rowCurrency !== baseCurrency) {
            const rawDate = dateCol && row ? row[dateCol.colIndex] : null;
            const dateKey = normalizeDateKey(rawDate);
            const dayRates = dateKey ? fxRatesMap.get(dateKey) : undefined;
            const fxRate = dayRates ? dayRates.get(rowCurrency) : undefined;

            if (fxRate !== undefined && fxRate !== null && fxRate > 0) {
              finalPrice = basePrice * fxRate;
            }
          }

          const isZeroDecimal = ['JPY', 'KRW', 'VND', 'CLP'].includes(rowCurrency);
          const roundedPrice = isZeroDecimal
            ? Math.round(finalPrice)
            : Math.round(finalPrice * 100) / 100;

          targetValues.push([roundedPrice]);
          currencyValues.push([rowCurrency]);
          derivedCount++;
        } else {
          targetValues.push(['']);
          currencyValues.push([existingCurr || '']);
          unresolvedCount++;
        }
      } else {
        targetValues.push(['']);
        currencyValues.push([existingCurr || '']);
        untouchedCount++;
      }
    }
  }

  // Vectorized batch writes
  const targetRangeNotation = `${targetCol.colLetter}${effectiveStartRow}:${targetCol.colLetter}${effectiveEndRow}`;
  sheet.getRange(targetRangeNotation)?.setValues?.(targetValues);

  if (currencyCol) {
    const currencyRangeNotation = `${currencyCol.colLetter}${effectiveStartRow}:${currencyCol.colLetter}${effectiveEndRow}`;
    sheet.getRange(currencyRangeNotation)?.setValues?.(currencyValues);
  }

  const durationMs = Math.round(performance.now() - t0);

  const summaryTable = [
    '| Metric | Count |',
    '| :--- | :--- |',
    `| **Detected Header Row** | Row ${effectiveHeaderRow + 1} |`,
    `| **Cleaned Existing Values** | ${existingCleanedCount} |`,
    `| **Derived Blanks (Imputed)** | ${derivedCount} |`,
    `| **Untouched Values** | ${untouchedCount} |`,
    `| **Unresolved Blanks** | ${unresolvedCount} |`,
    `| **Total Processed Rows** | ${numDataRows} |`,
  ].join('\n');

  return {
    status: 'SUCCESS',
    success: true,
    action: 'clean_and_impute_currency',
    detectedHeaderRow: effectiveHeaderRow + 1,
    existingCleanedCount,
    derivedCount,
    untouchedCount,
    unresolvedCount,
    totalRowsProcessed: numDataRows,
    sourceColumn: sourceCol.headerName,
    targetColumn: targetCol.headerName,
    currencyColumn: currencyCol ? currencyCol.headerName : undefined,
    durationMs,
    summaryTable,
    message: `Cleaned ${existingCleanedCount} existing currency cell(s) and derived ${derivedCount} blank cell(s) from reference prices & daily FX in ${durationMs}ms.`,
  };
}
