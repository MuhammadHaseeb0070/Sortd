import type { ToolExecutionContext } from '../../types';
import { guardRangeOutput } from '../../middleware/tokenGuard';
import { verifyRangeMutation } from '../../middleware/formulaVerifier';
import { colIndexToLetter, letterToColIndex, generateColumnHealthCard } from '../../radar';
import {
  resolveColumnSmart,
  resolveWorksheet,
  mapHorizontalAlignment,
  reconcileRangeAndEnsureCapacity,
  ensureSheetCapacity,
  parseA1RangeBounds,
} from '../../utils/univerBridge';
import { jaroWinklerSimilarity } from '../../utils/dataHygiene';
import { parseFlexibleDate, formatFormattedDate } from '../sanitizer/executors';

// Jaro-Winkler similarity calculation for fuzzy search (0.0 to 1.0)
function calculateStringSimilarity(s1: string, s2: string): number {
  return jaroWinklerSimilarity(s1.trim().toLowerCase(), s2.trim().toLowerCase());
}

/**
 * 1. INSPECT RANGE (Flagship Targeted, Filtered & Paginated Reading)
 */
export async function executeInspectRange(
  args: {
    sheetName?: string;
    rangeA1?: string;
    columns?: string[];
    filter?: {
      column: string;
      operator:
        | '>'
        | '<'
        | '>='
        | '<='
        | '=='
        | '!='
        | 'contains'
        | 'startsWith'
        | 'endsWith'
        | 'regex'
        | 'isNull'
        | 'notNull';
      value?: any;
    };
    sortBy?: { column: string; direction?: 'asc' | 'desc' };
    page?: number;
    pageSize?: number;
    includeFormulas?: boolean;
  },
  ctx: ToolExecutionContext
) {
  const {
    sheetName,
    rangeA1,
    columns,
    filter,
    sortBy,
    page,
    pageSize = 25,
    includeFormulas = true,
  } = args;

  const wb = ctx.univerAPI?.getActiveWorkbook?.();
  if (!wb) throw new Error('Univer active workbook unavailable');

  let parsedRange: any = null;
  let targetSheetName = sheetName;
  if (rangeA1) {
    parsedRange = parseA1RangeBounds(rangeA1);
    if (!targetSheetName && parsedRange.sheetPrefix) {
      targetSheetName = parsedRange.sheetPrefix;
    }
  }

  const sheet = resolveWorksheet(wb, targetSheetName);
  if (!sheet) throw new Error(`Worksheet ${targetSheetName || 'active'} not found`);

  const maxRows = Math.max(
    typeof sheet.getRowCount === 'function' ? sheet.getRowCount() : 0,
    sheet.getMaxRows?.() ?? 0,
    sheet.getLastRow?.() !== undefined ? sheet.getLastRow() + 1 : 0,
    1
  );
  const maxCols = Math.max(
    typeof sheet.getColumnCount === 'function' ? sheet.getColumnCount() : 0,
    sheet.getMaxColumns?.() ?? 0,
    sheet.getLastColumn?.() !== undefined ? sheet.getLastColumn() + 1 : 0,
    1
  );

  let localRangeStr = '';
  let effectiveRangeWithSheet = '';

  if (!rangeA1) {
    const lastRow = Math.max((sheet.getLastRow?.() ?? 0) + 1, 1);
    const lastCol = Math.max((sheet.getLastColumn?.() ?? 0) + 1, 1);
    localRangeStr = `A1:${colIndexToLetter(lastCol - 1)}${lastRow}`;
    effectiveRangeWithSheet = `${sheet.getSheetName?.() || 'Sheet'}!${localRangeStr}`;
  } else {
    if (!parsedRange) parsedRange = parseA1RangeBounds(rangeA1);
    const clampedStartRow = Math.min(parsedRange.startRow, maxRows - 1);
    const clampedStartCol = Math.min(parsedRange.startCol, maxCols - 1);
    const clampedEndRow = Math.min(parsedRange.endRow, maxRows - 1);
    const clampedEndCol = Math.min(parsedRange.endCol, maxCols - 1);

    localRangeStr = `${colIndexToLetter(clampedStartCol)}${clampedStartRow + 1}:${colIndexToLetter(clampedEndCol)}${clampedEndRow + 1}`;
    effectiveRangeWithSheet = `${sheet.getSheetName?.() || 'Sheet'}!${localRangeStr}`;
  }

  const fRange = sheet.getRange(localRangeStr);
  if (!fRange) throw new Error(`Failed to resolve range ${localRangeStr}`);

  const startRow = typeof fRange.getRow === 'function' ? fRange.getRow() : 0;
  const startCol = typeof fRange.getColumn === 'function' ? fRange.getColumn() : 0;

  const rawValues: any[][] = fRange.getValues?.() || [];
  let rawFormulas: any[][] = [];
  if (includeFormulas) {
    try {
      rawFormulas = fRange.getFormulas?.() || [];
    } catch {
      rawFormulas = [];
    }
  }

  if (rawValues.length === 0) {
    return {
      range: effectiveRangeWithSheet,
      totalRows: 0,
      filteredRows: 0,
      rows: [],
      formulas: [],
    };
  }

  // Map column letters OR header names to their relative indices within rawValues
  const colLetterToIndex = (colRef: string) => {
    try {
      const resolved = resolveColumnSmart(sheet, colRef);
      return resolved.colIndex - startCol;
    } catch {
      const absCol = letterToColIndex(colRef.trim().toUpperCase());
      return absCol - startCol;
    }
  };

  // Convert raw 2D grid into structured row items for processing
  interface RowItem {
    originalRowIndex: number;
    excelRowNum: number;
    values: any[];
    formulas: any[];
  }

  let rowItems: RowItem[] = rawValues.map((rowVals, rIdx) => ({
    originalRowIndex: rIdx,
    excelRowNum: startRow + rIdx + 1,
    values: rowVals,
    formulas: rawFormulas[rIdx] || [],
  }));

  // Preserve header row if row 0 appears to be headers
  const hasHeaderRow = rowItems.length > 1;
  const headerItem = hasHeaderRow ? rowItems[0] : null;
  const dataItems = hasHeaderRow ? rowItems.slice(1) : rowItems;

  let filteredData = dataItems;

  // A. Apply Row Filter
  if (filter && filter.column) {
    const targetRelCol = colLetterToIndex(filter.column);
    if (targetRelCol >= 0) {
      filteredData = filteredData.filter((item) => {
        const val = item.values[targetRelCol];
        const valStr = val !== undefined && val !== null ? String(val) : '';
        const numVal = typeof val === 'number' ? val : Number(val);
        const compVal = filter.value;
        const compNum = Number(compVal);

        switch (filter.operator) {
          case '==':
            return val == compVal || valStr.toLowerCase() === String(compVal).toLowerCase();
          case '!=':
            return val != compVal && valStr.toLowerCase() !== String(compVal).toLowerCase();
          case '>':
            return !isNaN(numVal) && !isNaN(compNum) && numVal > compNum;
          case '<':
            return !isNaN(numVal) && !isNaN(compNum) && numVal < compNum;
          case '>=':
            return !isNaN(numVal) && !isNaN(compNum) && numVal >= compNum;
          case '<=':
            return !isNaN(numVal) && !isNaN(compNum) && numVal <= compNum;
          case 'contains':
            return valStr.toLowerCase().includes(String(compVal).toLowerCase());
          case 'startsWith':
            return valStr.toLowerCase().startsWith(String(compVal).toLowerCase());
          case 'endsWith':
            return valStr.toLowerCase().endsWith(String(compVal).toLowerCase());
          case 'regex':
            try {
              const reg = new RegExp(String(compVal), 'i');
              return reg.test(valStr);
            } catch {
              return false;
            }
          case 'isNull':
            return val === undefined || val === null || val === '';
          case 'notNull':
            return val !== undefined && val !== null && val !== '';
          default:
            return true;
        }
      });
    }
  }

  // B. Apply Sorting
  if (sortBy && sortBy.column) {
    const sortColIdx = colLetterToIndex(sortBy.column);
    const dir = sortBy.direction === 'desc' ? -1 : 1;
    if (sortColIdx >= 0) {
      filteredData.sort((a, b) => {
        const valA = a.values[sortColIdx];
        const valB = b.values[sortColIdx];
        if (valA === valB) return 0;
        if (valA === null || valA === undefined || valA === '') return 1;
        if (valB === null || valB === undefined || valB === '') return -1;
        const numA = Number(valA);
        const numB = Number(valB);
        if (!isNaN(numA) && !isNaN(numB)) {
          return (numA - numB) * dir;
        }
        return String(valA).localeCompare(String(valB)) * dir;
      });
    }
  }

  // C. Apply Column Projection (if specific columns requested)
  let activeColIndices: number[] = [];
  if (columns && Array.isArray(columns) && columns.length > 0) {
    activeColIndices = columns
      .map(colLetterToIndex)
      .filter((idx) => idx >= 0 && idx < (rawValues[0]?.length || 0));
  } else {
    activeColIndices = Array.from(
      { length: rawValues[0]?.length || 0 },
      (_, i) => i
    );
  }

  const projectRow = (item: RowItem) => {
    return activeColIndices.map((cIdx) => item.values[cIdx]);
  };
  const projectFormulaRow = (item: RowItem) => {
    return activeColIndices.map((cIdx) => item.formulas[cIdx] || '');
  };

  const finalRows: any[][] = [];
  const finalFormulas: any[][] = [];

  if (headerItem) {
    finalRows.push(projectRow(headerItem));
    finalFormulas.push(projectFormulaRow(headerItem));
  }

  // D. Pagination Mode (if page is explicitly requested)
  if (page && page > 0) {
    const startIdx = (page - 1) * pageSize;
    const pagedSlice = filteredData.slice(startIdx, startIdx + pageSize);

    for (const item of pagedSlice) {
      finalRows.push(projectRow(item));
      finalFormulas.push(projectFormulaRow(item));
    }

    return {
      range: effectiveRangeWithSheet,
      page,
      pageSize,
      totalMatchingRows: filteredData.length,
      totalPages: Math.ceil(filteredData.length / pageSize),
      columnsProjected: columns || 'all',
      rows: finalRows,
      formulas: finalFormulas,
    };
  }

  // Non-paginated: pass through Token Safety Guard
  for (const item of filteredData) {
    finalRows.push(projectRow(item));
    finalFormulas.push(projectFormulaRow(item));
  }

  const guarded = guardRangeOutput(finalRows, finalFormulas, effectiveRangeWithSheet);
  return {
    ...guarded,
    filterApplied: filter || null,
    sortApplied: sortBy || null,
    totalRecordsInSheet: rawValues.length,
    matchingRecords: filteredData.length + (headerItem ? 1 : 0),
  };
}

