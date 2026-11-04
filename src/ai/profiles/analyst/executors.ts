import type { ToolExecutionContext } from '../../types';
import { colIndexToLetter } from '../../radar';
import { parseFlexibleDate } from '../sanitizer/executors';
import {
  resolveColumnSmart,
  ensureSheetCapacity,
} from '../../utils/univerBridge';
import {
  parseRobustNumber,
  clusterCategoryValues,
  detectEmbeddedSubtotalRows,
} from '../../utils/dataHygiene';

/**
 * Resolves a column identifier (Row 1 header label FIRST, then Excel column letter) on a given sheet.
 */
function resolveSheetColumn(
  sheet: any,
  colRef: string | number,
  headerRowIdx: number = 0
): { colIndex: number; colLetter: string; headerName: string } {
  return resolveColumnSmart(sheet, colRef, headerRowIdx);
}

/**
 * Safely parses any cell value to a numeric float (handles raw numbers, accounting parentheses, currency, % strings).
 */
function parseNumericVal(val: any): number | null {
  return parseRobustNumber(val);
}

/**
 * Gets or creates a destination worksheet and clears any stale data before writing.
 */
function getOrCreateSheet(wb: any, sheetName: string): any {
  let sheet = wb.getSheetByName?.(sheetName);
  if (!sheet) {
    wb.insertSheet?.(sheetName);
    sheet = wb.getSheetByName?.(sheetName);
  } else {
    try {
      sheet.clear?.();
    } catch {
      // ignore
    }
  }
  return sheet;
}

/**
 * 1. AGGREGATE MULTI-LEVEL GROUPBY
 * Hierarchical grouping across 1+ dimensions with automatic dirty-category normalization,
 * embedded subtotal exclusion, multi-metric aggregations, live SUMIFS formula mode, sorting, and grand totals.
 */
