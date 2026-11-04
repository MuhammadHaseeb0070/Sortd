import type { ToolExecutionContext, ChartPayload, ChartType, ChartSeries } from '../../types';
import { colIndexToLetter, letterToColIndex } from '../../radar';
import { resolveColumnSmart } from '../../utils/univerBridge';
import {
  parseRobustNumber,
  clusterCategoryValues,
  detectEmbeddedSubtotalRows,
} from '../../utils/dataHygiene';

/**
 * Parses numeric value from a cell safely (handles currency, accounting parentheses, %, commas)
 */
function parseCleanNumber(val: any): number | null {
  return parseRobustNumber(val);
}

/**
 * Color Interpolator for 2-stop and 3-stop gradients
 */
function hexToRgb(hex: string): [number, number, number] {
  const clean = hex.replace('#', '');
  const bigint = parseInt(clean, 16);
  return [(bigint >> 16) & 255, (bigint >> 8) & 255, bigint & 255];
}

function rgbToHex(r: number, g: number, b: number): string {
  const clamp = (n: number) => Math.max(0, Math.min(255, Math.round(n)));
  return (
    '#' +
    [clamp(r), clamp(g), clamp(b)]
      .map((x) => x.toString(16).padStart(2, '0'))
      .join('')
  );
}

function interpolateRgb(
  c1: [number, number, number],
  c2: [number, number, number],
  t: number
): [number, number, number] {
  const clampedT = Math.max(0, Math.min(1, t));
  return [
    c1[0] + (c2[0] - c1[0]) * clampedT,
    c1[1] + (c2[1] - c1[1]) * clampedT,
    c1[2] + (c2[2] - c1[2]) * clampedT,
  ];
}

function getRelativeLuminance(r: number, g: number, b: number): number {
  const a = [r, g, b].map((v) => {
    v /= 255;
    return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  });
  return a[0] * 0.2126 + a[1] * 0.7152 + a[2] * 0.0722;
}

// Sparkline Unicode glyph sets
const SPARKLINE_GLYPHS = {
  bars: [' ', '▂', '▃', '▄', '▅', '▆', '▇', '█'],
  blocks: ['░', '▒', '▓', '█'],
  dots: ['·', '•', '●'],
};

// Executive Palettes for Visualizer
const COLOR_SCALE_PALETTES = {
  emerald_to_zinc: {
    min: '#f4f4f5', // zinc-100
    mid: '#a7f3d0', // emerald-200
    max: '#047857', // emerald-700
  },
  slate_neutral: {
    min: '#f8fafc', // slate-50
    mid: '#cbd5e1', // slate-300
    max: '#334155', // slate-700
  },
  red_amber_emerald: {
    min: '#ef4444', // red-500
    mid: '#f59e0b', // amber-500
    max: '#10b981', // emerald-500
  },
  blue_to_slate: {
    min: '#f0f9ff', // sky-50
    mid: '#60a5fa', // blue-400
    max: '#1d4ed8', // blue-700
  },
};

/**
 * Freedman-Diaconis / Sturges Optimal Histogram Binning
 */
function computeOptimalHistogramBins(values: number[]): {
  binLabels: string[];
  binCounts: number[];
  binSums: number[];
} {
  if (values.length === 0) {
    return { binLabels: [], binCounts: [], binSums: [] };
  }
  const sorted = [...values].sort((a, b) => a - b);
  const n = sorted.length;
  const min = sorted[0];
  const max = sorted[n - 1];

  if (min === max) {
    return {
      binLabels: [`${min}`],
      binCounts: [n],
      binSums: [min * n],
    };
  }

  const q1 = sorted[Math.floor(n * 0.25)];
  const q3 = sorted[Math.floor(n * 0.75)];
  const iqr = q3 - q1;

  let binCount = 8;
  if (iqr > 0) {
    const fdWidth = 2 * iqr * Math.pow(n, -1 / 3);
    if (fdWidth > 0) {
      binCount = Math.round((max - min) / fdWidth);
    }
  } else {
    binCount = Math.ceil(Math.log2(n) + 1);
  }
  binCount = Math.max(5, Math.min(12, binCount));

  const rawStep = (max - min) / binCount;
  const step = rawStep >= 10 ? Math.ceil(rawStep) : Number(rawStep.toFixed(2)) || 1;

  const binLabels: string[] = [];
  const binCounts = new Array(binCount).fill(0);
  const binSums = new Array(binCount).fill(0);

  for (let b = 0; b < binCount; b++) {
    const low = min + b * step;
    const high = b === binCount - 1 ? max : min + (b + 1) * step;
    const fmt = (v: number) => (Number.isInteger(step) ? Math.round(v).toLocaleString() : v.toFixed(1));
    binLabels.push(`${fmt(low)}–${fmt(high)}`);
  }

  for (const v of values) {
    let idx = Math.floor((v - min) / step);
    if (idx >= binCount) idx = binCount - 1;
    if (idx < 0) idx = 0;
    binCounts[idx]++;
    binSums[idx] += v;
  }

  return { binLabels, binCounts, binSums };
}

/**
 * 1. executeGenerateChart
 * Flagship interactive SVG Chart generation engine with Few/Munzner/IBCS Expert Guardrails.
 */
