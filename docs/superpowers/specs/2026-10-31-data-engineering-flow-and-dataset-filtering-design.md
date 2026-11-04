# Data Engineer Execution Path (DEEP) & Dataset Filtering Engine — Design Specification

## 1. Problem Diagnosis & Root Cause Analysis

### 1.1 Trace Failure Breakdown
Prompt: *"Pull all cancelled orders into a new sheet called Cancelled with all columns. Give me the count and the total value in each currency."*

The execution resulted in:
- 29 separate tool executions over 30+ seconds.
- 15 consecutive calls to `mutate_cells` writing columns cell-by-cell / range-by-range (`P2:P132`, `Q2:Q132`, `R2:R132`, `S2:S132`, `T2:T132`, `U2:U132`, `W1:Y8`, `X2:X8`, `Y2:Y8`).
- An eventual `12,809ms` freeze on `mutate_cells Cancelled!X8:Y8` and complete abortion (`⚠️ Execution Interrupted: signal is aborted without reason`).

### 1.2 The Three Root Causes
1. **Critical Tool Gap (`filter_slice_dataset`)**:
   - Sortd had tools for GroupBy aggregation (`aggregate_multilevel_groupby`), pivot tables (`generate_crosstab_pivot`), deduplication (`deduplicate_dataset`), and cell mutation (`mutate_cells`), but **zero tools** for filtering/extracting matching records into a new or existing sheet.
   - Without an extraction tool, the LLM attempted to manually reconstruct 131 cancelled order rows column-by-column using `mutate_cells`. Each mutation triggered UniverJS sheet recalculations and canvas redraws, cascading into a browser timeout.

2. **`inspect_range` Coordinate Clamping Defect**:
   - The LLM requested `A2:O2261` and `A4:O2260` on a worksheet that only had 2,224 rows.
   - `executeInspectRange` did not clamp the requested bounds to the sheet's actual `rowCount` and `columnCount`, causing UniverJS `fRange.getValues()` to return `[]` (0 rows).
   - Receiving `Read 0 rows from A4:O2260`, the LLM panicked and repeated the same call 3 times before abandoning inspection and resorting to blind cell mutations.

3. **Absence of a Structured Data Engineering Cognitive Framework**:
   - The LLM jumped immediately into trial-and-error mutations without following a disciplined data engineering protocol:
     - Identifying required columns (`Status`, `Currency`, `TotalValue`/`Amount`).
     - Auditing whether they exist, are clean, or need derivation (`Quantity * UnitPrice`).
     - Checking feasibility and planning a high-order execution path.
     - Enforcing honest pushback if required data cannot be derived without fabricating numbers.

---

## 2. The Data Engineer Execution Path (DEEP) Cognitive Architecture

We introduce the **Data Engineer Execution Path (DEEP)** across `BASE_SYSTEM_PROMPT`, `core`, `sanitizer`, and `analyst` profiles:

```
[User Request]
       │
       ▼
┌─────────────────────────────────────────────────────────────┐
│ 1. TARGET INTENT & REQUIRED DATA AUDIT                       │
│    - What exact result does the user want?                  │
│    - What dimensions, filters, and metrics are required?    │
│    - Inspect Radar schema: Do these columns exist?          │
└──────────────────────────────┬──────────────────────────────┘
                               │
       ┌───────────────────────┴────────────────────────┐
       ▼                                                ▼
[Columns Exist]                                 [Columns Missing]
       │                                                │
       ▼                                                ▼
┌─────────────────────────────┐                 ┌─────────────────────────────┐
│ 2. DATA HEALTH & FORMAT     │                 │ 3. DERIVATION FEASIBILITY   │
│    - Are values clean?      │                 │    - Can it be derived?     │
│    - Dirty categories?      │                 │      (e.g. Qty * Price)     │
│    - Embedded headers/text? │                 │    - If YES: derive via     │
│    - Numeric vs string?     │                 │      filter_slice / formula │
└──────────────┬──────────────┘                 │    - If NO: NEVER FAKE.     │
               │                                │      Explain to user why!   │
               │                                └──────────────┬──────────────┘
               │                                               │
               └───────────────────────┬───────────────────────┘
                                       ▼
┌─────────────────────────────────────────────────────────────┐
│ 4. HIGH-ORDER EXECUTION MAPPING (VECTORIZED TOOLS FIRST)    │
│    - Filter / Slice: `filter_slice_dataset` (1 call)        │
│    - Aggregation: `aggregate_multilevel_groupby` (1 call)   │
│    - Slicing + Grouped Sums: `filter_slice_dataset` with    │
│      `summarizeMetrics` in ONE PASS (<50ms)                 │
│    - STRICT BAN: Never call `mutate_cells` in loops to copy │
│      records or columns.                                    │
└──────────────────────────────┬──────────────────────────────┘
                               │
                               ▼
┌─────────────────────────────────────────────────────────────┐
│ 5. EXECUTIVE DELIVERY & PROVENANCE                          │
│    - State exact rows extracted and coordinates [Sheet!A1]  │
│    - Present clean Markdown summary table with totals       │
│    - Disclose any derivations or normalizations performed   │
└─────────────────────────────────────────────────────────────┘
```

---

## 3. Flagship Tool Specification: `filter_slice_dataset`

Registered in `sanitizer`, `analyst`, and `core` profiles.

