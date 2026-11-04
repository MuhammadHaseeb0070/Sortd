# Sortd Intelligence, Reliability & Domain-Expert Overhaul Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Eliminate all 28 verified silent failures, empty-sheet stops, dirty group-by blindness, fake charts, and math bugs while adding Compact Multi-Sheet Radar v2, Progress-Aware Adaptive Loop Control, an Instant Stop Button, a Highlighted In-Sheet Diff Confirmation Gate, and Domain-Expert Constitutions across all 7 profiles.

**Architecture:**
1. Create a shared, unit-tested spreadsheet engine foundation (`src/ai/utils/univerBridge.ts` and `src/ai/utils/dataHygiene.ts`) handling Row-1-first column resolution, sheet capacity auto-expansion, UniverJS alignment mapping, robust number/date parsing, and 4-stage categorical entity clustering (`North` vs `N`, `N.`).
2. Upgrade `src/ai/radar.ts` (multi-sheet schemas + entity collision alerts + compact ~500-token prompt formatter) and `src/ai/orchestrator.ts` (progress-aware loop controller, zero-turn profile hot-swapping, `AbortSignal`, and staged diff confirmation gate).
3. Upgrade all 7 profile tool suites and prompts (`core`, `sanitizer`, `analyst`, `visualizer`, `formula_pro`, `architect`, `auditor`), `VisualChartCard.tsx` (all 15 chart types), `AIWorkbenchSidebar.tsx` + `SpreadsheetWorkspace.tsx` (Stop button, Live Canvas Diff Preview & Confirm/Reject banner, Turn-Level Snapshot Undo, and instant tab-bar sync).

**Tech Stack:** TypeScript 5, Next.js 16.4.3, React 19.3, `@univerjs/presets` `^1.2.0`, Node.js native test runner (`node --test`).

**Spec:** `docs/superpowers/specs/2026-10-31-sortd-intelligence-overhaul-design.md`

## Global Constraints
- Follow strict TDD (`node --test`) for core algorithmic and bridge modules before wiring executors.
- Never pass `'right'` to UniverJS `setHorizontalAlignment` — always map `'right' -> 'normal'`.
- Always resolve column references against Row 1 header names FIRST before falling back to Excel column letters (`A..Z`, `AA..ZZ`).
- Always call `ensureSheetCapacity(sheet, targetRowCount, targetColCount)` before writing ranges that may exceed current sheet bounds.
- Preserve Next.js 16 conventions and never remove the `nextjs-agent-rules` block in `AGENTS.md`.

---

### Task 1: Shared UniverJS Bridge & 6-Gate Data Hygiene Engine (TDD)
**Files:**
- Create: `src/ai/utils/univerBridge.ts`
- Create: `src/ai/utils/dataHygiene.ts`
- Test: `src/ai/utils/__tests__/engine.test.ts`
- Modify: `src/ai/middleware/formulaVerifier.ts`
- Modify: `src/ai/middleware/tokenGuard.ts`

- [x] **Step 1: Write failing unit tests in `src/ai/utils/__tests__/engine.test.ts`** covering:
  - `resolveColumnSmart`: single-word headers (`"Region"`, `"Sales"`, `"Email"`, `"Debit"`, `"A"`) matching Row 1 headers first before base-26 letters.
  - `mapHorizontalAlignment`: `'right' -> 'normal'`, `'left' -> 'left'`, `'center' -> 'center'`.
  - `ensureSheetCapacity`: expanding `setRowCount` / `setColumnCount` when writes exceed `getMaxRows()` / `getMaxColumns()`.
  - `parseRobustNumber`: accounting `($1,250.50)` -> `-1250.5`, trailing `1,250-` -> `-1250`, EU `1.250,50`, suffixes `$1.2M`, sentinels `"N/A"` -> `null`.
  - `clusterCategoryValues`: clustering `["North", "North ", "north", "N", "N.", "South", "S", "West", "W", "East"]` into canonical `North`, `South`, `West`, `East` while preserving distinct IDs (`"Store 1"` vs `"Store 2"`).
