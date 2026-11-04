import test from 'node:test';
import assert from 'node:assert/strict';
import {
  executeStatisticalDeepDive,
  executeAggregateMultilevelGroupby,
  executeGenerateCrosstabPivot,
  executeWhatIfScenarioModeler,
} from '../analyst/executors';
import {
  executeDeduplicateDataset,
  executeRemoveRepeatedHeaders,
  executeFilterSliceDataset,
  executeStandardizeDates,
  executeCleanAndImputeCurrency,
} from '../sanitizer/executors';

function createStatefulMockWorkbook(initialSheets: Record<string, any[][]>) {
  const sheetStore = new Map<string, any[][]>();
  let activeName = Object.keys(initialSheets)[0] || 'Sheet1';

  for (const [name, rows] of Object.entries(initialSheets)) {
    sheetStore.set(
      name,
      rows.map((r) => [...r])
    );
  }

  const makeWorksheet = (name: string) => {
    const getGrid = () => {
      if (!sheetStore.has(name)) sheetStore.set(name, [[]]);
      return sheetStore.get(name)!;
    };

    const parseRangeCoords = (rOrA1: any, c?: number, numR?: number, numC?: number) => {
      const grid = getGrid();
      if (typeof rOrA1 === 'string') {
        const clean = rOrA1.includes('!') ? rOrA1.split('!')[1] : rOrA1;
        const parts = clean.split(':');
        const parseCell = (s: string) => {
          const m = s.trim().match(/^([A-Za-z]+)(\d+)$/);
          if (!m) return { r: 0, c: 0 };
          let col = 0;
          for (const ch of m[1].toUpperCase()) col = col * 26 + (ch.charCodeAt(0) - 64);
          return { r: parseInt(m[2], 10) - 1, c: col - 1 };
        };
        const p1 = parseCell(parts[0]);
        const p2 = parts[1] ? parseCell(parts[1]) : p1;
        return {
          startR: p1.r,
          startC: p1.c,
          rowsCount: p2.r - p1.r + 1,
          colsCount: p2.c - p1.c + 1,
        };
      }
      return {
        startR: Number(rOrA1) || 0,
        startC: Number(c) || 0,
        rowsCount: numR ?? 1,
        colsCount: numC ?? 1,
      };
    };

    return {
      getName: () => name,
      getSheetName: () => name,
      getMaxRows: () => Math.max(getGrid().length + 20, 100),
      getMaxColumns: () => Math.max((getGrid()[0]?.length || 1) + 10, 26),
      setRowCount: () => {},
      setColumnCount: () => {},
      getLastRow: () => Math.max(getGrid().length - 1, 0),
      getLastColumn: () => Math.max((getGrid()[0]?.length || 1) - 1, 0),
      clear: () => {
        sheetStore.set(name, [[]]);
      },
      deleteRows: (startRow: number, count: number = 1) => {
        const g = getGrid();
        g.splice(startRow, count);
      },
      insertColumns: (startCol: number, count: number = 1) => {
        const g = getGrid();
        for (const row of g) {
          row.splice(startCol, 0, ...new Array(count).fill(null));
        }
      },
      autoResizeColumns: () => {},
      setColumnWidth: () => {},
      getRange: (rOrA1: any, c?: number, numR?: number, numC?: number) => {
        const coords = parseRangeCoords(rOrA1, c, numR, numC);
        const rangeObj: any = {
          getRow: () => coords.startR,
          getColumn: () => coords.startC,
          getValue: () => getGrid()[coords.startR]?.[coords.startC] ?? null,
          getValues: () => {
            const g = getGrid();
            const out: any[][] = [];
            for (let r = 0; r < coords.rowsCount; r++) {
              const rowArr: any[] = [];
              for (let col = 0; col < coords.colsCount; col++) {
                rowArr.push(g[coords.startR + r]?.[coords.startC + col] ?? null);
              }
              out.push(rowArr);
            }
            return out;
          },
          getFormulas: () => [],
          setValue: (v: any) => {
            const g = getGrid();
            while (g.length <= coords.startR) g.push([]);
            g[coords.startR][coords.startC] = v;
            return rangeObj;
          },
          setValues: (vals: any[][]) => {
            const g = getGrid();
            for (let r = 0; r < vals.length; r++) {
              while (g.length <= coords.startR + r) g.push([]);
              for (let col = 0; col < (vals[r]?.length || 0); col++) {
                g[coords.startR + r][coords.startC + col] = vals[r][col];
              }
            }
            return rangeObj;
          },
          clear: () => rangeObj,
          setBackgroundColor: () => rangeObj,
          setFontColor: () => rangeObj,
          setFontWeight: () => rangeObj,
          setFontStyle: () => rangeObj,
          setFontSize: () => rangeObj,
          setNumberFormat: () => rangeObj,
          setHorizontalAlignment: (align: string) => {
            if (align === 'right') {
              throw new Error('Invalid horizontal alignment: right');
            }
            return rangeObj;
          },
        };
        return rangeObj;
      },
    };
  };

  const wb = {
    getActiveSheet: () => makeWorksheet(activeName),
    getSheetByName: (n: string) => (sheetStore.has(n) ? makeWorksheet(n) : null),
    getSheets: () => Array.from(sheetStore.keys()).map((n) => makeWorksheet(n)),
    insertSheet: (n: string) => {
      sheetStore.set(n, [[]]);
      activeName = n;
      return makeWorksheet(n);
    },
    setActiveSheet: (s: any) => {
      activeName = typeof s === 'string' ? s : s.getSheetName();
    },
  };

  return {
    univerAPI: { getActiveWorkbook: () => wb },
    sheetStore,
  };
}

