/**
 * Shared UniverJS v1.2.0 Bridge Utilities
 * Eliminates silent failures across all 7 AI profiles:
 * 1. Row-1-header-first column resolution (fixes single-word header -> base-26 index bug)
 * 2. Automatic sheet grid capacity expansion (fixes invisible clipping past maxRows/maxCols)
 * 3. UniverJS v1.2.0 horizontal alignment mapping ('right' -> 'normal')
 * 4. Range dimension reconciliation for 2D matrix writes
 */

export function colIndexToLetter(colIndex: number): string {
  let temp = colIndex;
  let letter = '';
  while (temp >= 0) {
    letter = String.fromCharCode((temp % 26) + 65) + letter;
    temp = Math.floor(temp / 26) - 1;
  }
  return letter;
}

export function letterToColIndex(colStr: string): number {
  let col = 0;
  const upper = colStr.trim().toUpperCase();
  for (let i = 0; i < upper.length; i++) {
    col = col * 26 + (upper.charCodeAt(i) - 64);
  }
  return col - 1;
}

export interface ResolvedColumn {
  colIndex: number;
  colLetter: string;
  headerName: string;
  headerRowIdx?: number;
}

/**
 * Automatically detects the true table header row index (0-based) within the top N rows.
 * Handles ERP/enterprise exports where Row 1 is a title banner (e.g. A1 = "ORDER LINES - FY2025")
 * and the actual column headers ("OrderID", "SKU", "Quantity", etc.) sit on Row 3, 4, or 5.
 */
export function detectTableHeaderRow(
  sheetOrRows: any,
  maxScanRows: number = 10
): { headerRowIdx: number; headerVals: any[] } {
  let topRows: any[][] = [];
  if (Array.isArray(sheetOrRows)) {
    topRows = sheetOrRows.slice(0, maxScanRows);
  } else if (sheetOrRows && typeof sheetOrRows.getRange === 'function') {
    const lastRow = Math.max((sheetOrRows.getLastRow?.() ?? 0) + 1, 1);
    const lastCol = Math.max(
      (sheetOrRows.getLastColumn?.() ?? 0) + 1,
      Math.min(sheetOrRows.getMaxColumns?.() ?? 26, 100),
      1
    );
    const scanR = Math.min(lastRow, maxScanRows);
    const scanC = Math.min(lastCol, 150);
    try {
      topRows = sheetOrRows.getRange(0, 0, scanR, scanC)?.getValues?.() || [];
    } catch {
      topRows = [];
    }
  }

  if (topRows.length === 0) {
    return { headerRowIdx: 0, headerVals: [] };
  }

  const scoreRow = (row: any[]) => {
    if (!Array.isArray(row)) return { nonBlank: 0, stringLabels: 0 };
    let nonBlank = 0;
    let stringLabels = 0;
    for (const cell of row) {
      if (cell === undefined || cell === null) continue;
      const s = String(cell).trim();
      if (s === '') continue;
      nonBlank++;
      const cleanedNum = s.replace(/[$,%\s]/g, '');
      const isNumeric = cleanedNum !== '' && !isNaN(Number(cleanedNum));
      const isFormula = s.startsWith('=');
      if (!isNumeric && !isFormula && s.length <= 80) {
        stringLabels++;
      }
    }
    return { nonBlank, stringLabels };
  };

  const row0Score = scoreRow(topRows[0]);
  let bestIdx = 0;
  let bestScore = row0Score;

  for (let r = 1; r < topRows.length; r++) {
    const sc = scoreRow(topRows[r]);
    if (sc.nonBlank < 2 || sc.stringLabels < sc.nonBlank * 0.6) continue;
    if (
      (bestScore.nonBlank <= 2 && sc.nonBlank > bestScore.nonBlank && sc.stringLabels >= 2) ||
      sc.stringLabels > bestScore.stringLabels * 1.5
    ) {
      bestIdx = r;
      bestScore = sc;
      if (sc.nonBlank >= 3 && sc.stringLabels === sc.nonBlank) {
        break;
      }
    }
  }

  return {
    headerRowIdx: bestIdx,
    headerVals: topRows[bestIdx] || [],
  };
}

