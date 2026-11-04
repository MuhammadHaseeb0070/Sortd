import type {
  WorkbookRadar,
  ColumnSchema,
  SheetMetaSummary,
  ColumnHealthCard,
  SheetHeaderBrief,
} from './types';
import { colIndexToLetter, letterToColIndex, detectTableHeaderRow } from './utils/univerBridge';
import {
  parseRobustNumber,
  clusterCategoryValues,
  detectEmbeddedSubtotalRows,
} from './utils/dataHygiene';

export { colIndexToLetter, letterToColIndex };

/**
 * Deep, vectorized inspection down to the skeleton of a column:
 * Detects exact type census, mixed percentage hazards, currency strings,
 * null rates, full low-cardinality distinct distribution (eliminating the Frequency Dead Zone),
 * categorical entity collisions (North vs N, N.), and numeric variance/median/skewness.
 */
export function generateColumnHealthCard(
  rawValues: any[],
  colLetter: string,
  headerGuess: string,
  rawFormulas?: any[]
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
  let errorTokenCount = 0;

  const freqMap = new Map<string, { originalVal: any; count: number }>();
  const numericValues: number[] = [];
  let sampleFormulaTemplate: string | undefined;

  for (let r = 0; r < totalRows; r++) {
    const val = rawValues[r];
    const fStr = rawFormulas?.[r] ? String(rawFormulas[r]).trim() : '';

    if (fStr && fStr.startsWith('=')) {
      formulas++;
      if (!sampleFormulaTemplate) {
        sampleFormulaTemplate = fStr.replace(/\d+/g, '{r}');
      }
    }

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

      if (trimmed.startsWith('#') && (trimmed.endsWith('!') || trimmed.endsWith('?'))) {
        errorTokenCount++;
        continue;
      }

      if (trimmed.startsWith('=')) {
        formulas++;
      } else if (/[$€£¥₹]/.test(val)) {
        currencyStrings++;
        const parsed = parseRobustNumber(val);
        if (parsed !== null) numericValues.push(parsed);
      } else if (/^-?\d+(\.\d+)?%$/.test(trimmed)) {
        percentageStrings++;
        const parsedPct = parseFloat(trimmed.replace('%', '')) / 100;
        if (!isNaN(parsedPct)) numericValues.push(parsedPct);
      } else if (
        /^\d{4}[-/.]\d{1,2}[-/.]\d{1,2}/.test(trimmed) ||
        /^\d{1,2}[-/.]\d{1,2}[-/.]\d{2,4}/.test(trimmed)
      ) {
        dates++;
      } else if (trimmed !== '' && !isNaN(Number(trimmed))) {
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
  } else if (formulas > nonNullTotal * 0.5) {
    detectedType = 'formula';
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

  // Frequency analysis:
  // Eliminate the "Frequency Dead Zone": if uniqueCount <= 25, include ALL distinct values!
  const sortedFrequencies = Array.from(freqMap.values()).sort((a, b) => b.count - a.count);
  const topSliceLimit = freqMap.size <= 25 ? 25 : 8;
  const topFrequentValues = sortedFrequencies.slice(0, topSliceLimit).map((item) => ({
    value: item.originalVal,
    count: item.count,
    percentage: Number(((item.count / Math.max(totalRows, 1)) * 100).toFixed(1)),
  }));

  const rareOutliers = sortedFrequencies
    .slice(-5)
    .filter((item) => item.count <= 3)
    .map((item) => ({ value: item.originalVal, count: item.count }));

  // Numeric Stats (Min, Max, Mean, Median, Variance, Skewness)
  let stats: ColumnHealthCard['stats'] = null;
  if (numericValues.length > 0) {
    const sortedNums = [...numericValues].sort((a, b) => a - b);
    const n = sortedNums.length;
    const min = sortedNums[0];
    const max = sortedNums[n - 1];
    const sum = sortedNums.reduce((acc, curr) => acc + curr, 0);
    const mean = sum / n;
    const mid = Math.floor(n / 2);
    const median = n % 2 === 0 ? (sortedNums[mid - 1] + sortedNums[mid]) / 2 : sortedNums[mid];
    const variance =
      sortedNums.reduce((acc, curr) => acc + Math.pow(curr - mean, 2), 0) / n;
    const stdDev = Math.sqrt(variance);
    const skewness =
      n >= 3 && stdDev > 0
        ? sortedNums.reduce((acc, curr) => acc + Math.pow((curr - mean) / stdDev, 3), 0) / n
        : 0;

    stats = {
      min: Number(min.toFixed(4)),
      max: Number(max.toFixed(4)),
      mean: Number(mean.toFixed(4)),
      median: Number(median.toFixed(4)),
      variance: Number(variance.toFixed(4)),
      skewness: Number(skewness.toFixed(2)),
    };
  }

  // Hazard Analysis & Categorical Entity Collision Detection
  const hazardAlerts: string[] = [];
  let entityCollisions: string[] | undefined;

  if ((detectedType === 'string' || detectedType === 'mixed') && freqMap.size >= 2 && freqMap.size <= 100) {
    const clusterRes = clusterCategoryValues(rawValues);
    if (clusterRes.hasCollisions) {
      entityCollisions = clusterRes.collisionSummary;
      hazardAlerts.push(
        `ENTITY_COLLISION HAZARD: Dirty categorical variants detected! ${clusterRes.collisionSummary.join('; ')}. Normalize with 'inspect_and_cluster_categories' or 'standardize_types' BEFORE grouping or pivoting!`
      );
    }
  }

  if (errorTokenCount > 0) {
    hazardAlerts.push(
      `FORMULA ERROR HAZARD: Column contains ${errorTokenCount} Excel error cell(s) (#REF!, #VALUE!, #DIV/0!, etc.).`
    );
  }

  if (percentageStrings > 0 && (integers > 0 || decimals > 0)) {
    hazardAlerts.push(
      `CRITICAL HAZARD: Mixed percentage formats! ${percentageStrings} row(s) use "%" strings while ${integers + decimals} row(s) use raw numbers. Normalize first!`
    );
  } else if (percentageStrings > 0 && integers === 0 && decimals === 0) {
    hazardAlerts.push(
      `HAZARD: Column contains "%" strings. Clean "%" before arithmetic.`
    );
  }

  if (currencyStrings > 0) {
    hazardAlerts.push(
      `HAZARD: Column contains ${currencyStrings} string-formatted currency cell(s) ("$"). Strip currency symbols before Excel math.`
    );
  }

  if (trailingWhitespaceCount > 0) {
    hazardAlerts.push(
      `NOTICE: ${trailingWhitespaceCount} cell(s) have leading/trailing whitespace.`
    );
  }

  if (nulls > 0 && nulls > totalRows * 0.15) {
    hazardAlerts.push(
      `NOTICE: High null rate: ${nulls} blank cells (${Math.round((nulls / totalRows) * 100)}%).`
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
    entityCollisions,
    formulaTemplate: sampleFormulaTemplate,
    hazardAlerts,
  };
}

/**
 * Generates a Multi-Sheet WorkbookRadar v2 snapshot from the active univerAPI instance.
 * Preserves Row-1 header schemas for ALL worksheets (preventing amnesia when switching to a blank sheet)
 * and scans up to 5,000 rows in memory for accurate entity collision and subtotal detection.
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
    subtotalTrapRows: [],
  };

  if (!univerAPI) return fallbackRadar;

  try {
    const workbook = univerAPI.getActiveWorkbook?.();
    if (!workbook) return fallbackRadar;

    const sheet = workbook.getActiveSheet?.();
    if (!sheet) return fallbackRadar;

    const activeSheetName = sheet.getName?.() || sheet.getSheetName?.() || 'Sheet1';

    // 1. Gather all sheets metadata INCLUDING Row-1 headers & occupied bounds for EVERY sheet!
    const sheetsList = workbook.getSheets?.() || [];
    const allSheets: SheetMetaSummary[] = sheetsList.map((s: any) => {
      const sName = s.getName?.() || s.getSheetName?.() || 'Sheet';
      const maxRows = s.getMaxRows?.() || s.getRowCount?.() || 100;
      const maxCols = s.getMaxColumns?.() || s.getColumnCount?.() || 26;
      const lastR = Math.max(s.getLastRow?.() ?? 0, 0);
      const lastC = Math.max(s.getLastColumn?.() ?? 0, 0);

      const headers: SheetHeaderBrief[] = [];
      let populatedRows = 0;
      let populatedCols = 0;
      let occupiedBounds = 'A1:A1';

      try {
        const headerScanCols = Math.min(lastC + 1, 50);
        if (headerScanCols > 0) {
          const { headerVals: row1Vals } = detectTableHeaderRow(s);
          for (let c = 0; c < row1Vals.length; c++) {
            const hVal = row1Vals[c];
            if (hVal !== undefined && hVal !== null && String(hVal).trim() !== '') {
              headers.push({
                colLetter: colIndexToLetter(c),
                header: String(hVal).trim(),
              });
              populatedCols = c + 1;
            }
          }
        }
        if (headers.length > 0 || lastR > 0) {
          populatedRows = lastR + 1;
          populatedCols = Math.max(populatedCols, lastC + 1);
          occupiedBounds = `A1:${colIndexToLetter(Math.max(populatedCols - 1, 0))}${populatedRows}`;
        }
      } catch {
        // ignore
      }

      return {
        name: sName,
        rowCount: maxRows,
        colCount: maxCols,
        populatedRows,
        populatedCols,
        occupiedBounds,
        headers,
      };
    });

    // 2. Determine occupied bounds on active sheet
    const lastRowIndex = Math.max(sheet.getLastRow?.() ?? 0, 0);
    const lastColIndex = Math.max(sheet.getLastColumn?.() ?? 0, 0);

    const endColLetter = colIndexToLetter(lastColIndex);
    const occupiedBounds = `A1:${endColLetter}${lastRowIndex + 1}`;
    const nextSafeEmptyColumn = colIndexToLetter(lastColIndex + 1);

    // 3. Selection A1
    let userSelectionRange = currentSelectionA1 || 'A1';
    if (!currentSelectionA1) {
      try {
        const selection = sheet.getSelection?.();
        const activeRange = selection?.getActiveRange?.();
        if (activeRange?.getA1Notation) {
          userSelectionRange = activeRange.getA1Notation();
        }
      } catch {
        // fallback to A1
      }
    }

    // 4. Read Top 5 rows for preview + Full Scan up to 5,000 rows for Health Cards
    const previewRows = Math.min(lastRowIndex + 1, 5);
    const previewEndCol = Math.min(lastColIndex, 35);

    const topRange = sheet.getRange?.(0, 0, previewRows, previewEndCol + 1);
    const topRowsPreview: any[][] = topRange?.getValues?.() || [[]];

    const deepScanRows = Math.min(lastRowIndex + 1, 5000);
    const deepScanRange = sheet.getRange?.(0, 0, deepScanRows, previewEndCol + 1);
    const deepScanData: any[][] = deepScanRange?.getValues?.() || [[]];
    let deepScanFormulas: any[][] = [];
    try {
      deepScanFormulas = deepScanRange?.getFormulas?.() || [];
    } catch {
      deepScanFormulas = [];
    }

    // Auto-detect actual table header row (e.g. Row 4 when Row 1 is an ERP report title banner)
    const { headerRowIdx, headerVals: activeHeaders } = detectTableHeaderRow(deepScanData);

    // Detect embedded subtotal / grand total trap rows
    const subtotalTrapRows = detectEmbeddedSubtotalRows(deepScanData, true);
    const trapRowZeroIndices = new Set(subtotalTrapRows.map((r1) => r1 - 1));

    // Detect repeated pagination/export header rows against the true table header row
    const repeatedHeaderRows: number[] = [];
    if (deepScanData.length > headerRowIdx + 2 && activeHeaders.length > 0) {
      const topHeaders = activeHeaders.map((v: any) => String(v ?? '').trim().toLowerCase()).filter(Boolean);
      if (topHeaders.length >= 2) {
        for (let r = headerRowIdx + 1; r < deepScanData.length; r++) {
          if (trapRowZeroIndices.has(r)) continue;
          let matchCount = 0;
          let nonBlankCount = 0;
          for (let c = 0; c <= previewEndCol; c++) {
            const hVal = String(activeHeaders[c] ?? '').trim().toLowerCase();
            const rVal = String(deepScanData[r]?.[c] ?? '').trim().toLowerCase();
            if (!hVal) continue;
            if (rVal !== '') {
              nonBlankCount++;
              if (rVal === hVal) matchCount++;
            }
          }
          if (nonBlankCount >= 2 && matchCount / nonBlankCount >= 0.7) {
            repeatedHeaderRows.push(r + 1); // 1-indexed
            trapRowZeroIndices.add(r);
          }
        }
      }
    }

    // 5. Build ColumnSchemas & ColumnHealthCards (excluding title banner, repeated headers & subtotal trap rows!)
    const columnSchemas: ColumnSchema[] = [];
    const columnHealthCards: Record<string, ColumnHealthCard> = {};
    const totalColsToScan = previewEndCol + 1;

    for (let c = 0; c < totalColsToScan; c++) {
      const colLetter = colIndexToLetter(c);
      let headerGuess = '';

      if (
        activeHeaders &&
        activeHeaders[c] !== undefined &&
        activeHeaders[c] !== null
      ) {
        headerGuess = String(activeHeaders[c]).trim();
      }

      const columnCells: any[] = [];
      const columnFormulas: any[] = [];
      const scanStartRow = deepScanData.length > headerRowIdx + 1 ? headerRowIdx + 1 : 0;
      for (let r = scanStartRow; r < deepScanData.length; r++) {
        if (trapRowZeroIndices.has(r)) continue;
        columnCells.push(deepScanData[r]?.[c]);
        columnFormulas.push(deepScanFormulas[r]?.[c]);
      }

      const healthCard = generateColumnHealthCard(
        columnCells,
        colLetter,
        headerGuess,
        columnFormulas
      );
      columnHealthCards[colLetter] = healthCard;

      columnSchemas.push({
        colLetter,
        headerGuess: headerGuess || `Col ${colLetter}`,
        detectedType:
          healthCard.detectedType === 'currency' || healthCard.detectedType === 'percentage'
            ? 'mixed'
            : healthCard.detectedType,
        nullCount: healthCard.nullCount,
        sampleValues: healthCard.topFrequentValues.slice(0, 3).map((v) => v.value),
      });
    }

    return {
      activeSheetName,
      allSheets:
        allSheets.length > 0
          ? allSheets
          : [{ name: activeSheetName, rowCount: 100, colCount: 26 }],
      userSelectionRange,
      occupiedBounds,
      nextSafeEmptyColumn,
      topRowsPreview,
      columnSchemas,
      columnHealthCards,
      subtotalTrapRows,
      repeatedHeaderRows,
    };
  } catch (err) {
    console.warn('WorkbookRadar generation warning:', err);
    return fallbackRadar;
  }
}

/**
 * Formats WorkbookRadar into a compact, high-signal Markdown snapshot (~400-650 tokens)
 * instead of 5,000+ tokens of pretty-printed JSON.
 * Preserves full multi-sheet schemas, distinct category distributions, entity collisions,
 * and embedded subtotal trap alerts.
 */
export function formatCompactRadarForPrompt(radar: WorkbookRadar): string {
  const lines: string[] = [];
  lines.push(
    `ACTIVE SHEET: "${radar.activeSheetName}" | Occupied: ${radar.occupiedBounds} | Next Empty Col: ${radar.nextSafeEmptyColumn} | User Selection: ${radar.userSelectionRange}`
  );

  if (radar.subtotalTrapRows && radar.subtotalTrapRows.length > 0) {
    lines.push(
      `⚠ SUBTOTAL_ROW_TRAP DETECTED on "${radar.activeSheetName}" at Excel Row(s) ${radar.subtotalTrapRows.join(', ')}: Do NOT include these summary rows in SUM/AVERAGE/GroupBy ranges or you will double-count by 2x!`
    );
  }

  if (radar.repeatedHeaderRows && radar.repeatedHeaderRows.length > 0) {
    lines.push(
      `⚠ REPEATED_HEADER_TRAP DETECTED on "${radar.activeSheetName}" at Excel Row(s) ${radar.repeatedHeaderRows.join(', ')}: Repeating pagination/export headers detected! Clean them in one shot with 'remove_repeated_headers' or 'deduplicate_dataset'!`
    );
  }

  // All Worksheets Summary (Critical so AI never loses non-active sheet schemas!)
  lines.push(`WORKBOOK SHEETS (${radar.allSheets.length}):`);
  for (const s of radar.allSheets) {
    const isAct = s.name === radar.activeSheetName ? ' [ACTIVE]' : '';
    const headerSummary =
      s.headers && s.headers.length > 0
        ? s.headers.map((h) => `${h.colLetter}:"${h.header}"`).join(', ')
        : 'EMPTY SHEET';
    lines.push(
      `  - "${s.name}"${isAct} (${s.occupiedBounds || 'A1:A1'}, ${s.populatedRows || 0} rows, capacity ${s.rowCount}R×${s.colCount}C) -> Columns: [${headerSummary}]`
    );
  }

  // Active Sheet Column Health Cards
  const cards = Object.values(radar.columnHealthCards || {}).filter(
    (c) => c.detectedType !== 'empty' || c.headerGuess !== `Col ${c.colLetter}`
  );

  if (cards.length > 0) {
    lines.push(`ACTIVE SHEET ("${radar.activeSheetName}") COLUMN HEALTH & SKELETON:`);
    for (const c of cards) {
      const parts: string[] = [
        `Col ${c.colLetter} "${c.headerGuess}" [${c.detectedType}, scanned=${c.totalRowsScanned}, unique=${c.uniqueCount}, nulls=${c.nullCount}]`,
      ];

      if (c.formulaTemplate) {
        parts.push(`formula="${c.formulaTemplate}"`);
      }

      if (c.stats) {
        parts.push(
          `stats={min:${c.stats.min}, med:${c.stats.median ?? c.stats.mean}, mean:${c.stats.mean}, max:${c.stats.max}, skew:${c.stats.skewness ?? 0}}`
        );
      }

      if (c.topFrequentValues.length > 0 && c.uniqueCount <= 25) {
        const dist = c.topFrequentValues
          .slice(0, 12)
          .map((v) => `${JSON.stringify(v.value)}:${v.count}`)
          .join(', ');
        parts.push(`values=[${dist}]`);
      } else if (c.topFrequentValues.length > 0) {
        const top3 = c.topFrequentValues
          .slice(0, 4)
          .map((v) => `${JSON.stringify(v.value)}(${v.count})`)
          .join(', ');
        parts.push(`top=[${top3}]`);
      }

      if (c.hazardAlerts.length > 0) {
        parts.push(`⚠ ${c.hazardAlerts.join(' | ')}`);
      }

      lines.push(`  * ${parts.join(' | ')}`);
    }
  } else {
    lines.push(
      `ACTIVE SHEET ("${radar.activeSheetName}") IS CURRENTLY EMPTY. Check other sheets in WORKBOOK SHEETS above for source data!`
    );
  }

  if (radar.topRowsPreview && radar.topRowsPreview.length > 0 && radar.topRowsPreview[0]?.length > 0) {
    lines.push(
      `TOP ROWS PREVIEW ("${radar.activeSheetName}"): ${JSON.stringify(radar.topRowsPreview.slice(0, 4))}`
    );
  }

  return lines.join('\n');
}