/**
 * 2. TRANSFORM RANGE (Flagship In-Engine Bulk Vector Transformations)
 * Executes bulk transforms across thousands of cells inside browser memory in <5ms.
 * Solves cleaning, currency stripping, type conversion, regex replacement, and casing.
 */
export async function executeTransformRange(
  args: {
    sheetName?: string;
    rangeA1: string;
    operations: Array<{
      type:
        | 'trim_whitespace'
        | 'remove_currency'
        | 'parse_number'
        | 'replace_regex'
        | 'case'
        | 'fill_blanks'
        | 'math_scalar'
        | 'round'
        | 'format_date';
      pattern?: string;
      replacement?: string;
      flags?: string;
      caseType?: 'upper' | 'lower' | 'title' | 'capitalize';
      fallbackValue?: any;
      mathOperator?: 'add' | 'subtract' | 'multiply' | 'divide';
      scalarValue?: number;
      decimalPlaces?: number;
      dateFormat?: string;
    }>;
  },
  ctx: ToolExecutionContext
) {
  const { sheetName, rangeA1, operations } = args;
  if (!operations || operations.length === 0) {
    throw new Error('transform_range requires at least one operation in "operations"');
  }

  const wb = ctx.univerAPI?.getActiveWorkbook?.();
  if (!wb) throw new Error('Univer active workbook unavailable');

  const sheet = sheetName ? wb.getSheetByName?.(sheetName) : wb.getActiveSheet?.();
  if (!sheet) throw new Error(`Worksheet ${sheetName || 'active'} not found`);

  const fRange = sheet.getRange(rangeA1);
  if (!fRange) throw new Error(`Could not resolve range ${rangeA1}`);

  const values: any[][] = fRange.getValues?.() || [];
  if (values.length === 0) {
    return { success: true, range: rangeA1, modifiedCount: 0, message: 'Range is empty' };
  }

  const samplesBefore: any[] = [];
  const samplesAfter: any[] = [];

  let modifiedCount = 0;
  let totalCellsEvaluated = 0;

  // Prepare compiled regexes if needed
  const compiledOps: Array<any> = operations.map((op) => {
    if (op.type === 'replace_regex' && op.pattern) {
      return {
        ...op,
        regexInstance: new RegExp(op.pattern, op.flags || 'g'),
      };
    }
    return op;
  });

  const transformedValues: any[][] = [];

  for (let r = 0; r < values.length; r++) {
    const row = values[r] || [];
    const transformedRow: any[] = [];

    for (let c = 0; c < row.length; c++) {
      totalCellsEvaluated++;
      const originalVal = row[c];
      let currentVal = originalVal;

      if (samplesBefore.length < 5 && originalVal !== null && originalVal !== undefined) {
        samplesBefore.push(originalVal);
      }

      // Apply each operation in sequence to the cell
      for (const op of compiledOps) {
        if (currentVal === undefined || currentVal === null || currentVal === '') {
          if (op.type === 'fill_blanks') {
            currentVal = op.fallbackValue !== undefined ? op.fallbackValue : 0;
          }
          continue;
        }

        switch (op.type) {
          case 'trim_whitespace':
            if (typeof currentVal === 'string') {
              currentVal = currentVal.trim();
            }
            break;

          case 'remove_currency':
            if (typeof currentVal === 'string') {
              // Strip $, €, £, ¥, ₹, commas and trailing spaces
              currentVal = currentVal.replace(/[$€£¥₹,\s]/g, '').trim();
            }
            break;

          case 'parse_number': {
            if (typeof currentVal === 'string') {
              const cleaned = currentVal.replace(/[$€£¥₹,\s]/g, '').trim();
              if (cleaned !== '' && !isNaN(Number(cleaned))) {
                currentVal = Number(cleaned);
              }
            }
            break;
          }

          case 'replace_regex':
            if (op.regexInstance) {
              currentVal = String(currentVal).replace(
                op.regexInstance,
                op.replacement || ''
              );
            }
            break;

          case 'case': {
            const str = String(currentVal);
            if (op.caseType === 'upper') {
              currentVal = str.toUpperCase();
            } else if (op.caseType === 'lower') {
              currentVal = str.toLowerCase();
            } else if (op.caseType === 'title') {
              currentVal = str.replace(
                /\w\S*/g,
                (txt) => txt.charAt(0).toUpperCase() + txt.substring(1).toLowerCase()
              );
            } else if (op.caseType === 'capitalize') {
              currentVal = str.charAt(0).toUpperCase() + str.slice(1);
            }
            break;
          }

          case 'fill_blanks':
            if (currentVal === undefined || currentVal === null || currentVal === '') {
              currentVal = op.fallbackValue !== undefined ? op.fallbackValue : 0;
            }
            break;

          case 'math_scalar': {
            const num = typeof currentVal === 'number' ? currentVal : Number(currentVal);
            if (!isNaN(num) && typeof currentVal !== 'boolean') {
              const scalar = op.scalarValue ?? 1;
              if (op.mathOperator === 'add') currentVal = num + scalar;
              else if (op.mathOperator === 'subtract') currentVal = num - scalar;
              else if (op.mathOperator === 'multiply') currentVal = num * scalar;
              else if (op.mathOperator === 'divide') {
                currentVal = scalar !== 0 ? num / scalar : num;
              }
            }
            break;
          }

          case 'round': {
            const num = typeof currentVal === 'number' ? currentVal : Number(currentVal);
            if (!isNaN(num) && typeof currentVal !== 'boolean') {
              const places = op.decimalPlaces ?? 2;
              const factor = Math.pow(10, places);
              currentVal = Math.round(num * factor) / factor;
            }
            break;
          }

          case 'format_date': {
            const parsed = parseFlexibleDate(currentVal, true);
            if (parsed) {
              currentVal = formatFormattedDate(parsed, op.dateFormat || 'DD-MM-YYYY');
            }
            break;
          }
        }
      }

      if (currentVal !== originalVal) {
        modifiedCount++;
      }

      if (samplesAfter.length < 5 && currentVal !== null && currentVal !== undefined) {
        samplesAfter.push(currentVal);
      }

      transformedRow.push(currentVal);
    }

    transformedValues.push(transformedRow);
  }

  // Mutate all cells in Univer in ONE batch
  fRange.setValues(transformedValues);

  return {
    success: true,
    range: rangeA1,
    totalCellsEvaluated,
    modifiedCount,
    operationsApplied: operations.map((o) => o.type),
    samplesBefore,
    samplesAfter,
    message: `Successfully transformed ${modifiedCount} cell(s) across ${rangeA1} in-engine.`,
  };
}

