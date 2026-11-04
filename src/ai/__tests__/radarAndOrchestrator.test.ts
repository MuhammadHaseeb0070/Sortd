import test from 'node:test';
import assert from 'node:assert/strict';
import { generateWorkbookRadar, formatCompactRadarForPrompt } from '../radar';
import {
  shouldBlockDuplicateToolCall,
  inferTurnStartingProfile,
  detectMicroMutationLoop,
} from '../orchestrator';

function createMultiSheetMockUniver(activeSheetName: string) {
  const rawOrdersRows = [
    ['OrderID', 'Region', 'Sales'],
    ['ORD-1', 'North', 100],
    ['ORD-2', 'North', 150],
    ['ORD-3', 'North', 200],
    ['ORD-4', 'North', 120],
    ['ORD-5', 'South', 300],
    ['ORD-6', 'South', 250],
    ['ORD-7', 'South', 180],
    ['ORD-8', 'East', 400],
    ['ORD-9', 'East', 220],
    ['ORD-10', 'West', 190],
    ['ORD-11', 'West', 210],
    ['ORD-12', 'N', 90],
    ['ORD-13', 'N', 80],
    ['ORD-14', 'N', 85],
    ['ORD-15', 'N.', 70],
    ['ORD-16', 'W', 110],
    ['ORD-17', 'W', 115],
    ['ORD-18', 'W', 105],
    ['Grand Total', '', 2975],
  ];

  const makeSheet = (name: string, rows: any[][]) => ({
    getSheetName: () => name,
    getName: () => name,
    getMaxRows: () => Math.max(rows.length + 10, 50),
    getMaxColumns: () => 26,
    getLastRow: () => (rows.length > 0 ? rows.length - 1 : 0),
    getLastColumn: () => (rows[0] && rows[0].length > 0 ? rows[0].length - 1 : 0),
    getSelection: () => ({
      getActiveRange: () => ({ getA1Notation: () => 'A1' }),
    }),
    getRange: (r: number, c: number, numR?: number, numC?: number) => ({
      getValues: () => {
        if (rows.length === 0) return [[]];
        const sliceR = rows.slice(r, r + (numR ?? 1));
        return sliceR.map((row) => row.slice(c, c + (numC ?? 1)));
      },
      getFormulas: () => [],
    }),
  });

  const sheets = [
    makeSheet('Raw_Orders', rawOrdersRows),
    makeSheet('Regional_Summary', []),
  ];

  return {
    getActiveWorkbook: () => ({
      getSheets: () => sheets,
      getActiveSheet: () =>
        sheets.find((s) => s.getSheetName() === activeSheetName) || sheets[0],
    }),
  };
}

test('generateWorkbookRadar preserves non-active sheet headers when a new blank sheet is active', () => {
  const univerAPI = createMultiSheetMockUniver('Regional_Summary');
  const radar = generateWorkbookRadar(univerAPI);

  assert.equal(radar.activeSheetName, 'Regional_Summary');
  const rawOrdersMeta = radar.allSheets.find((s) => s.name === 'Raw_Orders');
  assert.ok(rawOrdersMeta, 'Raw_Orders must be in allSheets');
  assert.ok(
    Array.isArray(rawOrdersMeta.headers) && rawOrdersMeta.headers.length === 3,
    'Non-active sheet Raw_Orders must retain its Row-1 column headers in Radar v2'
  );
  assert.equal(rawOrdersMeta.headers?.[1]?.header, 'Region');
});