export async function executeGenerateChart(
  args: {
    range: string;
    chartType?: ChartType;
    xAxisColumn?: string;
    yAxisColumns?: string[];
    secondaryYAxisColumn?: string;
    aggregation?: 'sum' | 'average' | 'count' | 'none';
    title?: string;
    palette?: 'slate_emerald' | 'monochrome_zinc' | 'ocean_blue' | 'diverging_bipolar';
    showDataLabels?: boolean;
    showLegend?: boolean;
    sheetName?: string;
  },
  ctx: ToolExecutionContext
) {
  const t0 = performance.now();
  const wb = ctx.univerAPI?.getActiveWorkbook?.();
  if (!wb) throw new Error('Active workbook unavailable');

  const sheet = args.sheetName ? wb.getSheetByName?.(args.sheetName) : wb.getActiveSheet?.();
  if (!sheet) throw new Error(`Worksheet not found`);

  const activeSheetName = sheet.getSheetName?.() || sheet.getName?.() || 'Sheet1';
  const fRange = sheet.getRange(args.range);
  if (!fRange) throw new Error(`Could not resolve range: ${args.range}`);

  const rawValues: any[][] = fRange.getValues?.() || [];
  if (!rawValues || rawValues.length < 2) {
    throw new Error('Target range must have at least a header row and 1 data row.');
  }

  const startCol = typeof fRange.getColumn === 'function' ? fRange.getColumn() : 0;
  const headers = rawValues[0].map((h, i) =>
    h !== null && h !== undefined && String(h).trim() !== ''
      ? String(h).trim()
      : `Col_${colIndexToLetter(startCol + i)}`
  );

  // Exclude embedded Subtotal / Grand Total trap rows from raw data rows
  const trapRowSet = new Set(detectEmbeddedSubtotalRows(rawValues, true).map((r1) => r1 - 2));
  const dataRows = rawValues.slice(1).filter((_, rIdx) => !trapRowSet.has(rIdx));

  // Column type census
  const colCensus: Array<{
    index: number;
    header: string;
    isDate: boolean;
    numericRatio: number;
    uniqueCount: number;
  }> = [];

  for (let c = 0; c < headers.length; c++) {
    const colValues = dataRows.map((r) => r[c]);
    let numCount = 0;
    let dateCount = 0;
    const uniqueVals = new Set<string>();

    for (const v of colValues) {
      if (v === null || v === undefined || v === '') continue;
      uniqueVals.add(String(v).trim());
      const s = String(v).trim();
      if (!isNaN(Date.parse(s)) && (s.includes('/') || s.includes('-') || s.length === 10)) {
        dateCount++;
      }
      if (parseCleanNumber(v) !== null) {
        numCount++;
      }
    }

    const validLen = Math.max(colValues.filter((v) => v !== null && v !== undefined && v !== '').length, 1);
    colCensus.push({
      index: c,
      header: headers[c],
      isDate: dateCount / validLen > 0.6,
      numericRatio: numCount / validLen,
      uniqueCount: uniqueVals.size,
    });
  }

  const resolveLocalColIndex = (colRef: string): number => {
    const clean = colRef.trim();
    const byHeader = headers.findIndex((h) => h.toLowerCase() === clean.toLowerCase());
    if (byHeader >= 0) return byHeader;
    if (/^[A-Za-z]{1,3}$/.test(clean)) {
      const colLetterIdx = letterToColIndex(clean.toUpperCase()) - startCol;
      if (colLetterIdx >= 0 && colLetterIdx < headers.length) return colLetterIdx;
    }
    return -1;
  };

  // 1. Resolve X-Axis
  let xColIdx = 0;
  if (args.xAxisColumn) {
    const found = resolveLocalColIndex(args.xAxisColumn);
    if (found >= 0) xColIdx = found;
  } else {
    const firstCat = colCensus.find((c) => c.numericRatio < 0.6 || c.isDate);
    if (firstCat) xColIdx = firstCat.index;
  }

  // 2. Resolve Y-Axis
  let yColIndices: number[] = [];
  if (args.yAxisColumns && args.yAxisColumns.length > 0) {
    for (const yCol of args.yAxisColumns) {
      const found = resolveLocalColIndex(yCol);
      if (found >= 0) yColIndices.push(found);
    }
  }

  if (yColIndices.length === 0) {
    yColIndices = colCensus
      .filter((c) => c.index !== xColIdx && c.numericRatio >= 0.5)
      .map((c) => c.index);
    if (yColIndices.length === 0) {
      yColIndices = [headers.length > 1 ? (xColIdx === 0 ? 1 : 0) : 0];
    }
  }

  // 3. Resolve Secondary Y-Axis
  let secYColIdx: number | null = null;
  if (args.secondaryYAxisColumn) {
    const found = resolveLocalColIndex(args.secondaryYAxisColumn);
    if (found >= 0) secYColIdx = found;
  }

  const PALETTE_COLORS = {
    slate_emerald: ['#10b981', '#059669', '#34d399', '#047857', '#6ee7b7', '#065f46'],
    monochrome_zinc: ['#18181b', '#3f3f46', '#71717a', '#a1a1aa', '#d4d4d8', '#27272a'],
    ocean_blue: ['#2563eb', '#3b82f6', '#60a5fa', '#1d4ed8', '#93c5fd', '#1e40af'],
    diverging_bipolar: ['#10b981', '#ef4444', '#f59e0b', '#3b82f6', '#6366f1', '#14b8a6'],
  };
  const activeColors = PALETTE_COLORS[args.palette || 'slate_emerald'] || PALETTE_COLORS.slate_emerald;

  let effectiveChartType: ChartType =
    args.chartType && args.chartType !== 'auto' ? args.chartType : 'column';
  let recommendationReason = 'Explicit user selection';
  const advisories: string[] = [];

  const xCensus = colCensus[xColIdx];

  // Auto chart type selection if 'auto' or omitted
  if (!args.chartType || args.chartType === 'auto') {
    const distinctX = xCensus?.uniqueCount || dataRows.length;
    const metricCount = yColIndices.length;

    if (secYColIdx !== null) {
      effectiveChartType = 'combo_dual_axis';
      recommendationReason = 'Dual-axis detected with primary and secondary metric columns.';
    } else if (xCensus?.isDate) {
      effectiveChartType = metricCount > 1 ? 'line' : 'area';
      recommendationReason = 'Temporal dimension detected; continuous trend line prioritized.';
    } else if (xCensus?.numericRatio >= 0.8 && distinctX > 20 && metricCount >= 1) {
      effectiveChartType = 'bar';
      recommendationReason =
        'High-cardinality continuous X dimension detected; segmented brackets prioritized.';
    } else if (distinctX > 7 && distinctX <= 25) {
      effectiveChartType = 'bar';
      recommendationReason = `Moderate-high cardinality (${distinctX} categories); horizontal bar prevents label clipping.`;
    } else if (distinctX >= 2 && distinctX <= 5 && metricCount === 1) {
      effectiveChartType = 'donut';
      recommendationReason = `Compact category set (${distinctX} slices); part-to-whole donut representation.`;
    } else {
      effectiveChartType = 'column';
      recommendationReason = 'Discrete categorical comparison.';
    }
  }

  let categories: string[] = [];
  let series: ChartSeries[] = [];

  // CASE A: HISTOGRAM (Freedman-Diaconis distribution binning)
  if (effectiveChartType === 'histogram') {
    const targetColIdx = yColIndices[0] ?? xColIdx;
    const rawNums = dataRows
      .map((r) => parseCleanNumber(r[targetColIdx]))
      .filter((n): n is number => n !== null);
    const { binLabels, binCounts } = computeOptimalHistogramBins(rawNums);
    categories = binLabels;
    series = [
      {
        name: `${headers[targetColIdx]} Frequency`,
        data: binCounts,
        color: activeColors[0],
        type: 'bar',
      },
    ];
  }
  // CASE B: SCATTER OR BUBBLE (Continuous X vs Y [+ Z bubble size])
  else if (effectiveChartType === 'scatter' || effectiveChartType === 'bubble') {
    const yIdx = yColIndices[0] ?? (xColIdx === 0 ? 1 : 0);
    const zIdx = yColIndices[1] ?? secYColIdx;
    const rawPts: Array<{ x: number; y: number; r?: number; label?: string }> = [];

    for (let i = 0; i < dataRows.length; i++) {
      const xv = parseCleanNumber(dataRows[i][xColIdx]);
      const yv = parseCleanNumber(dataRows[i][yIdx]);
      if (xv === null || yv === null) continue;
      const zv = zIdx !== null && zIdx !== undefined ? parseCleanNumber(dataRows[i][zIdx]) : undefined;
      rawPts.push({
        x: xv,
        y: yv,
        r: zv !== null && zv !== undefined ? Math.max(4, Math.min(18, Math.sqrt(Math.abs(zv)))) : 5,
        label: String(dataRows[i][0] ?? `Row ${i + 2}`),
      });
    }

    // Downsample gracefully if > 250 points so SVG stays crisp
    const step = rawPts.length > 250 ? Math.ceil(rawPts.length / 250) : 1;
    const sampledPts = rawPts.filter((_, idx) => idx % step === 0);

    categories = sampledPts.map((p) => String(p.x));
    series = [
      {
        name: `${headers[xColIdx]} vs ${headers[yIdx]}`,
        data: sampledPts.map((p) => p.y),
        color: activeColors[0],
        scatterPoints: sampledPts,
      },
    ];
  }
  // CASE C: BOX PLOT (Statistical 5-Number Summary per Category or Metric)
  else if (effectiveChartType === 'box_plot') {
    const boxStats = yColIndices.map((colIdx) => {
      const nums = dataRows
        .map((r) => parseCleanNumber(r[colIdx]))
        .filter((n): n is number => n !== null)
        .sort((a, b) => a - b);
      const n = nums.length;
      const min = n ? nums[0] : 0;
      const q1 = n ? nums[Math.floor(n * 0.25)] : 0;
      const median = n ? nums[Math.floor(n * 0.5)] : 0;
      const q3 = n ? nums[Math.floor(n * 0.75)] : 0;
      const max = n ? nums[n - 1] : 0;
      return {
        category: headers[colIdx],
        min,
        q1,
        median,
        q3,
        max,
      };
    });
    categories = boxStats.map((b) => b.category);
    series = [
      {
        name: 'Distribution Summary',
        data: boxStats.map((b) => b.median),
        color: activeColors[0],
        boxPlotStats: boxStats,
      },
    ];
  }
  // CASE D: CONTINUOUS HIGH-CARDINALITY X-AXIS GUARDRAIL (e.g., 1,000 raw Order rows of Unit Price vs Quantity!)
  else if (
    xCensus &&
    xCensus.numericRatio >= 0.8 &&
    (dataRows.length > 25 || xCensus.uniqueCount > 15) &&
    (effectiveChartType === 'bar' ||
      effectiveChartType === 'column' ||
      effectiveChartType === 'donut' ||
      effectiveChartType === 'line' ||
      effectiveChartType === 'area')
  ) {
    const xNums = dataRows
      .map((r) => parseCleanNumber(r[xColIdx]))
      .filter((n): n is number => n !== null);
    const sortedX = [...xNums].sort((a, b) => a - b);
    const minX = sortedX[0] ?? 0;
    const maxX = sortedX[sortedX.length - 1] ?? 100;
    const binCount = 10;
    const step = (maxX - minX) / binCount || 1;

    const bucketLabels: string[] = [];
    for (let b = 0; b < binCount; b++) {
      const low = minX + b * step;
      const high = b === binCount - 1 ? maxX : minX + (b + 1) * step;
      bucketLabels.push(`${low.toFixed(0)}–${high.toFixed(0)}`);
    }

    categories = bucketLabels;
    series = yColIndices.map((colIdx, sIdx) => {
      const bucketSums = new Array(binCount).fill(0);
      for (const row of dataRows) {
        const xv = parseCleanNumber(row[xColIdx]);
        const yv = parseCleanNumber(row[colIdx]) ?? 0;
        if (xv === null) continue;
        let bIdx = Math.floor((xv - minX) / step);
        if (bIdx >= binCount) bIdx = binCount - 1;
        if (bIdx < 0) bIdx = 0;
        bucketSums[bIdx] += yv;
      }
      return {
        name: `${headers[colIdx]} (Segmented by ${headers[xColIdx]})`,
        data: bucketSums.map((v) => Number(v.toFixed(2))),
        color: activeColors[sIdx % activeColors.length],
        yAxisIndex: 0,
        type: 'bar',
      };
    });

    advisories.push(
      `Expert Visualization Guardrail: Plotting ${dataRows.length.toLocaleString()} raw rows with ${xCensus.uniqueCount} distinct numeric "${headers[xColIdx]}" values as individual bars would cause severe bar & label overlapping. Auto-segmented "${headers[xColIdx]}" into ${binCount} clean value brackets so you can clearly see where "${yColIndices.map((i) => headers[i]).join(', ')}" is concentrated.`
    );
  }
  // CASE E: CATEGORICAL / TEMPORAL AGGREGATION & TOP-10 + OTHER ROLLUP
  else {
    const rawCats = dataRows.map((r) =>
      r[xColIdx] !== null && r[xColIdx] !== undefined && String(r[xColIdx]).trim() !== ''
        ? String(r[xColIdx]).trim()
        : '(Blank)'
    );

    // Normalize dirty categories (e.g. "North" vs "N", "N.") unless it's a date column
    const catClusters = xCensus?.isDate ? null : clusterCategoryValues(rawCats);
    const canonicalCats = rawCats.map((c) => (catClusters ? catClusters.mapping[c] || c : c));

    if (catClusters?.hasCollisions) {
      advisories.push(
        `Normalized dirty category variants in "${headers[xColIdx]}": ${catClusters.collisionSummary.join('; ')}.`
      );
    }

    const distinctOrder: string[] = [];
    const groupRowMap = new Map<string, number[]>();
    for (let i = 0; i < canonicalCats.length; i++) {
      const key = canonicalCats[i];
      if (!groupRowMap.has(key)) {
        distinctOrder.push(key);
        groupRowMap.set(key, []);
      }
      groupRowMap.get(key)!.push(i);
    }

    const isNonAdditiveHeader = (h: string) =>
      /rate|margin|pct|percent|ratio|avg|average|price|score|yield/i.test(h);

    // Aggregate duplicate category rows automatically
    let groupedRows = distinctOrder.map((catKey) => {
      const rowIdxs = groupRowMap.get(catKey)!;
      const yVals = yColIndices.map((colIdx) => {
        const nums = rowIdxs
          .map((rIdx) => parseCleanNumber(dataRows[rIdx][colIdx]))
          .filter((n): n is number => n !== null);
        if (nums.length === 0) return 0;
        const aggMode =
          args.aggregation && args.aggregation !== 'none'
            ? args.aggregation
            : isNonAdditiveHeader(headers[colIdx])
            ? 'average'
            : 'sum';
        const sum = nums.reduce((a, b) => a + b, 0);
        return aggMode === 'average' ? Number((sum / nums.length).toFixed(2)) : Number(sum.toFixed(2));
      });
      const secVal =
        secYColIdx !== null
          ? (() => {
              const nums = rowIdxs
                .map((rIdx) => parseCleanNumber(dataRows[rIdx][secYColIdx!]))
                .filter((n): n is number => n !== null);
              if (nums.length === 0) return 0;
              const sum = nums.reduce((a, b) => a + b, 0);
              return isNonAdditiveHeader(headers[secYColIdx!])
                ? Number((sum / nums.length).toFixed(2))
                : Number(sum.toFixed(2));
            })()
          : undefined;
      return { category: catKey, yVals, secVal };
    });

    if (dataRows.length > distinctOrder.length) {
      advisories.push(
        `Aggregated ${dataRows.length} raw rows into ${distinctOrder.length} distinct "${headers[xColIdx]}" groups.`
      );
    }

    // Donut chart guardrail: never allow negative numbers or >6 slices in a donut chart!
    const hasNegatives = groupedRows.some((g) => g.yVals.some((v) => v < 0));
    if (effectiveChartType === 'donut' && (hasNegatives || groupedRows.length > 6)) {
      effectiveChartType = 'bar';
      advisories.push(
        hasNegatives
          ? `Expert Visualization Guardrail: Donut charts cannot represent negative values (${headers[yColIndices[0]]} contains negative numbers). Automatically switched to a horizontal bar chart.`
          : `Expert Visualization Guardrail: Donut charts with ${groupedRows.length} slices exceed human angle-comparison limits (max 6). Automatically switched to a sorted horizontal bar chart.`
      );
    }

    // High-cardinality categorical rollup (>12 categories -> Top 10 + Other) for bar/column/pareto/treemap
    if (
      !xCensus?.isDate &&
      groupedRows.length > 12 &&
      (effectiveChartType === 'bar' ||
        effectiveChartType === 'column' ||
        effectiveChartType === 'pareto' ||
        effectiveChartType === 'treemap')
    ) {
      const sorted = [...groupedRows].sort((a, b) => (b.yVals[0] ?? 0) - (a.yVals[0] ?? 0));
      const top10 = sorted.slice(0, 10);
      const tail = sorted.slice(10);
      const primaryIsNonAdditive = isNonAdditiveHeader(headers[yColIndices[0]]);

      if (!primaryIsNonAdditive && tail.length > 0) {
        const otherYVals = yColIndices.map((_, mIdx) =>
          Number(tail.reduce((acc, item) => acc + (item.yVals[mIdx] ?? 0), 0).toFixed(2))
        );
        const otherSecVal =
          secYColIdx !== null
            ? Number((tail.reduce((acc, item) => acc + (item.secVal ?? 0), 0) / tail.length).toFixed(2))
            : undefined;
        groupedRows = [
          ...top10,
          {
            category: `Other (${tail.length} items)`,
            yVals: otherYVals,
            secVal: otherSecVal,
          },
        ];
        advisories.push(
          `Expert Visualization Guardrail: Rolled up ${ distinctOrder.length } categories into the Top 10 drivers + "Other (${tail.length} items)" to prevent visual clutter.`
        );
      } else {
        groupedRows = top10;
        advisories.push(
          `Expert Visualization Guardrail: Displayed Top 10 of ${distinctOrder.length} categories for non-additive rate metric "${headers[yColIndices[0]]}".`
        );
      }
    } else if (effectiveChartType === 'pareto') {
      groupedRows.sort((a, b) => (b.yVals[0] ?? 0) - (a.yVals[0] ?? 0));
    }

    categories = groupedRows.map((g) => g.category);
    series = yColIndices.map((colIdx, sIdx) => ({
      name: headers[colIdx],
      data: groupedRows.map((g) => g.yVals[sIdx] ?? 0),
      color: activeColors[sIdx % activeColors.length],
      yAxisIndex: 0,
      type:
        effectiveChartType === 'combo_dual_axis' && sIdx > 0
          ? 'line'
          : effectiveChartType === 'line'
          ? 'line'
          : effectiveChartType === 'area'
          ? 'area'
          : 'bar',
    }));

    if (secYColIdx !== null) {
      series.push({
        name: headers[secYColIdx],
        data: groupedRows.map((g) => g.secVal ?? 0),
        color: '#f59e0b',
        yAxisIndex: 1,
        type: 'line',
      });
    }

    // If Pareto chart and only 1 series exists, automatically compute and attach the Cumulative % line on secondary axis!
    if (effectiveChartType === 'pareto' && series.length === 1) {
      const primaryData = series[0].data;
      const total = primaryData.reduce((a, b) => a + Math.max(0, b), 0) || 1;
      let running = 0;
      const cumPctData = primaryData.map((v) => {
        running += Math.max(0, v);
        return Number(((running / total) * 100).toFixed(1));
      });
      series.push({
        name: 'Cumulative %',
        data: cumPctData,
        color: '#f59e0b',
        yAxisIndex: 1,
        type: 'line',
      });
    }

    // If Waterfall chart, precompute start/end bridge coordinates
    if (effectiveChartType === 'waterfall' && series.length > 0) {
      let running = 0;
      series[0].waterfallItems = categories.map((cat, idx) => {
        const val = series[0].data[idx] ?? 0;
        const isTotal = /total|net|ebit|balance|ending/i.test(cat) && idx === categories.length - 1;
        if (isTotal) {
          return { label: cat, value: running, start: 0, end: running, isTotal: true };
        }
        const start = running;
        const end = running + val;
        running = end;
        return { label: cat, value: val, start, end, isTotal: false };
      });
    }
  }

  // Compute Quick Stats Summary
  const primaryNums = series[0]?.data || [];
  const totalSum = primaryNums.reduce((a, b) => a + b, 0);
  const minVal = primaryNums.length ? Math.min(...primaryNums) : 0;
  const maxVal = primaryNums.length ? Math.max(...primaryNums) : 0;
  const avgVal = primaryNums.length ? totalSum / primaryNums.length : 0;

  const expertAdvisory = advisories.length > 0 ? advisories.join(' ') : undefined;

  const chartPayload: ChartPayload = {
    id: `chart_${Date.now()}`,
    title: args.title || `${headers[xColIdx]} vs ${yColIndices.map((i) => headers[i]).join(', ')}`,
    chartType: effectiveChartType,
    categories,
    series,
    xAxisLabel: headers[xColIdx],
    yAxisLabel: yColIndices.map((i) => headers[i]).join(' / '),
    secondaryYAxisLabel:
      secYColIdx !== null
        ? headers[secYColIdx]
        : effectiveChartType === 'pareto'
        ? 'Cumulative %'
        : undefined,
    range: args.range,
    sheetName: activeSheetName,
    statsSummary: `Groups: ${categories.length} | Series: ${series.length} | Range: [${minVal.toLocaleString()}, ${maxVal.toLocaleString()}] | Avg: ${avgVal.toFixed(1)}`,
    expertAdvisory,
    timestamp: Date.now(),
  };

  if (ctx.onChartGenerated) {
    ctx.onChartGenerated(chartPayload);
  }

  const durationMs = Math.round(performance.now() - t0);

  return {
    status: 'SUCCESS',
    chartPayload,
    recommendationReason,
    expertAdvisory,
    durationMs,
    message: `Generated ${effectiveChartType.toUpperCase()} chart: "${chartPayload.title}" across ${categories.length} groups.${
      expertAdvisory ? ` (${expertAdvisory})` : ''
    }`,
  };
}

