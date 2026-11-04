import * as XLSX from 'xlsx';
import { generateWorkbookRadar, formatCompactRadarForPrompt } from '../src/ai/radar';

export function loadFreshWorkbook(filePath: string = 'TEsting/Meridian_Nova_StressTest.xlsx') {
  const fileBuf = XLSX.readFile(filePath, { cellFormula: true, cellStyles: true });
  const sheetMetaList = fileBuf.Workbook?.Sheets || [];

  const sheetDataStore = new Map<string, {
    values: any[][];
    formulas: (string | null)[][];
    formats: (string | null)[][];
    hidden: number; // 0 = visible, 1 = hidden, 2 = very hidden
  }>();

  for (let idx = 0; idx < fileBuf.SheetNames.length; idx++) {
    const sheetName = fileBuf.SheetNames[idx];
    const ws = fileBuf.Sheets[sheetName];
    const meta = sheetMetaList.find((s: any) => s.name === sheetName);
    const hidden = meta?.Hidden ?? 0;

    let maxR = 0;
    let maxC = 0;
    if (ws['!ref']) {
      const decoded = XLSX.utils.decode_range(ws['!ref']);
      maxR = decoded.e.r;
      maxC = decoded.e.c;
    }

    const values: any[][] = [];
    const formulas: (string | null)[][] = [];
    const formats: (string | null)[][] = [];

    for (let r = 0; r <= maxR; r++) {
      values.push(new Array(maxC + 1).fill(null));
      formulas.push(new Array(maxC + 1).fill(null));
      formats.push(new Array(maxC + 1).fill(null));
    }

    Object.keys(ws).forEach((cellKey) => {
      if (cellKey.startsWith('!')) return;
      try {
        const { r, c } = XLSX.utils.decode_cell(cellKey);
        const cell = ws[cellKey];
        if (!cell) return;
        values[r][c] = cell.v !== undefined ? cell.v : null;
        if (cell.f) {
          formulas[r][c] = cell.f.startsWith('=') ? cell.f : `=${cell.f}`;
        }
        if (cell.z) {
          formats[r][c] = cell.z;
        }
      } catch {
        // ignore cell parse error
      }
    });

    sheetDataStore.set(sheetName, { values, formulas, formats, hidden });
  }

  let activeSheetName = fileBuf.SheetNames[0] || 'Sheet1';

  const makeWorksheet = (name: string) => {
    const getSheetData = () => {
      if (!sheetDataStore.has(name)) {
        sheetDataStore.set(name, { values: [[]], formulas: [[]], formats: [[]], hidden: 0 });
      }
      return sheetDataStore.get(name)!;
    };

    const parseRangeCoords = (rOrA1: any, c?: number, numR?: number, numC?: number) => {
      const data = getSheetData();
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
          startR: Math.min(p1.r, p2.r),
          startC: Math.min(p1.c, p2.c),
          rowsCount: Math.abs(p2.r - p1.r) + 1,
          colsCount: Math.abs(p2.c - p1.c) + 1,
        };
      }
      return {
        startR: Number(rOrA1) || 0,
        startC: Number(c) || 0,
        rowsCount: numR ?? 1,
        colsCount: numC ?? 1,
      };
    };

    const ensureDimensions = (minRows: number, minCols: number) => {
      const data = getSheetData();
      while (data.values.length < minRows) {
        data.values.push(new Array(Math.max(minCols, 26)).fill(null));
        data.formulas.push(new Array(Math.max(minCols, 26)).fill(null));
        data.formats.push(new Array(Math.max(minCols, 26)).fill(null));
      }
      for (let r = 0; r < data.values.length; r++) {
        while (data.values[r].length < minCols) {
          data.values[r].push(null);
          data.formulas[r].push(null);
          data.formats[r].push(null);
        }
      }
    };

    return {
      getName: () => name,
      getSheetName: () => name,
      isHidden: () => getSheetData().hidden > 0,
      getVisibility: () => getSheetData().hidden, // 0 visible, 1 hidden, 2 very hidden
      getMaxRows: () => Math.max(getSheetData().values.length + 20, 100),
      getMaxColumns: () => Math.max((getSheetData().values[0]?.length || 1) + 10, 26),
      getRowCount: () => Math.max(getSheetData().values.length, 100),
      getColumnCount: () => Math.max(getSheetData().values[0]?.length || 1, 26),
      setRowCount: (n: number) => ensureDimensions(n, 1),
      setColumnCount: (n: number) => ensureDimensions(1, n),
      getLastRow: () => Math.max(getSheetData().values.length - 1, 0),
      getLastColumn: () => Math.max((getSheetData().values[0]?.length || 1) - 1, 0),
      clear: () => {
        sheetDataStore.set(name, { values: [[]], formulas: [[]], formats: [[]], hidden: 0 });
      },
      deleteRows: (startRow: number, count: number = 1) => {
        const data = getSheetData();
        data.values.splice(startRow, count);
        data.formulas.splice(startRow, count);
        data.formats.splice(startRow, count);
      },
      insertRows: (startRow: number, count: number = 1) => {
        const data = getSheetData();
        const emptyRows = Array.from({ length: count }, () => new Array(data.values[0]?.length || 26).fill(null));
        const emptyFormulas = Array.from({ length: count }, () => new Array(data.values[0]?.length || 26).fill(null));
        const emptyFormats = Array.from({ length: count }, () => new Array(data.values[0]?.length || 26).fill(null));
        data.values.splice(startRow, 0, ...emptyRows);
        data.formulas.splice(startRow, 0, ...emptyFormulas);
        data.formats.splice(startRow, 0, ...emptyFormats);
      },
      insertColumns: (startCol: number, count: number = 1) => {
        const data = getSheetData();
        for (let r = 0; r < data.values.length; r++) {
          data.values[r].splice(startCol, 0, ...new Array(count).fill(null));
          data.formulas[r].splice(startCol, 0, ...new Array(count).fill(null));
          data.formats[r].splice(startCol, 0, ...new Array(count).fill(null));
        }
      },
      deleteColumns: (startCol: number, count: number = 1) => {
        const data = getSheetData();
        for (let r = 0; r < data.values.length; r++) {
          data.values[r].splice(startCol, count);
          data.formulas[r].splice(startCol, count);
          data.formats[r].splice(startCol, count);
        }
      },
      autoResizeColumns: () => {},
      setColumnWidth: () => {},
      getSelection: () => ({
        getActiveRange: () => ({ getA1Notation: () => 'A1' }),
      }),
      getRange: (rOrA1: any, c?: number, numR?: number, numC?: number) => {
        const coords = parseRangeCoords(rOrA1, c, numR, numC);
        const data = getSheetData();

        const rangeObj: any = {
          getRow: () => coords.startR,
          getColumn: () => coords.startC,
          getValue: () => data.values[coords.startR]?.[coords.startC] ?? null,
          getValues: () => {
            const out: any[][] = [];
            for (let r = 0; r < coords.rowsCount; r++) {
              const rowArr: any[] = [];
              const srcRow = data.values[coords.startR + r] || [];
              for (let col = 0; col < coords.colsCount; col++) {
                rowArr.push(srcRow[coords.startC + col] ?? null);
              }
              out.push(rowArr);
            }
            return out;
          },
          getFormulas: () => {
            const out: string[][] = [];
            for (let r = 0; r < coords.rowsCount; r++) {
              const rowArr: string[] = [];
              const srcRow = data.formulas[coords.startR + r] || [];
              for (let col = 0; col < coords.colsCount; col++) {
                rowArr.push(srcRow[coords.startC + col] ?? '');
              }
              out.push(rowArr);
            }
            return out;
          },
          setValue: (v: any) => {
            ensureDimensions(coords.startR + 1, coords.startC + 1);
            data.values[coords.startR][coords.startC] = v;
            return rangeObj;
          },
          setValues: (vals: any[][]) => {
            if (!Array.isArray(vals)) return rangeObj;
            const matrixRows = vals.length;
            const matrixCols = Math.max(...vals.map((r) => (Array.isArray(r) ? r.length : 0)), 1);
            ensureDimensions(coords.startR + matrixRows, coords.startC + matrixCols);
            for (let r = 0; r < matrixRows; r++) {
              const rowVals = vals[r] || [];
              for (let col = 0; col < rowVals.length; col++) {
                data.values[coords.startR + r][coords.startC + col] = rowVals[col];
              }
            }
            return rangeObj;
          },
          setFormula: (f: string) => {
            ensureDimensions(coords.startR + 1, coords.startC + 1);
            data.formulas[coords.startR][coords.startC] = f.startsWith('=') ? f : `=${f}`;
            return rangeObj;
          },
          setFormulas: (fMatrix: string[][]) => {
            if (!Array.isArray(fMatrix)) return rangeObj;
            const matrixRows = fMatrix.length;
            const matrixCols = Math.max(...fMatrix.map((r) => (Array.isArray(r) ? r.length : 0)), 1);
            ensureDimensions(coords.startR + matrixRows, coords.startC + matrixCols);
            for (let r = 0; r < matrixRows; r++) {
              const rowF = fMatrix[r] || [];
              for (let col = 0; col < rowF.length; col++) {
                const fVal = rowF[col];
                data.formulas[coords.startR + r][coords.startC + col] = fVal ? (fVal.startsWith('=') ? fVal : `=${fVal}`) : null;
              }
            }
            return rangeObj;
          },
          setNumberFormat: (mask: string) => {
            ensureDimensions(coords.startR + coords.rowsCount, coords.startC + coords.colsCount);
            for (let r = 0; r < coords.rowsCount; r++) {
              for (let col = 0; col < coords.colsCount; col++) {
                data.formats[coords.startR + r][coords.startC + col] = mask;
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
    getActiveSheet: () => makeWorksheet(activeSheetName),
    getSheetByName: (n: string) => {
      const clean = String(n).replace(/^'+|'+$/g, '').trim();
      const exact = Array.from(sheetDataStore.keys()).find((k) => k.toLowerCase() === clean.toLowerCase());
      return exact ? makeWorksheet(exact) : null;
    },
    getSheets: () => Array.from(sheetDataStore.keys()).map((n) => makeWorksheet(n)),
    insertSheet: (n: string) => {
      sheetDataStore.set(n, { values: [[]], formulas: [[]], formats: [[]], hidden: 0 });
      activeSheetName = n;
      return makeWorksheet(n);
    },
    setActiveSheet: (s: any) => {
      activeSheetName = typeof s === 'string' ? s : s.getSheetName();
    },
  };

  return {
    univerAPI: { getActiveWorkbook: () => wb },
    sheetDataStore,
  };
}

if (process.argv[1]?.endsWith('test-loader.ts')) {
  console.log('Testing fresh workbook loader...');
  const { univerAPI, sheetDataStore } = loadFreshWorkbook();
  console.log('Loaded sheets:', Array.from(sheetDataStore.keys()));
  const radar = generateWorkbookRadar(univerAPI);
  console.log('Active sheet in radar:', radar.activeSheetName);
  console.log('All sheets in radar:', radar.allSheets.map((s) => s.name));
  const compactText = formatCompactRadarForPrompt(radar);
  console.log('Compact radar length:', compactText.length);
  console.log('Success!');
}