export async function executeAggregateMultilevelGroupby(
  args: {
    groupByColumns: string[];
    metrics: Array<{
      column: string;
      agg?: 'sum' | 'average' | 'count' | 'unique_count' | 'min' | 'max';
      operation?: 'sum' | 'average' | 'count' | 'unique_count' | 'min' | 'max';
      alias?: string;
    }>;
    autoNormalizeCategories?: boolean;
    excludeSubtotalRows?: boolean;
    outputMode?: 'values' | 'formulas';
    sourceSheetName?: string;
    targetSheetName?: string;
    startCell?: string;
    startRow?: number;
    endRow?: number;
    sortByMetricIndex?: number;
    sortDirection?: 'asc' | 'desc';
    topN?: number;
    includeGrandTotal?: boolean;
  },
  ctx: ToolExecutionContext
) {
  const t0 = performance.now();
  const {
    groupByColumns,
    metrics,
    autoNormalizeCategories = true,
    excludeSubtotalRows = true,
    outputMode = 'values',
    sourceSheetName,
    targetSheetName,
    startRow = 2,
    endRow,
    sortByMetricIndex,
    sortDirection = 'desc',
    topN,
    includeGrandTotal = true,
  } = args;

  const wb = ctx.univerAPI?.getActiveWorkbook?.();
  if (!wb) throw new Error('Univer active workbook unavailable');

  const srcSheet = sourceSheetName ? wb.getSheetByName?.(sourceSheetName) : wb.getActiveSheet?.();
  if (!srcSheet) throw new Error(`Worksheet ${sourceSheetName || 'active'} not found`);
  const srcSheetName = srcSheet.getSheetName?.() || srcSheet.getName?.() || 'Sheet1';

  const destSheetName = targetSheetName || `${srcSheetName}_GroupBy`;
  const destSheet = getOrCreateSheet(wb, destSheetName);
  if (!destSheet) throw new Error(`Failed to access or create worksheet "${destSheetName}"`);

  const lastSheetRow = Math.max((srcSheet.getLastRow?.() ?? 0) + 1, 1);
  const effectiveEndRow = endRow ? Math.min(endRow, lastSheetRow) : lastSheetRow;
  if (effectiveEndRow < startRow) {
    return {
      status: 'SUCCESS',
      success: true,
      totalGroupsCreated: 0,
      groupsCount: 0,
      targetSheet: destSheetName,
      outputSheet: destSheetName,
      message: 'No data rows in range',
    };
  }

  // Resolve group columns and metric columns
  const resolvedGroupCols = groupByColumns.map((colRef) => resolveSheetColumn(srcSheet, colRef, 0));
  const resolvedMetrics = metrics.map((m) => {
    const aggOp = (m.agg || m.operation || 'sum') as 'sum' | 'average' | 'count' | 'unique_count' | 'min' | 'max';
    const colInfo = resolveSheetColumn(srcSheet, m.column, 0);
    return {
      ...m,
      agg: aggOp,
      colInfo,
      alias: m.alias || `${aggOp.toUpperCase()}(${colInfo.headerName})`,
    };
  });

  const numDataRows = effectiveEndRow - startRow + 1;

  // Read column arrays
  const groupColsValues = resolvedGroupCols.map((col) => {
    return (
      srcSheet
        .getRange(`${col.colLetter}${startRow}:${col.colLetter}${effectiveEndRow}`)
        ?.getValues?.()
        ?.map((r: any[]) => r[0]) || []
    );
  });

  const metricColsValues = resolvedMetrics.map((m) => {
    return (
      srcSheet
        .getRange(`${m.colInfo.colLetter}${startRow}:${m.colInfo.colLetter}${effectiveEndRow}`)
        ?.getValues?.()
        ?.map((r: any[]) => r[0]) || []
    );
  });

  // Detect embedded subtotal / Grand Total rows across group columns
  const subtotalRowSet = new Set<number>();
  if (excludeSubtotalRows) {
    for (const colVals of groupColsValues) {
      const trapRows1Based = detectEmbeddedSubtotalRows(colVals.map((v: any) => [v]), false);
      for (const r1Based of trapRows1Based) {
        subtotalRowSet.add(r1Based - 1);
      }
    }
  }

  // Auto-normalize dirty category variants (e.g. "North" vs "N", "N."; "West" vs "W")
  const normalizationApplied: Record<string, Array<{ canonical: string; mergedVariants: string[] }>> = {};
  const normalizedGroupColsValues = groupColsValues.map((colVals, idx) => {
    const cleanRows = colVals.filter((_: any, rIdx: number) => !subtotalRowSet.has(rIdx));
    if (!autoNormalizeCategories) return colVals;
    const clustered = clusterCategoryValues(cleanRows);
    if (clustered.hasCollisions) {
      const mergedList = clustered.clusters
        .filter((c) => c.variants.length > 1)
        .map((c) => ({
          canonical: c.canonicalValue,
          mergedVariants: c.variants.map((v) => v.rawValue),
        }));
      if (mergedList.length > 0) {
        normalizationApplied[resolvedGroupCols[idx].headerName] = mergedList;
      }
      return colVals.map((v: any) => {
        if (v === undefined || v === null || String(v).trim() === '') return v;
        const raw = String(v).trim();
        return clustered.mapping[raw] || clustered.mapping[String(v)] || raw;
      });
    }
    return colVals;
  });

  const groupMap = new Map<string, { keyParts: any[]; rowIndices: number[] }>();

  for (let r = 0; r < numDataRows; r++) {
    if (subtotalRowSet.has(r)) continue;

    const keyParts = normalizedGroupColsValues.map((colVals) => {
      const v = colVals[r];
      return v !== undefined && v !== null && String(v).trim() !== '' ? String(v).trim() : '(Blank)';
    });
    const groupKey = keyParts.join('|||');

    const existing = groupMap.get(groupKey);
    if (existing) {
      existing.rowIndices.push(r);
    } else {
      groupMap.set(groupKey, { keyParts, rowIndices: [r] });
    }
  }

  // Compute metrics for each group
  const outputRows: any[][] = [];
  const metricRawAccumulators = resolvedMetrics.map(() => ({ totalSum: 0, totalCount: 0 }));

  for (const [, groupEntry] of groupMap.entries()) {
    const rowRecord: any[] = [...groupEntry.keyParts];

    for (let mIdx = 0; mIdx < resolvedMetrics.length; mIdx++) {
      const mDef = resolvedMetrics[mIdx];
      const colRawVals = metricColsValues[mIdx];
      const groupVals = groupEntry.rowIndices.map((rIdx) => colRawVals[rIdx]);

      if (mDef.agg === 'count') {
        rowRecord.push(groupVals.length);
        metricRawAccumulators[mIdx].totalCount += groupVals.length;
      } else if (mDef.agg === 'unique_count') {
        const uniqueSet = new Set(groupVals.filter((v) => v !== undefined && v !== null && v !== ''));
        rowRecord.push(uniqueSet.size);
      } else {
        const numVals: number[] = groupVals.map(parseNumericVal).filter((n: any): n is number => n !== null);
        if (numVals.length === 0) {
          rowRecord.push(0);
        } else {
          const sum = numVals.reduce((a: number, b: number) => a + b, 0);
          metricRawAccumulators[mIdx].totalSum += sum;
          metricRawAccumulators[mIdx].totalCount += numVals.length;

          if (mDef.agg === 'sum') {
            rowRecord.push(Number(sum.toFixed(2)));
          } else if (mDef.agg === 'average') {
            rowRecord.push(Number((sum / numVals.length).toFixed(2)));
          } else if (mDef.agg === 'min') {
            rowRecord.push(Math.min(...numVals));
          } else if (mDef.agg === 'max') {
            rowRecord.push(Math.max(...numVals));
          }
        }
      }
    }

    outputRows.push(rowRecord);
  }

  // Sorting (default sort by first metric descending when sortByMetricIndex not explicitly disabled)
  const effectiveSortIdx = sortByMetricIndex !== undefined ? sortByMetricIndex : 0;
  if (effectiveSortIdx >= 0 && effectiveSortIdx < resolvedMetrics.length) {
    const sortColIdx = resolvedGroupCols.length + effectiveSortIdx;
    outputRows.sort((a, b) => {
      const valA = a[sortColIdx];
      const valB = b[sortColIdx];
      if (typeof valA === 'number' && typeof valB === 'number') {
        return sortDirection === 'desc' ? valB - valA : valA - valB;
      }
      return sortDirection === 'desc'
        ? String(valB).localeCompare(String(valA))
        : String(valA).localeCompare(String(valB));
    });
  }

  const totalGroupsCreated = outputRows.length;
  const finalDataRows = topN && topN > 0 ? outputRows.slice(0, topN) : [...outputRows];

  // Optional Formula Mode: emit live =SUMIFS / =AVERAGEIFS / =COUNTIFS when no fuzzy normalization altered source keys
  const canUseLiveFormulas =
    outputMode === 'formulas' && Object.keys(normalizationApplied).length === 0;
  const quotedSrcSheet = /[\s']/.test(srcSheetName)
    ? `'${srcSheetName.replace(/'/g, "''")}'`
    : srcSheetName;

  if (canUseLiveFormulas) {
    for (let rIdx = 0; rIdx < finalDataRows.length; rIdx++) {
      const excelRowNum = rIdx + 2;
      const criteriaPairs = resolvedGroupCols
        .map(
          (gCol, gIdx) =>
            `${quotedSrcSheet}!$${gCol.colLetter}$${startRow}:$${gCol.colLetter}$${effectiveEndRow}, ${colIndexToLetter(gIdx)}${excelRowNum}`
        )
        .join(', ');

      for (let mIdx = 0; mIdx < resolvedMetrics.length; mIdx++) {
        const mDef = resolvedMetrics[mIdx];
        const mColRange = `${quotedSrcSheet}!$${mDef.colInfo.colLetter}$${startRow}:$${mDef.colInfo.colLetter}$${effectiveEndRow}`;
        const outColIdx = resolvedGroupCols.length + mIdx;

        if (mDef.agg === 'sum') {
          finalDataRows[rIdx][outColIdx] = `=SUMIFS(${mColRange}, ${criteriaPairs})`;
        } else if (mDef.agg === 'average') {
          finalDataRows[rIdx][outColIdx] = `=AVERAGEIFS(${mColRange}, ${criteriaPairs})`;
        } else if (mDef.agg === 'count') {
          finalDataRows[rIdx][outColIdx] = `=COUNTIFS(${criteriaPairs})`;
        }
      }
    }
  }

  // Build Headers: [...groupHeaders, ...metricAliases]
  const headers = [...resolvedGroupCols.map((c) => c.headerName), ...resolvedMetrics.map((m) => m.alias)];

  // Grand Total Row (using true weighted average instead of unweighted average of group averages)
  if (includeGrandTotal && finalDataRows.length > 0) {
    const totalRow: any[] = new Array(headers.length).fill('');
    totalRow[0] = 'Grand Total';

    for (let mIdx = 0; mIdx < resolvedMetrics.length; mIdx++) {
      const mDef = resolvedMetrics[mIdx];
      const colIdx = resolvedGroupCols.length + mIdx;

      if (mDef.agg === 'sum' || mDef.agg === 'count') {
        const sum = outputRows.reduce((acc: number, row: any[]) => acc + (Number(row[colIdx]) || 0), 0);
        totalRow[colIdx] = Number(sum.toFixed(2));
      } else if (mDef.agg === 'average') {
        const acc = metricRawAccumulators[mIdx];
        totalRow[colIdx] = acc.totalCount > 0 ? Number((acc.totalSum / acc.totalCount).toFixed(2)) : 0;
      } else if (mDef.agg === 'min') {
        totalRow[colIdx] = Math.min(...outputRows.map((r: any[]) => Number(r[colIdx]) || 0));
      } else if (mDef.agg === 'max') {
        totalRow[colIdx] = Math.max(...outputRows.map((r: any[]) => Number(r[colIdx]) || 0));
      }
    }
    finalDataRows.push(totalRow);
  }

  ensureSheetCapacity(destSheet, finalDataRows.length + 2, headers.length);

  // Write to destination sheet
  destSheet.getRange(0, 0, 1, headers.length)?.setValues?.([headers]);
  if (finalDataRows.length > 0) {
    destSheet.getRange(1, 0, finalDataRows.length, headers.length)?.setValues?.(finalDataRows);
  }

  // Format headers and total row
  try {
    destSheet.getRange(0, 0, 1, headers.length)?.setFontWeight?.('bold');
    destSheet.getRange(0, 0, 1, headers.length)?.setBackgroundColor?.('#18181b');
    destSheet.getRange(0, 0, 1, headers.length)?.setFontColor?.('#ffffff');

    if (includeGrandTotal) {
      destSheet.getRange(finalDataRows.length, 0, 1, headers.length)?.setFontWeight?.('bold');
    }
  } catch {
    // ignore
  }

  wb.setActiveSheet(destSheet);
  const durationMs = Math.round(performance.now() - t0);

  return {
    status: 'SUCCESS',
    success: true,
    action: 'aggregate_multilevel_groupby',
    targetSheet: destSheetName,
    outputSheet: destSheetName,
    dimensions: resolvedGroupCols.map((c) => c.headerName),
    metricsComputed: resolvedMetrics.map((m) => m.alias),
    totalGroupsCreated,
    groupsCount: totalGroupsCreated,
    subtotalRowsExcluded: subtotalRowSet.size,
    normalizationApplied,
    rowsWritten: finalDataRows.length,
    allGroupsPreview: finalDataRows.slice(0, 50),
    samplesPreview: finalDataRows.slice(0, 10),
    durationMs,
    message: `Aggregated ${totalGroupsCreated} clean groups across [${resolvedGroupCols.map((c) => c.headerName).join(', ')}] in sheet "${destSheetName}" in ${durationMs}ms.`,
  };
}

/**
 * 2. GENERATE CROSSTAB PIVOT (2D Matrix Cross-Tabulation)
 */
export async function executeGenerateCrosstabPivot(
  args: {
    rowDimension?: string;
    rowFields?: string[];
    colDimension?: string;
    columnField?: string;
    valColumn?: string;
    valueField?: string;
    valAgg?: 'sum' | 'count' | 'average';
    aggregation?: 'sum' | 'count' | 'average';
    displayMode?: 'raw' | 'percent_of_row' | 'percent_of_col' | 'percent_of_grand_total';
    sourceSheetName?: string;
    targetSheetName?: string;
    emptyCellValue?: any;
    includeRowTotals?: boolean;
    includeColTotals?: boolean;
    startRow?: number;
    endRow?: number;
  },
  ctx: ToolExecutionContext
) {
  const t0 = performance.now();
  const rowDimRef = args.rowDimension || args.rowFields?.[0];
  const colDimRef = args.colDimension || args.columnField;
  const valColRef = args.valColumn || args.valueField;
  const valAgg = args.valAgg || args.aggregation || 'sum';
  const {
    displayMode = 'raw',
    sourceSheetName,
    targetSheetName,
    emptyCellValue = 0,
    includeRowTotals = true,
    includeColTotals = true,
    startRow = 2,
    endRow,
  } = args;

  if (!rowDimRef || !colDimRef || !valColRef) {
    throw new Error('rowDimension, colDimension, and valColumn are required for generate_crosstab_pivot.');
  }

  const wb = ctx.univerAPI?.getActiveWorkbook?.();
  if (!wb) throw new Error('Univer active workbook unavailable');

  const srcSheet = sourceSheetName ? wb.getSheetByName?.(sourceSheetName) : wb.getActiveSheet?.();
  if (!srcSheet) throw new Error(`Worksheet ${sourceSheetName || 'active'} not found`);

  const destSheetName = targetSheetName || `${srcSheet.getSheetName?.() || 'Sheet'}_Pivot`;
  const destSheet = getOrCreateSheet(wb, destSheetName);
  if (!destSheet) throw new Error(`Failed to access or create worksheet "${destSheetName}"`);

  const lastSheetRow = Math.max((srcSheet.getLastRow?.() ?? 0) + 1, 1);
  const effectiveEndRow = endRow ? Math.min(endRow, lastSheetRow) : lastSheetRow;

  const rowCol = resolveSheetColumn(srcSheet, rowDimRef, 0);
  const colCol = resolveSheetColumn(srcSheet, colDimRef, 0);
  const valCol = resolveSheetColumn(srcSheet, valColRef, 0);

  // Read data
  const rowVals =
    srcSheet
      .getRange(`${rowCol.colLetter}${startRow}:${rowCol.colLetter}${effectiveEndRow}`)
      ?.getValues?.()
      ?.map((r: any[]) => r[0]) || [];

  const colVals =
    srcSheet
      .getRange(`${colCol.colLetter}${startRow}:${colCol.colLetter}${effectiveEndRow}`)
      ?.getValues?.()
      ?.map((r: any[]) => r[0]) || [];

  const rawValues =
    srcSheet
      .getRange(`${valCol.colLetter}${startRow}:${valCol.colLetter}${effectiveEndRow}`)
      ?.getValues?.()
      ?.map((r: any[]) => r[0]) || [];

  const subtotalRows = new Set(
    detectEmbeddedSubtotalRows(rowVals.map((v: any) => [v]), false).map((r1) => r1 - 1)
  );

  // Auto-normalize dirty row/col category keys
  const rowClusters = clusterCategoryValues(rowVals.filter((_: any, i: number) => !subtotalRows.has(i)));
  const colClusters = clusterCategoryValues(colVals.filter((_: any, i: number) => !subtotalRows.has(i)));

  const uniqueRowKeys: string[] = [];
  const uniqueColKeys: string[] = [];
  const matrix = new Map<string, Map<string, number[]>>();

  for (let i = 0; i < rowVals.length; i++) {
    if (subtotalRows.has(i)) continue;
    const rawR =
      rowVals[i] !== undefined && rowVals[i] !== null && String(rowVals[i]).trim() !== ''
        ? String(rowVals[i]).trim()
        : '(Blank)';
    const rawC =
      colVals[i] !== undefined && colVals[i] !== null && String(colVals[i]).trim() !== ''
        ? String(colVals[i]).trim()
        : '(Blank)';

    const rKey = rowClusters.mapping[rawR] || rawR;
    const cKey = colClusters.mapping[rawC] || rawC;

    if (!uniqueRowKeys.includes(rKey)) uniqueRowKeys.push(rKey);
    if (!uniqueColKeys.includes(cKey)) uniqueColKeys.push(cKey);

    if (!matrix.has(rKey)) matrix.set(rKey, new Map());
    const rowMap = matrix.get(rKey)!;
    if (!rowMap.has(cKey)) rowMap.set(cKey, []);

    const parsedNum = parseNumericVal(rawValues[i]);
    if (valAgg === 'count') {
      if (rawValues[i] !== undefined && rawValues[i] !== null && String(rawValues[i]).trim() !== '') {
        rowMap.get(cKey)!.push(1);
      }
    } else if (parsedNum !== null) {
      rowMap.get(cKey)!.push(parsedNum);
    }
  }

  uniqueRowKeys.sort();
  uniqueColKeys.sort();

  // Aggregate matrix
  const aggregatedGrid: number[][] = [];
  let grandTotalSum = 0;
  let grandTotalCount = 0;

  for (const rKey of uniqueRowKeys) {
    const rowGridVals: number[] = [];
    const rowMap = matrix.get(rKey)!;

    for (const cKey of uniqueColKeys) {
      const cellNumbers = rowMap.get(cKey) || [];
      let aggVal = 0;
      if (cellNumbers.length > 0) {
        const cellSum = cellNumbers.reduce((a, b) => a + b, 0);
        grandTotalSum += cellSum;
        grandTotalCount += cellNumbers.length;

        if (valAgg === 'count') aggVal = cellNumbers.length;
        else if (valAgg === 'average') aggVal = Number((cellSum / cellNumbers.length).toFixed(2));
        else aggVal = Number(cellSum.toFixed(2));
      }
      rowGridVals.push(aggVal);
    }
    aggregatedGrid.push(rowGridVals);
  }

  const grandTotalValue =
    valAgg === 'average'
      ? grandTotalCount > 0
        ? Number((grandTotalSum / grandTotalCount).toFixed(2))
        : 0
      : valAgg === 'count'
      ? grandTotalCount
      : Number(grandTotalSum.toFixed(2));

  // Row and Column Totals
  const rowTotals = uniqueRowKeys.map((rKey, rIdx) => {
    if (valAgg === 'average') {
      const allRowNums: number[] = [];
      const rowMap = matrix.get(rKey)!;
      for (const cKey of uniqueColKeys) {
        allRowNums.push(...(rowMap.get(cKey) || []));
      }
      return allRowNums.length > 0
        ? Number((allRowNums.reduce((a, b) => a + b, 0) / allRowNums.length).toFixed(2))
        : 0;
    }
    return Number(aggregatedGrid[rIdx].reduce((a, b) => a + b, 0).toFixed(2));
  });

  const colTotals: number[] = [];
  for (let c = 0; c < uniqueColKeys.length; c++) {
    const cKey = uniqueColKeys[c];
    if (valAgg === 'average') {
      const allColNums: number[] = [];
      for (const rKey of uniqueRowKeys) {
        allColNums.push(...(matrix.get(rKey)?.get(cKey) || []));
      }
      colTotals.push(
        allColNums.length > 0
          ? Number((allColNums.reduce((a, b) => a + b, 0) / allColNums.length).toFixed(2))
          : 0
      );
    } else {
      let colSum = 0;
      for (let r = 0; r < uniqueRowKeys.length; r++) {
        colSum += aggregatedGrid[r][c];
      }
      colTotals.push(Number(colSum.toFixed(2)));
    }
  }

  // Format matrix based on displayMode
  const finalMatrixRows: any[][] = [];

  for (let r = 0; r < uniqueRowKeys.length; r++) {
    const rowData: any[] = [uniqueRowKeys[r]];

    for (let c = 0; c < uniqueColKeys.length; c++) {
      const raw = aggregatedGrid[r][c];
      if (raw === 0) {
        rowData.push(emptyCellValue);
        continue;
      }

      if (displayMode === 'percent_of_row') {
        const pct = rowTotals[r] > 0 ? (raw / rowTotals[r]) * 100 : 0;
        rowData.push(`${pct.toFixed(1)}%`);
      } else if (displayMode === 'percent_of_col') {
        const pct = colTotals[c] > 0 ? (raw / colTotals[c]) * 100 : 0;
        rowData.push(`${pct.toFixed(1)}%`);
      } else if (displayMode === 'percent_of_grand_total') {
        const pct = grandTotalValue > 0 ? (raw / grandTotalValue) * 100 : 0;
        rowData.push(`${pct.toFixed(1)}%`);
      } else {
        rowData.push(raw);
      }
    }

    if (includeRowTotals) {
      rowData.push(rowTotals[r]);
    }

    finalMatrixRows.push(rowData);
  }

  // Build Headers
  const headers = [`${rowCol.headerName} \\ ${colCol.headerName}`, ...uniqueColKeys];
  if (includeRowTotals) headers.push('Total');

  // Bottom Column Totals Row
  if (includeColTotals) {
    const bottomRow: any[] = ['Total', ...colTotals];
    if (includeRowTotals) bottomRow.push(grandTotalValue);
    finalMatrixRows.push(bottomRow);
  }

  ensureSheetCapacity(destSheet, finalMatrixRows.length + 2, headers.length);

  // Write to destination sheet
  destSheet.getRange(0, 0, 1, headers.length)?.setValues?.([headers]);
  destSheet.getRange(1, 0, finalMatrixRows.length, headers.length)?.setValues?.(finalMatrixRows);

  try {
    destSheet.getRange(0, 0, 1, headers.length)?.setFontWeight?.('bold');
    destSheet.getRange(0, 0, 1, headers.length)?.setBackgroundColor?.('#18181b');
    destSheet.getRange(0, 0, 1, headers.length)?.setFontColor?.('#ffffff');

    if (includeColTotals) {
      destSheet.getRange(finalMatrixRows.length, 0, 1, headers.length)?.setFontWeight?.('bold');
    }
  } catch {
    // ignore
  }

  wb.setActiveSheet(destSheet);
  const durationMs = Math.round(performance.now() - t0);

  return {
    status: 'SUCCESS',
    success: true,
    action: 'generate_crosstab_pivot',
    targetSheet: destSheetName,
    outputSheet: destSheetName,
    rowDimension: rowCol.headerName,
    colDimension: colCol.headerName,
    valColumn: valCol.headerName,
    displayMode,
    matrixDimensions: `${uniqueRowKeys.length} Rows × ${uniqueColKeys.length} Columns`,
    grandTotal: grandTotalValue,
    pivotHeaders: headers,
    pivotMatrixPreview: finalMatrixRows.slice(0, 25),
    durationMs,
    message: `Generated ${uniqueRowKeys.length}×${uniqueColKeys.length} cross-tabulation pivot matrix in sheet "${destSheetName}" in ${durationMs}ms.`,
  };
}

/**
 * 3. TEMPORAL TREND ANALYZER (MoM, YoY, Moving Windows & Aging Buckets)
 */
export async function executeTemporalTrendAnalyzer(
  args: {
    dateColumn: string;
    measureColumn: string;
    interval?: 'month' | 'quarter' | 'year' | 'aging_buckets';
    calculateGrowth?: boolean;
    rollingWindow?: number;
    sourceSheetName?: string;
    targetSheetName?: string;
    startRow?: number;
    endRow?: number;
  },
  ctx: ToolExecutionContext
) {
  const t0 = performance.now();
  const {
    dateColumn,
    measureColumn,
    interval = 'month',
    calculateGrowth = true,
    rollingWindow = 3,
    sourceSheetName,
    targetSheetName,
    startRow = 2,
    endRow,
  } = args;

  const wb = ctx.univerAPI?.getActiveWorkbook?.();
  if (!wb) throw new Error('Univer active workbook unavailable');

  const srcSheet = sourceSheetName ? wb.getSheetByName?.(sourceSheetName) : wb.getActiveSheet?.();
  if (!srcSheet) throw new Error(`Worksheet ${sourceSheetName || 'active'} not found`);

  const destSheetName = targetSheetName || `${srcSheet.getSheetName?.() || 'Sheet'}_Trends`;
  const destSheet = getOrCreateSheet(wb, destSheetName);
  if (!destSheet) throw new Error(`Failed to access or create worksheet "${destSheetName}"`);

  const lastSheetRow = Math.max((srcSheet.getLastRow?.() ?? 0) + 1, 1);
  const effectiveEndRow = endRow ? Math.min(endRow, lastSheetRow) : lastSheetRow;

  const dateCol = resolveSheetColumn(srcSheet, dateColumn, 0);
  const measureCol = resolveSheetColumn(srcSheet, measureColumn, 0);

  const rawDates =
    srcSheet
      .getRange(`${dateCol.colLetter}${startRow}:${dateCol.colLetter}${effectiveEndRow}`)
      ?.getValues?.()
      ?.map((r: any[]) => r[0]) || [];

  const rawMeasures =
    srcSheet
      .getRange(`${measureCol.colLetter}${startRow}:${measureCol.colLetter}${effectiveEndRow}`)
      ?.getValues?.()
      ?.map((r: any[]) => r[0]) || [];

  const periodMap = new Map<string, { sum: number; count: number }>();

  for (let i = 0; i < rawDates.length; i++) {
    const parsedDate = parseFlexibleDate(rawDates[i]);
    const num = parseNumericVal(rawMeasures[i]) ?? 0;
    let periodKey = 'Unknown';

    if (parsedDate) {
      const y = parsedDate.year;
      const m = String(parsedDate.month).padStart(2, '0');
      const q = Math.ceil(parsedDate.month / 3);

      if (interval === 'quarter') periodKey = `${y}-Q${q}`;
      else if (interval === 'year') periodKey = `${y}`;
      else periodKey = `${y}-${m}`;
    }

    const existing = periodMap.get(periodKey) || { sum: 0, count: 0 };
    existing.sum += num;
    existing.count++;
    periodMap.set(periodKey, existing);
  }

  // Sort chronological periods (putting Unknown at the end)
  const sortedPeriods = Array.from(periodMap.keys()).sort((a, b) => {
    if (a === 'Unknown') return 1;
    if (b === 'Unknown') return -1;
    return a.localeCompare(b);
  });
  const reportRows: any[][] = [];

  for (let pIdx = 0; pIdx < sortedPeriods.length; pIdx++) {
    const period = sortedPeriods[pIdx];
    const data = periodMap.get(period)!;
    const currentSum = Number(data.sum.toFixed(2));
    const avg = Number((data.sum / data.count).toFixed(2));

    let growthStr = '—';
    if (calculateGrowth && pIdx > 0 && period !== 'Unknown') {
      const prevPeriod = sortedPeriods[pIdx - 1];
      const prevSum = periodMap.get(prevPeriod)!.sum;
      if (Math.abs(prevSum) > 0) {
        const pct = ((currentSum - prevSum) / Math.abs(prevSum)) * 100;
        growthStr = `${pct >= 0 ? '+' : ''}${pct.toFixed(1)}%`;
      }
    }

    let rollingAvgVal: number | string = '—';
    if (rollingWindow && pIdx >= rollingWindow - 1 && period !== 'Unknown') {
      const windowSums: number[] = [];
      for (let w = 0; w < rollingWindow; w++) {
        windowSums.push(periodMap.get(sortedPeriods[pIdx - w])!.sum);
      }
      const rAvg = windowSums.reduce((a, b) => a + b, 0) / rollingWindow;
      rollingAvgVal = Number(rAvg.toFixed(2));
    }

    reportRows.push([period, currentSum, data.count, avg, growthStr, rollingAvgVal]);
  }

  const headers = [
    'Period',
    `Total ${measureCol.headerName}`,
    'Volume (Count)',
    `Avg ${measureCol.headerName}`,
    'Velocity (Growth %)',
    `${rollingWindow}-Period Moving Avg`,
  ];

  ensureSheetCapacity(destSheet, reportRows.length + 2, headers.length);

  destSheet.getRange(0, 0, 1, headers.length)?.setValues?.([headers]);
  if (reportRows.length > 0) {
    destSheet.getRange(1, 0, reportRows.length, headers.length)?.setValues?.(reportRows);
  }

  try {
    destSheet.getRange(0, 0, 1, headers.length)?.setFontWeight?.('bold');
    destSheet.getRange(0, 0, 1, headers.length)?.setBackgroundColor?.('#18181b');
    destSheet.getRange(0, 0, 1, headers.length)?.setFontColor?.('#ffffff');
  } catch {
    // ignore
  }

  wb.setActiveSheet(destSheet);
  const durationMs = Math.round(performance.now() - t0);

  return {
    status: 'SUCCESS',
    success: true,
    action: 'temporal_trend_analyzer',
    targetSheet: destSheetName,
    outputSheet: destSheetName,
    interval,
    periodsCount: sortedPeriods.length,
    allPeriodsPreview: reportRows.slice(0, 36),
    samplesPreview: reportRows.slice(0, 12),
    durationMs,
    message: `Generated ${sortedPeriods.length}-period temporal trend analysis in worksheet "${destSheetName}" in ${durationMs}ms.`,
  };
}

/**
 * 4. PARETO AND SEGMENTATION (80/20 Analysis & Customer Tiering)
 */
export async function executeParetoAndSegmentation(
  args: {
    entityColumn: string;
    valueColumn: string;
    analysisType?: 'pareto_80_20' | 'customer_tiering';
    tierThresholds?: Array<{ name: string; minVal: number }>;
    sourceSheetName?: string;
    targetSheetName?: string;
    startRow?: number;
    endRow?: number;
  },
  ctx: ToolExecutionContext
) {
  const t0 = performance.now();
  const {
    entityColumn,
    valueColumn,
    analysisType = 'pareto_80_20',
    tierThresholds,
    sourceSheetName,
    targetSheetName,
    startRow = 2,
    endRow,
  } = args;

  const wb = ctx.univerAPI?.getActiveWorkbook?.();
  if (!wb) throw new Error('Univer active workbook unavailable');

  const srcSheet = sourceSheetName ? wb.getSheetByName?.(sourceSheetName) : wb.getActiveSheet?.();
  if (!srcSheet) throw new Error(`Worksheet ${sourceSheetName || 'active'} not found`);

  const destSheetName = targetSheetName || `${srcSheet.getSheetName?.() || 'Sheet'}_Pareto`;
  const destSheet = getOrCreateSheet(wb, destSheetName);
  if (!destSheet) throw new Error(`Failed to access or create worksheet "${destSheetName}"`);

  const lastSheetRow = Math.max((srcSheet.getLastRow?.() ?? 0) + 1, 1);
  const effectiveEndRow = endRow ? Math.min(endRow, lastSheetRow) : lastSheetRow;

  const entityCol = resolveSheetColumn(srcSheet, entityColumn, 0);
  const valCol = resolveSheetColumn(srcSheet, valueColumn, 0);

  const rawEntities =
    srcSheet
      .getRange(`${entityCol.colLetter}${startRow}:${entityCol.colLetter}${effectiveEndRow}`)
      ?.getValues?.()
      ?.map((r: any[]) => r[0]) || [];

  const rawValues =
    srcSheet
      .getRange(`${valCol.colLetter}${startRow}:${valCol.colLetter}${effectiveEndRow}`)
      ?.getValues?.()
      ?.map((r: any[]) => r[0]) || [];

  const subtotalRows = new Set(
    detectEmbeddedSubtotalRows(rawEntities.map((v: any) => [v]), false).map((r1) => r1 - 1)
  );
  const entityClusters = clusterCategoryValues(rawEntities.filter((_: any, i: number) => !subtotalRows.has(i)));

  // Aggregate by entity
  const entitySums = new Map<string, number>();
  let totalGrandSum = 0;

  for (let i = 0; i < rawEntities.length; i++) {
    if (subtotalRows.has(i)) continue;
    const rawE =
      rawEntities[i] !== undefined && rawEntities[i] !== null && String(rawEntities[i]).trim() !== ''
        ? String(rawEntities[i]).trim()
        : '(Blank)';
    const e = entityClusters.mapping[rawE] || rawE;
    const num = parseNumericVal(rawValues[i]) ?? 0;
    entitySums.set(e, (entitySums.get(e) || 0) + num);
    totalGrandSum += num;
  }

  // Sort descending by value
  const sortedEntities = Array.from(entitySums.entries()).sort((a, b) => b[1] - a[1]);

  let runningCumulative = 0;
  const resultRows: any[][] = [];

  const defaultTiers = tierThresholds || [
    { name: 'Platinum', minVal: totalGrandSum * 0.05 },
    { name: 'Gold', minVal: totalGrandSum * 0.02 },
    { name: 'Silver', minVal: totalGrandSum * 0.005 },
    { name: 'Bronze', minVal: 0 },
  ];

  let classACount = 0;
  for (let r = 0; r < sortedEntities.length; r++) {
    const [name, val] = sortedEntities[r];
    const prevCumPct = totalGrandSum > 0 ? (runningCumulative / totalGrandSum) * 100 : 0;
    runningCumulative += val;
    const pctOfTotal = totalGrandSum > 0 ? (val / totalGrandSum) * 100 : 0;
    const cumPct = totalGrandSum > 0 ? (runningCumulative / totalGrandSum) * 100 : 0;

    let classification = '';
    if (analysisType === 'pareto_80_20') {
      // Include the entity that crosses the 80% threshold in Class A
      if (cumPct <= 80 || prevCumPct < 80) {
        classification = 'Class A (Top 80%)';
        classACount++;
      } else if (cumPct <= 95 || prevCumPct < 95) {
        classification = 'Class B (Next 15%)';
      } else {
        classification = 'Class C (Bottom 5%)';
      }
    } else {
      for (const t of defaultTiers) {
        if (val >= t.minVal) {
          classification = t.name;
          break;
        }
      }
    }

    resultRows.push([
      r + 1,
      name,
      Number(val.toFixed(2)),
      `${pctOfTotal.toFixed(2)}%`,
      `${cumPct.toFixed(2)}%`,
      classification,
    ]);
  }

  const headers = [
    'Rank',
    entityCol.headerName,
    `Total ${valCol.headerName}`,
    '% of Total',
    'Cumulative %',
    analysisType === 'pareto_80_20' ? 'Pareto Tier' : 'Customer Tier',
  ];

  ensureSheetCapacity(destSheet, resultRows.length + 2, headers.length);

  destSheet.getRange(0, 0, 1, headers.length)?.setValues?.([headers]);
  if (resultRows.length > 0) {
    destSheet.getRange(1, 0, resultRows.length, headers.length)?.setValues?.(resultRows);
  }

  try {
    destSheet.getRange(0, 0, 1, headers.length)?.setFontWeight?.('bold');
    destSheet.getRange(0, 0, 1, headers.length)?.setBackgroundColor?.('#18181b');
    destSheet.getRange(0, 0, 1, headers.length)?.setFontColor?.('#ffffff');
  } catch {
    // ignore
  }

  wb.setActiveSheet(destSheet);
  const durationMs = Math.round(performance.now() - t0);

  return {
    status: 'SUCCESS',
    success: true,
    action: 'pareto_and_segmentation',
    targetSheet: destSheetName,
    outputSheet: destSheetName,
    totalEntitiesRanked: sortedEntities.length,
    vitalFewClassACount: classACount,
    vitalFewShareOfEntitiesPct:
      sortedEntities.length > 0 ? Number(((classACount / sortedEntities.length) * 100).toFixed(1)) : 0,
    grandTotalValue: Number(totalGrandSum.toFixed(2)),
    topEntitiesPreview: resultRows.slice(0, 15),
    samplesPreview: resultRows.slice(0, 10),
    durationMs,
    message: `Completed 80/20 Pareto and segmentation analysis for ${sortedEntities.length} entities (${classACount} Class A drivers) in sheet "${destSheetName}" in ${durationMs}ms.`,
  };
}

/**
 * 5. STATISTICAL DEEP DIVE (IQR Outliers, Percentiles & Row-Aligned Pearson Correlation)
 */
export async function executeStatisticalDeepDive(
  args: {
    columns: string[];
    calculateCorrelation?: boolean;
    includeCorrelationMatrix?: boolean;
    outlierThresholdIqr?: number;
    sourceSheetName?: string;
    targetSheetName?: string;
    startRow?: number;
    endRow?: number;
  },
  ctx: ToolExecutionContext
) {
  const t0 = performance.now();
  const {
    columns,
    calculateCorrelation,
    includeCorrelationMatrix,
    outlierThresholdIqr = 1.5,
    sourceSheetName,
    targetSheetName,
    startRow = 2,
    endRow,
  } = args;

  const shouldCorrelate =
    includeCorrelationMatrix !== undefined
      ? includeCorrelationMatrix
      : calculateCorrelation !== undefined
      ? calculateCorrelation
      : true;

  const wb = ctx.univerAPI?.getActiveWorkbook?.();
  if (!wb) throw new Error('Univer active workbook unavailable');

  const srcSheet = sourceSheetName ? wb.getSheetByName?.(sourceSheetName) : wb.getActiveSheet?.();
  if (!srcSheet) throw new Error(`Worksheet ${sourceSheetName || 'active'} not found`);

  const destSheetName = targetSheetName || `${srcSheet.getSheetName?.() || 'Sheet'}_Stats`;
  const destSheet = getOrCreateSheet(wb, destSheetName);
  if (!destSheet) throw new Error(`Failed to access or create worksheet "${destSheetName}"`);

  const lastSheetRow = Math.max((srcSheet.getLastRow?.() ?? 0) + 1, 1);
  const effectiveEndRow = endRow ? Math.min(endRow, lastSheetRow) : lastSheetRow;

  const resolvedCols = columns.map((colRef) => resolveSheetColumn(srcSheet, colRef, 0));

  const statsRows: any[][] = [];
  const statisticalSummary: Record<string, any> = {};
  // Store ROW-ALIGNED raw parsed numbers (including null for missing cells) so Pearson correlation preserves row pairing!
  const rawAlignedColumnMap = new Map<string, Array<number | null>>();

  const interpPercentile = (sorted: number[], p: number): number => {
    if (sorted.length === 0) return 0;
    const pos = (sorted.length - 1) * p;
    const base = Math.floor(pos);
    const rest = pos - base;
    if (sorted[base + 1] !== undefined) {
      return sorted[base] + rest * (sorted[base + 1] - sorted[base]);
    }
    return sorted[base];
  };

  for (const col of resolvedCols) {
    const rawVals =
      srcSheet
        .getRange(`${col.colLetter}${startRow}:${col.colLetter}${effectiveEndRow}`)
        ?.getValues?.()
        ?.map((r: any[]) => r[0]) || [];

    const alignedParsed: Array<number | null> = rawVals.map(parseNumericVal);
    rawAlignedColumnMap.set(col.headerName, alignedParsed);

    const numVals: number[] = alignedParsed.filter((n: number | null): n is number => n !== null);
    const sortedVals = [...numVals].sort((a, b) => a - b);

    if (sortedVals.length === 0) continue;

    const count = sortedVals.length;
    const min = sortedVals[0];
    const max = sortedVals[sortedVals.length - 1];
    const sum = sortedVals.reduce((a, b) => a + b, 0);
    const mean = sum / count;

    const q1 = interpPercentile(sortedVals, 0.25);
    const median = interpPercentile(sortedVals, 0.5);
    const q3 = interpPercentile(sortedVals, 0.75);
    const iqr = q3 - q1;

    const variance =
      count > 1
        ? sortedVals.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / (count - 1)
        : 0;
    const stdDev = Math.sqrt(variance);

    const lowerBound = q1 - outlierThresholdIqr * iqr;
    const upperBound = q3 + outlierThresholdIqr * iqr;
    const outliers = sortedVals.filter((v) => v < lowerBound || v > upperBound);

    const rowSummary = {
      metric: col.headerName,
      count,
      mean: Number(mean.toFixed(2)),
      median: Number(median.toFixed(2)),
      stdDev: Number(stdDev.toFixed(2)),
      min: Number(min.toFixed(2)),
      q1: Number(q1.toFixed(2)),
      q3: Number(q3.toFixed(2)),
      max: Number(max.toFixed(2)),
      iqr: Number(iqr.toFixed(2)),
      outlierCount: outliers.length,
      outliersSample: outliers.slice(0, 5),
    };
    statisticalSummary[col.headerName] = rowSummary;

    statsRows.push([
      col.headerName,
      count,
      rowSummary.mean,
      rowSummary.median,
      rowSummary.stdDev,
      rowSummary.min,
      rowSummary.q1,
      rowSummary.q3,
      rowSummary.max,
      rowSummary.iqr,
      outliers.length,
    ]);
  }

  // Write Table 1: Descriptive Stats
  const statHeaders = [
    'Metric',
    'Count',
    'Mean',
    'Median',
    'StdDev',
    'Min',
    'P25 (Q1)',
    'P75 (Q3)',
    'Max',
    'IQR',
    'Outlier Count',
  ];
  ensureSheetCapacity(destSheet, statsRows.length + resolvedCols.length + 8, Math.max(statHeaders.length, resolvedCols.length + 2));

  destSheet.getRange(0, 0, 1, statHeaders.length)?.setValues?.([statHeaders]);
  if (statsRows.length > 0) {
    destSheet.getRange(1, 0, statsRows.length, statHeaders.length)?.setValues?.(statsRows);
  }

  try {
    destSheet.getRange(0, 0, 1, statHeaders.length)?.setFontWeight?.('bold');
    destSheet.getRange(0, 0, 1, statHeaders.length)?.setBackgroundColor?.('#18181b');
    destSheet.getRange(0, 0, 1, statHeaders.length)?.setFontColor?.('#ffffff');
  } catch {
    // ignore
  }

  // Table 2: Bivariate Row-Aligned Pearson Correlation Matrix
  const correlationMatrix: Record<string, Record<string, number>> = {};

  if (shouldCorrelate && resolvedCols.length > 1) {
    const corrStartRow = statsRows.length + 3;
    const colNames = resolvedCols.map((c) => c.headerName);
    const corrHeaders = ['Correlation (r)', ...colNames];

    const corrRows: any[][] = [];
    for (let i = 0; i < colNames.length; i++) {
      const rowName = colNames[i];
      correlationMatrix[rowName] = {};
      const rowArr: any[] = [rowName];
      const alignedX = rawAlignedColumnMap.get(rowName) || [];

      for (let j = 0; j < colNames.length; j++) {
        const colTargetName = colNames[j];
        if (i === j) {
          rowArr.push(1.0);
          correlationMatrix[rowName][colTargetName] = 1.0;
          continue;
        }

        const alignedY = rawAlignedColumnMap.get(colTargetName) || [];
        const len = Math.min(alignedX.length, alignedY.length);

        const pairs: Array<[number, number]> = [];
        for (let k = 0; k < len; k++) {
          const vx = alignedX[k];
          const vy = alignedY[k];
          if (vx !== null && vx !== undefined && vy !== null && vy !== undefined) {
            pairs.push([vx, vy]);
          }
        }

        if (pairs.length <= 1) {
          rowArr.push(0);
          correlationMatrix[rowName][colTargetName] = 0;
          continue;
        }

        const meanX = pairs.reduce((a, p) => a + p[0], 0) / pairs.length;
        const meanY = pairs.reduce((a, p) => a + p[1], 0) / pairs.length;

        let num = 0;
        let denX = 0;
        let denY = 0;

        for (const [vx, vy] of pairs) {
          const diffX = vx - meanX;
          const diffY = vy - meanY;
          num += diffX * diffY;
          denX += diffX * diffX;
          denY += diffY * diffY;
        }

        const den = Math.sqrt(denX * denY);
        const r = den !== 0 ? Number((num / den).toFixed(3)) : 0;
        rowArr.push(r);
        correlationMatrix[rowName][colTargetName] = r;
      }
      corrRows.push(rowArr);
    }

    destSheet.getRange(corrStartRow, 0, 1, corrHeaders.length)?.setValues?.([corrHeaders]);
    destSheet.getRange(corrStartRow + 1, 0, corrRows.length, corrHeaders.length)?.setValues?.(corrRows);

    try {
      destSheet.getRange(corrStartRow, 0, 1, corrHeaders.length)?.setFontWeight?.('bold');
      destSheet.getRange(corrStartRow, 0, 1, corrHeaders.length)?.setBackgroundColor?.('#27272a');
      destSheet.getRange(corrStartRow, 0, 1, corrHeaders.length)?.setFontColor?.('#ffffff');
    } catch {
      // ignore
    }
  }

  wb.setActiveSheet(destSheet);
  const durationMs = Math.round(performance.now() - t0);

  return {
    status: 'SUCCESS',
    success: true,
    action: 'statistical_deep_dive',
    targetSheet: destSheetName,
    outputSheet: destSheetName,
    columnsAnalyzed: resolvedCols.map((c) => c.headerName),
    outliersIdentified: statsRows.reduce((a, b) => a + b[10], 0),
    statisticalSummary,
    correlationMatrix,
    durationMs,
    message: `Completed deep statistical distribution and row-aligned Pearson correlation analysis in sheet "${destSheetName}" in ${durationMs}ms.`,
  };
}

/**
 * 6. WHAT-IF SCENARIO MODELER (Driver-Aware Sensitivity & Multi-Scenario Forecasting)
 */
export async function executeWhatIfScenarioModeler(
  args: {
    scenarios: Array<{
      name?: string;
      scenarioName?: string;
      assumptions: Array<{
        column: string;
        percentChange?: number;
        changePercent?: number;
        changePct?: number;
      }>;
    }>;
    baseMetricColumn?: string;
    targetMetricColumn?: string;
    sourceSheetName?: string;
    targetSheetName?: string;
    startRow?: number;
    endRow?: number;
  },
  ctx: ToolExecutionContext
) {
  const t0 = performance.now();
  const baseColRef = args.baseMetricColumn || args.targetMetricColumn;
  const {
    scenarios,
    sourceSheetName,
    targetSheetName,
    startRow = 2,
    endRow,
  } = args;

  if (!baseColRef) {
    throw new Error('baseMetricColumn or targetMetricColumn is required for what_if_scenario_modeler.');
  }

  const wb = ctx.univerAPI?.getActiveWorkbook?.();
  if (!wb) throw new Error('Univer active workbook unavailable');

  const srcSheet = sourceSheetName ? wb.getSheetByName?.(sourceSheetName) : wb.getActiveSheet?.();
  if (!srcSheet) throw new Error(`Worksheet ${sourceSheetName || 'active'} not found`);

  const destSheetName = targetSheetName || `${srcSheet.getSheetName?.() || 'Sheet'}_Scenarios`;
  const destSheet = getOrCreateSheet(wb, destSheetName);
  if (!destSheet) throw new Error(`Failed to access or create worksheet "${destSheetName}"`);

  const lastSheetRow = Math.max((srcSheet.getLastRow?.() ?? 0) + 1, 1);
  const effectiveEndRow = endRow ? Math.min(endRow, lastSheetRow) : lastSheetRow;

  const metricCol = resolveSheetColumn(srcSheet, baseColRef, 0);

  const rawValues =
    srcSheet
      .getRange(`${metricCol.colLetter}${startRow}:${metricCol.colLetter}${effectiveEndRow}`)
      ?.getValues?.()
      ?.map((r: any[]) => r[0]) || [];

  const baseTotal = rawValues
    .map(parseNumericVal)
    .filter((n: any): n is number => n !== null)
    .reduce((a: number, b: number) => a + b, 0);

  const isProfitTarget = /profit|margin|income|ebit|net|earnings/i.test(metricCol.headerName);
  const isCostDriver = (header: string) =>
    /cost|expense|spend|shipping|freight|tax|discount|fee|cogs|loss|overhead|wage/i.test(header);

  const scenarioRows: any[][] = [];
  const scenariosComparison: Array<{
    scenarioName: string;
    assumptions: string;
    projectedTotal: number;
    deltaAmount: number;
    deltaPct: number;
  }> = [];

  // Base Row
  scenarioRows.push([
    'Base Case (Current Actuals)',
    'No changes',
    Number(baseTotal.toFixed(2)),
    '$0.00',
    '0.0%',
  ]);

  for (const s of scenarios) {
    const sName = s.name || s.scenarioName || 'Scenario';
    const assumptionDescriptions: string[] = [];

    let totalAdditiveDelta = 0;
    let compoundMultiplier = 1.0;
    let usedAdditiveDrivers = false;

    for (const a of s.assumptions) {
      const pctChange = a.percentChange ?? a.changePercent ?? a.changePct ?? 0;
      const driverCol = resolveSheetColumn(srcSheet, a.column, 0);
      assumptionDescriptions.push(`${driverCol.headerName} ${pctChange >= 0 ? '+' : ''}${pctChange}%`);

      if (driverCol.colIndex === metricCol.colIndex) {
        compoundMultiplier *= 1.0 + pctChange / 100;
      } else {
        const driverRaw =
          srcSheet
            .getRange(`${driverCol.colLetter}${startRow}:${driverCol.colLetter}${effectiveEndRow}`)
            ?.getValues?.()
            ?.map((r: any[]) => r[0]) || [];
        const driverSum = driverRaw
          .map(parseNumericVal)
          .filter((n: any): n is number => n !== null)
          .reduce((acc: number, v: number) => acc + v, 0);

        if (driverSum !== 0) {
          usedAdditiveDrivers = true;
          const rawDriverDelta = driverSum * (pctChange / 100);
          // Cost polarity: if modeling Profit/Net Income and a Cost driver increases, it reduces Profit!
          const polarity = isProfitTarget && isCostDriver(driverCol.headerName) ? -1 : 1;
          totalAdditiveDelta += polarity * rawDriverDelta;
        } else {
          compoundMultiplier *= 1.0 + pctChange / 100;
        }
      }
    }

    const projectedTotal = usedAdditiveDrivers
      ? (baseTotal + totalAdditiveDelta) * compoundMultiplier
      : baseTotal * compoundMultiplier;
    const deltaDollar = projectedTotal - baseTotal;
    const deltaPct = baseTotal !== 0 ? ((projectedTotal - baseTotal) / Math.abs(baseTotal)) * 100 : 0;

    const projNum = Number(projectedTotal.toFixed(2));
    const deltaNum = Number(deltaDollar.toFixed(2));
    const deltaPctNum = Number(deltaPct.toFixed(1));

    scenariosComparison.push({
      scenarioName: sName,
      assumptions: assumptionDescriptions.join(', '),
      projectedTotal: projNum,
      deltaAmount: deltaNum,
      deltaPct: deltaPctNum,
    });

    scenarioRows.push([
      sName,
      assumptionDescriptions.join(', '),
      projNum,
      `${deltaDollar >= 0 ? '+$' : '-$'}${Math.abs(deltaDollar).toFixed(2)}`,
      `${deltaPct >= 0 ? '+' : ''}${deltaPct.toFixed(1)}%`,
    ]);
  }

  const headers = ['Scenario Name', 'Assumptions Applied', 'Projected Total', 'Net Delta ($)', 'Variance (%)'];
  ensureSheetCapacity(destSheet, scenarioRows.length + 2, headers.length);

  destSheet.getRange(0, 0, 1, headers.length)?.setValues?.([headers]);
  destSheet.getRange(1, 0, scenarioRows.length, headers.length)?.setValues?.(scenarioRows);

  try {
    destSheet.getRange(0, 0, 1, headers.length)?.setFontWeight?.('bold');
    destSheet.getRange(0, 0, 1, headers.length)?.setBackgroundColor?.('#18181b');
    destSheet.getRange(0, 0, 1, headers.length)?.setFontColor?.('#ffffff');
  } catch {
    // ignore
  }

  wb.setActiveSheet(destSheet);
  const durationMs = Math.round(performance.now() - t0);

  return {
    status: 'SUCCESS',
    success: true,
    action: 'what_if_scenario_modeler',
    targetSheet: destSheetName,
    outputSheet: destSheetName,
    baseTotal: Number(baseTotal.toFixed(2)),
    scenariosEvaluated: scenarios.length,
    scenariosComparison,
    samplesPreview: scenarioRows,
    durationMs,
    message: `Modeled ${scenarios.length} business scenarios vs Base Case in sheet "${destSheetName}" in ${durationMs}ms.`,
  };
}