/**
 * Resolves a column reference (header name like "Region", "Email", "Sales",
 * decorated string like "C (Sales)", or column letter like "B") by checking
 * detected table headers FIRST before interpreting short alphabetic strings as column letters.
 */
export function resolveColumnSmart(
  sheet: any,
  ref: string | number,
  headerRowIdx: number = 0
): ResolvedColumn {
  const detected = headerRowIdx === 0 ? detectTableHeaderRow(sheet) : null;
  const effectiveHeaderRowIdx = detected ? detected.headerRowIdx : headerRowIdx;

  if (typeof ref === 'number' && Number.isFinite(ref)) {
    const idx = Math.max(0, Math.floor(ref));
    const letter = colIndexToLetter(idx);
    let headerName = letter;
    try {
      const val =
        detected?.headerVals?.[idx] ??
        sheet?.getRange?.(effectiveHeaderRowIdx, idx)?.getValue?.();
      if (val !== undefined && val !== null && String(val).trim() !== '') {
        headerName = String(val).trim();
      }
    } catch {
      // ignore
    }
    return { colIndex: idx, colLetter: letter, headerName, headerRowIdx: effectiveHeaderRowIdx };
  }

  const trimmed = String(ref ?? '').trim();
  if (!trimmed) {
    return { colIndex: 0, colLetter: 'A', headerName: 'A', headerRowIdx: effectiveHeaderRowIdx };
  }

  // Read headers across occupied columns
  const lastCol = Math.max(
    (sheet?.getLastColumn?.() ?? 0) + 1,
    Math.min(sheet?.getMaxColumns?.() ?? 26, 100),
    1
  );
  const maxColScan = Math.min(lastCol, 150);
  let headerRowVals: any[] = [];
  if (detected && detected.headerVals.length > 0) {
    headerRowVals = detected.headerVals;
  } else {
    try {
      headerRowVals = sheet?.getRange?.(effectiveHeaderRowIdx, 0, 1, maxColScan)?.getValues?.()?.[0] || [];
    } catch {
      headerRowVals = [];
    }
  }

  // 1. Check decorated format "C (Sales)" or "Col C"
  const decoratedMatch = trimmed.match(/^([A-Za-z]{1,3})\s*\((.+)\)$/);
  if (decoratedMatch) {
    const idx = letterToColIndex(decoratedMatch[1]);
    return {
      colIndex: idx,
      colLetter: decoratedMatch[1].toUpperCase(),
      headerName: decoratedMatch[2].trim(),
      headerRowIdx: effectiveHeaderRowIdx,
    };
  }
  const colPrefixMatch = trimmed.match(/^col(?:umn)?\s+([A-Za-z]{1,3})$/i);
  if (colPrefixMatch) {
    const idx = letterToColIndex(colPrefixMatch[1]);
    const hVal = headerRowVals[idx];
    return {
      colIndex: idx,
      colLetter: colPrefixMatch[1].toUpperCase(),
      headerName: hVal !== undefined && hVal !== null && String(hVal).trim() !== '' ? String(hVal).trim() : colPrefixMatch[1].toUpperCase(),
      headerRowIdx: effectiveHeaderRowIdx,
    };
  }

  // 2. Exact case-insensitive match against detected headers FIRST!
  const lowerTarget = trimmed.toLowerCase();
  for (let c = 0; c < headerRowVals.length; c++) {
    const h = String(headerRowVals[c] ?? '').trim();
    if (h && h.toLowerCase() === lowerTarget) {
      return {
        colIndex: c,
        colLetter: colIndexToLetter(c),
        headerName: h,
        headerRowIdx: effectiveHeaderRowIdx,
      };
    }
  }

  // 3. Normalized alphanumeric header match (e.g. "unit_price" vs "Unit Price")
  const normTarget = lowerTarget.replace(/[^a-z0-9]/g, '');
  if (normTarget.length >= 2) {
    for (let c = 0; c < headerRowVals.length; c++) {
      const h = String(headerRowVals[c] ?? '').trim();
      if (!h) continue;
      const normH = h.toLowerCase().replace(/[^a-z0-9]/g, '');
      if (normH && normH === normTarget) {
        return {
          colIndex: c,
          colLetter: colIndexToLetter(c),
          headerName: h,
          headerRowIdx: effectiveHeaderRowIdx,
        };
      }
    }
  }

  // 4. Only treat as an Excel column letter if it is 1-2 letters (A..ZZ) or valid 3-letter <= XFD
  // and within reasonable spreadsheet bounds (colIndex < 500)
  if (/^[A-Za-z]{1,3}$/.test(trimmed)) {
    const colIdx = letterToColIndex(trimmed);
    if (colIdx >= 0 && colIdx < 500) {
      let headerName = trimmed.toUpperCase();
      try {
        const hVal = headerRowVals[colIdx] ?? sheet?.getRange?.(effectiveHeaderRowIdx, colIdx)?.getValue?.();
        if (hVal !== undefined && hVal !== null && String(hVal).trim() !== '') {
          headerName = String(hVal).trim();
        }
      } catch {
        // ignore
      }
      return {
        colIndex: colIdx,
        colLetter: trimmed.toUpperCase(),
        headerName,
        headerRowIdx: effectiveHeaderRowIdx,
      };
    }
  }

  // 5. Substring / partial match against detected headers as helpful fallback
  if (lowerTarget.length >= 2) {
    for (let c = 0; c < headerRowVals.length; c++) {
      const h = String(headerRowVals[c] ?? '').trim();
      if (h && (h.toLowerCase().includes(lowerTarget) || lowerTarget.includes(h.toLowerCase()))) {
        return {
          colIndex: c,
          colLetter: colIndexToLetter(c),
          headerName: h,
          headerRowIdx: effectiveHeaderRowIdx,
        };
      }
    }
  }

  const availableHeaders = headerRowVals
    .map((h, idx) => (h !== undefined && h !== null && String(h).trim() !== '' ? `${colIndexToLetter(idx)} ("${String(h).trim()}")` : null))
    .filter(Boolean)
    .join(', ');

  throw new Error(
    `Column "${trimmed}" not found in worksheet. Available columns: ${availableHeaders || 'none'}`
  );
}