/**
 * 3. SEARCH WORKBOOK (Flagship Fuzzy Search, Error Tracing & Pattern Discovery)
 */
export async function executeSearchWorkbook(
  args: {
    sheetName?: string;
    query?: string;
    findType?: 'all' | 'errors' | 'formulas' | 'numbers' | 'empty' | 'text';
    columns?: string[];
    matchCase?: boolean;
    useRegex?: boolean;
    fuzzy?: boolean;
    fuzzyThreshold?: number;
    maxResults?: number;
  },
  ctx: ToolExecutionContext
) {
  const {
    sheetName,
    query = '',
    findType = 'all',
    columns,
    matchCase = false,
    useRegex = false,
    fuzzy = false,
    fuzzyThreshold = 0.7,
    maxResults = 25,
  } = args;

  const wb = ctx.univerAPI?.getActiveWorkbook?.();
  if (!wb) throw new Error('Active workbook unavailable');

  const sheet = sheetName ? wb.getSheetByName?.(sheetName) : wb.getActiveSheet?.();
  if (!sheet) throw new Error(`Worksheet ${sheetName || 'active'} unavailable`);

  const lastRow = Math.min((sheet.getLastRow?.() ?? 0) + 1, 10000);
  const lastCol = Math.min((sheet.getLastColumn?.() ?? 0) + 1, 52);
  const fullRangeStr = `A1:${colIndexToLetter(lastCol - 1)}${lastRow}`;

  const fRange = sheet.getRange(fullRangeStr);
  const values: any[][] = fRange?.getValues?.() || [];
  let formulas: any[][] = [];
  try {
    formulas = fRange?.getFormulas?.() || [];
  } catch {
    formulas = [];
  }

  let regex: RegExp | null = null;
  if (useRegex && query) {
    try {
      regex = new RegExp(query, matchCase ? '' : 'i');
    } catch (e: any) {
      throw new Error(`Invalid regex pattern: ${e.message}`);
    }
  }

  const allowedCols =
    columns && columns.length > 0
      ? new Set(columns.map((c) => c.trim().toUpperCase()))
      : null;

  const queryNorm = matchCase ? query : query.toLowerCase();
  const results: Array<{
    coordinate: string;
    value: any;
    formula?: string;
    similarity?: number;
    rowContextPreview: any[];
  }> = [];

  const EXCEL_ERRORS = new Set([
    '#REF!',
    '#NAME?',
    '#VALUE!',
    '#DIV/0!',
    '#N/A',
    '#ERROR!',
    '#NUM!',
    '#NULL!',
  ]);

  for (let r = 0; r < values.length; r++) {
    const row = values[r] || [];
    for (let c = 0; c < row.length; c++) {
      const colLetter = colIndexToLetter(c);
      if (allowedCols && !allowedCols.has(colLetter)) {
        continue;
      }

      const cellVal = row[c];
      const cellValStr = cellVal !== undefined && cellVal !== null ? String(cellVal) : '';
      const cellFormula = formulas[r]?.[c] || '';
      let isMatch = false;
      let score: number | undefined = undefined;

      // Filter by Type
      if (findType === 'errors') {
        const upperVal = cellValStr.trim().toUpperCase();
        isMatch =
          EXCEL_ERRORS.has(upperVal) ||
          (cellValStr.startsWith('#') && cellValStr.endsWith('!'));
      } else if (findType === 'formulas') {
        isMatch = Boolean(cellFormula) || cellValStr.startsWith('=');
      } else if (findType === 'numbers') {
        isMatch = typeof cellVal === 'number' || (!isNaN(Number(cellVal)) && cellValStr !== '');
      } else if (findType === 'empty') {
        isMatch = cellVal === undefined || cellVal === null || cellVal === '';
      } else {
        // Text / Pattern / Fuzzy search
        if (!query) {
          isMatch = true;
        } else if (regex) {
          isMatch = regex.test(cellValStr) || regex.test(cellFormula);
        } else if (fuzzy) {
          const sim = calculateStringSimilarity(cellValStr, query);
          if (sim >= fuzzyThreshold) {
            isMatch = true;
            score = Number(sim.toFixed(2));
          }
        } else {
          const testVal = matchCase ? cellValStr : cellValStr.toLowerCase();
          const testFormula = matchCase ? cellFormula : cellFormula.toLowerCase();
          isMatch = testVal.includes(queryNorm) || testFormula.includes(queryNorm);
        }
      }

      if (isMatch) {
        results.push({
          coordinate: `${colLetter}${r + 1}`,
          value: cellVal,
          formula: cellFormula || undefined,
          similarity: score,
          rowContextPreview: row.slice(0, 6),
        });

        if (results.length >= maxResults) {
          return {
            query,
            findType,
            totalMatchesFound: results.length,
            limitReached: true,
            results,
          };
        }
      }
    }
  }

  return {
    query,
    findType,
    totalMatchesFound: results.length,
    limitReached: false,
    results,
  };
}

