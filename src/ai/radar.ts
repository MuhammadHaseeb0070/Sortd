import { WorkbookRadar, ColumnSchema, SheetMetaSummary, ColumnHealthCard } from './types';

/**
 * Converts 0-indexed column integer to Excel column letter (0 -> "A", 25 -> "Z", 26 -> "AA")
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

/**
 * Converts Excel column letter to 0-indexed column integer ("A" -> 0, "Z" -> 25, "AA" -> 26)
 */
export function letterToColIndex(colStr: string): number {
  let col = 0;
  const upper = colStr.toUpperCase();
  for (let i = 0; i < upper.length; i++) {
    col = col * 26 + (upper.charCodeAt(i) - 64);
  }
  return col - 1;
}

/**
 * Deep, vectorized inspection down to the skeleton of a column:
 * Detects exact type census, mixed percentage hazards, currency strings,
 * null rates, frequency distribution (top frequent & rare outliers), and numeric variance.
 */
export function generateColumnHealthCard(
  rawValues: any[],
  colLetter: string,
  headerGuess: string
): ColumnHealthCard {
  const totalRows = rawValues.length;
  let nulls = 0;
  let integers = 0;
  let decimals = 0;
  let currencyStrings = 0;
  let percentageStrings = 0;
  let dates = 0;
  let formulas = 0;
  let booleans = 0;
  let plainStrings = 0;
  let trailingWhitespaceCount = 0;

  const freqMap = new Map<string, { originalVal: any; count: number }>();
  const numericValues: number[] = [];

  for (let r = 0; r < totalRows; r++) {
    const val = rawValues[r];

    if (val === undefined || val === null || val === '') {
      nulls++;
      continue;
    }

    const key = String(val);
    const existing = freqMap.get(key);
    if (existing) {
      existing.count++;
    } else {
      freqMap.set(key, { originalVal: val, count: 1 });
    }

    if (typeof val === 'boolean') {
      booleans++;
      continue;
    }

    if (typeof val === 'number') {
      if (Number.isInteger(val)) {
        integers++;
      } else {
        decimals++;
      }
      numericValues.push(val);
      continue;
    }

    if (val instanceof Date) {
      dates++;
      continue;
    }

    if (typeof val === 'string') {
      const trimmed = val.trim();

      if (val.startsWith(' ') || val.endsWith(' ')) {
        trailingWhitespaceCount++;
      }

      if (val.startsWith('=')) {
        formulas++;
      } else if (/[$€£¥₹]/.test(val)) {
        currencyStrings++;
        const parsed = Number(val.replace(/[$€£¥₹,\s]/g, ''));
        if (!isNaN(parsed)) numericValues.push(parsed);
      } else if (/^-?\d+(\.\d+)?%$/.test(trimmed)) {
        percentageStrings++;
        const parsedPct = parseFloat(trimmed.replace('%', '')) / 100;
        if (!isNaN(parsedPct)) numericValues.push(parsedPct);
      } else if (
        /^\d{4}[-/.]\d{1,2}[-/.]\d{1,2}/.test(trimmed) ||
        /^\d{1,2}[-/.]\d{1,2}[-/.]\d{2,4}/.test(trimmed) ||
        !isNaN(Date.parse(trimmed))
      ) {
        dates++;
      } else if (!isNaN(Number(trimmed))) {
        const num = Number(trimmed);
        if (Number.isInteger(num)) integers++;
        else decimals++;
        numericValues.push(num);
      } else {
        plainStrings++;
      }
    }
  }

  // Type classification
  let detectedType: ColumnHealthCard['detectedType'] = 'empty';
  const nonNullTotal = totalRows - nulls;

  if (nonNullTotal === 0) {
    detectedType = 'empty';
  } else if (currencyStrings > nonNullTotal * 0.4) {
    detectedType = 'currency';
  } else if (percentageStrings > nonNullTotal * 0.4) {
    detectedType = 'percentage';
  } else if (integers + decimals > nonNullTotal * 0.6) {
    detectedType = 'number';
  } else if (dates > nonNullTotal * 0.5) {
    detectedType = 'date';
  } else if (plainStrings > nonNullTotal * 0.6) {
    detectedType = 'string';
  } else {
    detectedType = 'mixed';
  }

  // Frequency analysis: Top 5 frequent and least frequent
  const sortedFrequencies = Array.from(freqMap.values()).sort((a, b) => b.count - a.count);
  const topFrequentValues = sortedFrequencies.slice(0, 5).map((item) => ({
    value: item.originalVal,
    count: item.count,
    percentage: Number(((item.count / totalRows) * 100).toFixed(1)),
  }));

  const rareOutliers = sortedFrequencies
    .slice(-3)
    .filter((item) => item.count <= 2)
    .map((item) => ({ value: item.originalVal, count: item.count }));

  // Numeric Stats & Variance
  let stats: ColumnHealthCard['stats'] = null;
  if (numericValues.length > 0) {
    const min = Math.min(...numericValues);
    const max = Math.max(...numericValues);
    const sum = numericValues.reduce((acc, curr) => acc + curr, 0);
    const mean = sum / numericValues.length;
    const variance =
      numericValues.reduce((acc, curr) => acc + Math.pow(curr - mean, 2), 0) / numericValues.length;

    stats = {
      min: Number(min.toFixed(4)),
      max: Number(max.toFixed(4)),
      mean: Number(mean.toFixed(4)),
      variance: Number(variance.toFixed(4)),
    };
  }

  // Hazard Analysis
  const hazardAlerts: string[] = [];

  if (percentageStrings > 0 && (integers > 0 || decimals > 0)) {
    hazardAlerts.push(
      `CRITICAL HAZARD: Mixed percentage formats! ${percentageStrings} row(s) use "%" strings (e.g. "10.0%") while ${integers + decimals} row(s) use raw numbers (e.g. 0.1). Excel formulas will be off by 100x unless normalized!`
    );
  } else if (percentageStrings > 0 && integers === 0 && decimals === 0) {
    hazardAlerts.push(
      `HAZARD: Column contains "%" strings (e.g. "10.0%"). Direct arithmetic in Excel requires dividing by 100 or cleaning "%".`
    );
  }

  if (currencyStrings > 0) {
    hazardAlerts.push(
      `HAZARD: Column contains currency symbols (e.g. "$"). Direct math formulas will crash with #VALUE! unless currency symbols are stripped first.`
    );
  }

  if (trailingWhitespaceCount > 0) {
    hazardAlerts.push(
      `NOTICE: ${trailingWhitespaceCount} cell(s) have leading or trailing whitespaces that cause lookup or matching failures.`
    );
  }

  if (nulls > 0 && nulls > totalRows * 0.15) {
    hazardAlerts.push(
      `NOTICE: High null rate: ${nulls} blank cells (${Math.round((nulls / totalRows) * 100)}%). Formulas must handle blanks safely.`
    );
  }

  return {
    colLetter,
    headerGuess: headerGuess || `Col ${colLetter}`,
    totalRowsScanned: totalRows,
    nullCount: nulls,
    uniqueCount: freqMap.size,
    detectedType,
    typeCensus: {
      integers,
      decimals,
      currencyStrings,
      percentageStrings,
      dates,
      plainStrings,
      booleans,
      nulls,
      formulas,
    },
    topFrequentValues,
    rareOutliers,
    stats,
    hazardAlerts,
  };
}

