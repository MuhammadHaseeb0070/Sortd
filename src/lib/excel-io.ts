import * as XLSX from 'xlsx';
import type { IWorkbookData, IWorksheetData, Nullable, IRange } from '@univerjs/presets';
import { LocaleType } from '@univerjs/presets';

/**
 * Parses an uploaded .xlsx or .csv file into Univer's IWorkbookData structure.
 */
export async function parseExcelFileToUniverData(file: File): Promise<IWorkbookData> {
  const arrayBuffer = await file.arrayBuffer();
  const workbook = XLSX.read(arrayBuffer, {
    type: 'array',
    cellFormula: true,
    cellStyles: true,
    cellDates: true,
  });

  const sheetNames = workbook.SheetNames;
  if (!sheetNames || sheetNames.length === 0) {
    throw new Error('No sheets found in the uploaded workbook.');
  }

  const sheets: Record<string, Partial<IWorksheetData>> = {};
  const sheetOrder: string[] = [];

  sheetNames.forEach((sheetName, index) => {
    const sheetId = `sheet_${index + 1}_${Math.random().toString(36).slice(2, 8)}`;
    sheetOrder.push(sheetId);

    const worksheet = workbook.Sheets[sheetName];
    const cellData: Record<number, Record<number, { v?: string | number | boolean; f?: string }>> = {};

    let maxRow = 0;
    let maxCol = 0;

    if (worksheet['!ref']) {
      const range = XLSX.utils.decode_range(worksheet['!ref']);
      maxRow = range.e.r;
      maxCol = range.e.c;
    }

    // Process all cells in the worksheet
    Object.keys(worksheet).forEach((key) => {
      if (key.startsWith('!')) return;

      try {
        const { r, c } = XLSX.utils.decode_cell(key);
        if (r > maxRow) maxRow = r;
        if (c > maxCol) maxCol = c;

        if (!cellData[r]) {
          cellData[r] = {};
        }

        const cell = worksheet[key];
        if (!cell) return;

        let cellValue: string | number | boolean | undefined = undefined;
        if (cell.t === 'b') {
          cellValue = Boolean(cell.v);
        } else if (cell.t === 'n') {
          cellValue = typeof cell.v === 'number' ? cell.v : Number(cell.v);
        } else if (cell.v !== undefined && cell.v !== null) {
          cellValue = String(cell.v);
        }

        let formula: string | undefined = undefined;
        if (cell.f) {
          formula = cell.f.startsWith('=') ? cell.f : `=${cell.f}`;
        }

        cellData[r][c] = {
          ...(cellValue !== undefined ? { v: cellValue } : {}),
          ...(formula ? { f: formula } : {}),
        };
      } catch (err) {
        console.warn(`Failed to parse cell ${key} in sheet ${sheetName}:`, err);
      }
    });

    // Parse merged cells if present
    const mergeData: IRange[] = [];
    if (worksheet['!merges']) {
      worksheet['!merges'].forEach((m) => {
        mergeData.push({
          startRow: m.s.r,
          endRow: m.e.r,
          startColumn: m.s.c,
          endColumn: m.e.c,
        });
      });
    }

    const rowCount = Math.max(maxRow + 10, 36);
    const columnCount = Math.max(maxCol + 5, 26);

    sheets[sheetId] = {
      id: sheetId,
      name: sheetName,
      cellData,
      rowCount,
      columnCount,
      tabColor: '',
      mergeData,
    };
  });

  const baseFileName = file.name.replace(/\.[^/.]+$/, '');

  const workbookData: IWorkbookData = {
    id: `workbook_${Date.now()}`,
    name: baseFileName || 'Imported Workbook',
    appVersion: '3.0.0',
    locale: LocaleType.EN_US,
    styles: {},
    sheetOrder,
    sheets,
  };

  return workbookData;
}

/**
 * Exports the active Univer workbook to a valid .xlsx file and initiates download.
 */