const dummyCtx = (univerAPI: any) => ({
  univerAPI,
  activeProfileId: 'analyst' as const,
  onProfileSwitch: () => {},
});

test('executeStatisticalDeepDive preserves row pairing for Pearson correlation (detects r = -1.0)', async () => {
  const { univerAPI } = createStatefulMockWorkbook({
    Sheet1: [
      ['Item', 'Price', 'Quantity'],
      ['A', 10, 500],
      ['B', 20, 400],
      ['C', 30, 300],
      ['D', 40, 200],
      ['E', 50, 100],
    ],
  });

  const res: any = await executeStatisticalDeepDive(
    { columns: ['Price', 'Quantity'], includeCorrelationMatrix: true },
    dummyCtx(univerAPI)
  );

  assert.equal(res.status, 'SUCCESS');
  assert.ok(res.correlationMatrix, 'Receipt must return correlationMatrix');
  assert.equal(res.correlationMatrix['Price']['Quantity'], -1);
});

test('executeAggregateMultilevelGroupby normalizes dirty categories (North vs N, N.) and excludes Grand Total trap rows', async () => {
  const { univerAPI, sheetStore } = createStatefulMockWorkbook({
    Sheet1: [
      ['Region', 'Sales'],
      ['North', 100],
      ['North', 200],
      ['N', 50],
      ['N.', 50],
      ['South', 300],
      ['West', 150],
      ['W', 50],
      ['Grand Total', 900],
    ],
  });

  const res: any = await executeAggregateMultilevelGroupby(
    {
      groupByColumns: ['Region'],
      metrics: [{ column: 'Sales', operation: 'sum' }],
    },
    dummyCtx(univerAPI)
  );

  assert.equal(res.status, 'SUCCESS');
  // North (100+200+50+50=400), South (300), West (150+50=200) -> 3 clean groups, NOT 6 dirty groups!
  assert.equal(res.totalGroupsCreated, 3);
  const targetRows = sheetStore.get(res.targetSheet)!;
  const northRow = targetRows.find((r) => r[0] === 'North');
  assert.ok(northRow, 'North row must exist');
  assert.equal(northRow[1], 400);
});

test('executeGenerateCrosstabPivot treats blank metric cells as 0 instead of 1 in sum/average', async () => {
  const { univerAPI } = createStatefulMockWorkbook({
    Sheet1: [
      ['Region', 'Quarter', 'Revenue'],
      ['North', 'Q1', 100],
      ['North', 'Q2', null],
      ['South', 'Q1', 200],
      ['South', 'Q2', ''],
    ],
  });

  const res: any = await executeGenerateCrosstabPivot(
    {
      rowFields: ['Region'],
      columnField: 'Quarter',
      valueField: 'Revenue',
      aggregation: 'sum',
    },
    dummyCtx(univerAPI)
  );

  assert.equal(res.status, 'SUCCESS');
  assert.equal(res.grandTotal, 300); // Must be 100 + 200 = 300, NOT 302!
});

test('executeWhatIfScenarioModeler subtracts cost driver increases from NetProfit', async () => {
  const { univerAPI } = createStatefulMockWorkbook({
    Sheet1: [
      ['Order', 'Revenue', 'ShippingCost', 'NetProfit'],
      ['1', 1000, 200, 800],
      ['2', 1000, 200, 800],
    ],
  });

  const res: any = await executeWhatIfScenarioModeler(
    {
      targetMetricColumn: 'NetProfit',
      scenarios: [
        {
          scenarioName: 'Higher Shipping Cost',
          assumptions: [{ column: 'ShippingCost', changePercent: 25 }],
        },
      ],
    },
    dummyCtx(univerAPI)
  );

  assert.equal(res.status, 'SUCCESS');
  // Baseline NetProfit = 1600, ShippingCost = 400. +25% ShippingCost = +100 cost -> NetProfit = 1500 (< 1600)!
  const scenarioRow = res.scenariosComparison?.[0];
  assert.ok(scenarioRow, 'scenariosComparison must be returned');
  assert.equal(scenarioRow.projectedTotal, 1500);
});

test('executeDeduplicateDataset does NOT falsely merge substring names like Jan vs Jane or North vs North America', async () => {
  const { univerAPI } = createStatefulMockWorkbook({
    Sheet1: [
      ['Name', 'Region'],
      ['Jan', 'North'],
      ['Jane', 'North America'],
      ['Bob', 'South'],
    ],
  });

  const res: any = await executeDeduplicateDataset(
    {
      keyColumns: ['Name'],
      matchMode: 'fuzzy',
      fuzzyThreshold: 0.85,
      action: 'flag_column',
    },
    dummyCtx(univerAPI)
  );

  assert.equal(res.duplicatesRemovedOrFlagged, 0);
});

