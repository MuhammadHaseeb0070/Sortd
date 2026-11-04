# Sortd Next-Gen Intelligence, Reliability & Domain-Expert Overhaul — Design Specification

## 1. Objective
Transform Sortd Studio (`d:\Sortd`) from a basic tool-calling spreadsheet wrapper into a zero-silent-failure, token-efficient, domain-expert AI Data Engineer & Spreadsheet Studio with:
1. **Zero Silent Failures (`src/ai/utils/univerBridge.ts` & `src/ai/middleware/formulaVerifier.ts`)**:
   - Row-1-header-first column resolution (`resolveColumnSmart`) so single-word headers (`"Region"`, `"Sales"`, `"Email"`, `"Price"`) never get misinterpreted as base-26 Excel column indices (`212,072,729`).
   - Automatic sheet grid capacity expansion (`ensureSheetCapacity`) before every range write so rows/columns beyond initial `rowCount`/`columnCount` never clip invisibly on Univer's canvas.
   - UniverJS v1.2.0 alignment normalization (`mapHorizontalAlignment`: `'right' -> 'normal'`).
   - Cross-sheet targeting (`sheetName`) across all Core tools (`mutate_cells`, `profile_columns`, `style_range`, `modify_structure`), plus `keepCurrentActiveSheet` support when creating sheets and instant UI tab-bar synchronization (`onWorkbookMutated` -> `refreshTelemetry()`).
   - Real `formulaVerifier` error reporting (never returning `SUCCESS` on null ranges or thrown exceptions, checking `getFormulaError()`, and adaptive calculation polling).
2. **Compact Multi-Sheet `WorkbookRadar` v2 & Adaptive Progress-Aware Orchestrator (`src/ai/radar.ts`, `src/ai/orchestrator.ts`)**:
   - Full-column in-memory scan (`up to 50,000 rows`) + multi-sheet schema indexing (`allSheets` includes `occupiedBounds`, `populatedRows`, and `headers: Array<{col, name, type}>` for every sheet in the workbook so creating a new sheet never causes amnesia of `Sheet1`).
   - Full distinct value distribution for low-cardinality categorical columns ($\le 25$ unique values), removing the "Frequency Dead Zone", plus automatic **Categorical Entity Collision Detection** (`North` vs `N`, `N.`; `West` vs `W`) and **Embedded Subtotal/Grand Total Trap Detection**.
   - Compact Markdown Radar serializer (`formatCompactRadarForPrompt`) reducing per-step system prompt overhead by ~85% (~500 tokens vs ~6,000 tokens).
   - Replace hardcoded `MAX_AUTONOMOUS_STEPS = 6` with an **Adaptive Progress-Aware Loop Controller**:
     - Zero-turn `switch_profile` hot-swapping (updates `activeProfile` and `availableTools` in-place within the current loop without burning a step, plus mounts cross-profile discovery).
     - Duplicate tool+args call blocker & 3-consecutive-error circuit breaker.
     - Soft step budget (`12`) that auto-extends up to `24` when verified workbook/analytical progress occurs.
     - `finish_reason` recovery (`malformed_function_call` / `length`) and a guaranteed final synthesis pass (never dumping `"Actions completed."` or leaving dangling `role: 'tool'` messages).
3. **Human-in-the-Loop Highlighted In-Sheet Diff Confirmation Gate & Instant Stop Button (`src/components/AIWorkbenchSidebar.tsx`, `src/ai/orchestrator.ts`, `src/app/api/chat/route.ts`)**:
   - End-to-end `AbortController` (`Stop` button in `AIWorkbenchSidebar.tsx` + `Escape` shortcut) propagating through `orchestrator.ts` and `/api/chat/route.ts`, with clean `rawHistory` hygiene and Turn-Level Snapshot Undo (`activeWorkbook.save()`).
   - Turn-Batched **In-Sheet Diff Preview & Confirmation Gate**:
     - Pre-turn workbook snapshot checkpoint (`activeWorkbook.save()`).
     - Staged mutations highlight modified/added cells directly on the UniverJS canvas (`#dcfce7` emerald for new cells/rows, `#fef3c7` amber for modified cells) and display a sticky **Confirm Changes / Reject & Revert** bar in `AIWorkbenchSidebar.tsx` (with an `"Ask Before Edits"` toggle defaulting to ON).
     - Clicking **Confirm** strips temporary diff highlights while preserving intended styles; clicking **Reject** atomically restores the pre-turn workbook snapshot (`<20ms`) and refreshes tabs.
4. **Domain-Expert Overhaul Across All 7 Profiles & All 44+ Tools**:
   - **`sanitizer`**: 6-Gate Hygiene Constitution + new `inspect_and_cluster_categories` tool (deterministic + synonym/compass abbreviation + Jaro-Winkler clustering with alphanumeric ID protection); fix `synthesize_columns` column-shift bug, `deduplicate_dataset` substring-delete bug, and `impute_data` `groupAgg` & `expression` row context.
   - **`analyst`**: Minto Pyramid + 6-Point Diagnostic Constitution; fix `statistical_deep_dive` in-place sort before Pearson `r` correlation; fix `generate_crosstab_pivot` `?? 1` null coercion & return full pivot preview; fix `what_if_scenario_modeler` driver column polarity (`cost` vs `revenue`); add pre-aggregation dirty-category auto-normalization & live `SUMIFS`/`AVERAGEIFS` formula mode (`outputMode: 'formulas' | 'values'`).
   - **`visualizer` & `VisualChartCard.tsx`**: Few/Munzner/IBCS Guardrail Constitution + Pre-Plot Cardinality/Granularity Engine (constructive pushback + auto-aggregation/Top-10 + `"Other"` rollup, Freedman-Diaconis histogram binning, X/Y scatter pairing on high-row-count numeric columns); implement all 15 chart types in `VisualChartCard.tsx` (`column`, multi-series `bar` with Y-labels, `line`, `area`, `donut`, `combo_dual_axis`, `scatter`, `bubble`, `histogram`, `pareto`, `waterfall`, `box_plot`, `funnel`, `radar`, `treemap`); fix `create_threshold_rule` string corruption.
   - **`formula_pro`, `architect`, `auditor`, & `excel-io.ts`**:
     - Fix `compose_aggregation` `'contains'` wildcard (`"*val*"`); fix `cascade_dynamic_arrays` spill clearing width; upgrade `validate_and_heal_formulas` to repair sheet-name quotes, range bounds, and `#DIV/0!` guards before falling back to `IFERROR`.
     - Fix `architect/format_numbers` right-alignment (`'normal'`); add borders, `setFrozenRows(1)`, and fast batch styling to `style_table_hierarchy`.
     - Implement real `balance_sheet_identity` reconciliation, cross-sheet range dependency matching (`B5` inside `Sheet1!B2:B10`), and hidden row/column scanning in `auditor`.
     - Preserve dates, column widths, merges, and number formats in `excel-io.ts`.