export function exportUniverToExcel(univerAPI: any, fileName?: string): void {
  if (!univerAPI) {
    throw new Error('Univer API instance is not available.');
  }

  const activeWorkbook =
    typeof univerAPI.getActiveWorkbook === 'function'
      ? univerAPI.getActiveWorkbook()
      : typeof univerAPI.getCurrentUniverSheet === 'function'
      ? univerAPI.getCurrentUniverSheet()
      : null;

  if (!activeWorkbook) {
    throw new Error('No active workbook found to export.');
  }

  const wb = XLSX.utils.book_new();
  const snapshot: Nullable<IWorkbookData> =
    typeof activeWorkbook.save === 'function' ? activeWorkbook.save() : null;

  if (snapshot && snapshot.sheets && snapshot.sheetOrder) {
    // Export using saved snapshot data
    snapshot.sheetOrder.forEach((sheetId) => {
      const sheetData = snapshot.sheets[sheetId];
      if (!sheetData) return;

      const sheetName = sheetData.name || `Sheet_${sheetId}`;
      const cellData = sheetData.cellData || {};
      const ws: XLSX.WorkSheet = {};

      let minR = Infinity;
      let maxR = 0;
      let minC = Infinity;
      let maxC = 0;
      let hasCells = false;

      Object.keys(cellData).forEach((rowKey) => {
        const r = Number(rowKey);
        const rowCells = cellData[r];
        if (!rowCells) return;

        Object.keys(rowCells).forEach((colKey) => {
          const c = Number(colKey);
          const cell = rowCells[c];
          if (!cell || (cell.v === undefined && !cell.f)) return;

          hasCells = true;
          if (r < minR) minR = r;
          if (r > maxR) maxR = r;
          if (c < minC) minC = c;
          if (c > maxC) maxC = c;

          const cellRef = XLSX.utils.encode_cell({ r, c });
          let cellType: XLSX.ExcelDataType = 's';
          if (typeof cell.v === 'number') {
            cellType = 'n';
          } else if (typeof cell.v === 'boolean') {
            cellType = 'b';
          }

          let formula: string | undefined = undefined;
          if (cell.f) {
            formula = cell.f.startsWith('=') ? cell.f.slice(1) : cell.f;
          }

          ws[cellRef] = {
            t: cellType,
            v: cell.v ?? '',
            ...(formula ? { f: formula } : {}),
          };
        });
      });

      if (hasCells) {
        ws['!ref'] = XLSX.utils.encode_range({
          s: { r: minR, c: minC },
          e: { r: maxR, c: maxC },
        });
      } else {
        ws['!ref'] = 'A1:A1';
      }

      if (sheetData.mergeData && sheetData.mergeData.length > 0) {
        ws['!merges'] = sheetData.mergeData.map((m) => ({
          s: { r: m.startRow, c: m.startColumn },
          e: { r: m.endRow, c: m.endColumn },
        }));
      }

      XLSX.utils.book_append_sheet(wb, ws, sheetName);
    });
  } else {
    // Fallback using active sheets directly
    const sheets = typeof activeWorkbook.getSheets === 'function' ? activeWorkbook.getSheets() : [];
    if (sheets.length === 0) {
      const activeSheet = activeWorkbook.getActiveSheet?.();
      if (activeSheet) sheets.push(activeSheet);
    }

    sheets.forEach((sheet: any) => {
      const sheetName = sheet.getSheetName?.() || 'Sheet1';
      const lastRow = Math.max(sheet.getLastRow?.() ?? 0, 0);
      const lastCol = Math.max(sheet.getLastColumn?.() ?? 0, 0);

      const ws: XLSX.WorkSheet = {};
      const range = sheet.getRange?.(0, 0, lastRow + 1, lastCol + 1);
      const values = range?.getValues?.() || [];
      const formulas = range?.getFormulas?.() || [];

      for (let r = 0; r <= lastRow; r++) {
        for (let c = 0; c <= lastCol; c++) {
          const v = values[r]?.[c];
          const f = formulas[r]?.[c];
          if (v === undefined && !f) continue;

          const cellRef = XLSX.utils.encode_cell({ r, c });
          const rawFormula = f ? (String(f).startsWith('=') ? String(f).slice(1) : String(f)) : undefined;

          ws[cellRef] = {
            t: typeof v === 'number' ? 'n' : typeof v === 'boolean' ? 'b' : 's',
            v: v ?? '',
            ...(rawFormula ? { f: rawFormula } : {}),
          };
        }
      }

      ws['!ref'] = XLSX.utils.encode_range({
        s: { r: 0, c: 0 },
        e: { r: Math.max(lastRow, 0), c: Math.max(lastCol, 0) },
      });

      XLSX.utils.book_append_sheet(wb, ws, sheetName);
    });
  }

  // Generate binary output and download in browser
  const defaultBaseName = activeWorkbook.getName?.() || 'workbook';
  const outName = fileName || `${defaultBaseName}.xlsx`;
  const finalFileName = outName.toLowerCase().endsWith('.xlsx') ? outName : `${outName}.xlsx`;

  const wbout = XLSX.write(wb, { bookType: 'xlsx', type: 'array' });
  const blob = new Blob([wbout], {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  });

  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = finalFileName;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
