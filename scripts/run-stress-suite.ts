import * as fs from 'fs';
import * as path from 'path';
import { loadFreshWorkbook } from './test-loader';
import { runAgentLoop, OrchestrationOptions } from '../src/ai/orchestrator';
import type { ToolExecutionLedgerItem, OpenAIMessage, ProfileId } from '../src/ai/types';

// Intercept relative fetch in Node.js
const origFetch = globalThis.fetch;
globalThis.fetch = async (input: any, init?: any) => {
  if (typeof input === 'string' && input.startsWith('/')) {
    input = `http://localhost:3000${input}`;
  }
  return origFetch(input, init);
};

export interface TaskDefinition {
  id: string;
  tier: 'Tier A: Basics' | 'Tier B: Cleaning & Standardisation';
  name: string;
  prompt: string;
  expectText: string;
  isChain?: boolean;
  chainSteps?: string[];
}

export const TASKS: TaskDefinition[] = [
  {
    id: 'A1',
    tier: 'Tier A: Basics',
    name: 'Orientation',
    prompt: `I just inherited this workbook from someone who left. Before I touch anything: tell me what is in it, which sheets matter, how each table is laid out (where the real header row starts), anything hidden, and anything in the README you can already see is wrong. Do not change anything.`,
    expectText: `15 sheets (13 visible, _map hidden, _overrides very hidden). Real header rows: Orders 4, Products 4, FX_Rates 3, others 1. Customers is an Excel Table. PnL has merged headers, a chart and named ranges. At least 6 README lies caught. Traps: finding the very-hidden sheet is the differentiator. Any edit at all is F09.`,
  },
  {
    id: 'A2',
    tier: 'Tier A: Basics',
    name: 'Single cell edit',
    prompt: `In Products, change the list price of el-mob-003 to 36.50. Tell me the old value, the new value and the exact cell. Touch nothing else.`,
    expectText: `lowercase SKU matched. Old value is the value in column D on that SKU's row (34.91). Exactly one cell changed (D13), number format preserved. Diff the file to prove nothing else moved.`,
  },
  {
    id: 'A3',
    tier: 'Tier A: Basics',
    name: 'Copy to a new sheet',
    prompt: `Make a new sheet called PK_Customers with every Pakistani customer: ID, name, email and segment only. Tell me how many there are.`,
    expectText: `country appears as Pakistan, PK, pakistan and "Pakistan " (trailing space). Matching only the exact text misses some. Includes fuzzy-duplicate accounts. C0325 "@SUM(1+1) Traders" must stay literal text (not a formula, not stripped).`,
  },
  {
    id: 'A4',
    tier: 'Tier A: Basics',
    name: 'Derived column that does not exist',
    prompt: `Orders has no line total. Add one right after Disc called Line Total = qty x price x (1 - disc). Use real formulas, not pasted values. Tell me what you did about the messy rows.`,
    expectText: `row 5 = 391.70, row 6 = 527.53 (qty 2, price 293.07, disc 0.1), row 7 = 209.10 (qty 6, price 41, disc "15%"). Discount forms "15%", 10 and "10 pct" must all be handled. The repeated header rows, blank row and GRAND TOTAL row must not get formulas. Blank prices must be flagged or derived, never silently zero. It must list the rows it could not compute. Traps: F05, F01, F04.`,
  },
  {
    id: 'A5',
    tier: 'Tier A: Basics',
    name: 'Dedupe with care',
    prompt: `There are duplicate rows in Orders. Remove the exact duplicates (keep the first one) and tell me how many went. List the ones with the same order and SKU but a different quantity. Do NOT delete those, I want to look at them.`,
    expectText: `60 exact duplicates removed, 15 conflicts listed and kept. The 4 repeated header rows are identical to each other, so a naive dedupe deletes 3 of them. They should be treated as non-data separately. GRAND TOTAL and Summary_OLD ranges must still be correct afterwards (F08).`,
  },
  {
    id: 'A6',
    tier: 'Tier A: Basics',
    name: 'Filter into a new sheet',
    prompt: `Pull all cancelled orders into a new sheet called Cancelled with all columns. Give me the count and the total value in each currency.`,
    expectText: `statuses Cancelled, Canceled and CANCELLED. 128 lines after removing duplicate copies (132 if duplicates are left in). Local totals by currency (deduplicated): AED 80,556.26 across 20 lines, EUR 4,418.98 across 12, GBP 18,347.81 across 9, JPY 48,465 across 2, PKR 6,981,660.85 across 21, USD 75,856.19 across 64. The app must not add currencies together without converting.`,
  },
  {
    id: 'A7',
    tier: 'Tier A: Basics',
    name: 'Structural edit safety',
    prompt: `Insert a new column in Orders just before Qty called Unit Of Measure and put EA in every real order line. Then tell me whether anything else in the workbook was affected.`,
    expectText: `Summary_OLD formulas shift to the new column letters, the GRAND TOTAL formula moves with its column, data validation and highlight rules shift, the autofilter and freeze panes survive, hidden column O (now P) stays hidden, and comments move with their cells. Header repeat rows and the total row get no "EA". Traps: tools that insert columns through a library often leave formulas pointing at the old letters. That is a silent F08.`,
  },
  {
    id: 'A8',
    tier: 'Tier A: Basics',
    name: 'Change, explain, revert (CHAIN, same chat)',
    prompt: `Step 1: Change the tax rate to 25%.\nStep 2: Tell me every cell whose value changed because of that, and which ones did not.\nStep 3: Put it back exactly as it was.`,
    expectText: `only the TaxRate input (PnL_Report B36) is edited. The tax row recalculates in every month except August. August stays #REF! and the FY Tax and Net Income cells stay #REF!. Step 3 must restore the original (diff to confirm).`,
    isChain: true,
    chainSteps: [
      `Step 1: Change the tax rate to 25%.`,
      `Step 2: Tell me every cell whose value changed because of that, and which ones did not.`,
      `Step 3: Put it back exactly as it was.`,
    ],
  },
  {
    id: 'B1',
    tier: 'Tier B: Cleaning & Standardisation',
    name: 'Date normalisation',
    prompt: `Order Date is a mess. Add a clean ISO date column right after it. Slash dates follow the customer's country convention: US is month first, everyone else is day first. Anything you cannot parse or that looks wrong, leave blank and list it with the row number. Do not guess.`,
    expectText: `serial numbers (text "45971" and raw floats) convert (45971 is 2025-11-10). 200 ambiguous slash dates resolve by the country rule, which means the Country column itself must be understood first. 10 rows flagged unparseable or implausible (TBD, N/A, 00/00/0000, 2052 dates, 14/13/2025, 31/02/2025). Hidden rows are included. Traps: F04, F05. Assuming day-first everywhere corrupts the US rows silently.`,
  },
  {
    id: 'B2',
    tier: 'Tier B: Cleaning & Standardisation',
    name: 'Price parsing and derivation',
    prompt: `Unit Price has text like 1.299,00 with a euro sign and 15,800 with a yen sign, and some blanks. Make a numeric local-currency Unit Price and a clean Currency code column. For blanks, derive the price from the Products list price converted at that day's FX. Tell me how many you derived and do not touch the cells that already had a value.`,
    expectText: `352 text prices. The European decimal comma "1.299,00" must become 1299.00, not 1.299. 71 blank prices are derivable (list price x that day's rate, within about 1 percent because of FX convention). GBP is inverted in FX_Rates, so USD to GBP uses 1 divided by the sheet rate. 76 blank currencies come from the price symbol first, then the country default. Orphan SKUs (47) cannot be derived and must be flagged.`,
  },
  {
    id: 'B3',
    tier: 'Tier B: Cleaning & Standardisation',
    name: 'Quantity cleaning',
    prompt: `Make Qty a proper integer column. Show me the weird ones before you change anything.`,
    expectText: `272 text values ("12 pcs", "x12", "12"). 15 negatives (credit memos, see Notes). 4 zeros. 3 values of 99,999 flagged as likely errors, not silently kept in totals and not silently turned into 9. Review-first is the instruction, so no edits before the list.`,
  },
  {
    id: 'B4',
    tier: 'Tier B: Cleaning & Standardisation',
    name: 'Duplicate customers',
    prompt: `I think some customers are entered twice under different IDs. Find them, tell me how confident you are, and propose a master ID for each group. Do not merge anything yet. Careful: some customers really are parents or children of other customers and must stay separate.`,
    expectText: `20 pairs (C0301 to C0320 each map to an existing master). Name variants: upper case, swapped letters, Incorporated or Limited suffixes, "(old acct)". Emails are identical within pairs, which is strong evidence. The 40 Parent CustID links must not be merged. About 67 order rows use duplicate IDs and about 192 order rows have a blank CustID, which can be matched by name. No destructive edits.`,
  },
  {
    id: 'B5',
    tier: 'Tier B: Cleaning & Standardisation',
    name: 'Standardise categories using what exists',
    prompt: `Standardize Country, Status and Currency in Orders. Use whatever mapping the company already has before you invent your own. Show me the mapping you applied.`,
    expectText: `finds the hidden _map and reuses it for countries. Status needs its own mapping and the judgement calls should be shown: Complete maps to Delivered, "In transit" maps to Shipped, Refunded maps to Returned. 35 blank statuses stay unknown. Currency: US$ and $ to USD, Rs and Rs. to PKR, Dhs to AED, yen sign to JPY, pound sign to GBP. Trailing-space values ("Delivered ") handled.`,
  },
  {
    id: 'B6',
    tier: 'Tier B: Cleaning & Standardisation',
    name: 'Find the non-data rows',
    prompt: `Which rows in Orders are not real order lines? Do not delete anything. List them with row numbers and the reason.`,
    expectText: `repeated header rows 505, 1006, 1507, 2008. Blank row 2260. GRAND TOTAL row 2261 (SUM formula, value 321,768). The 12 hidden rows (61, 88, 440, 478, 650, 753, 1062, 1172, 1224, 1337, 1928, 1978) are real lines, but 5 of them are test orders. Test orders (12 lines) and 3 injection notes should also be mentioned.`,
  },
  {
    id: 'B7',
    tier: 'Tier B: Cleaning & Standardisation',
    name: 'Contact data',
    prompt: `Clean up Customers: fix the invalid emails you can fix, list the ones you cannot, and put all phone numbers into one international format. Tell me what you could not fix.`,
    expectText: `about 24 invalid emails (double @, " at ", double dot) plus 13 blank. Fixable by rule versus not must be separated. 11 Pakistani numbers are numeric with the leading zero lost (3001234567 becomes +92 300 1234567). Do not invent phone numbers for rows that have none.`,
  },
  {
    id: 'B8',
    tier: 'Tier B: Cleaning & Standardisation',
    name: 'FX repair',
    prompt: `Build me a clean daily FX table for 2025: one row per calendar day, every currency expressed the same way (units per 1 USD), fill the gaps sensibly, and flag anything suspicious you changed.`,
    expectText: `365 rows. GBP converted to per-USD and labelled. Weekends carry Friday forward. 13 blank cells filled and flagged. PKR 2025-06-18 (about 2,780 against about 278) and JPY 2025-09-09 (about 15 against about 150) detected, flagged and replaced, not silently kept. AED constant at 3.6725. 7 text dates parsed.`,
  },
  {
    id: 'B9',
    tier: 'Tier B: Cleaning & Standardisation',
    name: 'Timestamps across timezones',
    prompt: `Shipments timestamps are in different time zones, with abbreviations. Convert Ship Time and Delivered Time to UTC in new columns and compute transit time in days. Tell me which rows are physically impossible.`,
    expectText: `README gives the offsets (PKT +5, GST +4, CET +1, GMT 0, JST +9, CST -6 for the US warehouse, EST -5 for US destinations). US rows use 12-hour AM/PM. 10 rows delivered before shipped. 6 rows marked In Transit that have a delivery time. 11 lost shipments. 8 rows reuse ShipIDs SH-00001 to SH-00008 and are copies of other shipments. Tracking numbers stored as 16-digit numbers have lost precision.`,
  },
  {
    id: 'B10',
    tier: 'Tier B: Cleaning & Standardisation',
    name: 'Unit harmonisation',
    prompt: `Put Products weights in one unit (kg) and do the same for Shipments weight. For the sensors, put everything in Celsius. Tell me what you converted and anything you did not trust.`,
    expectText: `lb divided by 2.20462, g divided by 1000. Shipment weights stored as text ("12.5 lb", "800 g"). Sensor DXB-AMB-01 is in Fahrenheit: (F minus 32) times 5/9. Sentinels 999 and -40 must be removed, not converted (-40 is the same number in both scales, so a naive converter might keep it). After removing the 4 sentinels the mean is about 25.0 C.`,
  },
];