test('executeDeduplicateDataset identifies conflict groups (same OrderID and SKU, different Quantity) with report_only without deleting rows', async () => {
  const initialData = [
    ['OrderID', 'SKU', 'Quantity', 'Status'],
    ['ORD-101', 'SKU-A', 5, 'Shipped'],
    ['ORD-101', 'SKU-A', 10, 'Pending'], // Conflict on Quantity!
    ['ORD-102', 'SKU-B', 2, 'Shipped'],
    ['ORD-102', 'SKU-B', 2, 'Shipped'], // Exact duplicate, same Quantity (not a conflict on Quantity!)
    ['ORD-103', 'SKU-C', 1, 'Delivered'],
  ];

  const { univerAPI, sheetStore } = createStatefulMockWorkbook({
    Orders: initialData,
  });

  const res: any = await executeDeduplicateDataset(
    {
      sheetName: 'Orders',
      keyColumns: ['OrderID', 'SKU'],
      conflictColumns: ['Quantity'],
      action: 'report_only',
    },
    dummyCtx(univerAPI)
  );

  assert.equal(res.success, true);
  assert.equal(res.duplicateGroupsFound, 1, 'Should find exactly 1 conflict group (ORD-101 SKU-A)');
  assert.equal(res.duplicateRowsIdentified, 2, 'Should identify 2 rows in the conflict group');
  assert.equal(res.duplicatesRemovedOrFlagged, 0, 'No rows should be deleted or flagged in report_only');

  // Verify sheet was untouched
  const finalRows = sheetStore.get('Orders')!;
  assert.equal(finalRows.length, initialData.length, 'Sheet rows must not be deleted in report_only');

  // Verify rich structured data in receipt
  assert.ok(res.groups && res.groups.length === 1, 'groups must be present in receipt');
  assert.equal(res.groups[0].keyValues.OrderID, 'ORD-101');
  assert.equal(res.groups[0].keyValues.SKU, 'SKU-A');
  assert.ok(res.groups[0].varyingColumns.includes('Quantity'));
  assert.equal(res.groups[0].records.length, 2);
  assert.ok(res.formattedSummaryTable.includes('ORD-101'), 'formattedSummaryTable must contain ORD-101');
});

test('executeDeduplicateDataset auto-cleans repeating pagination headers and removes exact duplicates in-place', async () => {
  const { univerAPI, sheetStore } = createStatefulMockWorkbook({
    Orders: [
      ['OrderID', 'SKU', 'Quantity'],
      ['ORD-1', 'SKU-A', 10],
      ['ORD-2', 'SKU-B', 20],
      ['OrderID', 'SKU', 'Quantity'], // Repeating pagination header row!
      ['ORD-2', 'SKU-B', 20], // Exact duplicate
      ['ORD-3', 'SKU-C', 30],
    ],
  });

  const res: any = await executeDeduplicateDataset(
    {
      sheetName: 'Orders',
      stripRepeatedHeaders: true,
      action: 'delete_rows',
    },
    dummyCtx(univerAPI)
  );

  assert.equal(res.success, true);
  assert.equal(res.repeatedHeadersRemoved, 1, 'Must remove 1 repeated header row');
  assert.equal(res.duplicatesRemovedOrFlagged, 1, 'Must remove 1 duplicate row');

  const finalRows = sheetStore.get('Orders')!;
  // Originally 6 rows: 1 header + 1 repeated header + 1 duplicate + 3 unique data rows
  // Result must be: 1 header + 3 unique data rows = 4 rows!
  assert.equal(finalRows.length, 4, 'Final sheet must contain 4 rows');
  assert.equal(finalRows[0][0], 'OrderID');
  assert.equal(finalRows[1][0], 'ORD-1');
  assert.equal(finalRows[2][0], 'ORD-2');
  assert.equal(finalRows[3][0], 'ORD-3');
});

test('executeRemoveRepeatedHeaders detects and strips repeating headers in one vectorized pass', async () => {
  const { univerAPI, sheetStore } = createStatefulMockWorkbook({
    Export: [
      ['Date', 'Region', 'Revenue', 'Units'],
      ['2026-01-01', 'North', 100, 5],
      ['2026-01-02', 'South', 200, 8],
      ['Date', 'Region', 'Revenue', 'Units'], // Page break header
      ['2026-01-03', 'East', 300, 12],
      ['Date', 'Region', 'Revenue', 'Units'], // Page break header
      ['2026-01-04', 'West', 400, 15],
    ],
  });

  const res: any = await executeRemoveRepeatedHeaders(
    { sheetName: 'Export' },
    dummyCtx(univerAPI)
  );

  assert.equal(res.success, true);
  assert.equal(res.removedCount, 2);

  const finalRows = sheetStore.get('Export')!;
  assert.equal(finalRows.length, 5); // 1 header + 4 data rows
});