/**
 * 2. executeApplyColorScale
 * Applies continuous or quantile color scales with WCAG font luminance contrast flipping.
 */
export async function executeApplyColorScale(
  args: {
    range: string;
    scaleType?: '2_color' | '3_color' | 'quantile_percentile' | 'diverging_zero_centered';
    palette?: 'emerald_to_zinc' | 'slate_neutral' | 'red_amber_emerald' | 'blue_to_slate';
    clampOutliers?: boolean;
    sheetName?: string;
  },
  ctx: ToolExecutionContext
) {
  const t0 = performance.now();
  const wb = ctx.univerAPI?.getActiveWorkbook?.();
  if (!wb) throw new Error('Active workbook unavailable');

  const sheet = args.sheetName ? wb.getSheetByName?.(args.sheetName) : wb.getActiveSheet?.();
  if (!sheet) throw new Error(`Worksheet not found`);

  const fRange = sheet.getRange(args.range);
  if (!fRange) throw new Error(`Could not resolve range: ${args.range}`);

  const startRow = typeof fRange.getRow === 'function' ? fRange.getRow() : 0;
  const startCol = typeof fRange.getColumn === 'function' ? fRange.getColumn() : 0;
  const rawValues: any[][] = fRange.getValues?.() || [];
  const numRows = rawValues.length;
  const numCols = rawValues[0]?.length || 0;

  const numericEntries: Array<{ r: number; c: number; val: number }> = [];
  for (let r = 0; r < numRows; r++) {
    for (let c = 0; c < numCols; c++) {
      const v = rawValues[r]?.[c];
      const parsed = parseCleanNumber(v);
      if (parsed !== null) {
        numericEntries.push({ r: startRow + r, c: startCol + c, val: parsed });
      }
    }
  }

  if (numericEntries.length === 0) {
    return {
      status: 'SUCCESS',
      modifiedCellCount: 0,
      message: 'No numeric values found in the target range to apply color scales.',
    };
  }

  const sortedVals = numericEntries.map((e) => e.val).sort((a, b) => a - b);
  let minVal = sortedVals[0];
  let maxVal = sortedVals[sortedVals.length - 1];

  if (args.clampOutliers !== false && sortedVals.length >= 10) {
    const p05Idx = Math.floor(sortedVals.length * 0.05);
    const p95Idx = Math.floor(sortedVals.length * 0.95);
    minVal = sortedVals[p05Idx];
    maxVal = sortedVals[p95Idx];
  }

  const p50Val = sortedVals[Math.floor(sortedVals.length * 0.5)];
  const scaleType = args.scaleType || '3_color';
  const pal =
    COLOR_SCALE_PALETTES[args.palette || 'emerald_to_zinc'] || COLOR_SCALE_PALETTES.emerald_to_zinc;

  const minRgb = hexToRgb(pal.min);
  const midRgb = hexToRgb(pal.mid);
  const maxRgb = hexToRgb(pal.max);

  let modifiedCount = 0;
  for (const entry of numericEntries) {
    const clampedVal = Math.max(minVal, Math.min(maxVal, entry.val));
    let cellRgb: [number, number, number];

    if (scaleType === 'diverging_zero_centered') {
      const absMax = Math.max(Math.abs(minVal), Math.abs(maxVal), 0.0001);
      if (entry.val < 0) {
        const factor = Math.min(1, Math.abs(entry.val) / absMax);
        cellRgb = interpolateRgb(midRgb, minRgb, factor);
      } else {
        const factor = Math.min(1, entry.val / absMax);
        cellRgb = interpolateRgb(midRgb, maxRgb, factor);
      }
    } else if (scaleType === '2_color' || minVal === maxVal) {
      const factor = maxVal === minVal ? 0.5 : (clampedVal - minVal) / (maxVal - minVal);
      cellRgb = interpolateRgb(minRgb, maxRgb, factor);
    } else {
      const midVal = scaleType === 'quantile_percentile' ? p50Val : (minVal + maxVal) / 2;
      if (clampedVal <= midVal) {
        const factor = midVal === minVal ? 0 : (clampedVal - minVal) / (midVal - minVal);
        cellRgb = interpolateRgb(minRgb, midRgb, factor);
      } else {
        const factor = maxVal === midVal ? 1 : (clampedVal - midVal) / (maxVal - midVal);
        cellRgb = interpolateRgb(midRgb, maxRgb, factor);
      }
    }

    const hexBg = rgbToHex(cellRgb[0], cellRgb[1], cellRgb[2]);
    const luminance = getRelativeLuminance(cellRgb[0], cellRgb[1], cellRgb[2]);
    const fontColor = luminance < 0.45 ? '#ffffff' : '#18181b';

    const cellRange = sheet.getRange(entry.r, entry.c);
    cellRange.setBackgroundColor?.(hexBg);
    cellRange.setFontColor?.(fontColor);
    modifiedCount++;
  }

  const durationMs = Math.round(performance.now() - t0);
  return {
    status: 'SUCCESS',
    range: args.range,
    modifiedCellCount: modifiedCount,
    scaleType,
    minVal,
    maxVal,
    durationMs,
    message: `Applied ${scaleType} heatmap on ${modifiedCount} cells with WCAG font contrast balancing.`,
  };
}