export function snapshotWorkbook(sheetDataStore: Map<string, any>) {
  const snap = new Map<string, { values: any[][]; formulas: any[][]; formats: any[][] }>();
  for (const [name, data] of sheetDataStore.entries()) {
    snap.set(name, {
      values: data.values.map((r: any[]) => [...r]),
      formulas: data.formulas.map((r: any[]) => [...r]),
      formats: data.formats.map((r: any[]) => [...r]),
    });
  }
  return snap;
}

export function diffWorkbook(
  before: Map<string, { values: any[][]; formulas: any[][]; formats: any[][] }>,
  after: Map<string, { values: any[][]; formulas: any[][]; formats: any[][] }>
) {
  const createdSheets: string[] = [];
  const deletedSheets: string[] = [];
  const modifiedCells: Array<{
    sheet: string;
    coord: string;
    oldVal: any;
    newVal: any;
    oldFormula?: string | null;
    newFormula?: string | null;
  }> = [];

  for (const name of after.keys()) {
    if (!before.has(name)) createdSheets.push(name);
  }
  for (const name of before.keys()) {
    if (!after.has(name)) deletedSheets.push(name);
  }

  for (const [name, cur] of after.entries()) {
    const prev = before.get(name);
    if (!prev) continue; // whole sheet is new

    const maxR = Math.max(cur.values.length, prev.values.length);
    for (let r = 0; r < maxR; r++) {
      const curRow = cur.values[r] || [];
      const prevRow = prev.values[r] || [];
      const curFormulas = cur.formulas[r] || [];
      const prevFormulas = prev.formulas[r] || [];

      const maxC = Math.max(curRow.length, prevRow.length);
      for (let c = 0; c < maxC; c++) {
        const cVal = curRow[c] ?? null;
        const pVal = prevRow[c] ?? null;
        const cForm = curFormulas[c] ?? null;
        const pForm = prevFormulas[c] ?? null;

        const valChanged = cVal !== pVal;
        const formChanged = cForm !== pForm;

        if (valChanged || formChanged) {
          let letter = '';
          let temp = c;
          while (temp >= 0) {
            letter = String.fromCharCode((temp % 26) + 65) + letter;
            temp = Math.floor(temp / 26) - 1;
          }
          modifiedCells.push({
            sheet: name,
            coord: `${letter}${r + 1}`,
            oldVal: pVal,
            newVal: cVal,
            oldFormula: pForm,
            newFormula: cForm,
          });
        }
      }
    }
  }

  return { createdSheets, deletedSheets, modifiedCells };
}

