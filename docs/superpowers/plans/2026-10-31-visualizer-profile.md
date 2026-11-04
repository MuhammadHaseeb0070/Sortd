# Visualizer Profile & Interactive Visualization Engine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the complete 6th persona profile (`visualizer`) with 6 specialized tools covering interactive charting (bar, line, area, donut, scatter, combo, waterfall, treemap, funnel, radar, pareto, histogram, box plot), continuous/quantile heatmaps, in-cell data bars, threshold rules, sparkline strips, and a responsive SVG Visual Studio UI.

**Architecture:** 
1. Build `src/ai/profiles/visualizer/executors.ts` containing the core data normalization, statistical heuristics, chart recommendation engine, and Univer cell styling algorithms.
2. Build `src/ai/profiles/visualizer/tools.ts` with strict JSON schemas and system prompts in `src/ai/profiles/visualizer/prompt.ts`.
3. Build the responsive SVG Chart Engine component `src/components/VisualChartCard.tsx` capable of rendering all 15 chart types with hover tooltips, legends, and export capabilities.
4. Mount the visualizer profile in `src/ai/registry.ts`, integrate chart rendering in `src/components/AIWorkbenchSidebar.tsx` and `src/components/SpreadsheetWorkspace.tsx`.

**Tech Stack:** TypeScript, React 19, Next.js 16, Tailwind CSS 4, Lucide React, Univer Sheets API.

**Spec:** `docs/superpowers/specs/2026-10-31-visualizer-profile-design.md`

## Global Constraints
- Strictly use zinc, slate, and emerald monochromatic palettes; NO AI slop/purple.
- Zero bundle bloat; render charts cleanly via scalable, responsive SVG.
- Ensure strict WCAG 2.1 contrast compliance when applying cell fills.
- Preserve existing number formatting and formulas when applying in-cell visual layers.

---

### Task 1: Visualizer Profile Tools & Prompts
**Files:**
- Create: `src/ai/profiles/visualizer/tools.ts`
- Create: `src/ai/profiles/visualizer/prompt.ts`
- Modify: `src/ai/profiles/visualizer/index.ts`

- [ ] **Step 1: Define tool schemas in `tools.ts`**
  Define `generate_chart`, `apply_color_scale`, `add_data_bars`, `create_threshold_rule`, `render_sparkline_strip`, and `clear_visual_formatting`.
- [ ] **Step 2: Define system prompt in `prompt.ts`**
  Include the AI Chart Recommendation decision matrix, Tufte principles, and operational rules.
- [ ] **Step 3: Export profile module in `index.ts`**

---

### Task 2: Visualizer Executors Engine
**Files:**
- Create: `src/ai/profiles/visualizer/executors.ts`

- [ ] **Step 1: Implement AI Chart Recommendation & Data Extraction (`executeGenerateChart`)**
  Implement column analysis, type census, series extraction, auto chart selection, and structured chart payload generation.
- [ ] **Step 2: Implement Color Scale Engine (`executeApplyColorScale`)**
  Implement linear, quantile, and zero-centered bipolar color interpolators with WCAG luminance font contrast flipping.
- [ ] **Step 3: Implement Data Bars Engine (`executeAddDataBars`)**
  Implement proportional Unicode / fill data bars with zero-axis support.
- [ ] **Step 4: Implement Threshold Rules Engine (`executeCreateThresholdRule`)**
  Implement relational operators and soft badge styling.
- [ ] **Step 5: Implement Sparkline Strip Engine (`executeRenderSparklineStrip`)**
  Implement normalized Unicode sparkline series generation.
- [ ] **Step 6: Implement Clear Visual Formatting (`executeClearVisualFormatting`)**

---

### Task 3: Interactive SVG Chart Component & Visual Studio UI
**Files:**
- Create: `src/components/VisualChartCard.tsx`
- Modify: `src/components/AIWorkbenchSidebar.tsx`
- Modify: `src/components/SpreadsheetWorkspace.tsx`

- [ ] **Step 1: Create `VisualChartCard.tsx`**
  Build pure responsive SVG renderer supporting bar, column, line, area, donut, combo, waterfall, scatter, pareto, radar, funnel, histogram, and box plot with interactive tooltips, legends, and SVG/PNG export.
- [ ] **Step 2: Connect chart output to AIWorkbenchSidebar message flow**
  Render `VisualChartCard` inside AI workbench responses when `generate_chart` executes.
- [ ] **Step 3: Add persistent Visual Studio Tray toggle in `SpreadsheetWorkspace.tsx`**
  Allow users to open a side/floating Visual Studio drawer showing all generated charts.

---

### Task 4: Verification & Build
**Files:**
- All modified files

- [ ] **Step 1: Typecheck via `npx tsc --noEmit`**
- [ ] **Step 2: Full Next.js production build via `npm run build`**
- [ ] **Step 3: Verify all 6 tools are active in registry**