test('ERP Export with Row 1 Title Banner: auto-detects Row 4 headers, strips repeated headers, deletes exact duplicates, and reports OrderID+SKU Quantity conflicts in 1 call', async () => {
  const { univerAPI, sheetStore } = createStatefulMockWorkbook({
    Orders: [
      ['ORDER LINES - FY2025 (ERP export)', '', '', '', ''], // Row 1: Title banner
      ['Extracted from SAP Production', '', '', '', ''], // Row 2: Subtitle
      ['', '', '', '', ''], // Row 3: Blank
      ['OrderID', 'OrderDate', 'SKU', 'Quantity', 'UnitPrice'], // Row 4: Actual Table Header!
      ['ORD-100', '2025-01-10', 'SKU-1', 10, 50], // Row 5: Unique
      ['ORD-100', '2025-01-10', 'SKU-1', 10, 50], // Row 6: Exact duplicate of Row 5 (should be deleted!)
      ['OrderID', 'OrderDate', 'SKU', 'Quantity', 'UnitPrice'], // Row 7: Repeated pagination header (should be deleted!)
      ['ORD-200', '2025-01-12', 'SKU-9', 5, 100], // Row 8: Conflict row 1
      ['ORD-200', '2025-01-12', 'SKU-9', 12, 100], // Row 9: Conflict row 2 (same OrderID & SKU, different Quantity -> KEEP & REPORT!)
      ['ORD-300', '2025-01-15', 'SKU-5', 3, 75], // Row 10: Unique
      ['OrderID', 'OrderDate', 'SKU', 'Quantity', 'UnitPrice'], // Row 11: Second repeated pagination header (should be deleted!)
      ['ORD-300', '2025-01-15', 'SKU-5', 3, 75], // Row 12: Exact duplicate of Row 10 after repeated header (should be deleted!)
    ],
  });

  const res: any = await executeDeduplicateDataset(
    {
      sheetName: 'Orders',
      keyColumns: ['OrderID', 'SKU'],
      conflictColumns: ['Quantity'],
      action: 'delete_rows',
    },
    dummyCtx(univerAPI)
  );

  assert.equal(res.success, true);
  assert.equal(res.detectedHeaderRow, 4, 'Must detect Row 4 as the true table header row');
  assert.equal(res.repeatedHeadersRemoved, 2, 'Must strip both repeated OrderID header rows');
  assert.equal(res.exactDuplicatesRemoved, 2, 'Must delete both exact duplicate rows in-place');
  assert.equal(res.duplicateGroupsFound, 1, 'Must report 1 conflict group (ORD-200 + SKU-9)');
  assert.equal(res.groups[0].keyValues.OrderID, 'ORD-200');
  assert.equal(res.groups[0].keyValues.SKU, 'SKU-9');
  assert.equal(res.groups[0].records.length, 2);

  // Verify the conflicting rows were NOT deleted from the sheet, while exact duplicates & repeated headers WERE deleted!
  const finalRows = sheetStore.get('Orders')!;
  // Original 12 rows - 2 repeated headers - 2 exact duplicates = 8 rows!
  assert.equal(finalRows.length, 8, 'Sheet must have 8 rows remaining');
  // Post-deletion row numbers for ORD-200 conflict must be rows 6 and 7:
  assert.equal(res.groups[0].records[0].rowNumber, 6);
  assert.equal(res.groups[0].records[1].rowNumber, 7);
});

test('executeFilterSliceDataset filters rows by condition, auto-creates target sheet, and copies all columns in 1 call', async () => {
  const { univerAPI, sheetStore } = createStatefulMockWorkbook({
    Orders: [
      ['OrderID', 'Customer', 'Status', 'Currency', 'Total'],
      ['ORD-1', 'Acme Corp', 'Delivered', 'USD', 1200],
      ['ORD-2', 'Globex', 'Cancelled', 'USD', 500],
      ['ORD-3', 'Soylent', 'Delivered', 'EUR', 800],
      ['ORD-4', 'Initech', 'Cancelled', 'EUR', 950],
      ['ORD-5', 'Umbrella', 'Pending', 'USD', 400],
      ['ORD-6', 'Hooli', 'Cancelled', 'USD', 750],
    ],
  });

  const res: any = await executeFilterSliceDataset(
    {
      sourceSheetName: 'Orders',
      filterConditions: [{ column: 'Status', operator: '==', value: 'Cancelled' }],
      targetSheetName: 'Cancelled',
    },
    dummyCtx(univerAPI)
  );

  assert.equal(res.success, true);
  assert.equal(res.matchingRowsCount, 3);
  assert.equal(res.targetSheetName, 'Cancelled');

  const cancelledSheet = sheetStore.get('Cancelled')!;
  assert.ok(cancelledSheet, 'Target sheet Cancelled must exist');
  // Header + 3 cancelled rows = 4 rows
  assert.equal(cancelledSheet.length, 4);
  assert.deepEqual(cancelledSheet[0], ['OrderID', 'Customer', 'Status', 'Currency', 'Total']);
  assert.equal(cancelledSheet[1][0], 'ORD-2');
  assert.equal(cancelledSheet[2][0], 'ORD-4');
  assert.equal(cancelledSheet[3][0], 'ORD-6');
});