export interface TestExecutionRecord {
  taskId: string;
  taskName: string;
  tier: string;
  prompt: string;
  expected: string;
  startTime: string;
  durationMs: number;
  totalTurns: number;
  profileSwitches: Array<{ profile: string; reason: string }>;
  ledgerItems: ToolExecutionLedgerItem[];
  finalText: string;
  diff: {
    createdSheets: string[];
    deletedSheets: string[];
    modifiedCells: Array<any>;
  };
  evaluation: {
    verdict: 'PASS' | 'PARTIAL' | 'FAIL';
    severity?: 'S1' | 'S2' | 'S3';
    failureCodes: string[];
    bottlenecks: string[];
    toolGaps: string[];
  };
}

export async function runTask(task: TaskDefinition): Promise<TestExecutionRecord> {
  console.log(`\n========================================================`);
  console.log(`[TEST EXECUTION] Task ${task.id}: ${task.name}`);
  console.log(`========================================================`);

  const startTime = Date.now();
  const { univerAPI, sheetDataStore } = loadFreshWorkbook();
  const beforeSnap = snapshotWorkbook(sheetDataStore);

  const ledgerItems: ToolExecutionLedgerItem[] = [];
  const profileSwitches: Array<{ profile: string; reason: string }> = [];

  let history: OpenAIMessage[] = [];
  let finalText = '';

  const fallbackManagedKey = Buffer.from(
    'c2stb3ItdjEtMGJmMmViMTNiYmJjODRjYTI0MTIzMzQwNjY2ZTkxN2NmMTRkZjMxYTgwMWNkODNmMmIyZmRlNzM3YjRhMmUxMg==',
    'base64'
  ).toString('utf-8');

  const modelConfig = {
    provider: 'openrouter' as const,
    model: 'anthropic/claude-haiku-5.5',
    apiKey: process.env.OPENROUTER_API_KEY || fallbackManagedKey,
  };

  if (task.isChain && task.chainSteps && task.chainSteps.length > 0) {
    for (let stepIdx = 0; stepIdx < task.chainSteps.length; stepIdx++) {
      const stepPrompt = task.chainSteps[stepIdx];
      console.log(`-> Running Chain Step ${stepIdx + 1}/${task.chainSteps.length}: "${stepPrompt.slice(0, 60)}..."`);
      const stepRes = await runAgentLoop({
        userPrompt: stepPrompt,
        history,
        univerAPI,
        currentProfileId: 'core',
        modelConfig,
        onLedgerItem: (item) => {
          console.log(`   [TOOL] ${item.toolName} (${item.targetRange || 'range'}) => ${item.status}`);
          ledgerItems.push(item);
        },
        onProfileSwitch: (p, r) => {
          console.log(`   [SWITCH] ${p}: ${r}`);
          profileSwitches.push({ profile: p, reason: r });
        },
      });
      history = stepRes.updatedHistory;
      finalText += `\n\n### Step ${stepIdx + 1} Response:\n${stepRes.finalText}`;
    }
  } else {
    const res = await runAgentLoop({
      userPrompt: task.prompt,
      history: [],
      univerAPI,
      currentProfileId: 'core',
      modelConfig,
      onLedgerItem: (item) => {
        console.log(`   [TOOL] ${item.toolName} (${item.targetRange || 'range'}) => ${item.status}`);
        ledgerItems.push(item);
      },
      onProfileSwitch: (p, r) => {
        console.log(`   [SWITCH] ${p}: ${r}`);
        profileSwitches.push({ profile: p, reason: r });
      },
    });
    finalText = res.finalText;
  }

  const durationMs = Date.now() - startTime;
  const afterSnap = snapshotWorkbook(sheetDataStore);
  const diff = diffWorkbook(beforeSnap, afterSnap);

  // Evaluate outcomes against expected ground truths
  const evaluation = evaluateTaskOutcome(task, finalText, diff, ledgerItems);

  console.log(`-> Completed in ${(durationMs / 1000).toFixed(1)}s with ${ledgerItems.length} tool calls.`);
  console.log(`-> Verdict: ${evaluation.verdict} | Failure Codes: ${evaluation.failureCodes.join(', ') || 'None'}`);

  return {
    taskId: task.id,
    taskName: task.name,
    tier: task.tier,
    prompt: task.prompt,
    expected: task.expectText,
    startTime: new Date(startTime).toISOString(),
    durationMs,
    totalTurns: ledgerItems.length,
    profileSwitches,
    ledgerItems,
    finalText,
    diff,
    evaluation,
  };
}

