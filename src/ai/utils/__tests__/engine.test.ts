import test from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveColumnSmart,
  mapHorizontalAlignment,
  ensureSheetCapacity,
} from '../univerBridge';
import {
  parseRobustNumber,
  clusterCategoryValues,
  detectEmbeddedSubtotalRows,
} from '../dataHygiene';
import { verifyRangeMutation } from '../../middleware/formulaVerifier';
import { guardRangeOutput } from '../../middleware/tokenGuard';
import { executeInspectRange } from '../../profiles/core/executors';

function createMockSheet(headers: string[], maxRows = 36, maxCols = 20) {
  let currentMaxRows = maxRows;
  let currentMaxCols = maxCols;
  return {
    getLastColumn: () => headers.length - 1,
    getLastRow: () => 25,
    getMaxRows: () => currentMaxRows,
    getMaxColumns: () => currentMaxCols,
    setRowCount: (n: number) => {
      currentMaxRows = n;
    },
    setColumnCount: (n: number) => {
      currentMaxCols = n;
    },
    getRange: (row: number, col: number, numRows?: number, numCols?: number) => {
      if (numRows !== undefined && numCols !== undefined) {
        return {
          getValues: () => [headers.slice(col, col + numCols)],
        };
      }
      return {
        getValue: () => (row === 0 ? headers[col] : null),
      };
    },
  };
}

test('resolveColumnSmart resolves single-word Row 1 headers BEFORE Excel column letters', () => {
  const sheet = createMockSheet(['OrderID', 'Region', 'Sales', 'Email', 'Debit', 'Credit']);

  const regionCol = resolveColumnSmart(sheet, 'Region');
  assert.equal(regionCol.colIndex, 1);
  assert.equal(regionCol.colLetter, 'B');
  assert.equal(regionCol.headerName, 'Region');

  const emailCol = resolveColumnSmart(sheet, 'email');
  assert.equal(emailCol.colIndex, 3);
  assert.equal(emailCol.colLetter, 'D');
  assert.equal(emailCol.headerName, 'Email');

  const letterCol = resolveColumnSmart(sheet, 'C');
  assert.equal(letterCol.colIndex, 2);
  assert.equal(letterCol.colLetter, 'C');
  assert.equal(letterCol.headerName, 'Sales');

  const decoratedCol = resolveColumnSmart(sheet, 'C (Sales)');
  assert.equal(decoratedCol.colIndex, 2);
  assert.equal(decoratedCol.colLetter, 'C');
});

test('mapHorizontalAlignment maps right to normal for UniverJS v1.2.0 compatibility', () => {
  assert.equal(mapHorizontalAlignment('right'), 'normal');
  assert.equal(mapHorizontalAlignment('RIGHT'), 'normal');
  assert.equal(mapHorizontalAlignment('normal'), 'normal');
  assert.equal(mapHorizontalAlignment('left'), 'left');
  assert.equal(mapHorizontalAlignment('center'), 'center');
});

test('ensureSheetCapacity expands sheet rowCount and columnCount when writes exceed grid capacity', () => {
  const sheet = createMockSheet(['A', 'B', 'C'], 36, 20);
  ensureSheetCapacity(sheet, 150, 28);
  assert.ok(sheet.getMaxRows() >= 150, `Expected maxRows >= 150, got ${sheet.getMaxRows()}`);
  assert.ok(sheet.getMaxColumns() >= 28, `Expected maxCols >= 28, got ${sheet.getMaxColumns()}`);
});

test('parseRobustNumber handles accounting negatives, trailing minus, suffixes, and null sentinels', () => {
  assert.equal(parseRobustNumber('($1,250.50)'), -1250.5);
  assert.equal(parseRobustNumber('1,250-'), -1250);
  assert.equal(parseRobustNumber('$1.2M'), 1200000);
  assert.equal(parseRobustNumber('450K'), 450000);
  assert.equal(parseRobustNumber('N/A'), null);
  assert.equal(parseRobustNumber('-'), null);
  assert.equal(parseRobustNumber(''), null);
});