### 3.1 Input Parameters
- `sourceSheetName` *(optional string)*: Source worksheet (defaults to active sheet).
- `filterConditions` *(array of objects)*:
  - `column`: Header name, decorated string (`"G (Status)"`), or column letter (`"G"`).
  - `operator`: `"=="` | `"!="` | `">"` | `"<"` | `">="` | `"<="` | `"contains"` | `"in"` | `"startsWith"` | `"endsWith"` | `"isNull"` | `"notNull"` | `"regex"`.
  - `value`: Filter value (e.g. `"Cancelled"`, or array `["Cancelled", "Refunded"]`).
  - `matchCase` *(optional boolean, default `false`)*: Case-insensitive by default.
- `conditionLogic` *(optional `"AND"` | `"OR"`, default `"AND"`)*.
- `columns` *(optional string[])*: Subset of columns to copy (defaults to all columns).
- `targetSheetName` *(optional string)*: Name of target worksheet (e.g. `"Cancelled"`). Automatically created if it doesn't exist.
- `targetStartCell` *(optional string, default `"A1"`)*: Destination origin cell.
- `action` *(optional `"copy_to_target"` | `"move_to_target"` | `"report_only"`, default `"copy_to_target"`)*:
  - `"copy_to_target"`: Copies matching rows to target sheet.
  - `"move_to_target"`: Copies matching rows to target sheet and deletes them from source sheet.
  - `"report_only"`: Returns matching row count, sample preview, and summary metrics without mutating the grid.
- `summarizeMetrics` *(optional array)*:
  - `groupBy`: Column to group summaries by (e.g. `"Currency"`).
  - `metricColumn`: Column to aggregate (e.g. `"Total"`, `"Total Value"`, `"Quantity"`). If omitted and aggregate is `"count"`, counts rows.
  - `aggregate`: `"count"` | `"sum"` | `"average"` | `"min"` | `"max"`.
  - `derivedFormula`: Optional expression if metric column does not exist (e.g. `"Quantity * UnitPrice"`).
- `writeSummaryBlock` *(optional boolean, default `true`)*: If `summarizeMetrics` is provided, writes an executive KPI / summary table on the target sheet (e.g. offset columns `P1:R10` or above data).
- `stripSourceRepeatedHeaders` *(optional boolean, default `true`)*: Automatically detects and ignores repeating pagination headers from ERP exports.

### 3.2 Execution Mechanics
1. **Header Detection**: Uses `detectTableHeaderRow` on the source sheet to locate the true table header row (e.g. Row 4, skipping ERP banner Row 1).
2. **Fast Memory Scan**: Loads source matrix in memory (<5ms), strips repeated headers, and filters matching rows.
3. **Metric Calculation**: Evaluates aggregations (e.g. count & sum grouped by Currency) in memory with robust number parsing (`parseRobustNumber`), handling currency symbols (`$`, `€`, `£`, `USD`) and nulls.
4. **Single-Pass UniverJS Mutation**:
   - Ensures sheet capacity with `ensureSheetCapacity`.
   - Writes all matching rows in **ONE single `setValues` call** (<15ms).
   - If `writeSummaryBlock` is enabled, formats a clean summary table right beside or above the dataset in a single call.
5. **Output**:
   - Returns structured counts, metrics, and a formatted Markdown summary table for instant user presentation.

---

## 4. Engine & Orchestrator Hardening

### 4.1 Coordinate Clamping in `executeInspectRange`
- When `rangeA1` is parsed, clamp `endRow = Math.min(parsed.endRow, maxSheetRows - 1)` and `endCol = Math.min(parsed.endCol, maxSheetCols - 1)`.
- Strip `sheetPrefix` before passing to `sheet.getRange(localRange)`.
- If the requested range starts beyond sheet boundaries, return a clear descriptive error rather than empty `totalRows: 0`.

### 4.2 Sheet Prefix Normalization in `shouldBlockDuplicateToolCall`
- Normalize `targetSheet` by checking `parseA1RangeBounds(args.rangeA1).sheetPrefix` if `args.sheetName` is omitted.

### 4.3 Anti-Micro-Mutation Circuit Breaker in Orchestrator
- Detect if the LLM attempts to call `mutate_cells` on consecutive single columns of the same row range (e.g., `P2:P132`, then `Q2:Q132`, then `R2:R132`).
- Block the repetitive loop and advise the LLM to use `filter_slice_dataset` or a single 2D matrix mutation.

---

## 5. Verification & Testing Strategy
1. **Unit Tests (`analystAndSanitizer.test.ts`)**:
   - `filter_slice_dataset`: Filters rows by condition (`Status == 'Cancelled'`), creates target sheet, copies all columns in 1 call.
   - `filter_slice_dataset`: Computes count and sum grouped by `Currency` with `summarizeMetrics`, writing summary block and returning Markdown table.
   - `filter_slice_dataset`: Skips ERP Row 1 banner and strips repeating pagination headers.
   - `filter_slice_dataset`: Derives missing metric column on the fly (`Quantity * UnitPrice`).
   - `inspect_range`: Clamps out-of-bounds row coordinates (e.g. `A4:O2260` on 2,224-row sheet) without returning 0 rows.
2. **Orchestrator Test (`radarAndOrchestrator.test.ts`)**:
   - Duplicate tool call blocker respects sheet prefixes from `rangeA1`.
   - Anti-micro-mutation circuit breaker triggers on repeated single-column mutations.
3. **Full Test Suite & Production Build**:
   - Run all 32+ tests via `npx tsx --test`.
   - Run `npm run build` to verify 0 TypeScript/Next.js errors.
