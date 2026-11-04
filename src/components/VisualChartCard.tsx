'use client';

import React, { useState } from 'react';
import {
  BarChart3,
  LineChart,
  PieChart,
  Download,
  Maximize2,
  Minimize2,
  Sparkles,
} from 'lucide-react';
import { ChartPayload } from '@/ai/types';

interface VisualChartCardProps {
  payload: ChartPayload;
  className?: string;
}

export default function VisualChartCard({ payload, className = '' }: VisualChartCardProps) {
  const [hoveredData, setHoveredData] = useState<{
    category: string;
    seriesName: string;
    value: number;
    x: number;
    y: number;
  } | null>(null);
  const [isExpanded, setIsExpanded] = useState(false);

  const {
    title,
    chartType,
    categories = [],
    series = [],
    secondaryYAxisLabel,
    statsSummary,
    expertAdvisory,
  } = payload;

  // Chart dimensions
  const width = isExpanded ? 760 : 390;
  const height = isExpanded ? 430 : 265;
  const isHorizontalBar = chartType === 'bar' || chartType === 'funnel';
  const padding = {
    top: 28,
    right: secondaryYAxisLabel || chartType === 'pareto' ? 46 : 24,
    bottom: chartType === 'donut' || chartType === 'radar' || chartType === 'treemap' ? 20 : 44,
    left: isHorizontalBar ? 88 : 46,
  };
  const chartW = width - padding.left - padding.right;
  const chartH = height - padding.top - padding.bottom;

  // Compute Primary Scale
  const primarySeries = series.filter((s) => !s.yAxisIndex || s.yAxisIndex === 0);
  const allValues = (primarySeries.length ? primarySeries : series).flatMap((s) => s.data);
  const boxVals = series.flatMap((s) =>
    (s.boxPlotStats || []).flatMap((b) => [b.min, b.max])
  );
  const waterfallVals = series.flatMap((s) =>
    (s.waterfallItems || []).flatMap((w) => [w.start, w.end])
  );
  const combinedScaleVals = [...allValues, ...boxVals, ...waterfallVals];

  const minVal = combinedScaleVals.length ? Math.min(0, ...combinedScaleVals) : 0;
  const maxVal = combinedScaleVals.length ? Math.max(1, ...combinedScaleVals) : 100;
  const valRange = maxVal - minVal || 1;

  // Secondary scale for combo & pareto charts
  const secSeries = series.find((s) => s.yAxisIndex === 1);
  const secMaxVal = secSeries ? Math.max(100, ...secSeries.data) : 100;

  const fmtCompact = (v: number) => {
    const abs = Math.abs(v);
    if (abs >= 1e6) return `${(v / 1e6).toFixed(1)}M`;
    if (abs >= 1e3) return `${(v / 1e3).toFixed(1)}k`;
    return Number.isInteger(v) ? String(v) : v.toFixed(1);
  };

  // Download SVG
  const handleDownloadSvg = () => {
    const svgEl = document.getElementById(`svg_${payload.id}`);
    if (!svgEl) return;
    const svgData = new XMLSerializer().serializeToString(svgEl);
    const blob = new Blob([svgData], { type: 'image/svg+xml;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${title.toLowerCase().replace(/\s+/g, '_')}.svg`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const showCartesianGrid =
    chartType !== 'donut' &&
    chartType !== 'radar' &&
    chartType !== 'treemap' &&
    chartType !== 'funnel';

  return (
    <div
      className={`border border-zinc-200 dark:border-zinc-800 rounded-lg bg-white dark:bg-zinc-950 p-3 shadow-xs my-2 text-zinc-900 dark:text-zinc-100 transition-all ${
        isExpanded
          ? 'fixed inset-4 z-50 overflow-auto shadow-2xl flex flex-col items-center justify-center bg-white/95 dark:bg-zinc-950/95 backdrop-blur-md'
          : ''
      } ${className}`}
    >
      {/* Header */}
      <div className="flex items-center justify-between gap-2 pb-2 border-b border-zinc-100 dark:border-zinc-800/80 w-full">
        <div className="flex items-center gap-1.5 min-w-0">
          <div className="p-1 rounded bg-emerald-50 dark:bg-emerald-950/60 text-emerald-600 dark:text-emerald-400">
            {chartType === 'line' || chartType === 'area' ? (
              <LineChart className="w-3.5 h-3.5" />
            ) : chartType === 'donut' ? (
              <PieChart className="w-3.5 h-3.5" />
            ) : (
              <BarChart3 className="w-3.5 h-3.5" />
            )}
          </div>
          <span className="text-xs font-semibold truncate text-zinc-800 dark:text-zinc-200">{title}</span>
          <span className="text-[10px] px-1.5 py-0.2 rounded font-mono uppercase bg-zinc-100 dark:bg-zinc-800 text-zinc-600 dark:text-zinc-400">
            {chartType}
          </span>
        </div>

        <div className="flex items-center gap-1 shrink-0">
          <button
            onClick={handleDownloadSvg}
            title="Download SVG"
            className="p-1 rounded text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200 hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors"
          >
            <Download className="w-3.5 h-3.5" />
          </button>
          <button
            onClick={() => setIsExpanded(!isExpanded)}
            title={isExpanded ? 'Minimize' : 'Expand'}
            className="p-1 rounded text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200 hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors"
          >
            {isExpanded ? <Minimize2 className="w-3.5 h-3.5" /> : <Maximize2 className="w-3.5 h-3.5" />}
          </button>
        </div>
      </div>

      {/* Expert Advisory Banner (when AI auto-binned or corrected a flawed chart choice) */}
      {expertAdvisory && (
        <div className="mt-2 px-2.5 py-1.5 rounded-md bg-amber-50/80 dark:bg-amber-950/40 border border-amber-200/70 dark:border-amber-800/60 flex items-start gap-1.5 text-[10px] text-amber-900 dark:text-amber-200 w-full">
          <Sparkles className="w-3.5 h-3.5 text-amber-600 dark:text-amber-400 shrink-0 mt-0.5" />
          <span className="leading-snug">{expertAdvisory}</span>
        </div>
      )}

      {/* SVG Canvas */}
      <div className="relative w-full flex justify-center py-2 overflow-hidden">
        <svg
          id={`svg_${payload.id}`}
          viewBox={`0 0 ${width} ${height}`}
          className="w-full max-w-full h-auto overflow-visible select-none"
        >
          {/* Cartesian Grid lines */}
          {showCartesianGrid &&
            [0, 0.25, 0.5, 0.75, 1].map((pct, idx) => {
              const y = padding.top + chartH * (1 - pct);
              const val = minVal + valRange * pct;
              return (
                <g key={idx}>
                  <line
                    x1={padding.left}
                    y1={y}
                    x2={padding.left + chartW}
                    y2={y}
                    stroke="currentColor"
                    strokeOpacity="0.08"
                    strokeDasharray="2,2"
                  />
                  {chartType !== 'bar' && (
                    <text
                      x={padding.left - 6}
                      y={y + 3}
                      textAnchor="end"
                      fontSize="8.5"
                      fill="currentColor"
                      opacity="0.45"
                      fontFamily="monospace"
                    >
                      {fmtCompact(val)}
                    </text>
                  )}
                </g>
              );
            })}

          {/* 1. LINE & AREA CHARTS */}
          {(chartType === 'line' || chartType === 'area') &&
            primarySeries.map((s, sIdx) => {
              const pts = s.data.map((d, dIdx) => {
                const x = padding.left + (dIdx / Math.max(categories.length - 1, 1)) * chartW;
                const y = padding.top + chartH - ((d - minVal) / valRange) * chartH;
                return { x, y, val: d, cat: categories[dIdx] || `${dIdx + 1}` };
              });
              if (pts.length === 0) return null;
              const linePath = pts.reduce((acc, p, i) => `${acc} ${i === 0 ? 'M' : 'L'} ${p.x} ${p.y}`, '');
              const areaPath = `${linePath} L ${pts[pts.length - 1].x} ${padding.top + chartH} L ${pts[0].x} ${
                padding.top + chartH
              } Z`;

              return (
                <g key={sIdx}>
                  {chartType === 'area' && <path d={areaPath} fill={s.color || '#10b981'} fillOpacity="0.15" />}
                  <path
                    d={linePath}
                    fill="none"
                    stroke={s.color || '#10b981'}
                    strokeWidth="2.2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                  {pts.map((p, pIdx) => (
                    <circle
                      key={pIdx}
                      cx={p.x}
                      cy={p.y}
                      r="3"
                      fill="#ffffff"
                      stroke={s.color || '#10b981'}
                      strokeWidth="2"
                      className="cursor-pointer transition-all"
                      onMouseEnter={() =>
                        setHoveredData({
                          category: p.cat,
                          seriesName: s.name,
                          value: p.val,
                          x: p.x,
                          y: p.y,
                        })
                      }
                      onMouseLeave={() => setHoveredData(null)}
                    />
                  ))}
                </g>
              );
            })}

          {/* 2. HORIZONTAL BAR CHART (Supports Multi-Series + Y-Axis Category Labels!) */}
          {chartType === 'bar' &&
            categories.map((cat, cIdx) => {
              const rowBandH = chartH / Math.max(categories.length, 1);
              const activeBarSeries = primarySeries.length ? primarySeries : series;
              const barH = Math.max(4, Math.min(18, (rowBandH * 0.76) / Math.max(activeBarSeries.length, 1)));
              const yGroupStart = padding.top + cIdx * rowBandH + (rowBandH - barH * activeBarSeries.length) / 2;
              const zeroX = padding.left + ((0 - minVal) / valRange) * chartW;
              const labelStr = cat.length > 13 ? `${cat.slice(0, 12)}…` : cat;

              return (
                <g key={cIdx}>
                  {/* Y-axis Category Label */}
                  <text
                    x={padding.left - 6}
                    y={padding.top + cIdx * rowBandH + rowBandH / 2 + 3}
                    textAnchor="end"
                    fontSize="8.5"
                    fill="currentColor"
                    opacity="0.7"
                  >
                    {labelStr}
                  </text>
                  {activeBarSeries.map((s, sIdx) => {
                    const val = s.data[cIdx] ?? 0;
                    const valX = padding.left + ((val - minVal) / valRange) * chartW;
                    const rectX = Math.min(zeroX, valX);
                    const rectW = Math.max(2, Math.abs(valX - zeroX));
                    const y = yGroupStart + sIdx * barH;

                    return (
                      <g key={sIdx}>
                        <rect
                          x={rectX}
                          y={y}
                          width={rectW}
                          height={barH - 1}
                          rx="2.5"
                          fill={val < 0 ? '#ef4444' : s.color || '#10b981'}
                          opacity="0.88"
                          className="cursor-pointer hover:opacity-100 transition-opacity"
                          onMouseEnter={() =>
                            setHoveredData({
                              category: cat,
                              seriesName: s.name,
                              value: val,
                              x: rectX + rectW,
                              y: y + barH / 2,
                            })
                          }
                          onMouseLeave={() => setHoveredData(null)}
                        />
                        {activeBarSeries.length === 1 && (
                          <text
                            x={rectX + rectW + 4}
                            y={y + barH / 2 + 3}
                            fontSize="8"
                            fill="currentColor"
                            opacity="0.6"
                            fontFamily="monospace"
                          >
                            {fmtCompact(val)}
                          </text>
                        )}
                      </g>
                    );
                  })}
                </g>
              );
            })}

          {/* 3. DONUT CHART */}
          {chartType === 'donut' &&
            (() => {
              const data = series[0]?.data || [];
              const total = data.reduce((a, b) => a + Math.max(0, b), 0) || 1;
              const cx = width / 2;
              const cy = height / 2;
              const r = Math.min(chartW, chartH) / 2.1;
              const innerR = r * 0.56;
              let currentAngle = -Math.PI / 2;
              const PALETTE = ['#10b981', '#059669', '#3b82f6', '#f59e0b', '#6366f1', '#14b8a6'];

              return (
                <g>
                  {data.map((d, dIdx) => {
                    const posVal = Math.max(0, d);
                    const sliceAngle = (posVal / total) * 2 * Math.PI;
                    const x1 = cx + r * Math.cos(currentAngle);
                    const y1 = cy + r * Math.sin(currentAngle);
                    const x2 = cx + r * Math.cos(currentAngle + sliceAngle);
                    const y2 = cy + r * Math.sin(currentAngle + sliceAngle);

                    const ix1 = cx + innerR * Math.cos(currentAngle + sliceAngle);
                    const iy1 = cy + innerR * Math.sin(currentAngle + sliceAngle);
                    const ix2 = cx + innerR * Math.cos(currentAngle);
                    const iy2 = cy + innerR * Math.sin(currentAngle);

                    const largeArc = sliceAngle > Math.PI ? 1 : 0;
                    const pathD = `M ${x1} ${y1} A ${r} ${r} 0 ${largeArc} 1 ${x2} ${y2} L ${ix1} ${iy1} A ${innerR} ${innerR} 0 ${largeArc} 0 ${ix2} ${iy2} Z`;
                    const sliceColor = PALETTE[dIdx % PALETTE.length];
                    currentAngle += sliceAngle;

                    return (
                      <path
                        key={dIdx}
                        d={pathD}
                        fill={sliceColor}
                        opacity="0.9"
                        className="cursor-pointer hover:opacity-100 transition-opacity"
                        onMouseEnter={() =>
                          setHoveredData({
                            category: categories[dIdx] || `Slice ${dIdx + 1}`,
                            seriesName: `${((posVal / total) * 100).toFixed(1)}%`,
                            value: d,
                            x: cx,
                            y: cy,
                          })
                        }
                        onMouseLeave={() => setHoveredData(null)}
                      />
                    );
                  })}
                  <text x={cx} y={cy - 3} textAnchor="middle" fontSize="9.5" opacity="0.5" fill="currentColor">
                    Total
                  </text>
                  <text x={cx} y={cy + 12} textAnchor="middle" fontSize="12.5" fontWeight="bold" fill="currentColor">
                    {fmtCompact(total)}
                  </text>
                </g>
              );
            })()}

          {/* 4. SCATTER & BUBBLE CHART */}
          {(chartType === 'scatter' || chartType === 'bubble') &&
            (() => {
              const pts = series[0]?.scatterPoints || [];
              if (pts.length === 0) return null;
              const xs = pts.map((p) => p.x);
              const ys = pts.map((p) => p.y);
              const minX = Math.min(...xs);
              const maxX = Math.max(...xs);
              const spanX = maxX - minX || 1;
              const minY = Math.min(0, ...ys);
              const maxY = Math.max(1, ...ys);
              const spanY = maxY - minY || 1;

              return (
                <g>
                  {pts.map((p, idx) => {
                    const cx = padding.left + ((p.x - minX) / spanX) * chartW;
                    const cy = padding.top + chartH - ((p.y - minY) / spanY) * chartH;
                    const radius = chartType === 'bubble' ? p.r || 6 : 4;
                    return (
                      <circle
                        key={idx}
                        cx={cx}
                        cy={cy}
                        r={radius}
                        fill={series[0]?.color || '#10b981'}
                        fillOpacity="0.65"
                        stroke={series[0]?.color || '#059669'}
                        strokeWidth="1.2"
                        className="cursor-pointer hover:fill-opacity-100"
                        onMouseEnter={() =>
                          setHoveredData({
                            category: p.label || `X: ${p.x}`,
                            seriesName: `Y`,
                            value: p.y,
                            x: cx,
                            y: cy,
                          })
                        }
                        onMouseLeave={() => setHoveredData(null)}
                      />
                    );
                  })}
                </g>
              );
            })()}

          {/* 5. WATERFALL BRIDGE CHART */}
          {chartType === 'waterfall' &&
            (() => {
              const items =
                series[0]?.waterfallItems ||
                categories.map((c, i) => ({
                  label: c,
                  value: series[0]?.data[i] ?? 0,
                  start: 0,
                  end: series[0]?.data[i] ?? 0,
                  isTotal: false,
                }));
              const colGroupW = chartW / Math.max(items.length, 1);
              const barW = Math.min(26, colGroupW * 0.68);

              return (
                <g>
                  {items.map((item, idx) => {
                    const topVal = Math.max(item.start, item.end);
                    const botVal = Math.min(item.start, item.end);
                    const yTop = padding.top + chartH - ((topVal - minVal) / valRange) * chartH;
                    const yBot = padding.top + chartH - ((botVal - minVal) / valRange) * chartH;
                    const barH = Math.max(3, yBot - yTop);
                    const x = padding.left + idx * colGroupW + (colGroupW - barW) / 2;
                    const fill = item.isTotal
                      ? '#3b82f6'
                      : item.value >= 0
                      ? '#10b981'
                      : '#ef4444';

                    return (
                      <g key={idx}>
                        <rect
                          x={x}
                          y={yTop}
                          width={barW}
                          height={barH}
                          rx="2"
                          fill={fill}
                          opacity="0.9"
                          className="cursor-pointer"
                          onMouseEnter={() =>
                            setHoveredData({
                              category: item.label,
                              seriesName: item.isTotal ? 'Total' : 'Bridge Delta',
                              value: item.value,
                              x: x + barW / 2,
                              y: yTop,
                            })
                          }
                          onMouseLeave={() => setHoveredData(null)}
                        />
                      </g>
                    );
                  })}
                </g>
              );
            })()}

          {/* 6. BOX PLOT (5-Number Statistical Summary) */}
          {chartType === 'box_plot' &&
            (() => {
              const stats = series[0]?.boxPlotStats || [];
              const colGroupW = chartW / Math.max(stats.length, 1);
              const boxW = Math.min(32, colGroupW * 0.55);

              return (
                <g>
                  {stats.map((st, idx) => {
                    const xCenter = padding.left + idx * colGroupW + colGroupW / 2;
                    const yOf = (v: number) => padding.top + chartH - ((v - minVal) / valRange) * chartH;
                    const yMin = yOf(st.min);
                    const yQ1 = yOf(st.q1);
                    const yMed = yOf(st.median);
                    const yQ3 = yOf(st.q3);
                    const yMax = yOf(st.max);

                    return (
                      <g key={idx}>
                        {/* Whisker line */}
                        <line x1={xCenter} y1={yMax} x2={xCenter} y2={yMin} stroke="#10b981" strokeWidth="1.5" />
                        <line x1={xCenter - boxW / 3} y1={yMax} x2={xCenter + boxW / 3} y2={yMax} stroke="#10b981" strokeWidth="1.5" />
                        <line x1={xCenter - boxW / 3} y1={yMin} x2={xCenter + boxW / 3} y2={yMin} stroke="#10b981" strokeWidth="1.5" />
                        {/* IQR Box */}
                        <rect
                          x={xCenter - boxW / 2}
                          y={yQ3}
                          width={boxW}
                          height={Math.max(4, yQ1 - yQ3)}
                          fill="#10b981"
                          fillOpacity="0.25"
                          stroke="#059669"
                          strokeWidth="1.5"
                          rx="2"
                          onMouseEnter={() =>
                            setHoveredData({
                              category: st.category,
                              seriesName: `Median (IQR: ${st.q1}–${st.q3})`,
                              value: st.median,
                              x: xCenter,
                              y: yQ3,
                            })
                          }
                          onMouseLeave={() => setHoveredData(null)}
                        />
                        {/* Median Line */}
                        <line
                          x1={xCenter - boxW / 2}
                          y1={yMed}
                          x2={xCenter + boxW / 2}
                          y2={yMed}
                          stroke="#047857"
                          strokeWidth="2.5"
                        />
                      </g>
                    );
                  })}
                </g>
              );
            })()}

          {/* 7. FUNNEL CHART */}
          {chartType === 'funnel' &&
            (() => {
              const vals = series[0]?.data || [];
              const topMax = Math.max(1, ...vals);
              const stageH = chartH / Math.max(vals.length, 1);

              return (
                <g>
                  {vals.map((v, idx) => {
                    const barW = Math.max(24, (v / topMax) * chartW);
                    const x = padding.left + (chartW - barW) / 2;
                    const y = padding.top + idx * stageH + 2;
                    return (
                      <g key={idx}>
                        <rect
                          x={x}
                          y={y}
                          width={barW}
                          height={Math.max(8, stageH - 4)}
                          rx="4"
                          fill="#10b981"
                          fillOpacity={Math.max(0.35, 1 - idx * 0.12)}
                        />
                        <text
                          x={padding.left + chartW / 2}
                          y={y + stageH / 2 + 2}
                          textAnchor="middle"
                          fontSize="8.5"
                          fontWeight="bold"
                          fill="currentColor"
                        >
                          {categories[idx]}: {fmtCompact(v)}
                        </text>
                      </g>
                    );
                  })}
                </g>
              );
            })()}

          {/* 8. RADAR (SPIDER) CHART */}
          {chartType === 'radar' &&
            (() => {
              const vals = series[0]?.data || [];
              const n = Math.max(categories.length, 3);
              const cx = width / 2;
              const cy = height / 2;
              const rMax = Math.min(chartW, chartH) / 2.1;

              const polyPts = vals
                .map((v, idx) => {
                  const angle = (idx / n) * 2 * Math.PI - Math.PI / 2;
                  const r = ((v - minVal) / valRange) * rMax;
                  return `${cx + r * Math.cos(angle)},${cy + r * Math.sin(angle)}`;
                })
                .join(' ');

              return (
                <g>
                  {[0.33, 0.66, 1].map((ring, rIdx) => (
                    <circle
                      key={rIdx}
                      cx={cx}
                      cy={cy}
                      r={rMax * ring}
                      fill="none"
                      stroke="currentColor"
                      strokeOpacity="0.12"
                      strokeDasharray="2,2"
                    />
                  ))}
                  <polygon
                    points={polyPts}
                    fill={series[0]?.color || '#10b981'}
                    fillOpacity="0.25"
                    stroke={series[0]?.color || '#10b981'}
                    strokeWidth="2"
                  />
                </g>
              );
            })()}

          {/* 9. TREEMAP CHART */}
          {chartType === 'treemap' &&
            (() => {
              const vals = series[0]?.data || [];
              const total = vals.reduce((a, b) => a + Math.max(0, b), 0) || 1;
              let curX = padding.left;
              const PALETTE = ['#10b981', '#059669', '#3b82f6', '#047857', '#6366f1', '#14b8a6'];

              return (
                <g>
                  {vals.map((v, idx) => {
                    const share = Math.max(0.02, Math.max(0, v) / total);
                    const boxW = Math.max(12, share * chartW);
                    const x = curX;
                    curX += boxW;
                    return (
                      <g key={idx}>
                        <rect
                          x={x}
                          y={padding.top}
                          width={Math.max(2, boxW - 2)}
                          height={chartH}
                          rx="3"
                          fill={PALETTE[idx % PALETTE.length]}
                          opacity="0.88"
                        />
                        {boxW > 34 && (
                          <text
                            x={x + boxW / 2}
                            y={padding.top + chartH / 2}
                            textAnchor="middle"
                            fontSize="8.5"
                            fill="#ffffff"
                            fontWeight="bold"
                          >
                            {(categories[idx] || '').slice(0, 8)}
                          </text>
                        )}
                      </g>
                    );
                  })}
                </g>
              );
            })()}

          {/* 10. COLUMN, HISTOGRAM, COMBO, & PARETO BARS */}
          {(chartType === 'column' ||
            chartType === 'histogram' ||
            chartType === 'combo_dual_axis' ||
            chartType === 'pareto' ||
            chartType === 'auto') &&
            categories.map((cat, cIdx) => {
              const colGroupW = chartW / Math.max(categories.length, 1);
              const barSeries = primarySeries.filter((s) => s.type !== 'line');
              const gapFactor = chartType === 'histogram' ? 0.94 : 0.78;
              const barW = Math.min(
                chartType === 'histogram' ? 36 : 24,
                (colGroupW * gapFactor) / Math.max(barSeries.length, 1)
              );
              const xStart = padding.left + cIdx * colGroupW + (colGroupW - barW * barSeries.length) / 2;

              return (
                <g key={cIdx}>
                  {barSeries.map((s, sIdx) => {
                    const val = s.data[cIdx] ?? 0;
                    const barH = Math.max(2, ((val - minVal) / valRange) * chartH);
                    const x = xStart + sIdx * barW;
                    const y = padding.top + chartH - barH;

                    return (
                      <rect
                        key={sIdx}
                        x={x}
                        y={y}
                        width={barW}
                        height={barH}
                        rx={chartType === 'histogram' ? '1' : '2.5'}
                        fill={s.color || '#10b981'}
                        opacity="0.86"
                        className="cursor-pointer hover:opacity-100 transition-opacity"
                        onMouseEnter={() =>
                          setHoveredData({
                            category: cat,
                            seriesName: s.name,
                            value: val,
                            x: x + barW / 2,
                            y,
                          })
                        }
                        onMouseLeave={() => setHoveredData(null)}
                      />
                    );
                  })}
                </g>
              );
            })}

          {/* Secondary Axis Line overlay (Combo Dual-Axis & Pareto 80/20 Curve) */}
          {secSeries &&
            (() => {
              const pts = secSeries.data.map((d, dIdx) => {
                const colGroupW = chartW / Math.max(categories.length, 1);
                const x = padding.left + dIdx * colGroupW + colGroupW / 2;
                const y = padding.top + chartH - (d / secMaxVal) * chartH;
                return { x, y, val: d, cat: categories[dIdx] };
              });
              if (pts.length === 0) return null;
              const linePath = pts.reduce((acc, p, i) => `${acc} ${i === 0 ? 'M' : 'L'} ${p.x} ${p.y}`, '');

              return (
                <g>
                  <path
                    d={linePath}
                    fill="none"
                    stroke="#f59e0b"
                    strokeWidth="2.2"
                    strokeDasharray={chartType === 'pareto' ? undefined : '3,3'}
                  />
                  {pts.map((p, pIdx) => (
                    <circle
                      key={pIdx}
                      cx={p.x}
                      cy={p.y}
                      r="3"
                      fill="#ffffff"
                      stroke="#f59e0b"
                      strokeWidth="2"
                      className="cursor-pointer"
                      onMouseEnter={() =>
                        setHoveredData({
                          category: p.cat,
                          seriesName: secSeries.name,
                          value: p.val,
                          x: p.x,
                          y: p.y,
                        })
                      }
                      onMouseLeave={() => setHoveredData(null)}
                    />
                  ))}
                </g>
              );
            })()}

          {/* X-Axis Category Labels (with automatic label-skip stride so labels never overlap!) */}
          {showCartesianGrid &&
            chartType !== 'bar' &&
            chartType !== 'scatter' &&
            chartType !== 'bubble' &&
            (() => {
              const labelStride = categories.length > 10 ? Math.ceil(categories.length / 7) : 1;
              return categories.map((cat, cIdx) => {
                if (cIdx % labelStride !== 0 && cIdx !== categories.length - 1) return null;
                const colGroupW = chartW / Math.max(categories.length, 1);
                const x = padding.left + cIdx * colGroupW + colGroupW / 2;
                const y = padding.top + chartH + 15;
                const truncated = cat.length > 9 ? `${cat.slice(0, 8)}…` : cat;

                return (
                  <text
                    key={cIdx}
                    x={x}
                    y={y}
                    textAnchor="middle"
                    fontSize="8.5"
                    fill="currentColor"
                    opacity="0.6"
                  >
                    {truncated}
                  </text>
                );
              });
            })()}
        </svg>

        {/* Floating Tooltip */}
        {hoveredData && (
          <div
            className="absolute z-10 pointer-events-none bg-zinc-900/90 dark:bg-zinc-100/90 text-white dark:text-zinc-900 text-[10px] px-2 py-1 rounded shadow-lg backdrop-blur-xs transition-transform"
            style={{
              left: `${(hoveredData.x / width) * 100}%`,
              top: `${Math.max(10, (hoveredData.y / height) * 100 - 15)}%`,
              transform: 'translate(-50%, -100%)',
            }}
          >
            <div className="font-semibold">{hoveredData.category}</div>
            <div className="opacity-80">
              {hoveredData.seriesName}: {hoveredData.value.toLocaleString()}
            </div>
          </div>
        )}
      </div>

      {/* Footer & Legend */}
      <div className="flex flex-wrap items-center justify-between gap-2 pt-1 border-t border-zinc-100 dark:border-zinc-800/80 text-[10px] text-zinc-500 w-full">
        <div className="flex items-center gap-3">
          {series.map((s, idx) => (
            <div key={idx} className="flex items-center gap-1">
              <span className="w-2 h-2 rounded-xs" style={{ backgroundColor: s.color || '#10b981' }} />
              <span className="truncate max-w-[120px]">{s.name}</span>
            </div>
          ))}
        </div>
        {statsSummary && (
          <span className="font-mono text-[9px] opacity-70 truncate max-w-[210px]" title={statsSummary}>
            {statsSummary}
          </span>
        )}
      </div>
    </div>
  );
}