/**
 * 3. executeAddDataBars
 * Applies proportional in-cell data bars with zero-axis support.
 */
export async function executeAddDataBars(
  args: {
    range: string;
    barColor?: string;
    negativeBarColor?: string;
    axisPosition?: 'automatic' | 'cell_midpoint' | 'none';
    sheetName?: string;
  },
  ctx: ToolExecutionContext
) {
  const t0 = performance.now();
  const wb = ctx.univerAPI?.getActiveWorkbook?.();
  if (!wb) throw new Error('Active workbook unavailable');

  const sheet = args.sheetName ? wb.getSheetByName?.(args.sheetName) : wb.getActiveSheet?.();
  if (!sheet) throw new Error(`Worksheet not found`);

  const fRange = sheet.getRange(args.range);
  if (!fRange) throw new Error(`Could not resolve range: ${args.range}`);

  const startRow = typeof fRange.getRow === 'function' ? fRange.getRow() : 0;
  const startCol = typeof fRange.getColumn === 'function' ? fRange.getColumn() : 0;
  const rawValues: any[][] = fRange.getValues?.() || [];
  const numRows = rawValues.length;
  const numCols = rawValues[0]?.length || 0;

  const posColor = args.barColor || '#10b981';
  const negColor = args.negativeBarColor || '#ef4444';

  let modifiedCount = 0;
  for (let c = 0; c < numCols; c++) {
    const colNums: Array<{ r: number; val: number }> = [];
    for (let r = 0; r < numRows; r++) {
      const v = parseCleanNumber(rawValues[r]?.[c]);
      if (v !== null) colNums.push({ r: startRow + r, val: v });
    }

    if (colNums.length === 0) continue;
    const maxAbs = Math.max(...colNums.map((n) => Math.abs(n.val)), 0.001);

    for (const item of colNums) {
      const cellRange = sheet.getRange(item.r, startCol + c);
      const ratio = Math.min(1, Math.abs(item.val) / maxAbs);
      const barRgb = item.val >= 0 ? hexToRgb(posColor) : hexToRgb(negColor);
      const neutralRgb = hexToRgb('#ffffff');
      const blendedRgb = interpolateRgb(neutralRgb, barRgb, ratio * 0.45);
      const bgHex = rgbToHex(blendedRgb[0], blendedRgb[1], blendedRgb[2]);

      cellRange.setBackgroundColor?.(bgHex);
      cellRange.setFontWeight?.(ratio > 0.7 ? 'bold' : 'normal');
      modifiedCount++;
    }
  }

  const durationMs = Math.round(performance.now() - t0);
  return {
    status: 'SUCCESS',
    range: args.range,
    modifiedCellCount: modifiedCount,
    durationMs,
    message: `Applied proportional data bar fills across ${modifiedCount} cells.`,
  };
}