test('executeFilterSliceDataset computes count and sum grouped by Currency with summarizeMetrics and writes summary block', async () => {
  const { univerAPI, sheetStore } = createStatefulMockWorkbook({
    Orders: [
      ['OrderID', 'Status', 'Currency', 'TotalValue'],
      ['ORD-1', 'Cancelled', 'USD', '$500.00'],
      ['ORD-2', 'Delivered', 'USD', '$1,200.00'],
      ['ORD-3', 'Cancelled', 'EUR', '€800.00'],
      ['ORD-4', 'Cancelled', 'USD', '$750.50'],
      ['ORD-5', 'Cancelled', 'EUR', '€200.00'],
    ],
  });

  const res: any = await executeFilterSliceDataset(
    {
      sourceSheetName: 'Orders',
      filterConditions: [{ column: 'Status', operator: '==', value: 'Cancelled' }],
      targetSheetName: 'Cancelled',
      summarizeMetrics: [
        { groupBy: 'Currency', aggregate: 'count' },
        { groupBy: 'Currency', metricColumn: 'TotalValue', aggregate: 'sum' },
      ],
      writeSummaryBlock: true,
    },
    dummyCtx(univerAPI)
  );

  assert.equal(res.success, true);
  assert.equal(res.matchingRowsCount, 4);
  assert.ok(res.summaryGroups, 'summaryGroups must be populated');
  assert.equal(res.summaryGroups['USD'].count, 2);
  assert.equal(res.summaryGroups['USD'].TotalValue_sum, 1250.5);
  assert.equal(res.summaryGroups['EUR'].count, 2);
  assert.equal(res.summaryGroups['EUR'].TotalValue_sum, 1000);

  assert.ok(res.formattedSummaryTable.includes('USD'), 'Summary table should contain USD');
  assert.ok(res.formattedSummaryTable.includes('1,250.5'), 'Summary table should format USD sum');

  // Verify target sheet has data table and summary block
  const cancelledSheet = sheetStore.get('Cancelled')!;
  assert.ok(cancelledSheet.length >= 5);
});

test('executeFilterSliceDataset skips ERP Row 1 banner and strips repeating pagination headers', async () => {
  const { univerAPI, sheetStore } = createStatefulMockWorkbook({
    Orders: [
      ['ERP Export - Orders FY2025', '', '', '', ''], // Row 1: Banner
      ['Confidential Internal Report', '', '', '', ''], // Row 2: Subtitle
      ['', '', '', '', ''], // Row 3: Blank
      ['OrderID', 'Status', 'SKU', 'Currency', 'Amount'], // Row 4: True Table Header!
      ['ORD-1', 'Cancelled', 'SKU-A', 'USD', 100],
      ['ORD-2', 'Active', 'SKU-B', 'USD', 200],
      ['OrderID', 'Status', 'SKU', 'Currency', 'Amount'], // Row 7: Repeating header
      ['ORD-3', 'Cancelled', 'SKU-C', 'EUR', 300],
      ['OrderID', 'Status', 'SKU', 'Currency', 'Amount'], // Row 9: Repeating header
      ['ORD-4', 'Cancelled', 'SKU-D', 'USD', 400],
    ],
  });

  const res: any = await executeFilterSliceDataset(
    {
      sourceSheetName: 'Orders',
      filterConditions: [{ column: 'Status', operator: '==', value: 'Cancelled' }],
      targetSheetName: 'CancelledOrders',
      stripSourceRepeatedHeaders: true,
    },
    dummyCtx(univerAPI)
  );

  assert.equal(res.success, true);
  assert.equal(res.detectedHeaderRow, 4, 'Must detect Row 4 as header');
  assert.equal(res.matchingRowsCount, 3, 'Must match 3 cancelled orders');
  assert.equal(res.repeatedHeadersSkipped, 2, 'Must skip 2 repeated headers');

  const cancelledSheet = sheetStore.get('CancelledOrders')!;
  assert.equal(cancelledSheet.length, 4); // 1 header + 3 data rows
  assert.deepEqual(cancelledSheet[0], ['OrderID', 'Status', 'SKU', 'Currency', 'Amount']);
});

test('executeFilterSliceDataset derives missing metric column on the fly (Quantity * UnitPrice)', async () => {
  const { univerAPI } = createStatefulMockWorkbook({
    Orders: [
      ['OrderID', 'Status', 'Currency', 'Quantity', 'UnitPrice'],
      ['ORD-1', 'Cancelled', 'USD', 5, 20], // 100
      ['ORD-2', 'Active', 'USD', 2, 50],
      ['ORD-3', 'Cancelled', 'USD', 10, 15], // 150
      ['ORD-4', 'Cancelled', 'EUR', 4, 25], // 100
    ],
  });

  const res: any = await executeFilterSliceDataset(
    {
      sourceSheetName: 'Orders',
      filterConditions: [{ column: 'Status', operator: '==', value: 'Cancelled' }],
      targetSheetName: 'Cancelled',
      summarizeMetrics: [
        { groupBy: 'Currency', aggregate: 'count' },
        {
          groupBy: 'Currency',
          derivedFormula: 'Quantity * UnitPrice',
          metricColumn: 'TotalValue',
          aggregate: 'sum',
        },
      ],
    },
    dummyCtx(univerAPI)
  );

  assert.equal(res.success, true);
  assert.equal(res.summaryGroups['USD'].TotalValue_sum, 250);
  assert.equal(res.summaryGroups['EUR'].TotalValue_sum, 100);
});