/**
 * UniverJS v1.2.0 FRange.setHorizontalAlignment only accepts 'left' | 'center' | 'normal'
 * where 'normal' means right-aligned! Passing 'right' throws a runtime exception.
 */
export function mapHorizontalAlignment(
  alignment?: string
): 'left' | 'center' | 'normal' | undefined {
  if (!alignment) return undefined;
  const lower = alignment.trim().toLowerCase();
  if (lower === 'right' || lower === 'normal') return 'normal';
  if (lower === 'center' || lower === 'middle') return 'center';
  if (lower === 'left') return 'left';
  return 'left';
}

/**
 * Expands worksheet rowCount / columnCount if a target write exceeds current grid capacity.
 * Prevents Univer's canvas viewport from clipping rows/columns written beyond initial bounds.
 */
export function ensureSheetCapacity(
  sheet: any,
  requiredRowCount1Based: number,
  requiredColCount1Based: number
): void {
  if (!sheet) return;
  try {
    const currentMaxRows =
      typeof sheet.getMaxRows === 'function'
        ? sheet.getMaxRows()
        : typeof sheet.getRowCount === 'function'
        ? sheet.getRowCount()
        : 100;
    if (requiredRowCount1Based > currentMaxRows && typeof sheet.setRowCount === 'function') {
      sheet.setRowCount(Math.max(requiredRowCount1Based + 25, currentMaxRows));
    }
  } catch {
    // ignore if unsupported by mock
  }

  try {
    const currentMaxCols =
      typeof sheet.getMaxColumns === 'function'
        ? sheet.getMaxColumns()
        : typeof sheet.getColumnCount === 'function'
        ? sheet.getColumnCount()
        : 26;
    if (requiredColCount1Based > currentMaxCols && typeof sheet.setColumnCount === 'function') {
      sheet.setColumnCount(Math.max(requiredColCount1Based + 6, currentMaxCols));
    }
  } catch {
    // ignore if unsupported by mock
  }
}

