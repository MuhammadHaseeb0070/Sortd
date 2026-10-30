import { ToolExecutionContext } from '../../types';
import { colIndexToLetter, letterToColIndex } from '../../radar';

// Levenshtein similarity for fuzzy matching (0.0 to 1.0)
function calculateStringSimilarity(s1: string, s2: string): number {
  const str1 = String(s1 || '').toLowerCase().trim();
  const str2 = String(s2 || '').toLowerCase().trim();
  if (str1 === str2) return 1.0;
  if (!str1 || !str2) return 0.0;
  if (str1.includes(str2) || str2.includes(str1)) return 0.85;

  const longer = str1.length > str2.length ? str1 : str2;
  const shorter = str1.length > str2.length ? str2 : str1;
  const costs: number[] = [];

  for (let i = 0; i <= str1.length; i++) {
    let lastVal = i;
    for (let j = 0; j <= str2.length; j++) {
      if (i === 0) costs[j] = j;
      else if (j > 0) {
        let newVal = costs[j - 1];
        if (str1.charAt(i - 1) !== str2.charAt(j - 1)) {
          newVal = Math.min(Math.min(newVal, lastVal), costs[j]) + 1;
        }
        costs[j - 1] = lastVal;
        lastVal = newVal;
      }
    }
    if (i > 0) costs[str2.length] = lastVal;
  }
  return (longer.length - costs[str2.length]) / longer.length;
}

/**
 * Resolves a column identifier (either an Excel letter like "A" / "BC" or a header label like "First Name")
 * to its 0-indexed column integer, letter, and detected header label.
 */
