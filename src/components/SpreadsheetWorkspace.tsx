'use client';

import React, { useEffect, useRef, useState, useCallback } from 'react';
import {
  createUniver,
  defaultTheme,
  LocaleType,
  mergeLocales,
} from '@univerjs/presets';
import { UniverSheetsCorePreset } from '@univerjs/preset-sheets-core';
import UniverPresetSheetsCoreEnUS from '@univerjs/preset-sheets-core/locales/en-US';
import '@univerjs/preset-sheets-core/lib/index.css';

import {
  Upload,
  Download,
  Sparkles,
  RefreshCw,
  FileSpreadsheet,
  MousePointer,
  Table,
  CheckCircle2,
  AlertCircle,
  PanelRight,
  Layers,
  ArrowLeft,
} from 'lucide-react';
import * as XLSX from 'xlsx';
import { parseExcelFileToUniverData, exportUniverToExcel } from '@/lib/excel-io';
import AIWorkbenchSidebar from '@/components/AIWorkbenchSidebar';

interface SheetTabItem {
  id: string;
  name: string;
  rowCount: number;
  colCount: number;
}

interface SheetTelemetry {
  workbookName: string;
  sheetName: string;
  populatedRows: number;
  populatedCols: number;
  selectedRange: string;
}

interface SpreadsheetWorkspaceProps {
  initialFile?: File | null;
  onBackToHome?: () => void;
}