/**
 * 4. executeCreateThresholdRule
 * Evaluates conditions and applies executive soft badges WITHOUT corrupting numbers into strings!
 */
export async function executeCreateThresholdRule(
  args: {
    range: string;
    condition:
      | 'greater_than'
      | 'less_than'
      | 'between'
      | 'equal_to'
      | 'contains_text'
      | 'top_n_percent'
      | 'below_average';
    thresholdValue: any;
    secondaryThresholdValue?: any;
    badgeStyle?:
      | 'soft_alert_red'
      | 'soft_warning_amber'
      | 'soft_success_emerald'
      | 'subtle_highlight_zinc'
      | 'subtle_accent_blue';
    prependStatusSymbol?: boolean;
    sheetName?: string;
  },
  ctx: ToolExecutionContext
) {
  const t0 = performance.now();
  const wb = ctx.univerAPI?.getActiveWorkbook?.();
  if (!wb) throw new Error('Active workbook unavailable');

  const sheet = args.sheetName ? wb.getSheetByName?.(args.sheetName) : wb.getActiveSheet?.();
  if (!sheet) throw new Error(`Worksheet not found`);

  const fRange = sheet.getRange(args.range);
  if (!fRange) throw new Error(`Could not resolve range: ${args.range}`);

  const startRow = typeof fRange.getRow === 'function' ? fRange.getRow() : 0;
  const startCol = typeof fRange.getColumn === 'function' ? fRange.getColumn() : 0;
  const rawValues: any[][] = fRange.getValues?.() || [];
  const numRows = rawValues.length;
  const numCols = rawValues[0]?.length || 0;

  const BADGE_STYLES = {
    soft_alert_red: { bg: '#fef2f2', font: '#b91c1c', symbol: '▲ ' },
    soft_warning_amber: { bg: '#fffbeb', font: '#b45309', symbol: '● ' },
    soft_success_emerald: { bg: '#ecfdf5', font: '#047857', symbol: '✓ ' },
    subtle_highlight_zinc: { bg: '#f4f4f5', font: '#18181b', symbol: '• ' },
    subtle_accent_blue: { bg: '#eff6ff', font: '#1d4ed8', symbol: '★ ' },
  };
  const activeStyle = BADGE_STYLES[args.badgeStyle || 'soft_alert_red'] || BADGE_STYLES.soft_alert_red;

  const targetThresh = parseCleanNumber(args.thresholdValue) ?? args.thresholdValue;
  const secThresh = parseCleanNumber(args.secondaryThresholdValue) ?? args.secondaryThresholdValue;

  const numericList: number[] = [];
  for (let r = 0; r < numRows; r++) {
    for (let c = 0; c < numCols; c++) {
      const n = parseCleanNumber(rawValues[r]?.[c]);
      if (n !== null) numericList.push(n);
    }
  }
  const colAvg = numericList.length ? numericList.reduce((a, b) => a + b, 0) / numericList.length : 0;
  const sortedDesc = [...numericList].sort((a, b) => b - a);

  let matchedCount = 0;
  for (let r = 0; r < numRows; r++) {
    for (let c = 0; c < numCols; c++) {
      const cellVal = rawValues[r]?.[c];
      const cellNum = parseCleanNumber(cellVal);
      let match = false;

      switch (args.condition) {
        case 'greater_than':
          match = cellNum !== null && typeof targetThresh === 'number' && cellNum > targetThresh;
          break;
        case 'less_than':
          match = cellNum !== null && typeof targetThresh === 'number' && cellNum < targetThresh;
          break;
        case 'between':
          match =
            cellNum !== null &&
            typeof targetThresh === 'number' &&
            typeof secThresh === 'number' &&
            cellNum >= Math.min(targetThresh, secThresh) &&
            cellNum <= Math.max(targetThresh, secThresh);
          break;
        case 'equal_to':
          match = String(cellVal).trim().toLowerCase() === String(targetThresh).trim().toLowerCase();
          break;
        case 'contains_text':
          match = String(cellVal ?? '').toLowerCase().includes(String(targetThresh).toLowerCase());
          break;
        case 'below_average':
          match = cellNum !== null && cellNum < colAvg;
          break;
        case 'top_n_percent':
          if (cellNum !== null && sortedDesc.length) {
            const cutoffIdx = Math.max(0, Math.floor((Number(targetThresh) / 100) * sortedDesc.length) - 1);
            match = cellNum >= sortedDesc[cutoffIdx];
          }
          break;
      }

      if (match) {
        const cellRange = sheet.getRange(startRow + r, startCol + c);
        cellRange.setBackgroundColor?.(activeStyle.bg);
        cellRange.setFontColor?.(activeStyle.font);
        cellRange.setFontWeight?.('bold');
        // Never overwrite numeric values with strings—use number format mask if prependStatusSymbol is requested
        if (args.prependStatusSymbol && cellNum !== null) {
          cellRange.setNumberFormat?.(`"${activeStyle.symbol}"#,##0.##`);
        }
        matchedCount++;
      }
    }
  }

  const durationMs = Math.round(performance.now() - t0);
  return {
    status: 'SUCCESS',
    condition: args.condition,
    matchedCount,
    badgeStyle: args.badgeStyle || 'soft_alert_red',
    durationMs,
    message: `Condition "${args.condition}" matched and highlighted ${matchedCount} cells with ${
      args.badgeStyle || 'soft_alert_red'
    }.`,
  };
}