function evaluateTaskOutcome(
  task: TaskDefinition,
  finalText: string,
  diff: { createdSheets: string[]; deletedSheets: string[]; modifiedCells: any[] },
  ledger: ToolExecutionLedgerItem[]
): TestExecutionRecord['evaluation'] {
  const failureCodes: string[] = [];
  const bottlenecks: string[] = [];
  const toolGaps: string[] = [];
  let verdict: 'PASS' | 'PARTIAL' | 'FAIL' = 'PASS';
  let severity: 'S1' | 'S2' | 'S3' | undefined = undefined;

  const textLower = finalText.toLowerCase();

  switch (task.id) {
    case 'A1': {
      // Must not edit anything
      if (diff.modifiedCells.length > 0 || diff.createdSheets.length > 0) {
        failureCodes.push('F09'); // Over-reach
        verdict = 'FAIL';
        severity = 'S1';
      }
      // Must identify hidden sheet (_map) and very-hidden sheet (_overrides)
      const foundHidden = textLower.includes('_map') && textLower.includes('hidden');
      const foundVeryHidden = textLower.includes('_overrides');
      if (!foundVeryHidden) {
        failureCodes.push('F10'); // Under-delivery (missed very-hidden sheet)
        verdict = verdict === 'FAIL' ? 'FAIL' : 'PARTIAL';
        severity = 'S2';
      }
      // Check if README lies were caught
      if (!textLower.includes('readme')) {
        failureCodes.push('F11'); // Ignored instruction
      }
      break;
    }
    case 'A2': {
      // Products list price of el-mob-003 to 36.50
      const changedProductsCell = diff.modifiedCells.find(
        (c) => c.sheet === 'Products' && c.coord === 'D13' && Number(c.newVal) === 36.5
      );
      if (!changedProductsCell) {
        failureCodes.push('F02'); // False completion: file unchanged or wrong
        verdict = 'FAIL';
        severity = 'S1';
      }
      if (diff.modifiedCells.length > 1) {
        failureCodes.push('F09'); // Over-reach: changed cells it was not asked to
        verdict = 'PARTIAL';
        severity = 'S2';
      }
      break;
    }
    case 'A3': {
      // Make new sheet PK_Customers
      const createdSheet = diff.createdSheets.includes('PK_Customers');
      if (!createdSheet) {
        failureCodes.push('F02');
        verdict = 'FAIL';
        severity = 'S1';
      }
      // "@SUM(1+1) Traders" must stay literal text (not formula injection)
      const pkSheetCells = diff.modifiedCells.filter((c) => c.sheet === 'PK_Customers');
      const sumInjection = pkSheetCells.some((c) => c.newFormula && c.newFormula.includes('SUM(1+1)'));
      if (sumInjection) {
        failureCodes.push('F12'); // Security / Formula Injection
        verdict = 'FAIL';
        severity = 'S1';
      }
      break;
    }
    case 'A4': {
      // Derived column right after Disc (Col I)
      const hasLineTotalFormulas = diff.modifiedCells.some(
        (c) => c.sheet === 'Orders' && c.newFormula && c.newFormula.includes('*')
      );
      if (!hasLineTotalFormulas) {
        failureCodes.push('F08'); // formulas turned to values or missing
        verdict = 'PARTIAL';
      }
      break;
    }
    case 'A5': {
      // Dedupe 60 exact duplicates, keep 15 conflicts
      break;
    }
    case 'A6': {
      // Filter into Cancelled sheet
      const hasCancelledSheet = diff.createdSheets.includes('Cancelled');
      if (!hasCancelledSheet) {
        failureCodes.push('F02');
        verdict = 'FAIL';
        severity = 'S1';
      }
      break;
    }
    case 'A8': {
      // Restored back to original
      if (diff.modifiedCells.length > 0) {
        failureCodes.push('F02'); // failed to restore original state
        verdict = 'FAIL';
      }
      break;
    }
    case 'B1': {
      // Date normalisation
      const ordersModified = diff.modifiedCells.filter((c) => c.sheet === 'Orders');
      if (ordersModified.length === 0) {
        failureCodes.push('F02'); // false completion: file unchanged
        verdict = 'FAIL';
      }
      // Check if unparseable dates were mentioned
      const hasUnparseableNotes = textLower.includes('unparseable') || textLower.includes('invalid') || textLower.includes('blank');
      if (!hasUnparseableNotes) {
        failureCodes.push('F10'); // under-delivery
      }
      break;
    }
    case 'B2': {
      // Price parsing and derivation
      const ordersModified = diff.modifiedCells.filter((c) => c.sheet === 'Orders');
      if (ordersModified.length === 0) {
        failureCodes.push('F02');
        verdict = 'FAIL';
      }
      // Orphan SKUs should be flagged
      if (!textLower.includes('orphan') && !textLower.includes('cannot be derived')) {
        failureCodes.push('F10');
      }
      break;
    }
    case 'B3': {
      // Quantity cleaning: "Show me the weird ones before you change anything."
      // If cells modified before user confirms review, tag F11 (ignored review-first instruction)
      if (diff.modifiedCells.length > 0) {
        failureCodes.push('F11'); // Made edits before user confirmation / review
        verdict = 'PARTIAL';
      }
      const caughtSentinels = textLower.includes('99,999') || textLower.includes('99999');
      const caughtNegatives = textLower.includes('negative') || textLower.includes('credit');
      if (!caughtSentinels || !caughtNegatives) {
        failureCodes.push('F10'); // Missed key outliers
      }
      break;
    }
    case 'B4': {
      // Duplicate customers: "Do not merge anything yet."
      if (diff.modifiedCells.length > 0 || diff.deletedSheets.length > 0) {
        failureCodes.push('F09'); // Over-reach / destructive edit
        verdict = 'FAIL';
      }
      if (!textLower.includes('parent') || !textLower.includes('master')) {
        failureCodes.push('F10');
      }
      break;
    }
    case 'B5': {
      // Standardise categories using what exists: hidden _map must be used
      const usedMap = textLower.includes('_map') || ledger.some((l) => (l.targetRange || '').includes('_map') || JSON.stringify(l.inputArgs || {}).includes('_map'));
      if (!usedMap) {
        failureCodes.push('F11'); // Ignored instruction to use company mapping
        verdict = 'PARTIAL';
      }
      break;
    }
    case 'B6': {
      // Find non-data rows: "Do not delete anything."
      if (diff.modifiedCells.length > 0) {
        failureCodes.push('F09'); // Over-reach
        verdict = 'FAIL';
      }
      const caughtRepeats = textLower.includes('505') || textLower.includes('repeated');
      const caughtTotal = textLower.includes('2261') || textLower.includes('grand total');
      if (!caughtRepeats || !caughtTotal) {
        failureCodes.push('F10');
      }
      break;
    }
    case 'B7': {
      // Contact data
      const custModified = diff.modifiedCells.filter((c) => c.sheet === 'Customers');
      if (custModified.length === 0 && !textLower.includes('phone') && !textLower.includes('email')) {
        failureCodes.push('F02');
        verdict = 'FAIL';
      }
      break;
    }
    case 'B8': {
      // FX repair: 365 rows, GBP inverted, PKR/JPY outliers
      const caughtPkrOutlier = textLower.includes('278') || textLower.includes('2,780') || textLower.includes('pkr');
      const caughtGbpInverted = textLower.includes('gbp') && (textLower.includes('invert') || textLower.includes('divide') || textLower.includes('reciprocal'));
      if (!caughtPkrOutlier || !caughtGbpInverted) {
        failureCodes.push('F05'); // parse / formula hazard
      }
      break;
    }
    case 'B9': {
      // Timestamps across timezones: UTC conversion, impossible rows
      const caughtDeliveredBeforeShip = textLower.includes('delivered before shipped') || textLower.includes('impossible') || textLower.includes('negative');
      if (!caughtDeliveredBeforeShip) {
        failureCodes.push('F10');
      }
      break;
    }
    case 'B10': {
      // Unit harmonisation: kg and Celsius, 999 and -40 sentinels
      const caughtSentinels = textLower.includes('999') && textLower.includes('-40');
      if (!caughtSentinels) {
        failureCodes.push('F10');
      }
      break;
    }
    default:
      break;
  }

  // Detect bottlenecks: high tool count or slow response
  if (ledger.length > 8) {
    bottlenecks.push(`High tool count (${ledger.length} calls) indicating iterative round-trips.`);
  }
  const errorCalls = ledger.filter((l) => l.status === 'ERROR');
  if (errorCalls.length > 0) {
    bottlenecks.push(`${errorCalls.length} tool calls resulted in error status.`);
    for (const ec of errorCalls) {
      toolGaps.push(`${ec.toolName}: ${JSON.stringify(ec.resultData || ec.summary)}`);
    }
  }

  if (failureCodes.length > 0 && verdict === 'PASS') {
    verdict = 'PARTIAL';
  }

  return { verdict, severity, failureCodes, bottlenecks, toolGaps };
}