test('End-to-End Simulation: Pull all cancelled orders into Cancelled sheet with count and total value per currency in 1 vectorized call', async () => {
  // Build realistic ERP export with Row 1 banner and pagination headers
  const initialRows: any[][] = [
    ['ORDER LINES - FY2025 (ERP export)', '', '', '', '', ''], // Row 1: Report Title Banner
    ['Confidential Internal Report - SAP Live Data', '', '', '', '', ''], // Row 2: Subtitle
    ['', '', '', '', '', ''], // Row 3: Blank
    ['OrderID', 'OrderDate', 'Customer', 'Status', 'Currency', 'TotalValue'], // Row 4: True Table Header!
  ];

  let expectedUsdCount = 0;
  let expectedUsdTotal = 0;
  let expectedEurCount = 0;
  let expectedEurTotal = 0;
  let totalCancelled = 0;

  for (let i = 1; i <= 200; i++) {
    // Insert repeating pagination headers every 50 rows
    if (i === 51 || i === 101 || i === 151) {
      initialRows.push(['OrderID', 'OrderDate', 'Customer', 'Status', 'Currency', 'TotalValue']);
    }

    const isCancelled = i % 4 === 0;
    const currency = i % 3 === 0 ? 'EUR' : 'USD';
    const val = 100 + i * 5;
    const valFormatted = currency === 'USD' ? `$${val.toFixed(2)}` : `€${val.toFixed(2)}`;

    if (isCancelled) {
      totalCancelled++;
      if (currency === 'USD') {
        expectedUsdCount++;
        expectedUsdTotal += val;
      } else {
        expectedEurCount++;
        expectedEurTotal += val;
      }
    }

    const status = isCancelled ? 'Cancelled' : i % 3 === 0 ? 'Delivered' : 'Pending';
    initialRows.push([`ORD-${i}`, '2025-03-01', `Cust-${i}`, status, currency, valFormatted]);
  }

  const { univerAPI, sheetStore } = createStatefulMockWorkbook({ Orders: initialRows });

  const startTime = performance.now();
  const res: any = await executeFilterSliceDataset(
    {
      sourceSheetName: 'Orders',
      filterConditions: [{ column: 'Status', operator: '==', value: 'Cancelled' }],
      targetSheetName: 'Cancelled',
      summarizeMetrics: [
        { groupBy: 'Currency', aggregate: 'count', alias: 'CancelledCount' },
        { groupBy: 'Currency', metricColumn: 'TotalValue', aggregate: 'sum', alias: 'TotalValue' },
      ],
      writeSummaryBlock: true,
      stripSourceRepeatedHeaders: true,
    },
    dummyCtx(univerAPI)
  );
  const duration = performance.now() - startTime;

  assert.equal(res.success, true);
  assert.equal(res.detectedHeaderRow, 4, 'Must detect Row 4 as the true table header row');
  assert.equal(res.repeatedHeadersSkipped, 3, 'Must skip all 3 repeating pagination headers');
  assert.equal(res.matchingRowsCount, totalCancelled, `Must extract exactly ${totalCancelled} cancelled rows`);

  // Verify target sheet "Cancelled"
  const cancelledSheet = sheetStore.get('Cancelled')!;
  assert.ok(cancelledSheet, 'Worksheet "Cancelled" must be created');
  assert.equal(cancelledSheet[0][0], 'OrderID');
  assert.equal(cancelledSheet[0][3], 'Status');
  assert.equal(cancelledSheet[0][5], 'TotalValue');

  // Verify all rows in Cancelled sheet have Status === 'Cancelled'
  for (let r = 1; r <= totalCancelled; r++) {
    assert.equal(cancelledSheet[r][3], 'Cancelled');
  }

  // Verify exact currency counts and totals
  assert.equal(res.summaryGroups['USD'].CancelledCount, expectedUsdCount);
  assert.equal(res.summaryGroups['USD'].TotalValue, expectedUsdTotal);
  assert.equal(res.summaryGroups['EUR'].CancelledCount, expectedEurCount);
  assert.equal(res.summaryGroups['EUR'].TotalValue, expectedEurTotal);

  // Verify Markdown table
  assert.ok(res.formattedSummaryTable.includes('USD'));
  assert.ok(res.formattedSummaryTable.includes('EUR'));

  // Execution must be fast (<100ms in-engine)
  assert.ok(duration < 100, `Execution should take <100ms in-memory, took ${duration.toFixed(1)}ms`);
});

test('executeStandardizeDates uses countryColumn to parse US dates as MM/DD/YYYY and others as DD/MM/YYYY', async () => {
  const { univerAPI, sheetStore } = createStatefulMockWorkbook({
    Orders: [
      ['OrderID', 'OrderDate', 'CustomerCountry'],
      ['ORD-1', '03/04/2025', 'US'], // US: March 4, 2025 -> 2025-03-04
      ['ORD-2', '03/04/2025', 'UK'], // UK: 3 April, 2025 -> 2025-04-03
      ['ORD-3', '03/04/2025', 'Germany'], // Germany: 3 April, 2025 -> 2025-04-03
      ['ORD-4', '15/01/2025', 'USA'], // Unambiguous day 15 -> 2025-01-15
    ],
  });

  const res: any = await executeStandardizeDates(
    {
      sheetName: 'Orders',
      column: 'OrderDate',
      countryColumn: 'CustomerCountry',
      outputFormat: 'YYYY-MM-DD',
      targetColumn: 'OrderDate', // overwrite in-place for this test
    },
    dummyCtx(univerAPI)
  );

  assert.equal(res.success, true);
  assert.equal(res.convertedCount, 4);

  const rows = sheetStore.get('Orders')!;
  assert.equal(rows[1][1], '2025-03-04', 'US date 03/04/2025 must be parsed as March 4');
  assert.equal(rows[2][1], '2025-04-03', 'UK date 03/04/2025 must be parsed as April 3');
  assert.equal(rows[3][1], '2025-04-03', 'Germany date 03/04/2025 must be parsed as April 3');
  assert.equal(rows[4][1], '2025-01-15', 'Unambiguous day 15 must be parsed as Jan 15');
});

