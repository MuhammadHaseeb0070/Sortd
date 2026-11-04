import test from 'node:test';
import assert from 'node:assert/strict';
import {
  executeGenerateChart,
  executeCreateThresholdRule,
  executeRenderSparklineStrip,
} from '../visualizer/executors';

function createVisualizerMockWorkbook(initialSheets: Record<string, any[][]>) {
  const sheetStore = new Map<string, any[][]>();
  let activeName = Object.keys(initialSheets)[0] || 'Sheet1';

  for (const [name, rows] of Object.entries(initialSheets)) {
    sheetStore.set(
      name,
      rows.map((r) => [...r])
    );
  }

  const makeWorksheet = (name: string) => {
    const getGrid = () => sheetStore.get(name)!;

    const parseRangeCoords = (rOrA1: any, c?: number, numR?: number, numC?: number) => {
      const grid = getGrid();
      if (typeof rOrA1 === 'string') {
        const clean = rOrA1.includes('!') ? rOrA1.split('!')[1] : rOrA1;
        const parts = clean.split(':');
        const parseCell = (s: string, isEnd: boolean) => {
          const colOnly = s.trim().match(/^([A-Za-z]+)$/);
          if (colOnly) {
            let col = 0;
            for (const ch of colOnly[1].toUpperCase()) col = col * 26 + (ch.charCodeAt(0) - 64);
            return { r: isEnd ? Math.max(grid.length - 1, 0) : 0, c: col - 1 };
          }
          const m = s.trim().match(/^([A-Za-z]+)(\d+)$/);
          if (!m) return { r: 0, c: 0 };
          let col = 0;
          for (const ch of m[1].toUpperCase()) col = col * 26 + (ch.charCodeAt(0) - 64);
          return { r: parseInt(m[2], 10) - 1, c: col - 1 };
        };
        const p1 = parseCell(parts[0], false);
        const p2 = parts[1] ? parseCell(parts[1], true) : p1;
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
      getLastRow: () => Math.max(getGrid().length - 1, 0),
      getLastColumn: () => Math.max((getGrid()[0]?.length || 1) - 1, 0),
      getRange: (rOrA1: any, c?: number, numR?: number, numC?: number) => {
        const coords = parseRangeCoords(rOrA1, c, numR, numC);
        const rangeObj: any = {
          getRow: () => coords.startR,
          getColumn: () => coords.startC,
          getLastRow: () => coords.startR + coords.rowsCount - 1,
          getLastColumn: () => coords.startC + coords.colsCount - 1,
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
          setBackgroundColor: () => rangeObj,
          setFontColor: () => rangeObj,
          setFontWeight: () => rangeObj,
          setFontFamily: () => rangeObj,
          setNumberFormat: () => rangeObj,
        };
        return rangeObj;
      },
    };
  };

  const wb = {
    getActiveSheet: () => makeWorksheet(activeName),
    getSheetByName: (n: string) => (sheetStore.has(n) ? makeWorksheet(n) : null),
  };

  return {
    univerAPI: { getActiveWorkbook: () => wb },
    sheetStore,
  };
}

const dummyCtx = (univerAPI: any) => ({
  univerAPI,
  activeProfileId: 'visualizer' as const,
  onProfileSwitch: () => {},
});

test('executeGenerateChart refuses to plot 1,000 overlapping bars for Quantity vs Unit Price; emits expertAdvisory and bins into <= 20 clean segments', async () => {
  const rows: any[][] = [['OrderID', 'Quantity', 'Unit Price']];
  for (let i = 1; i <= 1000; i++) {
    const qty = (i % 50) + 1;
    const price = Number((10 + (i % 200) * 1.75).toFixed(2));
    rows.push([`ORD-${i}`, qty, price]);
  }

  const { univerAPI } = createVisualizerMockWorkbook({ Orders: rows });

  const res: any = await executeGenerateChart(
    {
      range: 'A1:C1001',
      chartType: 'bar',
      xAxisColumn: 'Unit Price',
      yAxisColumns: ['Quantity'],
    },
    dummyCtx(univerAPI)
  );

  assert.equal(res.status, 'SUCCESS');
  assert.ok(res.chartPayload.expertAdvisory, 'Must include expertAdvisory explaining why 1,000 raw bars were segmented/binned');
  assert.ok(
    res.chartPayload.categories.length <= 20,
    `Expected <= 20 segmented categories/bins, got ${res.chartPayload.categories.length}`
  );
});

test('executeGenerateChart aggregates repeated categories and rolls up >12 categories into Top 10 + Other', async () => {
  const rows: any[][] = [['Product', 'Revenue']];
  // 20 distinct products, each appearing 3 times
  for (let p = 1; p <= 20; p++) {
    rows.push([`Product_${p}`, p * 100]);
    rows.push([`Product_${p}`, p * 100]);
    rows.push([`Product_${p}`, p * 100]);
  }

  const { univerAPI } = createVisualizerMockWorkbook({ Sales: rows });

  const res: any = await executeGenerateChart(
    {
      range: 'A1:B61',
      chartType: 'column',
      xAxisColumn: 'Product',
      yAxisColumns: ['Revenue'],
    },
    dummyCtx(univerAPI)
  );

  assert.equal(res.status, 'SUCCESS');
  // 20 distinct products -> Top 10 + 1 "Other (10 items)" = 11 categories!
  assert.equal(res.chartPayload.categories.length, 11);
  assert.ok(res.chartPayload.categories[10].startsWith('Other'), '11th bar must be Other rollup');
  // Top product is Product_20 with 3 * 2000 = 6000
  assert.equal(res.chartPayload.series[0].data[0], 6000);
});

test('executeGenerateChart switches donut chart to bar when >6 slices or negative values exist', async () => {
  const rows: any[][] = [
    ['Segment', 'Profit'],
    ['A', 500],
    ['B', 400],
    ['C', -120],
    ['D', 200],
  ];

  const { univerAPI } = createVisualizerMockWorkbook({ ProfitSheet: rows });

  const res: any = await executeGenerateChart(
    {
      range: 'A1:B5',
      chartType: 'donut',
      xAxisColumn: 'Segment',
      yAxisColumns: ['Profit'],
    },
    dummyCtx(univerAPI)
  );

  assert.equal(res.status, 'SUCCESS');
  assert.equal(res.chartPayload.chartType, 'bar');
  assert.ok(res.chartPayload.expertAdvisory, 'Must advise why donut was switched to bar for negative values');
});

test('executeGenerateChart computes Freedman-Diaconis bins for histogram chartType', async () => {
  const rows: any[][] = [['OrderValue']];
  for (let i = 1; i <= 120; i++) {
    rows.push([Math.round(Math.pow(i, 1.3))]);
  }

  const { univerAPI } = createVisualizerMockWorkbook({ DistSheet: rows });

  const res: any = await executeGenerateChart(
    {
      range: 'A1:A121',
      chartType: 'histogram',
      yAxisColumns: ['OrderValue'],
    },
    dummyCtx(univerAPI)
  );

  assert.equal(res.status, 'SUCCESS');
  assert.equal(res.chartPayload.chartType, 'histogram');
  assert.ok(res.chartPayload.categories.length >= 4 && res.chartPayload.categories.length <= 20);
  const totalCount = res.chartPayload.series[0].data.reduce((a: number, b: number) => a + b, 0);
  assert.equal(totalCount, 120);
});

test('executeRenderSparklineStrip does not overwrite row 2 data with header when sourceRange starts at row 2', async () => {
  const { univerAPI, sheetStore } = createVisualizerMockWorkbook({
    Sheet1: [
      ['Rep', 'Q1', 'Q2', 'Q3', 'Trend'],
      ['Alice', 10, 20, 30, ''],
      ['Bob', 30, 20, 10, ''],
    ],
  });

  const res: any = await executeRenderSparklineStrip(
    {
      sourceRange: 'B2:D3',
      targetColumn: 'E',
      headerTitle: 'Trajectory',
    },
    dummyCtx(univerAPI)
  );

  assert.equal(res.status, 'SUCCESS');
  assert.equal(res.rowsRendered, 2);
  const grid = sheetStore.get('Sheet1')!;
  assert.equal(grid[0][4], 'Trajectory'); // Row 1 header gets Title
  assert.ok(grid[1][4].length === 3, 'Alice (Row 2) must get a 3-bar sparkline, not be overwritten by header!');
  assert.ok(grid[2][4].length === 3, 'Bob (Row 3) must get a 3-bar sparkline');
});