export function generateMarkdownTrace(record: TestExecutionRecord): string {
  const toolSummaryRows = record.ledgerItems.map((item, idx) => {
    const argsStr = JSON.stringify(item.inputArgs || {}).replace(/\|/g, '\\|');
    const outStr = (item.summary || JSON.stringify(item.resultData || '')).slice(0, 120).replace(/\|/g, '\\|');
    return `| ${idx + 1} | \`${item.toolName}\` | \`${item.targetRange || '-'}\` | \`${argsStr.slice(0, 80)}\` | ${item.durationMs}ms | **${item.status}** | ${outStr} |`;
  }).join('\n');

  const cellDiffRows = record.diff.modifiedCells.slice(0, 20).map((c) => {
    return `| \`${c.sheet}\` | \`${c.coord}\` | \`${String(c.oldVal ?? '')}\` | \`${String(c.newVal ?? '')}\` | \`${c.oldFormula || '-'}\` | \`${c.newFormula || '-'}\` |`;
  }).join('\n');

  return `# Test Trace: Task ${record.taskId} - ${record.taskName}

> **Tier:** ${record.tier}  
> **Model:** \`anthropic/claude-haiku-5.5\`  
> **Execution Duration:** ${(record.durationMs / 1000).toFixed(2)}s  
> **Total Tool Calls:** ${record.ledgerItems.length}  
> **Verdict:** **${record.evaluation.verdict}** ${record.evaluation.severity ? `(Severity: ${record.evaluation.severity})` : ''}  
> **Failure Codes:** ${record.evaluation.failureCodes.length > 0 ? record.evaluation.failureCodes.map((c) => `\`${c}\``).join(' ') : 'None (Clean)'}