test('executeStandardizeDates inserts clean ISO column right after source column with header aligned to true table header row', async () => {
  const { univerAPI, sheetStore } = createStatefulMockWorkbook({
    Orders: [
      ['ERP Export - Orders FY2025', '', '', ''], // Row 1: Banner
      ['Confidential Internal Report', '', '', ''], // Row 2: Subtitle
      ['', '', '', ''], // Row 3: Blank
      ['OrderID', 'OrderDate', 'Country', 'Total'], // Row 4: True Table Header!
      ['ORD-1', '2025-01-10', 'US', 100],
      ['ORD-2', '2025-02-15', 'UK', 200],
    ],
  });

  const res: any = await executeStandardizeDates(
    {
      sheetName: 'Orders',
      column: 'OrderDate',
      insertPlacement: 'right_of_source',
      newHeader: 'Order Date (ISO)',
      outputFormat: 'YYYY-MM-DD',
    },
    dummyCtx(univerAPI)
  );

  assert.equal(res.success, true);
  assert.equal(res.detectedHeaderRow, 4, 'Must detect Row 4 as header');

  const rows = sheetStore.get('Orders')!;
  // Should have inserted new column at index 2 (between OrderDate at 1 and Country at 3)
  assert.equal(rows[3][1], 'OrderDate');
  assert.equal(rows[3][2], 'Order Date (ISO)');
  assert.equal(rows[3][3], 'Country');

  assert.equal(rows[4][2], '2025-01-10');
  assert.equal(rows[5][2], '2025-02-15');
});

test('executeStandardizeDates leaves invalid/impossible dates blank in strictNoGuess mode and returns structured Markdown audit table with Excel row numbers', async () => {
  const { univerAPI, sheetStore } = createStatefulMockWorkbook({
    Orders: [
      ['OrderID', 'OrderDate', 'Country'],
      ['ORD-1', '2025-01-10', 'US'], // Valid
      ['ORD-2', '99/99/2025', 'US'], // Invalid month/day -> row 3
      ['ORD-3', '2025-02-30', 'UK'], // Feb 30 does not exist -> row 4
      ['ORD-4', 'pending', 'DE'], // Non-date text -> row 5
      ['ORD-5', '', 'FR'], // Blank -> row 6
      ['ORD-6', '2025-03-15', 'FR'], // Valid
    ],
  });

  const res: any = await executeStandardizeDates(
    {
      sheetName: 'Orders',
      column: 'OrderDate',
      outputFormat: 'YYYY-MM-DD',
      strictNoGuess: true,
      invalidHandling: 'set_empty',
      targetColumn: 'OrderDate',
    },
    dummyCtx(univerAPI)
  );

  assert.equal(res.success, true);
  assert.equal(res.convertedCount, 2);
  assert.equal(res.unparsedCount, 4);

  const rows = sheetStore.get('Orders')!;
  assert.equal(rows[1][1], '2025-01-10');
  assert.equal(rows[2][1], '', 'Row 3 invalid date must be blank');
  assert.equal(rows[3][1], '', 'Row 4 Feb 30 must be blank');
  assert.equal(rows[4][1], '', 'Row 5 pending text must be blank');
  assert.equal(rows[5][1], '', 'Row 6 blank must remain blank');
  assert.equal(rows[6][1], '2025-03-15');

  // Verify unparseable audit list
  assert.ok(res.unparseableAudit && res.unparseableAudit.length === 4);
  assert.equal(res.unparseableAudit[0].rowNumber, 3);
  assert.equal(res.unparseableAudit[0].rawValue, '99/99/2025');
  assert.equal(res.unparseableAudit[1].rowNumber, 4);
  assert.equal(res.unparseableAudit[1].rawValue, '2025-02-30');
  assert.equal(res.unparseableAudit[2].rowNumber, 5);
  assert.equal(res.unparseableAudit[2].rawValue, 'pending');

  assert.ok(res.formattedAuditTable.includes('99/99/2025'));
  assert.ok(res.formattedAuditTable.includes('Row 3') || res.formattedAuditTable.includes('| 3 |'));
});