/**
 * 4. PROFILE COLUMNS (Deep Data Quality, Dirtiness Detection & Recommendations)
 */
export async function executeProfileColumns(
  args: { columns: string[]; startRow?: number; endRow?: number; sheetName?: string },
  ctx: ToolExecutionContext
) {
  const { columns, startRow = 1, endRow, sheetName } = args;
  const wb = ctx.univerAPI?.getActiveWorkbook?.();
  if (!wb) throw new Error('Active workbook unavailable');

  const sheet = resolveWorksheet(wb, sheetName);
  if (!sheet) throw new Error(`Worksheet "${sheetName || 'active'}" unavailable`);

  const maxSheetRow = Math.max((sheet.getLastRow?.() ?? 0) + 1, 1);
  const effectiveEndRow = endRow ? Math.min(endRow, maxSheetRow) : maxSheetRow;

  const columnProfiles: Record<string, any> = {};

  for (const col of columns) {
    const resolved = resolveColumnSmart(sheet, col);
    const colTrimmed = resolved.colLetter;
    const rangeNotation = `${colTrimmed}${startRow}:${colTrimmed}${effectiveEndRow}`;
    let values: any[][] = [];
    try {
      values = sheet.getRange(rangeNotation)?.getValues?.() || [];
    } catch {
      values = [];
    }

    const flatVals = values.map((row) => row[0]);
    const headerName = resolved.headerName || colTrimmed;

    const healthCard = generateColumnHealthCard(
      startRow === 1 ? flatVals.slice(1) : flatVals,
      colTrimmed,
      headerName
    );

    columnProfiles[`${colTrimmed} (${headerName})`] = {
      ...healthCard,
      analyzedRange: rangeNotation,
    };
  }

  return columnProfiles;
}