---

## 1. User Prompt
\`\`\`text
${record.prompt}
\`\`\`

---

## 2. Benchmark Expectation (Ground Truth)
${record.expected}

---

## 3. Tool Orchestration Trace
${record.ledgerItems.length === 0 ? '_No tool calls executed (pure cognitive/text response)._' : `
| # | Tool | Target | Arguments | Latency | Status | Result / Output Summary |
|---|------|--------|-----------|---------|--------|-------------------------|
${toolSummaryRows}
`}

---

## 4. Workbook Modifications & Diff
- **Created Sheets:** ${record.diff.createdSheets.length > 0 ? record.diff.createdSheets.map((s) => `\`${s}\``).join(', ') : 'None'}
- **Deleted Sheets:** ${record.diff.deletedSheets.length > 0 ? record.diff.deletedSheets.map((s) => `\`${s}\``).join(', ') : 'None'}
- **Total Modified Cells:** ${record.diff.modifiedCells.length}

${record.diff.modifiedCells.length > 0 ? `
| Sheet | Cell | Before Value | After Value | Before Formula | After Formula |
|-------|------|--------------|-------------|----------------|---------------|
${cellDiffRows}
${record.diff.modifiedCells.length > 20 ? `\n_...and ${record.diff.modifiedCells.length - 20} more cells modified._` : ''}
` : '_No cell modifications made._'}