export interface ParsedA1Range {
  sheetPrefix?: string;
  cleanRangeA1: string;
  startRow: number; // 0-based
  endRow: number; // 0-based inclusive
  startCol: number; // 0-based
  endCol: number; // 0-based inclusive
}

export function parseA1RangeBounds(rangeA1: string): ParsedA1Range {
  let raw = String(rangeA1 || 'A1').trim();
  let sheetPrefix: string | undefined;

  if (raw.includes('!')) {
    const bangIdx = raw.lastIndexOf('!');
    sheetPrefix = raw.slice(0, bangIdx).replace(/^'+|'+$/g, '').trim();
    raw = raw.slice(bangIdx + 1).trim();
  }

  const parts = raw.split(':');
  const cellRegex = /^\$?([A-Za-z]{1,3})\$?(\d+)$/;
  const m1 = parts[0].trim().match(cellRegex);
  const m2 = (parts[1] || parts[0]).trim().match(cellRegex);

  const startCol = m1 ? letterToColIndex(m1[1]) : 0;
  const startRow = m1 ? Math.max(0, parseInt(m1[2], 10) - 1) : 0;
  const endCol = m2 ? letterToColIndex(m2[1]) : startCol;
  const endRow = m2 ? Math.max(startRow, parseInt(m2[2], 10) - 1) : startRow;

  return {
    sheetPrefix,
    cleanRangeA1: raw,
    startRow: Math.min(startRow, endRow),
    endRow: Math.max(startRow, endRow),
    startCol: Math.min(startCol, endCol),
    endCol: Math.max(startCol, endCol),
  };
}

/**
 * Reconciles rangeA1 against values2D dimensions (so oversized/undersized arrays never
 * truncate silently or crash Univer's covertCellValues) AND expands sheet capacity.
 */
export function reconcileRangeAndEnsureCapacity(
  sheet: any,
  rangeA1: string,
  values2D?: any[][]
): string {
  const parsed = parseA1RangeBounds(rangeA1);
  let targetEndRow = parsed.endRow;
  let targetEndCol = parsed.endCol;

  if (values2D && values2D.length > 0) {
    const matrixRows = values2D.length;
    const matrixCols = Math.max(...values2D.map((r) => (Array.isArray(r) ? r.length : 0)), 1);
    targetEndRow = parsed.startRow + matrixRows - 1;
    targetEndCol = parsed.startCol + matrixCols - 1;
  }

  ensureSheetCapacity(sheet, targetEndRow + 1, targetEndCol + 1);

  const startCoord = `${colIndexToLetter(parsed.startCol)}${parsed.startRow + 1}`;
  const endCoord = `${colIndexToLetter(targetEndCol)}${targetEndRow + 1}`;
  return startCoord === endCoord ? startCoord : `${startCoord}:${endCoord}`;
}

/**
 * Resolves a worksheet by name (with case-insensitive fallback) or returns the active sheet.
 */
export function resolveWorksheet(wb: any, sheetName?: string): any {
  if (!wb) return null;
  if (!sheetName || !String(sheetName).trim()) {
    return wb.getActiveSheet?.();
  }
  const cleanName = String(sheetName).replace(/^'+|'+$/g, '').trim();
  const exact = wb.getSheetByName?.(cleanName);
  if (exact) return exact;

  const allSheets = wb.getSheets?.() || [];
  const lower = cleanName.toLowerCase();
  for (const s of allSheets) {
    const sName = String(s.getName?.() || s.getSheetName?.() || '').trim();
    if (sName.toLowerCase() === lower) {
      return s;
    }
  }
  return null;
}

/**
 * Creates or retrieves a worksheet WITHOUT leaving the user stranded on an empty sheet
 * if preserveActiveSheet is requested.
 */
export function getOrCreateWorksheet(
  wb: any,
  targetSheetName: string,
  options?: { clearIfExists?: boolean }
): any {
  let sheet = resolveWorksheet(wb, targetSheetName);
  if (!sheet) {
    sheet = wb.insertSheet?.(targetSheetName);
  } else if (options?.clearIfExists) {
    try {
      sheet.clear?.();
    } catch {
      // ignore
    }
  }
  return sheet;
}