/**
 * 5. MUTATE CELLS (Vectorized Batch Writes, Formula Templates & Conditional Updates)
 */
export async function executeMutateCells(
  args: {
    rangeA1: string;
    sheetName?: string;
    values2D?: any[][];
    formulaTemplate?: string;
    conditionalUpdate?: {
      targetCol: string;
      conditionCol: string;
      operator: '>' | '<' | '>= ' | '<=' | '==' | '!=';
      conditionVal: any;
      newVal: any;
    };
    clearFirst?: boolean;
  },
  ctx: ToolExecutionContext
) {
  const {
    rangeA1,
    sheetName,
    values2D,
    formulaTemplate,
    conditionalUpdate,
    clearFirst = false,
  } = args;
  const wb = ctx.univerAPI?.getActiveWorkbook?.();
  if (!wb) throw new Error('Active workbook unavailable');

  const sheet = resolveWorksheet(wb, sheetName);
  if (!sheet) throw new Error(`Worksheet "${sheetName || 'active'}" unavailable`);

  const effectiveRangeA1 = reconcileRangeAndEnsureCapacity(sheet, rangeA1, values2D);
  const fRange = sheet.getRange(effectiveRangeA1);
  if (!fRange) throw new Error(`Could not locate range ${effectiveRangeA1}`);

  if (clearFirst) {
    try {
      fRange.clear?.();
    } catch {
      // Clear fallback
    }
  }

  // Mode A: Formula Template Auto-Fill Mode (e.g. formulaTemplate: "=B{row}-C{row}" across D2:D500)
  if (formulaTemplate) {
    const startRow = (typeof fRange.getRow === 'function' ? fRange.getRow() : 0) + 1; // 1-indexed
    const endRow =
      (typeof fRange.getLastRow === 'function' ? fRange.getLastRow() : startRow - 1) + 1;
    const numRows = Math.max(endRow - startRow + 1, 1);
    const startCol = typeof fRange.getColumn === 'function' ? fRange.getColumn() : 0;
    const endCol =
      typeof fRange.getLastColumn === 'function' ? fRange.getLastColumn() : startCol;
    const numCols = Math.max(endCol - startCol + 1, 1);

    ensureSheetCapacity(sheet, endRow, endCol + 1);

    const generatedMatrix: string[][] = [];
    for (let r = 0; r < numRows; r++) {
      const currentRowNum = startRow + r;
      const rowArr: string[] = [];
      for (let c = 0; c < numCols; c++) {
        const substituted = formulaTemplate.replace(/\{row\}/gi, String(currentRowNum));
        rowArr.push(substituted.startsWith('=') ? substituted : `=${substituted}`);
      }
      generatedMatrix.push(rowArr);
    }

    fRange.setValues(generatedMatrix);
    return await verifyRangeMutation(sheet, effectiveRangeA1);
  }

  // Mode B: Conditional Update Mode (e.g. Set targetCol = newVal where conditionCol == conditionVal)
  if (conditionalUpdate) {
    const { targetCol, conditionCol, operator, conditionVal, newVal } = conditionalUpdate;
    const existingValues: any[][] = fRange.getValues?.() || [];
    const startCol = typeof fRange.getColumn === 'function' ? fRange.getColumn() : 0;

    const targetRelCol = resolveColumnSmart(sheet, targetCol).colIndex - startCol;
    const condRelCol = resolveColumnSmart(sheet, conditionCol).colIndex - startCol;

    if (targetRelCol < 0 || condRelCol < 0) {
      throw new Error('conditionalUpdate columns must fall within target range');
    }

    let updatedRows = 0;
    const updatedValues = existingValues.map((row) => {
      const cVal = row[condRelCol];
      let matches = false;
      const op = String(operator).trim();
      if (op === '==') matches = cVal == conditionVal;
      else if (op === '!=') matches = cVal != conditionVal;
      else if (op === '>') matches = Number(cVal) > Number(conditionVal);
      else if (op === '<') matches = Number(cVal) < Number(conditionVal);
      else if (op === '>=') matches = Number(cVal) >= Number(conditionVal);
      else if (op === '<=') matches = Number(cVal) <= Number(conditionVal);

      if (matches) {
        row[targetRelCol] = newVal;
        updatedRows++;
      }
      return row;
    });

    fRange.setValues(updatedValues);
    const verification = await verifyRangeMutation(sheet, effectiveRangeA1);
    return {
      ...verification,
      success: verification.status !== 'ERROR',
      range: effectiveRangeA1,
      conditionalUpdatedRows: updatedRows,
      message: `Updated ${updatedRows} row(s) where ${conditionCol} ${operator} ${conditionVal}`,
    };
  }

  // Mode C: 2D Matrix Mode
  if (values2D && Array.isArray(values2D) && values2D.length > 0) {
    fRange.setValues(values2D);
    return await verifyRangeMutation(sheet, effectiveRangeA1);
  }

  throw new Error(
    'mutate_cells requires either "values2D", "formulaTemplate", or "conditionalUpdate"'
  );
}

