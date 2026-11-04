# Currency Parsing, Cross-Sheet FX Imputation & Locale-Aware Date Standardization — Design Specification

## 1. Problem Diagnosis & Trace Breakdown

### Trace 1 Breakdown:
Prompt: *"Unit Price has text like 1.299,00 with a euro sign and 15,800 with a yen sign, and some blanks. Make a numeric local-currency Unit Price and a clean Currency code column. For blanks, derive the price from the Products list price converted at that day's FX. Tell me how many you derived and do not touch the cells that already had a value."*

**Failure Modes:**
1. **Missing Currency Parser & Cross-Sheet Imputer**:
   - Sortd had no tool to parse international currency formatting (`1.299,00 €`, `¥15,800`) into separated numeric amounts and ISO currency codes (`EUR`, `JPY`).
   - The AI attempted to write Excel formulas (`VLOOKUP` / `INDEX MATCH`) across worksheets (`Orders`, `Products`, `FX_Rates`) using low-level `mutate_cells` on micro-ranges 4 cells at a time (`S1:S4`, `S1:S5`, `T1:T4`, `T5:T8`, `T9:T11`, `S5:S7`, `T12`).
   - Complex cross-sheet formula syntax in UniverJS generated calculation errors (`Encountered 1 formula calculation error(s)...`), burning steps and freezing the engine until it timed out.

### Trace 2 Breakdown:
Prompt: *"Order Date is a mess. Add a clean ISO date column right after it. Slash dates follow the customer's country convention: US is month first, everyone else is day first. Anything you cannot parse or that looks wrong, leave blank and list it with the row number. Do not guess."*

**Failure Modes:**
1. **`standardize_dates` Parameter Deficiency**:
   - `standardize_dates` hardcoded `headerRowIdx = 0` and `startRow = 2`, failing on ERP exports where Row 1 is a report banner.
   - It lacked support for dynamic row-by-row locale conventions (`countryColumn`: US = month-first, others = day-first).
   - It lacked column insertion placement (`insertPlacement: 'right_of_source'`).
   - It lacked an audit trail of unparseable rows, forcing the AI to abandon the tool, attempt ad-hoc `synthesize_columns`, and ultimately output an apologetic failure message admitting it could not list the unparseable row numbers.

---

## 2. Solution Architecture

### Subsystem 1: `clean_and_impute_currency`
A dedicated, in-engine vectorized tool in `sanitizer` and `core` that:
1. **Parses Mixed International Currency Strings**:
   - Auto-detects European decimal comma / period thousands (`1.299,00 €` -> `1299.00`, `EUR`) and Asian/Anglo formats (`¥15,800` -> `15800.00`, `JPY`; `$1,299.00` -> `1299.00`, `USD`).
   - Extracts standard ISO currency codes (`EUR`, `JPY`, `USD`, `GBP`, `CHF`, `CAD`, `AUD`, `CNY`, `INR`, etc.).
2. **Performs In-Memory Cross-Sheet Lookup & FX Conversion**:
   - For rows where the price is blank:
     - Looks up base product price from `Products` sheet on `ProductID` or `SKU`.
     - Looks up daily exchange rate from `FX_Rates` sheet on `Date` + `Currency`.
     - Calculates converted price in local currency.
     - Populates **ONLY blank cells**, leaving existing values completely untouched.
3. **Structured Audit Receipt**:
   - Reports exact counts: `existingCleanedCount`, `derivedCount`, `untouchedCount`.
   - Returns a clean Markdown summary table with preview samples.
   - Runtime: **<50ms** in 1 single tool call.

### Subsystem 2: Overhaul of `standardize_dates`
Enhance `executeStandardizeDates` with:
1. **Dynamic True Header Detection**: Uses `detectTableHeaderRow` to find the real header row and start data row, perfectly supporting ERP title banners.
2. **Row-by-Row Country/Locale Convention (`countryColumn`)**:
   - Inspects the specified country column per row. If country is US (`"US"`, `"USA"`, `"United States"`), evaluates slash dates as `MM/DD/YYYY`. Otherwise, evaluates as `DD/MM/YYYY`.
3. **Column Insertion Placement (`insertPlacement`)**:
   - `'right_of_source'`: Inserts the new column directly right of the date column, placing the header in the true header row.
   - `'overwrite'`: Replaces the source column.
   - `'append'`: Appends to the end of the sheet.
4. **Strict No-Guess Mode (`strictNoGuess: true`) & Year Bounds (`allowedYearRange`)**:
   - Does not guess ambiguous 2-digit years or impossible dates (`2025-02-30`). Leaves them blank.
5. **Structured Audit Table (`auditUnparseable: true`)**:
   - Returns an array and Markdown table of unparseable rows with their exact Excel row numbers, raw values, country, and failure reason.

---

## 3. Verification & Test Plan
1. Unit tests for `clean_and_impute_currency`:
   - Parses mixed international currencies (`1.299,00 €`, `¥15,800`, `$100.50`).
   - Cross-sheet list price lookup and daily FX rate conversion for blanks.
   - Preserves existing values untouched.
2. Unit tests for upgraded `standardize_dates`:
   - Country-based slash date resolution (US month-first vs EU day-first).
   - Insertion right of source column with header aligned to true header row.
   - Returns structured Markdown table of unparseable rows with Excel row numbers.
3. Full test suite passing (all 40+ tests) + Next.js production build (`npm run build`).