/**
 * Rapidly generates a ~250-token WorkbookRadar snapshot from the active univerAPI instance.
 * Designed to execute in <15ms without blocking the UI.
 */
export function generateWorkbookRadar(
  univerAPI: any,
  currentSelectionA1?: string
): WorkbookRadar {
  const fallbackRadar: WorkbookRadar = {
    activeSheetName: 'Sheet1',
    allSheets: [{ name: 'Sheet1', rowCount: 100, colCount: 26 }],
    userSelectionRange: currentSelectionA1 || 'A1',
    occupiedBounds: 'A1:A1',
    nextSafeEmptyColumn: 'B',
    topRowsPreview: [[]],
    columnSchemas: [],
    columnHealthCards: {},
  };

  if (!univerAPI) return fallbackRadar;

  try {
    const workbook = univerAPI.getActiveWorkbook?.();
    if (!workbook) return fallbackRadar;

    const sheet = workbook.getActiveSheet?.();
    if (!sheet) return fallbackRadar;

    const activeSheetName = sheet.getSheetName?.() || 'Sheet1';

    // 1. Gather all sheets metadata
    const allSheets: SheetMetaSummary[] = [];
    const sheetsList = workbook.getSheets?.() || [];
    for (const s of sheetsList) {
      allSheets.push({
        name: s.getSheetName?.() || 'Sheet',
        rowCount: s.getRowCount?.() || 100,
        colCount: s.getColumnCount?.() || 26,
      });
    }

    if (allSheets.length === 0) {
      allSheets.push({
        name: activeSheetName,
        rowCount: sheet.getRowCount?.() || 100,
        colCount: sheet.getColumnCount?.() || 26,
      });
    }

    // 2. Compute occupied bounds safely
    const lastRowIndex = Math.max(sheet.getLastRow?.() ?? 0, 0);
    const lastColIndex = Math.max(sheet.getLastColumn?.() ?? 0, 0);

    const endColLetter = colIndexToLetter(Math.min(lastColIndex, 51)); // Up to column AZ
    const boundedRow = Math.min(lastRowIndex + 1, 2000);
    const occupiedBounds = `A1:${endColLetter}${boundedRow}`;
    const nextSafeEmptyColumn = colIndexToLetter(lastColIndex + 1);

    // 3. User selection
    let selectionRange = currentSelectionA1 || 'A1';
    if (!currentSelectionA1) {
      try {
        const activeRange = workbook.getActiveRange?.() || sheet.getActiveRange?.();
        if (activeRange) {
          selectionRange = activeRange.getA1Notation?.() || 'A1';
        }
      } catch {
        selectionRange = 'A1';
      }
    }

    // 4. Sample top 3 rows for preview
    const previewEndRow = Math.min(lastRowIndex + 1, 3);
    const previewEndCol = Math.min(lastColIndex, 25); // Up to col Z for preview
    const previewRangeNotation = `A1:${colIndexToLetter(previewEndCol)}${Math.max(previewEndRow, 1)}`;

    let topRowsPreview: any[][] = [];
    try {
      const pRange = sheet.getRange(previewRangeNotation);
      topRowsPreview = pRange?.getValues?.() || [];
    } catch {
      topRowsPreview = [];
    }

    // 5. Deep Scan for Column Health Cards (up to 200 rows for lightning-fast <10ms radar)
    const deepScanRows = Math.min(lastRowIndex + 1, 200);
    const deepScanNotation = `A1:${colIndexToLetter(previewEndCol)}${Math.max(deepScanRows, 1)}`;
    let deepScanData: any[][] = [];
    try {
      deepScanData = sheet.getRange(deepScanNotation)?.getValues?.() || topRowsPreview;
    } catch {
      deepScanData = topRowsPreview;
    }

    const columnSchemas: ColumnSchema[] = [];
    const columnHealthCards: Record<string, ColumnHealthCard> = {};
    const totalColsToScan = previewEndCol + 1;

    for (let c = 0; c < totalColsToScan; c++) {
      const colLetter = colIndexToLetter(c);
      let headerGuess = '';

      if (deepScanData.length > 0 && deepScanData[0] && deepScanData[0][c] !== undefined && deepScanData[0][c] !== null) {
        headerGuess = String(deepScanData[0][c]).trim();
      }

      // Column values excluding row 0 header
      const columnCells: any[] = [];
      const scanStartRow = deepScanData.length > 1 ? 1 : 0;
      for (let r = scanStartRow; r < deepScanData.length; r++) {
        columnCells.push(deepScanData[r]?.[c]);
      }

      // Generate the full Column Health Card down to the skeleton!
      const healthCard = generateColumnHealthCard(columnCells, colLetter, headerGuess);
      columnHealthCards[colLetter] = healthCard;

      columnSchemas.push({
        colLetter,
        headerGuess: headerGuess || `Col ${colLetter}`,
        detectedType: healthCard.detectedType === 'currency' || healthCard.detectedType === 'percentage'
          ? 'mixed'
          : healthCard.detectedType,
        nullCount: healthCard.nullCount,
        sampleValues: healthCard.topFrequentValues.slice(0, 3).map((v) => v.value),
      });
    }

    return {
      activeSheetName,
      allSheets,
      userSelectionRange: selectionRange,
      occupiedBounds,
      nextSafeEmptyColumn,
      topRowsPreview: topRowsPreview.slice(0, 3),
      columnSchemas,
      columnHealthCards,
    };
  } catch (err) {
    console.warn('generateWorkbookRadar failed, returning fallback:', err);
    return fallbackRadar;
  }
}