/**
 * 6. MODIFY STRUCTURE (Auto-Fit Columns, Freeze Panes, Sort Range, Delete Empty Rows, Dimensions)
 */
export async function executeModifyStructure(
  args: {
    action:
      | 'insert_rows'
      | 'delete_rows'
      | 'insert_columns'
      | 'delete_columns'
      | 'merge_range'
      | 'unmerge_range'
      | 'create_sheet'
      | 'rename_sheet'
      | 'delete_sheet'
      | 'freeze_panes'
      | 'unfreeze_panes'
      | 'sort_range'
      | 'set_column_width'
      | 'auto_fit_columns'
      | 'delete_empty_rows';
    index?: number;
    count?: number;
    rangeA1?: string;
    sheetName?: string;
    widthPx?: number;
    columns?: string[];
    sortColumn?: string;
    sortAscending?: boolean;
  },
  ctx: ToolExecutionContext
) {
  const {
    action,
    index = 0,
    count = 1,
    rangeA1,
    sheetName,
    widthPx,
    columns,
    sortColumn,
    sortAscending = true,
  } = args;
  const wb = ctx.univerAPI?.getActiveWorkbook?.();
  if (!wb) throw new Error('Active workbook unavailable');

  const sheet =
    action === 'create_sheet' || action === 'rename_sheet'
      ? wb.getActiveSheet?.()
      : resolveWorksheet(wb, sheetName);
  if (!sheet) throw new Error('Target worksheet unavailable');

  switch (action) {
    case 'auto_fit_columns': {
      const lastRow = Math.min((sheet.getLastRow?.() ?? 0) + 1, 500);
      const colsToFit =
        columns && columns.length > 0
          ? columns.map((c) => resolveColumnSmart(sheet, c).colIndex)
          : Array.from(
              { length: Math.min((sheet.getLastColumn?.() ?? 0) + 1, 26) },
              (_, i) => i
            );

      const fitted: Record<string, number> = {};
      for (const colIdx of colsToFit) {
        const colLetter = colIndexToLetter(colIdx);
        let maxLen = 0;
        try {
          const colVals =
            sheet.getRange(`${colLetter}1:${colLetter}${lastRow}`)?.getValues?.() || [];
          for (const r of colVals) {
            const str = r[0] !== undefined && r[0] !== null ? String(r[0]) : '';
            if (str.length > maxLen) maxLen = str.length;
          }
        } catch {
          maxLen = 10;
        }

        const calculatedWidth = Math.min(Math.max(Math.round(maxLen * 8.5 + 24), 75), 350);
        sheet.setColumnWidth?.(colIdx, calculatedWidth);
        fitted[colLetter] = calculatedWidth;
      }

      return {
        success: true,
        action: 'auto_fit_columns',
        columnWidthsSet: fitted,
        message: `Auto-fitted ${Object.keys(fitted).length} column(s) to match cell text dimensions.`,
      };
    }

    case 'delete_empty_rows': {
      const lastRow = sheet.getLastRow?.() ?? 0;
      const lastCol = sheet.getLastColumn?.() ?? 0;
      if (lastRow <= 0) return { success: true, deletedEmptyRows: 0 };

      const allVals =
        sheet
          .getRange(`A1:${colIndexToLetter(lastCol)}${lastRow + 1}`)
          ?.getValues?.() || [];

      let deletedCount = 0;
      for (let r = allVals.length - 1; r >= 0; r--) {
        const row = allVals[r] || [];
        const isBlank = row.every(
          (v: any) => v === undefined || v === null || String(v).trim() === ''
        );
        if (isBlank) {
          sheet.deleteRows?.(r, 1);
          deletedCount++;
        }
      }

      return {
        success: true,
        deletedEmptyRows: deletedCount,
        message: `Scanned and removed ${deletedCount} empty row(s).`,
      };
    }

    case 'freeze_panes': {
      const rowsToFreeze = index > 0 ? index : count > 0 ? count : 1;
      sheet.setFrozenRows?.(rowsToFreeze);
      return {
        success: true,
        frozenRows: rowsToFreeze,
        message: `Froze top ${rowsToFreeze} row(s) on "${sheet.getName?.() || sheet.getSheetName?.() || 'Sheet'}".`,
      };
    }

    case 'unfreeze_panes': {
      sheet.cancelFreeze?.();
      sheet.setFrozenRows?.(0);
      sheet.setFrozenColumns?.(0);
      return {
        success: true,
        message: `Unfroze all rows and columns.`,
      };
    }

    case 'sort_range': {
      const lastRow = Math.max((sheet.getLastRow?.() ?? 0) + 1, 1);
      const lastCol = Math.max((sheet.getLastColumn?.() ?? 0) + 1, 1);
      const targetRangeStr = rangeA1 || `A1:${colIndexToLetter(lastCol - 1)}${lastRow}`;
      const fRange = sheet.getRange(targetRangeStr);
      if (!fRange) throw new Error(`Could not resolve range ${targetRangeStr} for sorting`);

      const allRows: any[][] = fRange.getValues?.() || [];
      if (allRows.length <= 2) {
        return { success: true, message: 'Range has <= 1 data row; no sorting needed.' };
      }

      const resolvedSortCol = sortColumn ? resolveColumnSmart(sheet, sortColumn).colIndex : 0;
      const startColOffset = typeof fRange.getColumn === 'function' ? fRange.getColumn() : 0;
      const relSortIdx = Math.max(0, resolvedSortCol - startColOffset);
      const dir = sortAscending ? 1 : -1;

      const header = allRows[0];
      const body = allRows.slice(1);
      body.sort((a, b) => {
        const va = a[relSortIdx];
        const vb = b[relSortIdx];
        if (va === vb) return 0;
        if (va === null || va === undefined || va === '') return 1;
        if (vb === null || vb === undefined || vb === '') return -1;
        const na = Number(String(va).replace(/[$,%\s]/g, ''));
        const nb = Number(String(vb).replace(/[$,%\s]/g, ''));
        if (!isNaN(na) && !isNaN(nb)) return (na - nb) * dir;
        return String(va).localeCompare(String(vb)) * dir;
      });

      fRange.setValues([header, ...body]);
      return {
        success: true,
        range: targetRangeStr,
        sortedBy: colIndexToLetter(resolvedSortCol),
        direction: sortAscending ? 'asc' : 'desc',
        rowsSorted: body.length,
        message: `Sorted ${body.length} data rows in ${targetRangeStr} by column ${colIndexToLetter(resolvedSortCol)} (${sortAscending ? 'ASC' : 'DESC'}).`,
      };
    }

    case 'insert_rows':
      sheet.insertRows?.(index, count);
      return { success: true, message: `Inserted ${count} row(s) at index ${index}` };

    case 'delete_rows':
      sheet.deleteRows?.(index, count);
      return { success: true, message: `Deleted ${count} row(s) starting from index ${index}` };

    case 'insert_columns':
      sheet.insertColumns?.(index, count);
      return { success: true, message: `Inserted ${count} column(s) at index ${index}` };

    case 'delete_columns':
      sheet.deleteColumns?.(index, count);
      return { success: true, message: `Deleted ${count} column(s) starting from index ${index}` };

    case 'merge_range': {
      if (!rangeA1) throw new Error('merge_range requires rangeA1');
      sheet.getRange(rangeA1)?.merge?.();
      return { success: true, message: `Merged cells in ${rangeA1}` };
    }

    case 'unmerge_range': {
      if (!rangeA1) throw new Error('unmerge_range requires rangeA1');
      sheet.getRange(rangeA1)?.breakApart?.();
      return { success: true, message: `Unmerged cells in ${rangeA1}` };
    }

    case 'create_sheet': {
      const name = sheetName || `Sheet_${Date.now().toString(36).slice(-4)}`;
      const existing = resolveWorksheet(wb, name);
      if (existing) {
        wb.setActiveSheet?.(existing);
        ctx.onWorkbookMutated?.();
        return {
          success: true,
          sheetName: name,
          message: `Worksheet "${name}" already exists and is now active. Proceed to populate it immediately!`,
        };
      }
      wb.insertSheet?.(name);
      ctx.onWorkbookMutated?.();
      return {
        success: true,
        sheetName: name,
        message: `Created new worksheet "${name}". IMPORTANT: The sheet is currently blank — proceed IMMEDIATELY to write headers, data, or formulas into "${name}" in your next tool call!`,
      };
    }

    case 'rename_sheet': {
      if (!sheetName) throw new Error('rename_sheet requires sheetName');
      sheet.setName?.(sheetName);
      ctx.onWorkbookMutated?.();
      return { success: true, message: `Renamed sheet to "${sheetName}"` };
    }

    case 'delete_sheet': {
      if (!sheetName) throw new Error('delete_sheet requires sheetName');
      const toDelete = resolveWorksheet(wb, sheetName);
      if (!toDelete) throw new Error(`Sheet "${sheetName}" not found`);
      wb.deleteSheet?.(toDelete);
      ctx.onWorkbookMutated?.();
      return { success: true, message: `Deleted worksheet "${sheetName}"` };
    }

    case 'set_column_width': {
      if (widthPx === undefined) throw new Error('set_column_width requires widthPx');
      sheet.setColumnWidth?.(index, widthPx);
      return {
        success: true,
        message: `Set column ${colIndexToLetter(index)} width to ${widthPx}px`,
      };
    }

    default:
      throw new Error(`Unsupported structural action: ${action}`);
  }
}