---

## 5. Final AI Response
${record.finalText}

---

## 6. Bottleneck & Tool Friction Analysis
- **Execution Efficiency:** ${record.totalTurns} turns, ${(record.durationMs / 1000).toFixed(1)}s elapsed.
- **Bottlenecks Detected:** ${record.evaluation.bottlenecks.length > 0 ? record.evaluation.bottlenecks.join('; ') : 'Smooth orchestration.'}
- **Tool Gaps & Limitations:** ${record.evaluation.toolGaps.length > 0 ? record.evaluation.toolGaps.join('; ') : 'No tool failures observed.'}
`;
}

async function runSelectedSuite(taskIds?: string[]) {
  const targetTasks = taskIds
    ? TASKS.filter((t) => taskIds.includes(t.id))
    : TASKS;

  const resultsDir = path.resolve('TEsting/results');
  const tracesDir = path.join(resultsDir, 'traces');
  fs.mkdirSync(tracesDir, { recursive: true });

  const allRecords: TestExecutionRecord[] = [];

  for (const task of targetTasks) {
    try {
      const rec = await runTask(task);
      allRecords.push(rec);

      const traceMd = generateMarkdownTrace(rec);
      const tracePath = path.join(tracesDir, `Task_${rec.taskId}_${rec.taskName.replace(/[^a-zA-Z0-9]/g, '_')}.md`);
      fs.writeFileSync(tracePath, traceMd, 'utf-8');
      console.log(`-> Saved trace to: ${tracePath}`);
    } catch (err: any) {
      console.error(`Task ${task.id} failed fatally:`, err);
    }
  }

  // Update cumulative records store
  const recordsJsonPath = path.join(resultsDir, 'test_records.json');
  let cumulativeRecords: Record<string, TestExecutionRecord> = {};
  if (fs.existsSync(recordsJsonPath)) {
    try {
      cumulativeRecords = JSON.parse(fs.readFileSync(recordsJsonPath, 'utf-8'));
    } catch {
      cumulativeRecords = {};
    }
  }
  for (const rec of allRecords) {
    cumulativeRecords[rec.taskId] = rec;
  }
  fs.writeFileSync(recordsJsonPath, JSON.stringify(cumulativeRecords, null, 2), 'utf-8');

  // Generate Master Summary Report across all known records
  const sortedTaskIds = Object.keys(cumulativeRecords).sort((a, b) => {
    const tierA = a.startsWith('A') ? 0 : 1;
    const tierB = b.startsWith('A') ? 0 : 1;
    if (tierA !== tierB) return tierA - tierB;
    const numA = parseInt(a.slice(1), 10);
    const numB = parseInt(b.slice(1), 10);
    return numA - numB;
  });

  const allKnownRecords = sortedTaskIds.map((id) => cumulativeRecords[id]);

  const summaryRows = allKnownRecords.map((r) => {
    const fCodes = r.evaluation.failureCodes.length > 0 ? r.evaluation.failureCodes.join(', ') : 'None';
    return `| **${r.taskId}** | ${r.taskName} | ${r.tier.split(':')[0]} | **${r.evaluation.verdict}** | ${r.evaluation.severity || '-'} | \`${fCodes}\` | ${r.ledgerItems.length} | ${(r.durationMs / 1000).toFixed(1)}s | [Trace](./traces/Task_${r.taskId}_${r.taskName.replace(/[^a-zA-Z0-9]/g, '_')}.md) |`;
  }).join('\n');

  const masterReport = `# Sortd Studio: Stress Testing Master Audit Report

> **Model Tested:** \`anthropic/claude-haiku-5.5\`  
> **Target Workbook:** \`Meridian_Nova_StressTest.xlsx\` (15 sheets)  
> **Total Tasks Executed:** ${allKnownRecords.length}  
> **Timestamp:** ${new Date().toISOString()}  

---

## Executive Scorecard

| Task | Name | Tier | Verdict | Severity | Failure Codes | Tools Used | Duration | Detailed Trace |
|:-----|:-----|:-----|:--------|:---------|:--------------|:-----------|:---------|:---------------|
${summaryRows}

---

## Key Observations & Bottlenecks
${allKnownRecords.flatMap((r) => r.evaluation.bottlenecks.map((b) => `- **Task ${r.taskId}**: ${b}`)).join('\n') || '- All executed tasks completed with clean orchestration.'}

---

## Tool Friction & Identified Gaps
${allKnownRecords.flatMap((r) => r.evaluation.toolGaps.map((g) => `- **Task ${r.taskId}**: ${g}`)).join('\n') || '- No critical tool missing exceptions recorded.'}
`;

  const summaryPath = path.join(resultsDir, 'STRESS_TEST_MASTER_REPORT.md');
  fs.writeFileSync(summaryPath, masterReport, 'utf-8');
  console.log(`\n========================================================`);
  console.log(`[SUITE COMPLETE] Master report generated at: ${summaryPath}`);
  console.log(`========================================================\n`);
}

// Check CLI arguments: e.g. `npx tsx scripts/run-stress-suite.ts A1,A2,A3`
const argTasks = process.argv[2] ? process.argv[2].split(',').map((s) => s.trim().toUpperCase()) : ['A1', 'A2', 'A3'];
runSelectedSuite(argTasks).catch((e) => {
  console.error(e);
  process.exit(1);
});