- [x] **Step 2: Run `node --test src/ai/utils/__tests__/engine.test.ts` to verify RED.**
- [x] **Step 3: Implement `src/ai/utils/univerBridge.ts`, `src/ai/utils/dataHygiene.ts`, and fix `formulaVerifier.ts` & `tokenGuard.ts`.**
- [x] **Step 4: Run `node --test src/ai/utils/__tests__/engine.test.ts` to verify GREEN.**

---

### Task 2: Compact Multi-Sheet `WorkbookRadar` v2 & Adaptive Progress-Aware Orchestrator (TDD)
**Files:**
- Modify: `src/ai/types.ts`
- Modify: `src/ai/radar.ts`
- Modify: `src/ai/orchestrator.ts`
- Modify: `src/app/api/chat/route.ts`
- Test: `src/ai/__tests__/radarAndOrchestrator.test.ts`

- [x] **Step 1: Write failing tests in `src/ai/__tests__/radarAndOrchestrator.test.ts`** covering:
  - Multi-sheet header retention in Radar v2 even when active sheet is blank (`Regional_Summary` active while `Sheet1` has data).
  - Full distinct value capture & `ENTITY_COLLISION` hazard alert when `Region` has `North, South, East, West, N, N., W`.
  - Embedded `SUBTOTAL_ROW_TRAP` detection on `"Grand Total"` rows.
  - Compact Radar prompt formatting (`< 800` tokens for a 10-column sheet).
  - Loop circuit breaker detection on duplicate `(toolName, args)` calls.
- [x] **Step 2: Run `node --test src/ai/__tests__/radarAndOrchestrator.test.ts` to verify RED.**
- [x] **Step 3: Implement `WorkbookRadar` v2 (`radar.ts`), Adaptive Loop + Zero-Turn Profile Hot-Swap + `AbortSignal` + Diff Confirmation Hook (`orchestrator.ts`), and `finish_reason`/signal forwarding (`route.ts`).**
- [x] **Step 4: Run `node --test src/ai/__tests__/radarAndOrchestrator.test.ts` to verify GREEN.**

---

### Task 3: Core, Sanitizer & Analyst Tool Suite & Expert Prompts Overhaul (TDD)
**Files:**
- Modify: `src/ai/profiles/core/tools.ts`, `src/ai/profiles/core/executors.ts`, `src/ai/profiles/core/prompt.ts`
- Modify: `src/ai/profiles/sanitizer/tools.ts`, `src/ai/profiles/sanitizer/executors.ts`, `src/ai/profiles/sanitizer/prompt.ts`
- Modify: `src/ai/profiles/analyst/tools.ts`, `src/ai/profiles/analyst/executors.ts`, `src/ai/profiles/analyst/prompt.ts`
- Test: `src/ai/profiles/__tests__/analystAndSanitizer.test.ts`

- [x] **Step 1: Write failing tests in `src/ai/profiles/__tests__/analystAndSanitizer.test.ts`** covering:
  - Row-aligned pairwise Pearson correlation (verifying negative correlation `-1.0` is NOT turned into `+1.0` by sorting!).
  - GroupBy dirty category normalization / auto-clustering (`North` + `N` + `N.` grouped together when `autoNormalizeCategories !== false`) + weighted Grand Total average.
  - Crosstab Pivot null handling (blank cells treated as `null`/`0`, never `1`!).
  - What-If Scenario Modeler driver polarity (cost increase reduces profit; revenue increase increases profit).
  - Safe fuzzy deduplication (`"Jan"` vs `"Jane"` and `"North"` vs `"North America"` are NOT merged/deleted).
- [x] **Step 2: Run `node --test src/ai/profiles/__tests__/analystAndSanitizer.test.ts` to verify RED.**
- [x] **Step 3: Upgrade `core`, `sanitizer` (adding `inspect_and_cluster_categories` + fixing all 6 tools), and `analyst` (fixing all 6 tools + adding live `SUMIFS` formula mode + Minto Pyramid expert prompt).**
- [x] **Step 4: Run `node --test src/ai/profiles/__tests__/analystAndSanitizer.test.ts` to verify GREEN.**

---

### Task 4: Expert Visualizer Engine & Full 15-Chart `VisualChartCard.tsx` Suite (TDD)
**Files:**
- Modify: `src/ai/profiles/visualizer/tools.ts`, `src/ai/profiles/visualizer/executors.ts`, `src/ai/profiles/visualizer/prompt.ts`
- Modify: `src/components/VisualChartCard.tsx`
- Test: `src/ai/profiles/__tests__/visualizer.test.ts`