/**
 * 7. STYLE RANGE (Batch Visual Design)
 */
export async function executeStyleRange(
  args: {
    rangeA1: string;
    sheetName?: string;
    backgroundColor?: string;
    fontColor?: string;
    bold?: boolean;
    italic?: boolean;
    horizontalAlignment?: 'left' | 'center' | 'right';
    fontSize?: number;
  },
  ctx: ToolExecutionContext
) {
  const {
    rangeA1,
    sheetName,
    backgroundColor,
    fontColor,
    bold,
    italic,
    horizontalAlignment,
    fontSize,
  } = args;

  const wb = ctx.univerAPI?.getActiveWorkbook?.();
  if (!wb) throw new Error('Active workbook unavailable');

  const sheet = resolveWorksheet(wb, sheetName);
  if (!sheet) throw new Error(`Worksheet "${sheetName || 'active'}" unavailable`);

  const fRange = sheet.getRange(rangeA1);
  if (!fRange) throw new Error(`Target range ${rangeA1} not found`);

  if (backgroundColor) fRange.setBackgroundColor?.(backgroundColor);
  if (fontColor) fRange.setFontColor?.(fontColor);
  if (bold !== undefined) fRange.setFontWeight?.(bold ? 'bold' : null);
  if (italic !== undefined) fRange.setFontStyle?.(italic ? 'italic' : null);
  if (horizontalAlignment) {
    const mappedAlign = mapHorizontalAlignment(horizontalAlignment);
    if (mappedAlign) fRange.setHorizontalAlignment?.(mappedAlign);
  }
  if (fontSize) fRange.setFontSize?.(fontSize);

  return {
    success: true,
    sheetName: sheet.getName?.() || sheet.getSheetName?.(),
    styledRange: rangeA1,
    applied: { backgroundColor, fontColor, bold, italic, horizontalAlignment, fontSize },
  };
}