test('generateWorkbookRadar detects ENTITY_COLLISION (North vs N, N.) and SUBTOTAL_ROW_TRAP without Frequency Dead Zone', () => {
  const univerAPI = createMultiSheetMockUniver('Raw_Orders');
  const radar = generateWorkbookRadar(univerAPI);

  const regionCard = radar.columnHealthCards?.['B'];
  assert.ok(regionCard, 'Column B health card must exist');
  // All 7 distinct region variants must be visible in topFrequentValues (no dead zone for N=3 or W=3!)
  assert.equal(regionCard.topFrequentValues.length, 7);
  assert.ok(
    regionCard.hazardAlerts.some((h) => h.includes('ENTITY_COLLISION')),
    `Expected ENTITY_COLLISION alert in Region hazards, got: ${JSON.stringify(regionCard.hazardAlerts)}`
  );
  assert.deepEqual(radar.subtotalTrapRows, [20]);
});

test('formatCompactRadarForPrompt produces a compact (<2200 chars) multi-sheet markdown summary', () => {
  const univerAPI = createMultiSheetMockUniver('Raw_Orders');
  const radar = generateWorkbookRadar(univerAPI);
  const compactText = formatCompactRadarForPrompt(radar);

  assert.ok(compactText.length < 2200, `Expected compact prompt < 2200 chars, got ${compactText.length}`);
  assert.ok(compactText.includes('Raw_Orders'));
  assert.ok(compactText.includes('Regional_Summary'));
  assert.ok(compactText.includes('ENTITY_COLLISION'));
  assert.ok(compactText.includes('SUBTOTAL_ROW_TRAP'));
});

test('shouldBlockDuplicateToolCall blocks identical repeated tool calls while allowing new args', () => {
  const history = new Map<string, number>();
  const first = shouldBlockDuplicateToolCall(history, 'Sheet1', 'inspect_range', { rangeA1: 'A1:C20' });
  assert.equal(first.blocked, false);

  const second = shouldBlockDuplicateToolCall(history, 'Sheet1', 'inspect_range', { rangeA1: 'A1:C20' });
  assert.equal(second.blocked, true);

  const differentRange = shouldBlockDuplicateToolCall(history, 'Sheet1', 'inspect_range', { rangeA1: 'D1:F20' });
  assert.equal(differentRange.blocked, false);
});

test('inferTurnStartingProfile escapes Sticky Profile Amnesia when user intent changes domains', () => {
  // User was stuck on 'visualizer' from Turn 1, now asks to clean and group sales
  const nextProfile = inferTurnStartingProfile(
    'Clean the dirty Region values and group sales by region into a new sheet',
    'visualizer'
  );
  assert.notEqual(nextProfile, 'visualizer');
});

test('shouldBlockDuplicateToolCall extracts sheet prefix from rangeA1 so targetSheet is normalized', () => {
  const history = new Map<string, number>();
  // First call with sheet prefix in rangeA1 and omitted sheetName
  const first = shouldBlockDuplicateToolCall(history, 'Orders', 'inspect_range', { rangeA1: 'Orders!A4:O2260' });
  assert.equal(first.blocked, false);

  // Second call with same sheet prefix in rangeA1
  const second = shouldBlockDuplicateToolCall(history, 'Orders', 'inspect_range', { rangeA1: 'Orders!A4:O2260' });
  assert.equal(second.blocked, true);
});

test('detectMicroMutationLoop detects repeated single-column mutate_cells across same row span', () => {
  const history: Array<{ sheet: string; rangeA1: string; timestamp: number }> = [
    { sheet: 'Cancelled', rangeA1: 'Cancelled!P2:P132', timestamp: 1 },
    { sheet: 'Cancelled', rangeA1: 'Cancelled!Q2:Q132', timestamp: 2 },
  ];

  // Third call mutating R2:R132
  const isLoop = detectMicroMutationLoop(history, { sheet: 'Cancelled', rangeA1: 'Cancelled!R2:R132' });
  assert.equal(isLoop, true, 'Should detect micro-mutation loop on 3rd single-column mutation');

  // A 2D matrix mutation should NOT be flagged
  const isNotLoop = detectMicroMutationLoop(history, { sheet: 'Cancelled', rangeA1: 'Cancelled!R2:U132' });
  assert.equal(isNotLoop, false, 'Multi-column 2D mutation should not be flagged as micro-mutation');
});