test('executeCleanAndImputeCurrency parses mixed international text (1.299,00 € vs ¥15,800) and imputes blanks from Products and FX_Rates in 1 call', async () => {
  const { univerAPI, sheetStore } = createStatefulMockWorkbook({
    Orders: [
      ['ERP Export - Orders FY2025', '', '', '', ''], // Row 1: Banner
      ['Confidential Internal Report', '', '', '', ''], // Row 2: Subtitle
      ['', '', '', '', ''], // Row 3: Blank
      ['OrderID', 'OrderDate', 'SKU', 'UnitPrice', 'Currency'], // Row 4: True Table Header!
      ['ORD-1', '2025-01-10', 'SKU-A', '1.299,00 €', ''], // Existing EU format -> 1299, EUR
      ['ORD-2', '2025-01-10', 'SKU-B', '¥15,800', ''], // Existing Asian format -> 15800, JPY
      ['ORD-3', '2025-01-10', 'SKU-C', '$100.50', ''], // Existing US format -> 100.50, USD
      ['ORD-4', '2025-01-12', 'SKU-A', '', 'EUR'], // Blank price -> derive from SKU-A (1000) * 0.92 = 920
      ['ORD-5', '2025-01-12', 'SKU-B', '', 'JPY'], // Blank price -> derive from SKU-B (100) * 150 = 15000
    ],
    Products: [
      ['SKU', 'ProductName', 'ListPrice'],
      ['SKU-A', 'Laptop Pro', 1000],
      ['SKU-B', 'Wireless Mouse', 100],
      ['SKU-C', 'Monitor 4K', 500],
    ],
    FX_Rates: [
      ['Date', 'USD', 'EUR', 'JPY', 'GBP'],
      ['2025-01-10', 1.0, 0.9, 145.0, 0.8],
      ['2025-01-12', 1.0, 0.92, 150.0, 0.82],
    ],
  });

  const startTime = performance.now();
  const res: any = await executeCleanAndImputeCurrency(
    {
      sheetName: 'Orders',
      sourceColumn: 'UnitPrice',
      currencyColumnName: 'Currency',
      imputeBlanks: {
        keyColumn: 'SKU',
        lookupSheetName: 'Products',
        lookupKeyColumn: 'SKU',
        lookupPriceColumn: 'ListPrice',
        dateColumn: 'OrderDate',
        fxSheetName: 'FX_Rates',
        fxDateColumn: 'Date',
      },
    },
    dummyCtx(univerAPI)
  );
  const duration = performance.now() - startTime;

  assert.equal(res.success, true);
  assert.equal(res.detectedHeaderRow, 4, 'Must detect Row 4 as true header row');
  assert.equal(res.existingCleanedCount, 3, 'Must clean 3 existing currency text cells');
  assert.equal(res.derivedCount, 2, 'Must derive 2 blank price cells');

  const rows = sheetStore.get('Orders')!;
  // Verify existing values were NOT overwritten by product list prices
  assert.equal(rows[4][3], 1299, 'ORD-1 must remain 1299 (not overwritten with 1000 or 900)');
  assert.equal(rows[4][4], 'EUR');

  assert.equal(rows[5][3], 15800, 'ORD-2 must remain 15800');
  assert.equal(rows[5][4], 'JPY');

  assert.equal(rows[6][3], 100.5, 'ORD-3 must remain 100.50');
  assert.equal(rows[6][4], 'USD');

  // Verify derived values
  assert.equal(rows[7][3], 920, 'ORD-4 blank price must be derived as 1000 * 0.92 = 920');
  assert.equal(rows[7][4], 'EUR');

  assert.equal(rows[8][3], 15000, 'ORD-5 blank price must be derived as 100 * 150 = 15000');
  assert.equal(rows[8][4], 'JPY');

  assert.ok(duration < 100, `Execution should take <100ms, took ${duration.toFixed(1)}ms`);
});

test('executeCleanAndImputeCurrency auto-creates Currency column when missing and skips repeating headers', async () => {
  const { univerAPI, sheetStore } = createStatefulMockWorkbook({
    Orders: [
      ['OrderID', 'SKU', 'UnitPrice'], // No Currency column exists yet!
      ['ORD-101', 'SKU-A', '€ 1.250,50'],
      ['ORD-102', 'SKU-B', '$450.00'],
      ['OrderID', 'SKU', 'UnitPrice'], // Repeated pagination header
      ['ORD-103', 'SKU-C', '¥12,000'],
      ['ORD-104', 'SKU-A', ''], // Blank price -> impute
    ],
    Products: [
      ['SKU', 'ListPrice'],
      ['SKU-A', 500],
    ],
  });

  const res: any = await executeCleanAndImputeCurrency(
    {
      sheetName: 'Orders',
      sourceColumn: 'UnitPrice',
      currencyColumnName: 'Currency',
      imputeBlanks: {
        keyColumn: 'SKU',
        lookupSheetName: 'Products',
        lookupKeyColumn: 'SKU',
        lookupPriceColumn: 'ListPrice',
        baseCurrency: 'USD',
      },
    },
    dummyCtx(univerAPI)
  );

  assert.equal(res.success, true);
  assert.equal(res.existingCleanedCount, 3);
  assert.equal(res.derivedCount, 1);

  const rows = sheetStore.get('Orders')!;
  // Check header row now has 'Currency' created
  assert.equal(rows[0][2], 'UnitPrice');
  assert.equal(rows[0][3], 'Currency');

  // Check row 1
  assert.equal(rows[1][2], 1250.5);
  assert.equal(rows[1][3], 'EUR');

  // Check row 2
  assert.equal(rows[2][2], 450);
  assert.equal(rows[2][3], 'USD');

  // Check row 4 (ORD-103)
  assert.equal(rows[4][2], 12000);
  assert.equal(rows[4][3], 'JPY');

  // Check row 5 (ORD-104 derived from Products SKU-A = 500 USD)
  assert.equal(rows[5][2], 500);
  assert.equal(rows[5][3], 'USD');
});