export default function SpreadsheetWorkspace({
  initialFile,
  onBackToHome,
}: SpreadsheetWorkspaceProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const univerRef = useRef<any>(null);
  const univerAPIRef = useRef<any>(null);
  const [apiInstance, setApiInstance] = useState<any>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const selectionListenerRef = useRef<any>(null);

  const [isLoading, setIsLoading] = useState(false);
  const [statusMessage, setStatusMessage] = useState<{
    type: 'success' | 'error' | 'info';
    text: string;
  } | null>(null);

  // Workbench Sidebar State
  const [isSidebarOpen, setIsSidebarOpen] = useState(true);
  const [sidebarWidth, setSidebarWidth] = useState(410);
  const [isDraggingSidebar, setIsDraggingSidebar] = useState(false);

  // Multi-Sheet Tabs State
  const [sheetsList, setSheetsList] = useState<SheetTabItem[]>([
    { id: 'sheet_1', name: 'Sheet1', rowCount: 0, colCount: 0 },
  ]);

  const [telemetry, setTelemetry] = useState<SheetTelemetry>({
    workbookName: 'Sortd Sheet',
    sheetName: 'Sheet1',
    populatedRows: 0,
    populatedCols: 0,
    selectedRange: 'A1',
  });

  // Refresh live telemetry from univerAPI
  const refreshTelemetry = useCallback(() => {
    const api = univerAPIRef.current;
    if (!api) return;

    try {
      const workbook = api.getActiveWorkbook?.();
      if (!workbook) return;

      const sheet = workbook.getActiveSheet?.();
      if (!sheet) return;

      const sheetName = sheet.getSheetName?.() || 'Sheet1';
      const lastRow = Math.max((sheet.getLastRow?.() ?? 0) + 1, 0);
      const lastCol = Math.max((sheet.getLastColumn?.() ?? 0) + 1, 0);

      let selectedRangeNotation = 'A1';
      try {
        const activeRange = workbook.getActiveRange?.() || sheet.getActiveRange?.();
        if (activeRange) {
          selectedRangeNotation = activeRange.getA1Notation?.() || 'A1';
        }
      } catch {
        // Range notation query fallback
      }

      setTelemetry({
        workbookName: workbook.getName?.() || 'Workbook',
        sheetName,
        populatedRows: lastRow,
        populatedCols: lastCol,
        selectedRange: selectedRangeNotation,
      });

      // Extract all sheets for top tab navigation
      const rawSheets = workbook.getSheets?.() || [];
      const tabs: SheetTabItem[] = rawSheets.map((s: any) => ({
        id: s.getSheetId?.() || s.getSheetName?.() || 'sheet',
        name: s.getSheetName?.() || 'Sheet',
        rowCount: Math.max((s.getLastRow?.() ?? 0) + 1, 0),
        colCount: Math.max((s.getLastColumn?.() ?? 0) + 1, 0),
      }));

      setSheetsList(
        tabs.length > 0
          ? tabs
          : [{ id: 'sheet_1', name: sheetName, rowCount: lastRow, colCount: lastCol }]
      );
    } catch (err) {
      console.warn('Error refreshing telemetry:', err);
    }
  }, []);

  // Switch visible worksheet tab
  const handleSwitchSheet = (targetSheetName: string) => {
    const api = univerAPIRef.current;
    if (!api) return;
    try {
      const wb = api.getActiveWorkbook?.();
      if (!wb) return;
      const target = wb.getSheetByName?.(targetSheetName);
      if (target) {
        wb.setActiveSheet(target);
        setTimeout(refreshTelemetry, 50);
      }
    } catch (err) {
      console.warn('Switch sheet failed:', err);
    }
  };

  // Add new worksheet tab
  const handleAddNewSheet = () => {
    const api = univerAPIRef.current;
    if (!api) return;
    try {
      const wb = api.getActiveWorkbook?.();
      if (!wb) return;
      const newName = `Sheet${sheetsList.length + 1}`;
      wb.insertSheet?.(newName);
      const newSheet = wb.getSheetByName?.(newName);
      if (newSheet) {
        wb.setActiveSheet(newSheet);
      }
      setTimeout(refreshTelemetry, 100);
    } catch (err) {
      console.warn('Failed to add new sheet:', err);
    }
  };

  // Hook listeners onto a workbook
  const attachWorkbookListeners = useCallback((workbook: any) => {
    if (!workbook) return;

    if (selectionListenerRef.current) {
      try {
        selectionListenerRef.current.dispose?.();
      } catch {
        // ignore
      }
      selectionListenerRef.current = null;
    }

    try {
      if (typeof workbook.onSelectionChange === 'function') {
        selectionListenerRef.current = workbook.onSelectionChange((selections: any[]) => {
          if (selections && selections.length > 0) {
            const s = selections[0];
            const range = s.range || s;
            if (range && range.startRow !== undefined) {
              const notation =
                range.startRow === range.endRow && range.startColumn === range.endColumn
                  ? XLSX.utils.encode_cell({ r: range.startRow, c: range.startColumn })
                  : XLSX.utils.encode_range({
                      s: { r: range.startRow, c: range.startColumn },
                      e: { r: range.endRow, c: range.endColumn },
                    });

              setTelemetry((prev) => ({
                ...prev,
                selectedRange: notation,
              }));
            }
          }
        });
      }
    } catch (err) {
      console.warn('Could not register onSelectionChange listener:', err);
    }
  }, []);

  // Initialize Univer lifecycle
  useEffect(() => {
    if (!containerRef.current) return;

    // Strict lifecycle cleanup
    if (univerRef.current) {
      try {
        univerRef.current.dispose();
      } catch (e) {
        console.warn('Cleanup previous Univer instance:', e);
      }
      univerRef.current = null;
      univerAPIRef.current = null;
    }

    containerRef.current.innerHTML = '';

    try {
      const { univer, univerAPI } = createUniver({
        locale: LocaleType.EN_US,
        locales: {
          [LocaleType.EN_US]: mergeLocales(UniverPresetSheetsCoreEnUS),
        },
        theme: defaultTheme,
        presets: [
          UniverSheetsCorePreset({
            container: containerRef.current,
            header: true,
            footer: {
              sheetBar: true,
            },
          }),
        ],
      });

      univerRef.current = univer;
      univerAPIRef.current = univerAPI;
      setApiInstance(univerAPI);

      if (initialFile) {
        setIsLoading(true);
        setStatusMessage({ type: 'info', text: `Parsing "${initialFile.name}"...` });
        parseExcelFileToUniverData(initialFile)
          .then((workbookData) => {
            const newWorkbook = univerAPI.createWorkbook(workbookData);
            attachWorkbookListeners(newWorkbook);

            const importedTabs: SheetTabItem[] = (workbookData.sheetOrder || []).map((sId) => {
              const sData = workbookData.sheets[sId];
              return {
                id: sId,
                name: sData?.name || sId,
                rowCount: sData?.rowCount || 0,
                colCount: sData?.columnCount || 0,
              };
            });
            if (importedTabs.length > 0) {
              setSheetsList(importedTabs);
            }

            try {
              const firstSheet = newWorkbook.getSheets?.()?.[0];
              if (firstSheet) {
                newWorkbook.setActiveSheet(firstSheet);
              }
            } catch {
              // ignore
            }

            setStatusMessage({
              type: 'success',
              text: `Loaded "${initialFile.name}" successfully.`,
            });
            setTimeout(refreshTelemetry, 250);
          })
          .catch((err) => {
            console.error('Failed to load initial file:', err);
            const fallbackWorkbook = univerAPI.createWorkbook({
              id: 'workbook_init',
              name: 'Sortd Sheet',
            });
            attachWorkbookListeners(fallbackWorkbook);
            setStatusMessage({
              type: 'error',
              text: `Could not parse file. Created fresh blank sheet.`,
            });
            setTimeout(refreshTelemetry, 300);
          })
          .finally(() => {
            setIsLoading(false);
          });
      } else {
        const initialWorkbook = univerAPI.createWorkbook({
          id: 'workbook_init',
          name: 'Sortd Financial Model',
        });
        attachWorkbookListeners(initialWorkbook);
        setTimeout(refreshTelemetry, 300);
      }
    } catch (err) {
      console.error('Failed to initialize Univer:', err);
      setStatusMessage({
        type: 'error',
        text: 'Failed to initialize spreadsheet engine.',
      });
    }

    return () => {
      if (selectionListenerRef.current) {
        try {
          selectionListenerRef.current.dispose?.();
        } catch {
          // ignore
        }
        selectionListenerRef.current = null;
      }
      if (univerRef.current) {
        try {
          univerRef.current.dispose();
        } catch (e) {
          console.warn('Unmount Univer disposal:', e);
        }
        univerRef.current = null;
        univerAPIRef.current = null;
        setApiInstance(null);
      }
    };
  }, [attachWorkbookListeners, refreshTelemetry, initialFile]);

  // Global Ctrl/Cmd + B shortcut to toggle AI Workbench
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'b') {
        e.preventDefault();
        setIsSidebarOpen((prev) => !prev);
        setTimeout(() => window.dispatchEvent(new Event('resize')), 50);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  // Upload handler
  const handleFileUpload = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;

    const api = univerAPIRef.current;
    if (!api) {
      setStatusMessage({ type: 'error', text: 'Univer engine is not ready.' });
      return;
    }

    setIsLoading(true);
    setStatusMessage({ type: 'info', text: `Parsing "${file.name}"...` });

    try {
      const workbookData = await parseExcelFileToUniverData(file);

      // Cleanly dispose active workbook before mounting imported workbook
      const currentWb = api.getActiveWorkbook?.();
      if (currentWb) {
        try {
          currentWb.dispose();
        } catch (e) {
          console.warn('Disposing existing workbook:', e);
        }
      }

      const newWorkbook = api.createWorkbook(workbookData);
      attachWorkbookListeners(newWorkbook);

      // Immediately display all imported sheets in the top tab strip
      const importedTabs: SheetTabItem[] = (workbookData.sheetOrder || []).map((sId) => {
        const sData = workbookData.sheets[sId];
        return {
          id: sId,
          name: sData?.name || sId,
          rowCount: sData?.rowCount || 0,
          colCount: sData?.columnCount || 0,
        };
      });
      if (importedTabs.length > 0) {
        setSheetsList(importedTabs);
      }

      // Ensure the first sheet is focused as active
      try {
        const firstSheet = newWorkbook.getSheets?.()?.[0];
        if (firstSheet) {
          newWorkbook.setActiveSheet(firstSheet);
        }
      } catch {
        // ignore
      }

      const sheetCount = Object.keys(workbookData.sheets).length;
      setStatusMessage({
        type: 'success',
        text: `Loaded "${file.name}" successfully (${sheetCount} sheet${sheetCount > 1 ? 's' : ''}).`,
      });

      refreshTelemetry();
      setTimeout(refreshTelemetry, 200);
    } catch (err: any) {
      console.error('File import error:', err);
      setStatusMessage({
        type: 'error',
        text: `Upload failed: ${err.message || String(err)}`,
      });
    } finally {
      setIsLoading(false);
      if (fileInputRef.current) {
        fileInputRef.current.value = '';
      }
    }
  };

  // Download handler
  const handleDownload = () => {
    const api = univerAPIRef.current;
    if (!api) {
      setStatusMessage({ type: 'error', text: 'Univer engine is not initialized.' });
      return;
    }

    try {
      const activeWorkbook = api.getActiveWorkbook?.();
      const currentName = activeWorkbook?.getName?.() || 'sortd-workbook';
      exportUniverToExcel(api, `${currentName}.xlsx`);
      setStatusMessage({
        type: 'success',
        text: `Exported "${currentName}.xlsx" successfully.`,
      });
    } catch (err: any) {
      console.error('Download error:', err);
      setStatusMessage({
        type: 'error',
        text: `Export failed: ${err.message || String(err)}`,
      });
    }
  };

  // AI Micro-Op handler
  const handleTestMicroOp = () => {
    const api = univerAPIRef.current;
    if (!api) {
      setStatusMessage({ type: 'error', text: 'Univer engine is not ready.' });
      return;
    }

    const workbook = api.getActiveWorkbook?.();
    const sheet = workbook?.getActiveSheet?.();
    if (!sheet) {
      setStatusMessage({ type: 'error', text: 'No active worksheet found.' });
      return;
    }

    try {
      // 1. Write sample headers ["Item", "Revenue", "Cost", "Profit"] in A1:D1
      const headerRange = sheet.getRange('A1:D1');
      headerRange.setValues([['Item', 'Revenue', 'Cost', 'Profit']]);
      headerRange.setBackgroundColor('#f1f5f9');
      headerRange.setFontColor('#0f172a');
      headerRange.setFontWeight('bold');

      // 2. Populate 5 rows of sample numbers in A2:C6
      const dataRange = sheet.getRange('A2:C6');
      dataRange.setValues([
        ['SaaS Subscriptions', 125000, 42000],
        ['Enterprise Licenses', 240000, 85000],
        ['Consulting Services', 92000, 38000],
        ['Cloud Infrastructure', 68000, 24000],
        ['API Usage Billing', 115000, 31000],
      ]);

      // 3. Inject Excel formulas =B2-C2 into D2:D6
      const formulaRange = sheet.getRange('D2:D6');
      formulaRange.setFormulas([
        ['=B2-C2'],
        ['=B3-C3'],
        ['=B4-C4'],
        ['=B5-C5'],
        ['=B6-C6'],
      ]);
      formulaRange.setFontWeight('bold');
      formulaRange.setFontColor('#059669');

      setStatusMessage({
        type: 'success',
        text: 'AI Micro-Op completed: Injected headers, 5 rows data, and live formulas =B2-C2 in D2:D6!',
      });

      setTimeout(refreshTelemetry, 250);
    } catch (err: any) {
      console.error('AI Micro-Op execution failed:', err);
      setStatusMessage({
        type: 'error',
        text: `Micro-Op failed: ${err.message || String(err)}`,
      });
    }
  };

  return (
    <div className="h-screen w-screen overflow-hidden flex flex-col bg-[#FAFAFA] text-slate-800 font-sans select-none">
      {/* 1. TOP ACTION BAR (Clean Light Executive Style) */}
      <header className="h-12 border-b border-slate-200 bg-white px-3 sm:px-4 flex items-center justify-between z-10 shrink-0">
        <div className="flex items-center space-x-2 sm:space-x-3">
          {onBackToHome && (
            <button
              onClick={onBackToHome}
              className="flex items-center space-x-1 px-2.5 py-1.5 rounded-md text-xs font-medium text-slate-600 hover:text-slate-900 hover:bg-slate-100 border border-slate-200 transition cursor-pointer"
              title="Return to Home"
            >
              <ArrowLeft className="h-3.5 w-3.5" />
              <span className="hidden sm:inline">Home</span>
            </button>
          )}

          <div className="flex items-center space-x-2">
            <div className="h-7 w-7 rounded-md bg-emerald-600 flex items-center justify-center text-white font-bold text-sm shadow-xs">
              S
            </div>
            <div className="flex items-baseline space-x-1.5">
              <span className="font-semibold tracking-tight text-slate-900 text-sm">Sortd</span>
              <span className="text-[10px] px-1.5 py-0.5 rounded font-medium bg-emerald-50 text-emerald-700 border border-emerald-200">
                AI Studio
              </span>
            </div>
          </div>
          <span className="text-slate-200 hidden sm:inline">|</span>

          {/* Compact Telemetry Badges */}
          <div className="hidden md:flex items-center space-x-2 text-xs text-slate-500 font-mono">
            <span className="flex items-center space-x-1 bg-slate-50 px-2 py-0.5 rounded border border-slate-200">
              <FileSpreadsheet className="h-3 w-3 text-slate-400" />
              <span className="text-slate-700">{telemetry.sheetName}</span>
            </span>

            <span className="flex items-center space-x-1 bg-slate-50 px-2 py-0.5 rounded border border-slate-200">
              <MousePointer className="h-3 w-3 text-emerald-600" />
              <span className="text-slate-800 font-medium">{telemetry.selectedRange}</span>
            </span>

            {telemetry.populatedRows > 0 && (
              <span className="flex items-center space-x-1 bg-slate-50 px-2 py-0.5 rounded border border-slate-200">
                <Table className="h-3 w-3 text-emerald-600" />
                <span className="text-slate-600">
                  {telemetry.populatedRows}R × {telemetry.populatedCols}C
                </span>
              </span>
            )}

            <button
              onClick={refreshTelemetry}
              className="p-1 rounded bg-slate-50 hover:bg-slate-100 border border-slate-200 text-slate-500 hover:text-slate-800 transition cursor-pointer"
              title="Refresh telemetry"
            >
              <RefreshCw className="h-3 w-3" />
            </button>
          </div>
        </div>

        {/* Action Controls */}
        <div className="flex items-center space-x-1.5 sm:space-x-2">
          {/* Hidden File Input */}
          <input
            ref={fileInputRef}
            type="file"
            accept=".xlsx,.xls,.csv"
            onChange={handleFileUpload}
            className="hidden"
          />

          <button
            onClick={() => fileInputRef.current?.click()}
            disabled={isLoading}
            className="flex items-center space-x-1.5 px-2.5 sm:px-3 py-1.5 rounded-md text-xs font-medium bg-white hover:bg-slate-50 text-slate-700 border border-slate-300 shadow-2xs transition disabled:opacity-50 cursor-pointer"
            title="Import Excel or CSV file"
          >
            <Upload className="h-3.5 w-3.5 text-slate-500" />
            <span className="hidden sm:inline">Upload .xlsx / .csv</span>
            <span className="sm:hidden">Upload</span>
          </button>

          <button
            onClick={handleDownload}
            disabled={isLoading}
            className="flex items-center space-x-1.5 px-2.5 sm:px-3 py-1.5 rounded-md text-xs font-medium bg-white hover:bg-slate-50 text-slate-700 border border-slate-300 shadow-2xs transition disabled:opacity-50 cursor-pointer"
            title="Export to .xlsx"
          >
            <Download className="h-3.5 w-3.5 text-slate-500" />
            <span className="hidden sm:inline">Download</span>
          </button>

          <button
            onClick={handleTestMicroOp}
            disabled={isLoading}
            className="flex items-center space-x-1.5 px-2.5 sm:px-3 py-1.5 rounded-md text-xs font-medium bg-emerald-600 hover:bg-emerald-700 text-white shadow-2xs transition disabled:opacity-50 cursor-pointer"
            title="Demonstrate programmatic Univer cell & formula operations"
          >
            <Sparkles className="h-3.5 w-3.5 text-emerald-100" />
            <span className="hidden sm:inline">AI Micro-Op</span>
          </button>

          <span className="text-slate-200">|</span>

          {/* AI Workbench Toggle */}
          <button
            onClick={() => {
              setIsSidebarOpen(!isSidebarOpen);
              setTimeout(() => window.dispatchEvent(new Event('resize')), 50);
            }}
            className={`flex items-center space-x-1.5 px-2.5 sm:px-3 py-1.5 rounded-md text-xs font-medium border transition cursor-pointer ${
              isSidebarOpen
                ? 'bg-emerald-50 border-emerald-300 text-emerald-800'
                : 'bg-white hover:bg-slate-50 border-slate-300 text-slate-700'
            }`}
            title="Toggle AI Workbench (Ctrl+B)"
          >
            <PanelRight className="h-3.5 w-3.5 text-emerald-600" />
            <span>AI Workbench</span>
          </button>
        </div>
      </header>

      {/* Optional Status Banner */}
      {statusMessage && (
        <div
          className={`px-4 py-1.5 text-xs flex items-center justify-between border-b transition-all ${
            statusMessage.type === 'success'
              ? 'bg-emerald-50 border-emerald-200 text-emerald-800'
              : statusMessage.type === 'error'
              ? 'bg-rose-50 border-rose-200 text-rose-800'
              : 'bg-sky-50 border-sky-200 text-sky-800'
          }`}
        >
          <div className="flex items-center space-x-2">
            {statusMessage.type === 'success' && <CheckCircle2 className="h-3.5 w-3.5 text-emerald-600" />}
            {statusMessage.type === 'error' && <AlertCircle className="h-3.5 w-3.5 text-rose-600" />}
            {statusMessage.type === 'info' && <RefreshCw className="h-3.5 w-3.5 text-sky-600 animate-spin" />}
            <span className="font-medium">{statusMessage.text}</span>
          </div>
          <button
            onClick={() => setStatusMessage(null)}
            className="text-xs hover:opacity-75 font-mono cursor-pointer ml-4"
          >
            ×
          </button>
        </div>
      )}

      {/* 2. PROMINENT TOP SHEET TAB STRIP (Refined Light Aesthetic) */}
      <div className="h-8 bg-[#F8FAFC] border-b border-slate-200 flex items-center px-3 space-x-1 shrink-0 overflow-x-auto select-none font-sans z-10">
        <span className="text-[10px] font-mono uppercase tracking-wider text-slate-500 mr-1.5 flex items-center space-x-1 shrink-0">
          <Layers className="h-3 w-3 text-slate-400" />
          <span>Tabs:</span>
        </span>

        {sheetsList.map((s) => {
          const isActive = s.name === telemetry.sheetName;
          return (
            <button
              key={s.id || s.name}
              onClick={() => handleSwitchSheet(s.name)}
              className={`h-6 px-2.5 flex items-center space-x-1.5 text-xs rounded transition cursor-pointer border ${
                isActive
                  ? 'bg-white border-slate-300 text-slate-900 font-medium shadow-2xs'
                  : 'bg-transparent border-transparent text-slate-600 hover:text-slate-900 hover:bg-slate-200/50'
              }`}
            >
              <FileSpreadsheet
                className={`h-3 w-3 ${isActive ? 'text-emerald-600' : 'text-slate-400'}`}
              />
              <span className="truncate max-w-[130px]">{s.name}</span>
              {s.rowCount > 0 && (
                <span
                  className={`text-[9.5px] font-mono px-1 rounded ${
                    isActive ? 'bg-slate-100 text-slate-700' : 'bg-slate-200/70 text-slate-500'
                  }`}
                >
                  {s.rowCount}R
                </span>
              )}
            </button>
          );
        })}

        <button
          onClick={handleAddNewSheet}
          className="h-6 px-2 flex items-center justify-center rounded hover:bg-slate-200/70 text-slate-600 hover:text-slate-900 transition cursor-pointer text-xs ml-1 border border-slate-200"
          title="Create new sheet tab"
        >
          + Add Tab
        </button>
      </div>

      {/* 3. SPLIT WORKSPACE: CANVAS + AI WORKBENCH */}
      <div className="flex-1 w-full h-full flex overflow-hidden relative">
        <main
          className={`flex-1 h-full relative overflow-hidden bg-white ${
            isDraggingSidebar ? 'pointer-events-none' : ''
          }`}
        >
          <div ref={containerRef} className="w-full h-full relative" />
        </main>

        <AIWorkbenchSidebar
          univerAPI={apiInstance || univerAPIRef.current}
          isOpen={isSidebarOpen}
          onClose={() => {
            setIsSidebarOpen(false);
            setTimeout(() => window.dispatchEvent(new Event('resize')), 50);
          }}
          width={sidebarWidth}
          onWidthChange={setSidebarWidth}
          isDragging={isDraggingSidebar}
          setIsDragging={setIsDraggingSidebar}
          currentSelection={telemetry.selectedRange}
        />
      </div>
    </div>
  );
}