/**
 * 8. SWITCH PROFILE (Handoff)
 */
export async function executeSwitchProfile(
  args: { targetProfile: any; handoffSummary: string },
  ctx: ToolExecutionContext
) {
  const { targetProfile, handoffSummary } = args;
  ctx.onProfileSwitch(targetProfile, handoffSummary);
  return {
    success: true,
    switchedTo: targetProfile,
    handoffSummary,
    instruction: `Profile context is now handed off to '${targetProfile}'. You are NOW operating as the '${targetProfile}' specialist. You MUST IMMEDIATELY call your specialized tools in this step to fulfill the user's request. DO NOT output conversational text announcing the switch; execute the tools directly!`,
    message: `Profile context dynamically handed off to '${targetProfile}'.`,
  };
}

/**
 * 9. SWITCH SHEET (Navigate active sheet view)
 */
export async function executeSwitchSheet(
  args: { sheetName: string },
  ctx: ToolExecutionContext
) {
  const { sheetName } = args;
  const wb = ctx.univerAPI?.getActiveWorkbook?.();
  if (!wb) throw new Error('Active workbook unavailable');

  const sheet = wb.getSheetByName?.(sheetName);
  if (!sheet) {
    const available = (wb.getSheets?.() || []).map((s: any) => s.getSheetName?.() || '');
    throw new Error(
      `Worksheet "${sheetName}" not found. Available sheets: [${available.join(', ')}]`
    );
  }

  wb.setActiveSheet(sheet);

  return {
    success: true,
    activeSheet: sheetName,
    rowCount: Math.max((sheet.getLastRow?.() ?? 0) + 1, 0),
    colCount: Math.max((sheet.getLastColumn?.() ?? 0) + 1, 0),
    message: `Switched active worksheet view to "${sheetName}".`,
  };
}