/**
 * 5. executeRenderSparklineStrip
 * Computes normalized in-cell Unicode micro-sparklines across multi-period columns.
 * Properly detects whether row 0 of sourceRange is a header or data row so data is never overwritten!
 */
export async function executeRenderSparklineStrip(
  args: {
    sourceRange: string;
    targetColumn: string;
    sparklineType?: 'bars' | 'blocks' | 'dots';
    headerTitle?: string;
    sheetName?: string;
  },
  ctx: ToolExecutionContext
) {
  const t0 = performance.now();
  const wb = ctx.univerAPI?.getActiveWorkbook?.();
  if (!wb) throw new Error('Active workbook unavailable');

  const sheet = args.sheetName ? wb.getSheetByName?.(args.sheetName) : wb.getActiveSheet?.();
  if (!sheet) throw new Error(`Worksheet not found`);

  const fRange = sheet.getRange(args.sourceRange);
  if (!fRange) throw new Error(`Could not resolve source range: ${args.sourceRange}`);

  const startRow = typeof fRange.getRow === 'function' ? fRange.getRow() : 0;
  const rawValues: any[][] = fRange.getValues?.() || [];
  const numRows = rawValues.length;
  const numCols = rawValues[0]?.length || 0;

  const targetCol = resolveColumnSmart(sheet, args.targetColumn, 0);
  const targetColIdx = targetCol.colIndex;
  const glyphs = SPARKLINE_GLYPHS[args.sparklineType || 'bars'] || SPARKLINE_GLYPHS.bars;

  // Always write headerTitle to Row 1 (index 0)
  const headerCell = sheet.getRange(0, targetColIdx);
  headerCell.setValue?.(args.headerTitle || 'Trend');
  headerCell.setFontWeight?.('bold');

  // If startRow === 0 (sourceRange includes Row 1 header), start rendering sparklines at r = 1.
  // If startRow > 0 (e.g. sourceRange is "B2:D3"), start rendering at r = 0 so Row 2 is NOT skipped or overwritten!
  const firstDataRowOffset = startRow === 0 ? 1 : 0;

  let rowsRendered = 0;
  for (let r = firstDataRowOffset; r < numRows; r++) {
    const rowVals = rawValues[r] || [];
    const nums: number[] = [];
    for (let c = 0; c < numCols; c++) {
      const parsed = parseCleanNumber(rowVals[c]);
      if (parsed !== null) nums.push(parsed);
    }

    if (nums.length === 0) continue;

    const min = Math.min(...nums);
    const max = Math.max(...nums);
    const span = max - min;

    let sparkStr = '';
    for (const n of nums) {
      const norm = span === 0 ? 0.5 : (n - min) / span;
      const gIdx = Math.min(glyphs.length - 1, Math.floor(norm * (glyphs.length - 0.001)));
      sparkStr += glyphs[gIdx];
    }

    const targetCell = sheet.getRange(startRow + r, targetColIdx);
    targetCell.setValue?.(sparkStr);
    targetCell.setFontFamily?.('monospace');
    rowsRendered++;
  }

  const durationMs = Math.round(performance.now() - t0);
  return {
    status: 'SUCCESS',
    targetColumn: targetCol.colLetter,
    rowsRendered,
    durationMs,
    message: `Injected Unicode sparklines into Column ${targetCol.colLetter} across ${rowsRendered} rows.`,
  };
}

