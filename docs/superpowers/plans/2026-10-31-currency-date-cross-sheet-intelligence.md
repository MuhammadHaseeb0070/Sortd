# Currency Parsing, Cross-Sheet FX Imputation & Locale-Aware Date Standardization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Permanently resolve cross-sheet lookup formula errors, micro-mutation thrashing on currency derivation, and unparseable date audit failures by implementing `clean_and_impute_currency` and upgrading `standardize_dates`.

**Architecture:**
- Create `clean_and_impute_currency` in `sanitizer` and `core`: parses international currencies (`1.299,00 €`, `¥15,800`) into separated numeric amounts and ISO codes, and performs in-memory cross-sheet Product list price + daily FX conversion for blanks, leaving existing values untouched.
- Upgrade `standardize_dates`: add `countryColumn` (US month-first vs EU day-first), `insertPlacement: 'right_of_source'`, `strictNoGuess`, and a structured Markdown audit table of unparseable row numbers.
- Update `BASE_SYSTEM_PROMPT` and profile prompt fragments with explicit guidance for currency parsing, cross-sheet derivation, and country-based date standardization.

**Tech Stack:** TypeScript, Node.js Test Runner (`tsx --test`), Next.js 16.4.3 Turbopack, UniverJS v1.2.0.

**Spec:** `docs/superpowers/specs/2026-10-31-currency-date-cross-sheet-intelligence-design.md`

## Global Constraints
- Use `detectTableHeaderRow` and `resolveColumnSmart` across all tools.
- All grid mutations must expand sheet capacity with `ensureSheetCapacity` and perform vectorized batch operations.
- All existing 40 tests must continue passing with zero regressions.

---

### Task 1: Overhaul of `standardize_dates` (Country Convention, Right-Insertion, Unparseable Audit)

**Files:**
- Modify: `src/ai/profiles/sanitizer/executors.ts`, `src/ai/profiles/sanitizer/tools.ts`
- Test: `src/ai/profiles/__tests__/analystAndSanitizer.test.ts`

- [x] **Step 1: Write failing tests in `analystAndSanitizer.test.ts`**
  - Test 1: `executeStandardizeDates`: uses `countryColumn` to parse US dates as MM/DD/YYYY and others as DD/MM/YYYY.
  - Test 2: `executeStandardizeDates`: inserts clean ISO column right after source column, placing header in true table header row.
  - Test 3: `executeStandardizeDates`: leaves invalid/impossible dates blank in `strictNoGuess` mode and returns structured Markdown audit table with Excel row numbers.
- [x] **Step 2: Run test to confirm failures**
- [x] **Step 3: Implement upgrades in `executeStandardizeDates`**
  - Integrate `detectTableHeaderRow` for header/startRow resolution.
  - Add `countryColumn` row-by-row resolution.
  - Add `insertPlacement: 'right_of_source'`.
  - Add `strictNoGuess` and `unparseableAudit` reporting.
- [x] **Step 4: Update tool definition in `sanitizer/tools.ts`**
- [x] **Step 5: Run tests to verify all pass**

---

### Task 2: Implement `clean_and_impute_currency`

**Files:**
- Modify: `src/ai/profiles/sanitizer/executors.ts`, `src/ai/profiles/sanitizer/tools.ts`, `src/ai/profiles/core/tools.ts`
- Test: `src/ai/profiles/__tests__/analystAndSanitizer.test.ts`

- [x] **Step 1: Write failing tests in `analystAndSanitizer.test.ts`**
  - Test 1: `executeCleanAndImputeCurrency`: parses mixed international currency text (`1.299,00 €`, `¥15,800`, `$100.50`), separating numeric amount and ISO currency code.
  - Test 2: `executeCleanAndImputeCurrency`: cross-sheet list price lookup from `Products` and daily FX conversion from `FX_Rates` to impute ONLY blanks, keeping existing values untouched.
  - Test 3: `executeCleanAndImputeCurrency`: handles ERP export with Row 1 banner and repeated headers.
- [x] **Step 2: Run test to confirm failures**
- [x] **Step 3: Implement `executeCleanAndImputeCurrency` in `src/ai/profiles/sanitizer/executors.ts`**
  - Robust currency symbol mapping (`€` -> `EUR`, `¥` -> `JPY`, `$` -> `USD`, `£` -> `GBP`, `₹` -> `INR`, etc.).
  - European decimal comma parser (`1.299,00` -> `1299.00`).
  - Cross-sheet in-memory cache for `Products` and `FX_Rates`.
  - Batch single-pass `setValues` on target columns.
- [x] **Step 4: Register tool in `sanitizer/tools.ts` and `core/tools.ts`**
- [x] **Step 5: Run tests to verify all pass**

---

### Task 3: System Prompts & Orchestrator Alignment

**Files:**
- Modify: `src/ai/orchestrator.ts` (`BASE_SYSTEM_PROMPT` and `inferTurnStartingProfile`)
- Modify: `src/ai/profiles/sanitizer/prompt.ts`, `src/ai/profiles/core/prompt.ts`

- [x] **Step 1: Update `BASE_SYSTEM_PROMPT` with currency parsing and country-date rules**
- [x] **Step 2: Update `sanitizer/prompt.ts` and `core/prompt.ts`**
- [x] **Step 3: Update `inferTurnStartingProfile` with currency and FX keywords**

---

### Task 4: Full Suite Verification & Production Build

**Files:**
- Test: Full unit test suite (`npx tsx --test ...`)
- Build: `npm run build`

- [x] **Step 1: Run all 40+ unit and integration tests**
- [x] **Step 2: Run `npm run build`**