function resolveColumn(
  sheet: any,
  ref: string | number,
  headerRowIdx: number = 0
): { colIndex: number; colLetter: string; headerName: string } {
  if (typeof ref === 'number') {
    return {
      colIndex: ref,
      colLetter: colIndexToLetter(ref),
      headerName: String(sheet.getRange(headerRowIdx, ref)?.getValue?.() || colIndexToLetter(ref)),
    };
  }

  const trimmed = String(ref).trim();
  // If it's a pure A-Z column notation
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

  // Otherwise, match against Row 1 header names
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

  // Fallback: treat as column letter anyway
  const fallbackIdx = letterToColIndex(trimmed);
  return { colIndex: fallbackIdx, colLetter: colIndexToLetter(fallbackIdx), headerName: trimmed };
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
        return (${expressionStr});
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

  // Resolve source columns
  const resolvedSources = sourceColumns.map((colRef) => resolveColumn(srcSheet, colRef, 0));

  // Determine target column index
  let targetColIdx: number;
  if (insertMode === 'append') {
    targetColIdx = (destSheet.getLastColumn?.() ?? 0) + 1;
  } else if (targetColumn) {
    targetColIdx = resolveColumn(destSheet, targetColumn, 0).colIndex;
  } else {
    // Default: place directly after the rightmost source column
    const maxSourceIdx = Math.max(...resolvedSources.map((s) => s.colIndex));
    targetColIdx = maxSourceIdx + 1;
  }

  if (insertMode === 'insert_new') {
    destSheet.insertColumns?.(targetColIdx, 1);
  }

  const numDataRows = effectiveEndRow - startRow + 1;

  // Read all source columns in batch
  const sourceColumnData: Map<number, any[]> = new Map();
  for (const src of resolvedSources) {
    const rangeNotation = `${src.colLetter}${startRow}:${src.colLetter}${effectiveEndRow}`;
    const vals = srcSheet.getRange(rangeNotation)?.getValues?.() || [];
    sourceColumnData.set(
      src.colIndex,
      vals.map((r: any[]) => r[0])
    );
  }

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
              compiled = compiled.replace(new RegExp(`\\{${k}\\}`, 'g'), v !== undefined && v !== null ? String(v) : '');
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
        compiled = compiled.replace(new RegExp(`\\{${k}\\}`, 'g'), v !== undefined && v !== null ? String(v) : '');
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
export async function executeDeduplicateDataset(
  args: {
    sheetName?: string;
    keyColumns?: string[];
    matchMode?: 'exact' | 'fuzzy';
    fuzzyThreshold?: number;
    strategy?: 'keep_first' | 'keep_last';
    tieBreaker?: {
      column: string;
      rule: 'max' | 'min' | 'most_complete' | 'expression';
      expression?: string;
    };
    coalesceDuplicates?: boolean;
    action?: 'delete_rows' | 'quarantine_to_sheet' | 'flag_column';
    flagColumnHeader?: string;
    targetSheetName?: string;
    startRow?: number;
    endRow?: number;
  },
  ctx: ToolExecutionContext
) {
  const t0 = performance.now();
  const {
    sheetName,
    keyColumns,
    matchMode = 'exact',
    fuzzyThreshold = 0.85,
    strategy = 'keep_first',
    tieBreaker,
    coalesceDuplicates = false,
    action = 'delete_rows',
    flagColumnHeader = 'Is_Duplicate',
    targetSheetName,
    startRow = 2,
    endRow,
  } = args;

  const wb = ctx.univerAPI?.getActiveWorkbook?.();
  if (!wb) throw new Error('Univer active workbook unavailable');

  const sheet = sheetName ? wb.getSheetByName?.(sheetName) : wb.getActiveSheet?.();
  if (!sheet) throw new Error(`Worksheet ${sheetName || 'active'} not found`);

  const lastSheetRow = Math.max((sheet.getLastRow?.() ?? 0) + 1, 1);
  const lastSheetCol = Math.max((sheet.getLastColumn?.() ?? 0) + 1, 1);
  const effectiveEndRow = endRow ? Math.min(endRow, lastSheetRow) : lastSheetRow;

  if (effectiveEndRow < startRow) {
    return { success: true, duplicatesFound: 0, message: 'No rows to evaluate' };
  }

  // Read full occupied table
  const fullRangeNotation = `A1:${colIndexToLetter(lastSheetCol - 1)}${effectiveEndRow}`;
  const fullTableValues: any[][] = sheet.getRange(fullRangeNotation)?.getValues?.() || [];

  const headers = fullTableValues[0] || [];
  const dataRowsWithIdx: Array<{ originalRowIdx: number; rowNumber: number; values: any[] }> = [];

  for (let r = startRow - 1; r < fullTableValues.length; r++) {
    dataRowsWithIdx.push({
      originalRowIdx: r,
      rowNumber: r + 1,
      values: fullTableValues[r] || [],
    });
  }

  // Resolve key column indices
  let keyIndices: number[] = [];
  if (keyColumns && keyColumns.length > 0) {
    keyIndices = keyColumns.map((colRef) => resolveColumn(sheet, colRef, 0).colIndex);
  } else {
    // All occupied columns
    keyIndices = Array.from({ length: lastSheetCol }, (_, i) => i);
  }

  // Group duplicate rows
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
        // Fuzzy comparison
        const sim = calculateStringSimilarity(baseKeyStr, compareKeyStr);
        if (sim >= fuzzyThreshold) isDuplicate = true;
      }

      if (isDuplicate) {
        currentGroup.push(compareRow);
        processedRowIndices.add(j);
      }
    }

    if (currentGroup.length > 1) {
      duplicateGroups.push(currentGroup);
    }
  }

  if (duplicateGroups.length === 0) {
    return {
      success: true,
      duplicatesFound: 0,
      rowsKept: dataRowsWithIdx.length,
      actionTaken: action,
      durationMs: Math.round(performance.now() - t0),
      message: 'Zero duplicate rows detected across the specified key columns.',
    };
  }

  // Resolve winners and losers for each duplicate group
  const rowsToDelete: number[] = [];
  const quarantinedRows: any[][] = [];
  const rowsToUpdateCoalesced: Array<{ rowIdx: number; coalescedValues: any[] }> = [];
  const duplicateFlagMap = new Map<number, boolean>();

  // Resolve tie breaker column if specified
  let tieBreakerColIdx = -1;
  if (tieBreaker?.column) {
    tieBreakerColIdx = resolveColumn(sheet, tieBreaker.column, 0).colIndex;
  }

  for (const group of duplicateGroups) {
    let winner = group[0];
    let losers: typeof group = [];

    if (tieBreaker) {
      group.sort((a, b) => {
        if (tieBreaker.rule === 'most_complete') {
          const compA = a.values.filter((v) => v !== undefined && v !== null && v !== '').length;
          const compB = b.values.filter((v) => v !== undefined && v !== null && v !== '').length;
          return compB - compA; // descending
        }
        if (tieBreakerColIdx !== -1) {
          const valA = a.values[tieBreakerColIdx];
          const valB = b.values[tieBreakerColIdx];
          if (tieBreaker.rule === 'max') return valA < valB ? 1 : -1;
          if (tieBreaker.rule === 'min') return valA > valB ? 1 : -1;
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

    // Coalesce duplicate data into winner if requested
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

  if (action === 'delete_rows') {
    // Update any coalesced rows first
    for (const update of rowsToUpdateCoalesced) {
      sheet.getRange(update.rowIdx, 0, 1, update.coalescedValues.length)?.setValues?.([update.coalescedValues]);
    }
    // Delete duplicate rows from bottom up so index positions don't shift
    const sortedDesc = [...new Set(rowsToDelete)].sort((a, b) => b - a);
    for (const rIdx of sortedDesc) {
      sheet.deleteRows?.(rIdx, 1);
    }
    actionResultMsg = `Deleted ${rowsToDelete.length} duplicate row(s) in-place.`;
  } else if (action === 'quarantine_to_sheet') {
    const qSheetName = targetSheetName || `${sheet.getSheetName?.() || 'Sheet'}_Duplicates`;
    const qSheet = wb.getSheetByName?.(qSheetName) || wb.insertSheet?.(qSheetName);
    if (qSheet) {
      // Write headers
      qSheet.getRange(0, 0, 1, headers.length)?.setValues?.([headers]);
      // Write quarantined rows
      qSheet.getRange(1, 0, quarantinedRows.length, headers.length)?.setValues?.(quarantinedRows);
    }
    actionResultMsg = `Extracted ${quarantinedRows.length} duplicate rows to worksheet "${qSheetName}".`;
  } else if (action === 'flag_column') {
    // Add Is_Duplicate boolean flag column
    const flagColIdx = lastSheetCol;
    sheet.insertColumns?.(flagColIdx, 1);
    sheet.getRange(0, flagColIdx, 1, 1)?.setValues?.([[flagColumnHeader]]);

    const flags: any[][] = [];
    for (let r = startRow; r <= effectiveEndRow; r++) {
      flags.push([duplicateFlagMap.get(r) === true]);
    }
    const flagColLetter = colIndexToLetter(flagColIdx);
    sheet.getRange(`${flagColLetter}${startRow}:${flagColLetter}${effectiveEndRow}`)?.setValues?.(flags);
    actionResultMsg = `Flagged duplicate rows in new column ${flagColLetter} ("${flagColumnHeader}").`;
  }

  const durationMs = Math.round(performance.now() - t0);

  return {
    success: true,
    action: 'deduplicate_dataset',
    duplicateGroupsFound: duplicateGroups.length,
    duplicateRowsIdentified: rowsToDelete.length,
    coalescedRowsUpdated: rowsToUpdateCoalesced.length,
    actionExecuted: action,
    durationMs,
    message: `${actionResultMsg} (Evaluated ${dataRowsWithIdx.length} rows in ${durationMs}ms)`,
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
      // Group-by forward fill or mean
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
    } else if (method === 'expression' && expression) {
      for (let i = 0; i < resultVals.length; i++) {
        if (resultVals[i] === undefined || resultVals[i] === null || resultVals[i] === '') {
          const rowNum = startRow + i;
          const computed = evaluateExpression(expression, { [col.colLetter]: resultVals[i] }, rowNum);
          if (computed !== null) {
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

  // Read data
  const reshapedMatrix: any[][] = [];

  for (let r = startRow; r <= effectiveEndRow; r++) {
    // Read ID values for this row
    const idVals: any[] = [];
    for (const id of resolvedIds) {
      idVals.push(srcSheet.getRange(r - 1, id.colIndex)?.getValue?.());
    }

    // For each value column, emit a new row
    for (const valCol of resolvedValues) {
      const cellVal = srcSheet.getRange(r - 1, valCol.colIndex)?.getValue?.();
      if (ignoreEmpty && (cellVal === undefined || cellVal === null || cellVal === '')) {
        continue;
      }
      reshapedMatrix.push([...idVals, valCol.headerName, cellVal]);
    }
  }

  // Write headers to target sheet
  destSheet.getRange(0, 0, 1, targetHeaders.length)?.setValues?.([targetHeaders]);

  // Write reshaped rows
  if (reshapedMatrix.length > 0) {
    destSheet.getRange(1, 0, reshapedMatrix.length, targetHeaders.length)?.setValues?.(reshapedMatrix);
  }

  const durationMs = Math.round(performance.now() - t0);

  return {
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
export function parseFlexibleDate(
  val: any,
  preferDayFirst: boolean = true
): { date: Date; year: number; month: number; day: number } | null {
  if (val === undefined || val === null || val === '') return null;

  if (val instanceof Date && !isNaN(val.getTime())) {
    return {
      date: val,
      year: val.getFullYear(),
      month: val.getMonth() + 1,
      day: val.getDate(),
    };
  }

  // 1. Numeric Excel Serial Number (e.g. 44941)
  if (typeof val === 'number' || (/^\d{5}(\.\d+)?$/.test(String(val).trim()))) {
    const num = Number(val);
    if (!isNaN(num) && num > 1000 && num < 100000) {
      // Excel serial date epoch: Dec 30 1899
      const ms = Math.round((num - 25569) * 86400 * 1000);
      const d = new Date(ms);
      if (!isNaN(d.getTime())) {
        return {
          date: d,
          year: d.getUTCFullYear(),
          month: d.getUTCMonth() + 1,
          day: d.getUTCDate(),
        };
      }
    }
  }

  const str = String(val).trim();
  if (!str) return null;

  // 2. ISO or YYYY-MM-DD / YYYY/MM/DD / YYYY.MM.DD
  const ymdMatch = str.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/);
  if (ymdMatch) {
    const y = parseInt(ymdMatch[1], 10);
    const m = parseInt(ymdMatch[2], 10);
    const d = parseInt(ymdMatch[3], 10);
    if (m >= 1 && m <= 12 && d >= 1 && d <= 31) {
      return { date: new Date(y, m - 1, d), year: y, month: m, day: d };
    }
  }

  // 3. Two-segment day/month or month/day with 2-4 digit year: DD-MM-YYYY or MM-DD-YYYY
  const dmyMatch = str.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})/);
  if (dmyMatch) {
    let p1 = parseInt(dmyMatch[1], 10);
    let p2 = parseInt(dmyMatch[2], 10);
    let y = parseInt(dmyMatch[3], 10);
    if (y < 100) y += y > 50 ? 1900 : 2000;

    let d: number, m: number;
    if (p1 > 12 && p2 <= 12) {
      d = p1;
      m = p2;
    } else if (p2 > 12 && p1 <= 12) {
      m = p1;
      d = p2;
    } else {
      // Ambiguous case (e.g. 05/06/2023): use preferDayFirst hint
      if (preferDayFirst) {
        d = p1;
        m = p2;
      } else {
        m = p1;
        d = p2;
      }
    }

    if (m >= 1 && m <= 12 && d >= 1 && d <= 31) {
      return { date: new Date(y, m - 1, d), year: y, month: m, day: d };
    }
  }

  // 4. Textual month format: "15 Jan 2023", "January 15, 2023", "15-Jan-2023"
  const MONTHS: Record<string, number> = {
    jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3, apr: 4, april: 4,
    may: 5, jun: 6, june: 6, jul: 7, july: 7, aug: 8, august: 8, sep: 9, september: 9,
    oct: 10, october: 10, nov: 11, november: 11, dec: 12, december: 12,
  };

  const textMatch = str.match(/([a-zA-Z]+)[,\s-]+(\d{1,2})[,\s-]+(\d{2,4})/) ||
                    str.match(/(\d{1,2})[,\s-]+([a-zA-Z]+)[,\s-]+(\d{2,4})/);
  if (textMatch) {
    const isFirstMonth = isNaN(Number(textMatch[1]));
    const monthStr = (isFirstMonth ? textMatch[1] : textMatch[2]).toLowerCase();
    const dayNum = parseInt(isFirstMonth ? textMatch[2] : textMatch[1], 10);
    let y = parseInt(textMatch[3], 10);
    if (y < 100) y += y > 50 ? 1900 : 2000;

    const m = MONTHS[monthStr];
    if (m && dayNum >= 1 && dayNum <= 31) {
      return { date: new Date(y, m - 1, dayNum), year: y, month: m, day: dayNum };
    }
  }

  // Native parse fallback
  const native = new Date(str);
  if (!isNaN(native.getTime()) && native.getFullYear() > 1900 && native.getFullYear() < 2100) {
    return {
      date: native,
      year: native.getFullYear(),
      month: native.getMonth() + 1,
      day: native.getDate(),
    };
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
 */
export async function executeStandardizeDates(
  args: {
    sheetName?: string;
    column: string;
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
    startRow?: number;
    endRow?: number;
  },
  ctx: ToolExecutionContext
) {
  const t0 = performance.now();
  const {
    sheetName,
    column,
    outputFormat = 'DD-MM-YYYY',
    preferDayFirst = true,
    invalidHandling = 'keep_original',
    targetColumn,
    startRow = 2,
    endRow,
  } = args;

  const wb = ctx.univerAPI?.getActiveWorkbook?.();
  if (!wb) throw new Error('Univer active workbook unavailable');

  const sheet = sheetName ? wb.getSheetByName?.(sheetName) : wb.getActiveSheet?.();
  if (!sheet) throw new Error(`Worksheet ${sheetName || 'active'} not found`);

  const srcCol = resolveColumn(sheet, column, 0);
  const destCol = targetColumn ? resolveColumn(sheet, targetColumn, 0) : srcCol;

  const lastSheetRow = Math.max((sheet.getLastRow?.() ?? 0) + 1, 1);
  const effectiveEndRow = endRow ? Math.min(endRow, lastSheetRow) : lastSheetRow;
  if (effectiveEndRow < startRow) {
    return { success: true, rowsStandardized: 0, message: 'No rows to standardize' };
  }

  const rangeNotation = `${srcCol.colLetter}${startRow}:${srcCol.colLetter}${effectiveEndRow}`;
  const rawValues: any[][] = sheet.getRange(rangeNotation)?.getValues?.() || [];

  const standardizedValues: any[][] = [];
  const samplesBefore: any[] = [];
  const samplesAfter: any[] = [];
  let convertedCount = 0;
  let unparsedCount = 0;

  for (let i = 0; i < rawValues.length; i++) {
    const originalVal = rawValues[i]?.[0];

    if (samplesBefore.length < 5 && originalVal !== undefined && originalVal !== null && originalVal !== '') {
      samplesBefore.push(originalVal);
    }

    if (originalVal === undefined || originalVal === null || String(originalVal).trim() === '') {
      standardizedValues.push(['']);
      continue;
    }

    const parsed = parseFlexibleDate(originalVal, preferDayFirst);

    if (parsed) {
      const formatted = formatFormattedDate(parsed, outputFormat);
      standardizedValues.push([formatted]);
      convertedCount++;

      if (samplesAfter.length < 5) {
        samplesAfter.push(formatted);
      }
    } else {
      unparsedCount++;
      if (invalidHandling === 'set_empty') {
        standardizedValues.push(['']);
      } else if (invalidHandling === 'flag_invalid') {
        standardizedValues.push(['[INVALID_DATE]']);
      } else {
        standardizedValues.push([originalVal]);
      }
    }
  }

  // Write standardized values directly into destination column
  const destRangeNotation = `${destCol.colLetter}${startRow}:${destCol.colLetter}${effectiveEndRow}`;
  sheet.getRange(destRangeNotation)?.setValues?.(standardizedValues);

  const durationMs = Math.round(performance.now() - t0);

  return {
    success: true,
    action: 'standardize_dates',
    sourceColumn: srcCol.colLetter,
    targetColumn: destCol.colLetter,
    outputFormat,
    rowsProcessed: rawValues.length,
    convertedCount,
    unparsedCount,
    samplesBefore,
    samplesAfter,
    durationMs,
    message: `Standardized ${convertedCount} date(s) in Column ${destCol.colLetter} to format "${outputFormat}" in ${durationMs}ms.`,
  };
}