test('clusterCategoryValues clusters North vs N, N., and West vs W while protecting Store 1 vs Store 2', () => {
  const regionData = [
    'North', 'North', 'North', 'North', 'North ', 'north', 'N', 'N.',
    'South', 'South', 'South',
    'East', 'East', 'East',
    'West', 'West', 'West', 'W', 'W.',
  ];
  const result = clusterCategoryValues(regionData);
  assert.equal(result.hasCollisions, true);
  assert.equal(result.mapping['N'], 'North');
  assert.equal(result.mapping['N.'], 'North');
  assert.equal(result.mapping['north'], 'North');
  assert.equal(result.mapping['W'], 'West');
  assert.equal(result.mapping['W.'], 'West');
  assert.equal(result.canonicalCounts['North'], 8);
  assert.equal(result.canonicalCounts['West'], 5);

  // Must NOT merge numbered entities like Store 1 vs Store 2
  const storeData = ['Store 1', 'Store 1', 'Store 1', 'Store 2', 'Store 3'];
  const storeResult = clusterCategoryValues(storeData);
  assert.equal(storeResult.hasCollisions, false);
  assert.equal(Object.keys(storeResult.mapping).length, 0);
});

test('detectEmbeddedSubtotalRows flags Subtotal and Grand Total rows inside data tables', () => {
  const rows = [
    ['Region', 'Sales'],
    ['North', 100],
    ['South', 200],
    ['Subtotal', 300],
    ['West', 150],
    ['Grand Total', 450],
  ];
  const traps = detectEmbeddedSubtotalRows(rows);
  assert.deepEqual(traps, [4, 6]); // 1-based Excel row numbers
});

test('verifyRangeMutation returns ERROR instead of fake SUCCESS when range is null or throws', async () => {
  const nullRangeSheet = { getRange: () => null };
  const receipt1 = await verifyRangeMutation(nullRangeSheet, 'A1:B10');
  assert.equal(receipt1.status, 'ERROR');

  const throwingSheet = {
    getRange: () => {
      throw new Error('Invalid range syntax');
    },
  };
  const receipt2 = await verifyRangeMutation(throwingSheet, 'INVALID_RANGE');
  assert.equal(receipt2.status, 'ERROR');
});

test('guardRangeOutput counts true unique values (>50) and preserves offset column letters', () => {
  const rows: any[][] = [['OrderID', 'Status']];
  for (let i = 1; i <= 120; i++) {
    rows.push([`ORD-${i}`, i % 2 === 0 ? 'Paid' : 'Pending']);
  }
  const guarded = guardRangeOutput(rows, [], 'D1:E121');
  assert.equal(guarded.truncated, true);
  // Column D (OrderID) has 121 unique values (including header), must NOT be capped at 50!
  assert.ok((guarded.columnStats?.['D']?.uniqueCount ?? 0) > 100);
  assert.equal(guarded.columnStats?.['E']?.uniqueCount, 3);
});

test('executeInspectRange clamps out-of-bounds coordinates and extracts sheet prefix without returning 0 rows', async () => {
  // Mock sheet with 50 rows and 5 columns
  const mockRows: any[][] = [['ID', 'Status', 'Val']];
  for (let i = 1; i <= 49; i++) {
    mockRows.push([`ORD-${i}`, i % 2 === 0 ? 'Active' : 'Cancelled', i * 10]);
  }

  const mockSheet = {
    getName: () => 'Orders',
    getSheetName: () => 'Orders',
    getRowCount: () => 50,
    getColumnCount: () => 3,
    getMaxRows: () => 50,
    getMaxColumns: () => 3,
    getLastRow: () => 49,
    getLastColumn: () => 2,
    getRange: (rangeStr: string) => {
      // In real UniverJS, if rangeStr extends beyond 50 rows (e.g. A2:O2260), it throws or returns empty!
      const parts = rangeStr.split(':');
      const parseCell = (s: string) => {
        const m = s.match(/([A-Z]+)(\d+)/);
        return m ? parseInt(m[2], 10) : 1;
      };
      const endRow = parts[1] ? parseCell(parts[1]) : parseCell(parts[0]);
      if (endRow > 50) {
        throw new Error(`Range is out of bounds. Max rows: 50, Given: ${endRow}`);
      }
      return {
        getRow: () => 0,
        getColumn: () => 0,
        getValues: () => mockRows.slice(0, endRow),
        getFormulas: () => [],
      };
    },
  };

  const wb = {
    getActiveSheet: () => mockSheet,
    getSheetByName: (n: string) => (n.toLowerCase() === 'orders' ? mockSheet : null),
  };

  const ctx: any = { univerAPI: { getActiveWorkbook: () => wb } };

  // Call with out-of-bounds rangeA1 containing sheet prefix
  const res: any = await executeInspectRange(
    {
      rangeA1: 'Orders!A2:O2260', // Exceeds 50 rows and 3 columns!
    },
    ctx
  );

  assert.ok(res.totalRows > 0, 'Must NOT return 0 rows when range bounds exceed sheet dimensions');
  assert.equal(res.range, 'Orders!A2:C50', 'Should clamp range to available grid bounds');
});