- [x] **Step 1: Write failing tests in `src/ai/profiles/__tests__/visualizer.test.ts`** covering:
  - 1,000 raw order rows of `Quantity` vs `Unit Price`: automatic detection of unaggregated high-cardinality numeric data, generating constructive pushback guidance + auto-binning/scatter/segmentation instead of 1,000 overlapping bars.
  - Freedman-Diaconis histogram binning (`chartType: 'histogram'`) producing clean human-readable numeric buckets.
  - High-cardinality categorical bar chart (`>12` categories) auto-rolling up into `Top 10 + Other (N items)` for additive sums.
  - Donut/Pie guardrail rejecting `>6` slices or negative values and auto-switching to horizontal `bar`.
- [x] **Step 2: Run `node --test src/ai/profiles/__tests__/visualizer.test.ts` to verify RED.**
- [x] **Step 3: Implement Visualizer Cardinality/Binning/Guardrail Engine in `visualizer/executors.ts`, non-destructive threshold formatting, expert IBCS/Few prompt in `visualizer/prompt.ts`, and all 15 SVG chart renderers in `VisualChartCard.tsx`.**
- [x] **Step 4: Run `node --test src/ai/profiles/__tests__/visualizer.test.ts` to verify GREEN.**

---

### Task 5: Formula Pro, Architect, Auditor & `.xlsx` I/O Repair
**Files:**
- Modify: `src/ai/profiles/formula_pro/tools.ts`, `src/ai/profiles/formula_pro/executors.ts`, `src/ai/profiles/formula_pro/prompt.ts`
- Modify: `src/ai/profiles/architect/tools.ts`, `src/ai/profiles/architect/executors.ts`, `src/ai/profiles/architect/prompt.ts`
- Modify: `src/ai/profiles/auditor/tools.ts`, `src/ai/profiles/auditor/executors.ts`, `src/ai/profiles/auditor/prompt.ts`
- Modify: `src/lib/excel-io.ts`

- [x] **Step 1: Fix `formula_pro`** (`resolveColumnSmart`, `'contains' -> "*val*"`, Year-0 `NPV`, `0%` rate guard, safe dynamic array spill width, real Formula Doctor syntax/reference repair before `IFERROR`, FAST prompt).
- [x] **Step 2: Fix `architect`** (`'right' -> 'normal'` alignment, real accounting borders, `setFrozenRows(1)`, fast batch styling, real summary table scaffolding in `scaffold_dashboard_layout`, FAST/IBCS prompt).
- [x] **Step 3: Fix `auditor`** (`resolveColumnSmart`, real `balance_sheet_identity` scanner, cross-sheet range dependency matching `B5` in `Sheet1!B2:B10`, hidden row/col checks, MAD Modified Z-score).
- [x] **Step 4: Upgrade `src/lib/excel-io.ts`** to preserve dates, column widths, merges, and number formats on import and export.

---

### Task 6: Stop Button, Highlighted In-Sheet Diff Confirmation Gate & Workspace Telemetry Sync
**Files:**
- Modify: `src/components/AIWorkbenchSidebar.tsx`
- Modify: `src/components/SpreadsheetWorkspace.tsx`

- [x] **Step 1: Wire `onWorkbookMutated` callback from `SpreadsheetWorkspace.tsx` to `AIWorkbenchSidebar.tsx`** so any AI-created, renamed, deleted, or switched sheet immediately updates the top `Tabs:` bar and row/col telemetry badges.
- [x] **Step 2: Implement Instant Stop Button (`AbortController` + `Escape` key)** and Turn-Level Snapshot Undo/Redo (`activeWorkbook.save()` / `createUniverSheet` snapshot restore) in `AIWorkbenchSidebar.tsx`.
- [x] **Step 3: Implement Live Canvas Diff Highlighting & Sticky Confirm/Reject Gate** (`Ask Before Edits` toggle + `#dcfce7` added / `#fef3c7` modified cell highlights + `[NEW]` sheet indicator + `<20ms` atomic revert on Reject).
- [x] **Step 4: Run full test suite (`node --test`), `npx tsc --noEmit`, and `npm run build` to verify zero errors.**