/**
 * 6. executeClearVisualFormatting
 * Surgically removes color scales and badge fills without destroying data.
 */
export async function executeClearVisualFormatting(
  args: {
    range: string;
    target?: 'all' | 'color_scales' | 'threshold_rules' | 'data_bars';
    sheetName?: string;
  },
  ctx: ToolExecutionContext
) {
  const t0 = performance.now();
  const wb = ctx.univerAPI?.getActiveWorkbook?.();
  if (!wb) throw new Error('Active workbook unavailable');

  const sheet = args.sheetName ? wb.getSheetByName?.(args.sheetName) : wb.getActiveSheet?.();
  if (!sheet) throw new Error(`Worksheet not found`);

  const fRange = sheet.getRange(args.range);
  if (!fRange) throw new Error(`Could not resolve range: ${args.range}`);

  const startRow = typeof fRange.getRow === 'function' ? fRange.getRow() : 0;
  const startCol = typeof fRange.getColumn === 'function' ? fRange.getColumn() : 0;
  const rawValues: any[][] = fRange.getValues?.() || [];
  const numRows = rawValues.length;
  const numCols = rawValues[0]?.length || 0;

  for (let r = 0; r < numRows; r++) {
    for (let c = 0; c < numCols; c++) {
      const cellRange = sheet.getRange(startRow + r, startCol + c);
      cellRange.setBackgroundColor?.(null);
      cellRange.setFontColor?.(null);
    }
  }

  const durationMs = Math.round(performance.now() - t0);
  return {
    status: 'SUCCESS',
    clearedRange: args.range,
    durationMs,
    message: `Cleared visual fills across ${numRows * numCols} cells in ${args.range}.`,
  };
}
