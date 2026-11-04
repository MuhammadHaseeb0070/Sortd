# Data Engineer Execution Path (DEEP) & Dataset Filtering Engine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Permanently resolve repetitive micro-mutation loops, out-of-bounds reading thrash, and missing dataset subsetting capabilities by introducing `filter_slice_dataset`, coordinate clamping in `inspect_range`, orchestrator anti-micro-mutation circuit breaking, and the Data Engineer Execution Path (DEEP) cognitive protocol.

**Architecture:** 
- Add vectorized `filter_slice_dataset` tool in `sanitizer`, `analyst`, and `core` with multi-condition filtering, in-memory currency/metric aggregation, automatic target sheet creation, ERP pagination header stripping, and single-pass UniverJS mutation.
- Harden `executeInspectRange` with automatic grid coordinate clamping (`rowCount`/`columnCount`) and sheet-prefix stripping.
- Add an anti-micro-mutation circuit breaker in `runAgentLoop` (`orchestrator.ts`) to block repeated single-column `mutate_cells` loops.
- Codify the Data Engineer Execution Path (DEEP) in `BASE_SYSTEM_PROMPT` and profile prompt fragments.

**Tech Stack:** TypeScript, Node.js Test Runner (`tsx --test`), Next.js 16.4.3 Turbopack, UniverJS v1.2.0.

**Spec:** `docs/superpowers/specs/2026-10-31-data-engineering-flow-and-dataset-filtering-design.md`

## Global Constraints
- All column resolutions must use `resolveColumnSmart` with `detectTableHeaderRow` to support ERP exports where Row 1 is a title banner.
- All UniverJS grid mutations must expand sheet capacity with `ensureSheetCapacity` and perform vectorized batch `setValues` (<50ms).
- Never hallucinate or fake data when required columns do not exist and cannot be derived.
- All existing 32 unit tests must continue passing with zero regressions.

---

### Task 1: Flagship Tool `filter_slice_dataset`

**Files:**
- Create/Modify: `src/ai/profiles/sanitizer/executors.ts`, `src/ai/profiles/sanitizer/tools.ts`, `src/ai/profiles/analyst/tools.ts`, `src/ai/profiles/core/tools.ts`
- Test: `src/ai/profiles/__tests__/analystAndSanitizer.test.ts`

- [ ] **Step 1: Write the failing tests in `analystAndSanitizer.test.ts`**
  - Test 1: `executeFilterSliceDataset`: filters rows by condition (`Status == 'Cancelled'`), creates target sheet `"Cancelled"`, copies all columns in 1 call, returns accurate count.
  - Test 2: `executeFilterSliceDataset`: computes count and sum grouped by `Currency` with `summarizeMetrics`, generates Markdown summary table and writes summary block on target sheet.
  - Test 3: `executeFilterSliceDataset`: handles ERP export where Row 1 is a title banner, table headers are on Row 4, and pagination headers repeat throughout the data.
  - Test 4: `executeFilterSliceDataset`: derives missing metric column on the fly (`Quantity * UnitPrice`).
- [ ] **Step 2: Run tests to confirm failures**
- [ ] **Step 3: Implement `executeFilterSliceDataset` in `src/ai/profiles/sanitizer/executors.ts`**
  - Implement full filtering logic with `detectTableHeaderRow`, `resolveColumnSmart`, robust number parsing for currency strings (`$`, `€`, `£`, `USD`), in-memory metric aggregation, target sheet creation, `ensureSheetCapacity`, and vectorized `setValues`.
- [ ] **Step 4: Register tool schemas in `sanitizer/tools.ts`, `analyst/tools.ts`, and `core/tools.ts`**
- [ ] **Step 5: Run tests to verify all pass**

---

### Task 2: Engine Hardening in `executeInspectRange`

**Files:**
- Modify: `src/ai/profiles/core/executors.ts`
- Test: `src/ai/utils/__tests__/engine.test.ts`

- [ ] **Step 1: Write failing test in `engine.test.ts`**
  - Test: `executeInspectRange` gracefully clamps out-of-bounds row ranges (e.g. requesting row 2260 on a 100-row sheet) to the sheet's actual bounds instead of returning 0 rows.
  - Test: `executeInspectRange` strips `SheetName!` prefix before passing to `sheet.getRange(localCoordinate)`.
- [ ] **Step 2: Run test to confirm failure**
- [ ] **Step 3: Implement coordinate clamping and prefix stripping in `executeInspectRange`**
  - Read `maxRows = sheet.getRowCount?.() ?? 10000; maxCols = sheet.getColumnCount?.() ?? 100;`
  - Clamp parsed `endRow` and `endCol`.
  - Format clamped local range string.
- [ ] **Step 4: Run test to verify passes**

---

### Task 3: Orchestrator Hardening & Anti-Micro-Mutation Circuit Breaker

**Files:**
- Modify: `src/ai/orchestrator.ts`
- Test: `src/ai/__tests__/radarAndOrchestrator.test.ts`

- [ ] **Step 1: Write failing test in `radarAndOrchestrator.test.ts`**
  - Test 1: `shouldBlockDuplicateToolCall` extracts sheet prefix from `rangeA1` (e.g. `"Orders!A4:O2260"`) so target sheet is normalized.
  - Test 2: Orchestrator detects repeated single-column micro-mutations across consecutive columns (e.g. `P2:P132`, `Q2:Q132`, `R2:R132`) and halts/advises vectorized tools.
- [ ] **Step 2: Run test to confirm failure**
- [ ] **Step 3: Implement sheet prefix extraction in `shouldBlockDuplicateToolCall` and micro-mutation tracking in `runAgentLoop`**
- [ ] **Step 4: Run test to verify passes**

---

### Task 4: Codify Data Engineer Execution Path (DEEP) in System Prompts

**Files:**
- Modify: `src/ai/orchestrator.ts` (`BASE_SYSTEM_PROMPT`)
- Modify: `src/ai/profiles/sanitizer/prompt.ts`, `src/ai/profiles/analyst/prompt.ts`, `src/ai/profiles/core/prompt.ts`

- [ ] **Step 1: Add DEEP constitution to `BASE_SYSTEM_PROMPT`**
  - Mandate 5-step path: (1) Target Intent & Required Data Audit, (2) Data Health & Format, (3) Derivation Feasibility (Never Fake), (4) High-Order Tool First (ban micro-mutation loops), (5) Executive Delivery.
- [ ] **Step 2: Add specific `filter_slice_dataset` guidance to `sanitizer`, `analyst`, and `core` prompts**

---

### Task 5: End-to-End Simulation, Full Test Suite & Production Build

**Files:**
- Test: `src/ai/profiles/__tests__/analystAndSanitizer.test.ts`
- Verification: Full test suite + `npm run build`

- [ ] **Step 1: Add end-to-end simulation test in `analystAndSanitizer.test.ts`**
  - Simulates the exact user request: *"Pull all cancelled orders into a new sheet called Cancelled with all columns. Give me the count and the total value in each currency."* on an ERP export sheet with Row 1 banner and repeated headers.
  - Asserts target sheet `Cancelled` is created, populated with 131 cancelled rows, currency counts/sums match, and runtime is <50ms.
- [ ] **Step 2: Run all 33+ unit and integration tests**
- [ ] **Step 3: Run production Next.js build (`npm run build`)**
