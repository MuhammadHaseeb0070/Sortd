'use client';

import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  Undo2,
  Redo2,
  Settings2,
  ChevronDown,
  ChevronRight,
  X,
  Play,
  Code2,
  MousePointer,
  Sparkles,
  ArrowUp,
  Square,
  ShieldCheck,
  Check,
  Copy,
  RotateCcw,
} from 'lucide-react';
import {
  ProfileId,
  ChatMessage,
  ToolExecutionLedgerItem,
  ModelConfig,
  WorkbookRadar,
  OpenAIMessage,
  StagedMutationSummary,
} from '@/ai/types';
import { getAllProfiles, getProfile, getActiveToolsForProfile } from '@/ai/registry';
import { generateWorkbookRadar } from '@/ai/radar';
import { runAgentLoop } from '@/ai/orchestrator';
import MarkdownMessage from '@/components/MarkdownMessage';
import VisualChartCard from '@/components/VisualChartCard';

interface AIWorkbenchSidebarProps {
  univerAPI: any;
  isOpen: boolean;
  onClose: () => void;
  width: number;
  onWidthChange: (width: number) => void;
  isDragging: boolean;
  setIsDragging: (dragging: boolean) => void;
  currentSelection: string;
  onWorkbookMutated?: () => void;
}

const DEFAULT_STARTER_PROMPTS = [
  'Generate an executive chart of sales and margins by region',
  'Apply a 3-color emerald heatmap across the performance metrics',
  'Audit sheet structure and identify any broken formulas',
  'Populate a complete 5-row SaaS P&L model with Revenue, Cost & Profit formulas',
  'Add a Totals row at the bottom with bold styling and SUM formulas',
  'Apply sleek slate headers with white text and highlight negative numbers',
];

export default function AIWorkbenchSidebar({
  univerAPI,
  isOpen,
  onClose,
  width,
  onWidthChange,
  isDragging,
  setIsDragging,
  currentSelection,
  onWorkbookMutated,
}: AIWorkbenchSidebarProps) {
  // Profiles & Tools
  const profiles = getAllProfiles();
  const [activeProfileId, setActiveProfileId] = useState<ProfileId>('core');
  const [isProfileMenuOpen, setIsProfileMenuOpen] = useState(false);
  const activeProfile = getProfile(activeProfileId);
  const activeTools = getActiveToolsForProfile(activeProfileId);

  // Settings & BYOK / Pro Admin
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [modelConfig, setModelConfig] = useState<ModelConfig>({
    provider: 'openrouter',
    model: 'anthropic/claude-haiku-5.5',
    apiKey: '',
    adminPassword: '',
  });
  const [adminPasswordInput, setAdminPasswordInput] = useState('');

  // Radar Telemetry Strip
  const [radar, setRadar] = useState<WorkbookRadar | null>(null);
  const [isRadarOpen, setIsRadarOpen] = useState(false);

  // Chat & Execution state
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [rawHistory, setRawHistory] = useState<OpenAIMessage[]>([]);
  const [inputPrompt, setInputPrompt] = useState('');
  const [isRunning, setIsRunning] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  // Human-in-the-Loop Confirmation Gate & Instant Stop Button
  const [requireConfirmation, setRequireConfirmation] = useState<boolean>(true);
  const [pendingConfirmation, setPendingConfirmation] = useState<StagedMutationSummary | null>(null);
  const confirmationResolverRef = useRef<((decision: 'confirm' | 'reject') => void) | null>(null);
  const abortControllerRef = useRef<AbortController | null>(null);

  // Turn-level Workbook Snapshot Undo/Redo stacks
  const undoSnapshotsRef = useRef<any[]>([]);
  const redoSnapshotsRef = useRef<any[]>([]);
  const preTurnSnapshotRef = useRef<any>(null);

  // Expandable ledger items
  const [expandedLedgerIds, setExpandedLedgerIds] = useState<Set<string>>(new Set());
  const [expandedLedgerMsgIds, setExpandedLedgerMsgIds] = useState<Set<string>>(new Set());

  const toggleLedgerMsgExpand = (msgId: string) => {
    setExpandedLedgerMsgIds((prev) => {
      const next = new Set(prev);
      if (next.has(msgId)) next.delete(msgId);
      else next.add(msgId);
      return next;
    });
  };

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [copiedMsgId, setCopiedMsgId] = useState<string | null>(null);

  const handleCopyMessage = useCallback(async (msgId: string, text: string) => {
    try {
      if (navigator?.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
      } else {
        const textArea = document.createElement('textarea');
        textArea.value = text;
        textArea.style.position = 'fixed';
        textArea.style.left = '-999999px';
        textArea.style.top = '-999999px';
        document.body.appendChild(textArea);
        textArea.focus();
        textArea.select();
        document.execCommand('copy');
        textArea.remove();
      }
      setCopiedMsgId(msgId);
      setTimeout(() => {
        setCopiedMsgId((prev) => (prev === msgId ? null : prev));
      }, 2000);
    } catch (err) {
      console.error('Failed to copy text:', err);
    }
  }, []);

  // Load Settings from localStorage on mount
  useEffect(() => {
    try {
      const savedConfig = localStorage.getItem('sortd_model_config');
      if (savedConfig) {
        const parsed = JSON.parse(savedConfig);
        // Default to claude-haiku-5.5 if unset or previous gemini default
        if (!parsed.model || parsed.model === 'google/gemini-2.5-flash') {
          parsed.model = 'anthropic/claude-haiku-5.5';
        }
        setModelConfig(parsed);
        if (parsed.adminPassword) {
          setAdminPasswordInput(parsed.adminPassword);
        }
      }
      const savedGate = localStorage.getItem('sortd_require_confirmation');
      if (savedGate !== null) {
        setRequireConfirmation(savedGate === 'true');
      }
    } catch {
      // ignore
    }
  }, []);

  const toggleConfirmationGate = () => {
    setRequireConfirmation((prev) => {
      const next = !prev;
      try {
        localStorage.setItem('sortd_require_confirmation', String(next));
      } catch {
        // ignore
      }
      return next;
    });
  };

  // Save Settings to localStorage
  const handleSaveSettings = (newConfig: ModelConfig) => {
    const updated: ModelConfig = {
      ...newConfig,
      model: newConfig.model?.trim() || 'anthropic/claude-haiku-5.5',
      adminPassword: adminPasswordInput.trim(),
    };
    setModelConfig(updated);
    try {
      localStorage.setItem('sortd_model_config', JSON.stringify(updated));
    } catch {
      // ignore
    }
    setIsSettingsOpen(false);
  };

  // Live Radar sync when selection or API changes
  const refreshRadar = useCallback(() => {
    if (!univerAPI) return;
    const freshRadar = generateWorkbookRadar(univerAPI, currentSelection);
    setRadar(freshRadar);
  }, [univerAPI, currentSelection]);

  useEffect(() => {
    refreshRadar();
  }, [refreshRadar]);

  // Scroll to bottom on new messages or confirmation banner
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, isRunning, pendingConfirmation]);

  // Capture a full JSON snapshot of the active workbook before mutations
  const captureWorkbookSnapshot = useCallback((): any | null => {
    try {
      const wb = univerAPI?.getActiveWorkbook?.();
      if (wb && typeof wb.save === 'function') {
        return JSON.parse(JSON.stringify(wb.save()));
      }
    } catch (err) {
      console.warn('Could not capture workbook snapshot:', err);
    }
    return null;
  }, [univerAPI]);

  // Restore a previously captured workbook snapshot in <20ms
  const restoreWorkbookSnapshot = useCallback(
    (snapshotData: any): boolean => {
      if (!snapshotData || !univerAPI) return false;
      try {
        const currentWb = univerAPI.getActiveWorkbook?.();
        if (currentWb && typeof currentWb.dispose === 'function') {
          try {
            currentWb.dispose();
          } catch {
            // ignore
          }
        }
        univerAPI.createWorkbook?.(snapshotData);
        refreshRadar();
        onWorkbookMutated?.();
        return true;
      } catch (err) {
        console.warn('Failed to restore workbook snapshot:', err);
        return false;
      }
    },
    [univerAPI, refreshRadar, onWorkbookMutated]
  );

  // Highlight staged ranges on the Univer canvas while awaiting user confirmation
  const applyStagedCanvasHighlights = useCallback(
    (summary: StagedMutationSummary, highlight: boolean) => {
      try {
        const wb = univerAPI?.getActiveWorkbook?.();
        if (!wb) return;
        for (const mod of summary.modifiedRanges) {
          const sheet = wb.getSheetByName?.(mod.sheetName) || wb.getActiveSheet?.();
          if (!sheet) continue;
          const cleanRange = mod.rangeA1.includes('!') ? mod.rangeA1.split('!')[1] : mod.rangeA1;
          if (!cleanRange || cleanRange === 'Sheet') continue;
          const rangeObj = sheet.getRange?.(cleanRange);
          if (rangeObj) {
            if (highlight) {
              const isNewSheet = summary.createdSheets.includes(mod.sheetName);
              if (!isNewSheet) {
                rangeObj.setBackgroundColor?.('#dcfce7'); // Soft emerald diff highlight
              }
            } else {
              const isNewSheet = summary.createdSheets.includes(mod.sheetName);
              if (!isNewSheet) {
                rangeObj.setBackgroundColor?.(null);
              }
            }
          }
        }
      } catch {
        // ignore
      }
    },
    [univerAPI]
  );

  // Resolve pending confirmation (Confirm or Reject)
  const handleConfirmationDecision = useCallback(
    (decision: 'confirm' | 'reject') => {
      if (!pendingConfirmation) return;

      if (decision === 'confirm') {
        applyStagedCanvasHighlights(pendingConfirmation, false);
        if (preTurnSnapshotRef.current) {
          undoSnapshotsRef.current.push(preTurnSnapshotRef.current);
          if (undoSnapshotsRef.current.length > 15) undoSnapshotsRef.current.shift();
          redoSnapshotsRef.current = [];
        }
      } else {
        // Reject: revert to pre-turn snapshot immediately
        if (preTurnSnapshotRef.current) {
          restoreWorkbookSnapshot(preTurnSnapshotRef.current);
        }
      }

      setPendingConfirmation(null);
      if (confirmationResolverRef.current) {
        const resolve = confirmationResolverRef.current;
        confirmationResolverRef.current = null;
        resolve(decision);
      }
    },
    [pendingConfirmation, applyStagedCanvasHighlights, restoreWorkbookSnapshot]
  );

  // Stop / Abort ongoing AI request immediately
  const handleStopRequest = useCallback(() => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
      abortControllerRef.current = null;
    }
    if (pendingConfirmation) {
      handleConfirmationDecision('reject');
    }
    setIsRunning(false);
  }, [pendingConfirmation, handleConfirmationDecision]);

  // Global Escape key listener to stop running request or reject pending confirmation
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (pendingConfirmation) {
          e.preventDefault();
          handleConfirmationDecision('reject');
        } else if (isRunning) {
          e.preventDefault();
          handleStopRequest();
        }
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [isRunning, pendingConfirmation, handleConfirmationDecision, handleStopRequest]);

  // Drag-to-resize listener
  const handleMouseDown = (e: React.MouseEvent) => {
    e.preventDefault();
    setIsDragging(true);

    const startX = e.clientX;
    const startWidth = width;

    const onMouseMove = (moveEvent: MouseEvent) => {
      const deltaX = startX - moveEvent.clientX;
      const maxAllowed = Math.round(window.innerWidth * 0.55);
      const newWidth = Math.min(Math.max(startWidth + deltaX, 320), maxAllowed);
      onWidthChange(newWidth);
    };

    const onMouseUp = () => {
      setIsDragging(false);
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
      setTimeout(() => {
        window.dispatchEvent(new Event('resize'));
      }, 50);
    };

    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
  };

  // Toggle ledger JSON drawer
  const toggleLedgerExpand = (id: string) => {
    setExpandedLedgerIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  // Turn-level Snapshot Undo (with fallback to Univer Undo)
  const handleUndo = async () => {
    try {
      if (undoSnapshotsRef.current.length > 0) {
        const currentSnap = captureWorkbookSnapshot();
        if (currentSnap) redoSnapshotsRef.current.push(currentSnap);
        const prevSnap = undoSnapshotsRef.current.pop();
        if (prevSnap && restoreWorkbookSnapshot(prevSnap)) {
          return;
        }
      }
      if (univerAPI?.undo) {
        await univerAPI.undo();
        refreshRadar();
        onWorkbookMutated?.();
      }
    } catch (e) {
      console.warn('Undo action failed:', e);
    }
  };

  // Turn-level Snapshot Redo (with fallback to Univer Redo)
  const handleRedo = async () => {
    try {
      if (redoSnapshotsRef.current.length > 0) {
        const currentSnap = captureWorkbookSnapshot();
        if (currentSnap) undoSnapshotsRef.current.push(currentSnap);
        const nextSnap = redoSnapshotsRef.current.pop();
        if (nextSnap && restoreWorkbookSnapshot(nextSnap)) {
          return;
        }
      }
      if (univerAPI?.redo) {
        await univerAPI.redo();
        refreshRadar();
        onWorkbookMutated?.();
      }
    } catch (e) {
      console.warn('Redo action failed:', e);
    }
  };

  // Send Prompt Handler
  const handleSend = async (customPrompt?: string) => {
    const promptToSend = (customPrompt || inputPrompt).trim();
    if (!promptToSend || isRunning) return;

    setInputPrompt('');
    setErrorMessage(null);
    setIsRunning(true);

    // Save pre-turn workbook snapshot so we can preview diffs and revert cleanly on Reject or Undo
    preTurnSnapshotRef.current = captureWorkbookSnapshot();

    const controller = new AbortController();
    abortControllerRef.current = controller;

    const userMessageId = `msg_user_${Date.now()}`;
    const userMsg: ChatMessage = {
      id: userMessageId,
      role: 'user',
      content: promptToSend,
      timestamp: Date.now(),
    };

    setMessages((prev) => [...prev, userMsg]);

    const activeLedgerItems: ToolExecutionLedgerItem[] = [];

    try {
      const result = await runAgentLoop({
        userPrompt: promptToSend,
        history: rawHistory,
        univerAPI,
        currentProfileId: activeProfileId,
        modelConfig,
        currentSelectionA1: currentSelection,
        signal: controller.signal,
        requireConfirmation,
        onWorkbookMutated: () => {
          onWorkbookMutated?.();
        },
        onRequestConfirmation: async (summary) => {
          applyStagedCanvasHighlights(summary, true);
          setPendingConfirmation(summary);
          return await new Promise<'confirm' | 'reject'>((resolve) => {
            confirmationResolverRef.current = resolve;
          });
        },
        onProfileSwitch: (newProfileId) => {
          setActiveProfileId(newProfileId);
        },
        onLedgerItem: (item) => {
          activeLedgerItems.push(item);
          setMessages((prev) => {
            const last = prev[prev.length - 1];
            if (last && last.role === 'assistant') {
              return [
                ...prev.slice(0, -1),
                { ...last, ledgerItems: [...activeLedgerItems] },
              ];
            } else {
              return [
                ...prev,
                {
                  id: `msg_asst_${Date.now()}`,
                  role: 'assistant',
                  content: '',
                  timestamp: Date.now(),
                  ledgerItems: [item],
                },
              ];
            }
          });
        },
        onRadarUpdated: (freshRadar) => {
          setRadar(freshRadar);
        },
      });

      // If mutations occurred and confirmation was not required (auto-apply), push pre-turn snapshot to undo stack
      if (!requireConfirmation && activeLedgerItems.length > 0 && preTurnSnapshotRef.current) {
        undoSnapshotsRef.current.push(preTurnSnapshotRef.current);
        if (undoSnapshotsRef.current.length > 15) undoSnapshotsRef.current.shift();
        redoSnapshotsRef.current = [];
      }

      if (result.activeProfileId !== activeProfileId) {
        setActiveProfileId(result.activeProfileId);
      }

      setRawHistory(result.updatedHistory);

      setMessages((prev) => {
        const last = prev[prev.length - 1];
        if (last && last.role === 'assistant') {
          return [
            ...prev.slice(0, -1),
            {
              ...last,
              content: result.finalText,
              ledgerItems: result.ledgerItems,
            },
          ];
        } else {
          return [
            ...prev,
            {
              id: `msg_asst_${Date.now()}`,
              role: 'assistant',
              content: result.finalText,
              timestamp: Date.now(),
              ledgerItems: result.ledgerItems,
            },
          ];
        }
      });

      refreshRadar();
      onWorkbookMutated?.();
    } catch (err: any) {
      console.error('Agent loop failed:', err);
      setErrorMessage(err.message || 'Execution failed.');
      setMessages((prev) => [
        ...prev,
        {
          id: `msg_err_${Date.now()}`,
          role: 'assistant',
          content: `⚠️ **Execution Interrupted**: ${err.message || String(err)}`,
          timestamp: Date.now(),
          ledgerItems: activeLedgerItems,
        },
      ]);
    } finally {
      abortControllerRef.current = null;
      setPendingConfirmation(null);
      setIsRunning(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  if (!isOpen) return null;

  return (
    <aside
      style={{ width: `${width}px` }}
      className={`relative h-full flex flex-col bg-[#FAFAFA] text-slate-800 border-l border-slate-200 font-sans z-20 shrink-0 text-xs shadow-xs ${
        isDragging ? 'select-none' : 'select-text'
      }`}
    >
      {/* 1. VERTICAL DRAG RESIZE HANDLE */}
      <div
        onMouseDown={handleMouseDown}
        className="absolute -left-1.5 top-0 bottom-0 w-3 cursor-col-resize z-30 group flex items-center justify-center"
        title="Drag to resize AI Workbench"
      >
        <div
          className={`w-1 h-full transition-colors ${
            isDragging ? 'bg-slate-400' : 'bg-transparent group-hover:bg-slate-300'
          }`}
        />
      </div>

      {/* 2. WORKBENCH HEADER BAR */}
      <header className="h-11 px-3 border-b border-slate-200 bg-white flex items-center justify-between shrink-0">
        <div className="flex items-center space-x-2">
          {/* Profile Dropdown */}
          <div className="relative">
            <button
              onClick={() => setIsProfileMenuOpen(!isProfileMenuOpen)}
              className="flex items-center space-x-1.5 px-2 py-1 rounded-md bg-slate-50 hover:bg-slate-100 text-slate-700 border border-slate-200 font-sans text-xs transition cursor-pointer"
              title="Switch Active Profile"
            >
              <span
                className="w-2 h-2 rounded-full"
                style={{ backgroundColor: activeProfile.badgeColor || '#059669' }}
              />
              <span className="font-semibold text-slate-800">{activeProfile.name}</span>
              <span className="text-[10px] text-slate-400">({activeTools.length} tools)</span>
              <ChevronDown className="h-3 w-3 text-slate-400" />
            </button>

            {isProfileMenuOpen && (
              <div className="absolute left-0 top-8 w-64 bg-white border border-slate-200 rounded-lg shadow-xl py-1 z-50">
                <div className="px-2.5 py-1 text-[10px] font-mono uppercase text-slate-400 tracking-wider border-b border-slate-100">
                  Select Operating Profile
                </div>
                {profiles.map((p) => {
                  const isSelected = p.id === activeProfileId;
                  return (
                    <button
                      key={p.id}
                      onClick={() => {
                        setActiveProfileId(p.id);
                        setIsProfileMenuOpen(false);
                      }}
                      className={`w-full text-left px-2.5 py-2 flex items-start space-x-2 hover:bg-slate-50 transition cursor-pointer ${
                        isSelected ? 'bg-slate-50/80 font-medium' : ''
                      }`}
                    >
                      <span
                        className="w-2 h-2 rounded-full mt-1 shrink-0"
                        style={{ backgroundColor: p.badgeColor || '#64748b' }}
                      />
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center justify-between">
                          <span className="font-medium text-slate-900 text-xs">{p.name}</span>
                          <span className="font-mono text-[9px] px-1 py-0.2 bg-slate-100 rounded text-slate-600 border border-slate-200">
                            {p.shortBadge}
                          </span>
                        </div>
                        <p className="text-[10.5px] text-slate-500 line-clamp-1 mt-0.5">
                          {p.description}
                        </p>
                      </div>
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        </div>

        {/* Quick Actions (Confirmation Gate Toggle, Undo, Redo, Settings, Close) */}
        <div className="flex items-center space-x-1">
          <button
            onClick={toggleConfirmationGate}
            className={`px-1.5 py-1 rounded-md text-[10px] font-medium flex items-center space-x-1 border transition cursor-pointer ${
              requireConfirmation
                ? 'bg-emerald-50 border-emerald-200 text-emerald-700'
                : 'bg-slate-50 border-slate-200 text-slate-500 hover:text-slate-700'
            }`}
            title={
              requireConfirmation
                ? 'Confirmation Gate ON: AI previews sheet & cell edits and waits for your approval'
                : 'Confirmation Gate OFF: AI applies edits automatically'
            }
          >
            <ShieldCheck className="h-3 w-3" />
            <span className="hidden sm:inline">{requireConfirmation ? 'Confirm On' : 'Auto'}</span>
          </button>
          <button
            onClick={handleUndo}
            className="p-1.5 rounded-md hover:bg-slate-100 text-slate-500 hover:text-slate-800 transition cursor-pointer"
            title="Undo Last Turn / Action (Ctrl+Z)"
          >
            <Undo2 className="h-3.5 w-3.5" />
          </button>
          <button
            onClick={handleRedo}
            className="p-1.5 rounded-md hover:bg-slate-100 text-slate-500 hover:text-slate-800 transition cursor-pointer"
            title="Redo Action (Ctrl+Y)"
          >
            <Redo2 className="h-3.5 w-3.5" />
          </button>
          <button
            onClick={() => setIsSettingsOpen(true)}
            className="p-1.5 rounded-md hover:bg-slate-100 text-slate-500 hover:text-slate-800 transition cursor-pointer"
            title="Workbench Model & BYOK Settings"
          >
            <Settings2 className="h-3.5 w-3.5" />
          </button>
          <button
            onClick={onClose}
            className="p-1.5 rounded-md hover:bg-slate-100 text-slate-400 hover:text-slate-700 transition cursor-pointer ml-0.5"
            title="Collapse Workbench (Ctrl+B)"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      </header>

      {/* 3. WORKBOOK RADAR TELEMETRY STRIP */}
      <div className="border-b border-slate-200 bg-slate-50/80 px-3 py-1.5 text-[11px] font-mono text-slate-600 flex items-center justify-between shrink-0">
        <button
          onClick={() => setIsRadarOpen(!isRadarOpen)}
          className="flex items-center space-x-1.5 hover:text-slate-900 transition cursor-pointer"
          title="Toggle Workbook Radar Telemetry"
        >
          {isRadarOpen ? (
            <ChevronDown className="h-3 w-3 text-slate-400" />
          ) : (
            <ChevronRight className="h-3 w-3 text-slate-400" />
          )}
          <span className="text-slate-800 font-medium">Radar:</span>
          <span>{radar?.activeSheetName || 'Sheet1'}</span>
          <span className="text-slate-300">·</span>
          <span>Bounds: {radar?.occupiedBounds || 'A1'}</span>
          <span className="text-slate-300">·</span>
          <span className="text-emerald-700 font-semibold">Sel: {currentSelection}</span>
        </button>

        <span className="text-[10px] text-slate-400 font-sans">Live sync</span>
      </div>

      {/* Expanded Radar Summary Details */}
      {isRadarOpen && radar && (
        <div className="bg-white border-b border-slate-200 px-3 py-2 text-[10.5px] font-mono space-y-1 text-slate-600">
          <div className="flex justify-between">
            <span>Worksheets ({radar.allSheets.length}):</span>
            <span className="text-slate-800 font-medium">
              {radar.allSheets.map((s) => s.name).join(', ')}
            </span>
          </div>
          <div className="flex justify-between">
            <span>Active Range:</span>
            <span className="text-emerald-700 font-medium">{radar.occupiedBounds}</span>
          </div>
          <div className="flex justify-between">
            <span>Detected Columns:</span>
            <span className="text-slate-700">{radar.columnSchemas.length} cols analyzed</span>
          </div>
        </div>
      )}

      {/* 4. MESSAGE STREAM & ACTION LEDGER */}
      <div className="flex-1 overflow-y-auto px-3 py-3 space-y-3.5 bg-[#FAFBFB] select-text">
        {messages.length === 0 && (
          <div className="h-full flex flex-col justify-center items-center text-center px-3 py-8 space-y-3.5">
            <div className="h-10 w-10 rounded-xl border border-slate-200 bg-white flex items-center justify-center text-slate-700 shadow-2xs">
              <Sparkles className="h-5 w-5 text-emerald-600" />
            </div>
            <div>
              <h3 className="font-semibold text-slate-900 text-sm select-text">Sortd AI Assistant</h3>
              <p className="text-[11px] text-slate-500 mt-1 max-w-xs leading-relaxed select-text">
                Active Profile:{' '}
                <span className="text-slate-800 font-medium">{activeProfile.name}</span>. Inspects
                workbook state, normalizes dirty data, and builds executive analytics with zero
                silent errors.
              </p>
            </div>

            {/* Quick Starter Chips */}
            <div className="w-full space-y-1.5 pt-2 text-left">
              <span className="text-[10px] uppercase font-mono tracking-wider text-slate-400 block px-1 select-none">
                Suggested Prompts
              </span>
              {DEFAULT_STARTER_PROMPTS.map((starter, idx) => (
                <button
                  key={idx}
                  onClick={() => handleSend(starter)}
                  className="w-full text-left p-2.5 rounded-lg bg-white hover:bg-slate-50 border border-slate-200 hover:border-slate-300 text-slate-700 text-[11px] transition flex items-center justify-between group cursor-pointer shadow-2xs select-none"
                >
                  <span className="line-clamp-1">{starter}</span>
                  <Play className="h-3 w-3 text-slate-300 group-hover:text-emerald-600 shrink-0 ml-2" />
                </button>
              ))}
            </div>
          </div>
        )}

        {messages.map((msg) => (
          <div key={msg.id} className="space-y-1.5">
            {msg.role === 'user' && (
              <div className="flex flex-col items-end pl-8 space-y-1">
                <div className="flex items-center space-x-1.5 mb-0.5 text-[10px] text-slate-400 font-medium select-none">
                  <span>You</span>
                </div>
                <div className="bg-slate-100 text-slate-900 border border-slate-200/80 rounded-2xl rounded-tr-xs px-3.5 py-2.5 text-[12.5px] leading-relaxed break-words font-sans shadow-2xs max-w-full select-text cursor-text">
                  {msg.content}
                </div>
                {msg.content && (
                  <div className="flex items-center space-x-1 pr-1">
                    <button
                      onClick={() => handleCopyMessage(msg.id, msg.content)}
                      className="inline-flex items-center space-x-1 px-1.5 py-0.5 rounded text-[10.5px] text-slate-400 hover:text-slate-700 hover:bg-slate-200/60 transition-colors cursor-pointer select-none"
                      title="Copy prompt"
                      aria-label="Copy prompt"
                    >
                      {copiedMsgId === msg.id ? (
                        <>
                          <Check className="h-2.5 w-2.5 text-emerald-600" />
                          <span className="text-emerald-700 font-medium text-[10px]">Copied</span>
                        </>
                      ) : (
                        <>
                          <Copy className="h-2.5 w-2.5 text-slate-400" />
                          <span className="text-[10px]">Copy</span>
                        </>
                      )}
                    </button>
                  </div>
                )}
              </div>
            )}

            {msg.role === 'assistant' && (
              <div className="flex flex-col items-start pr-4 space-y-1.5">
                <div className="flex items-center space-x-1.5 text-[10px] text-slate-400 font-medium select-none">
                  <div className="w-4 h-4 rounded bg-emerald-600 flex items-center justify-center text-[9px] font-bold text-white shadow-2xs">
                    S
                  </div>
                  <span className="text-slate-600 font-semibold">Sortd AI</span>
                </div>

                <div className="w-full space-y-2">
                  {msg.ledgerItems &&
                    msg.ledgerItems.length > 0 &&
                    (() => {
                      const isLedgerOpen = expandedLedgerMsgIds.has(msg.id);
                      const totalDuration = msg.ledgerItems.reduce((acc, i) => acc + i.durationMs, 0);
                      const hasWarning = msg.ledgerItems.some(
                        (i) => i.status === 'WARNING_FORMULA_ERRORS'
                      );
                      const hasError = msg.ledgerItems.some((i) => i.status === 'ERROR');
                      const uniqueToolNames = Array.from(
                        new Set(msg.ledgerItems.map((i) => i.toolName))
                      ).join(', ');

                      return (
                        <div className="rounded-lg border border-slate-200 bg-white overflow-hidden shadow-2xs">
                          <div
                            onClick={() => toggleLedgerMsgExpand(msg.id)}
                            className="h-8 px-2.5 flex items-center justify-between text-[11px] font-mono cursor-pointer hover:bg-slate-50 select-none transition-colors"
                          >
                            <div className="flex items-center space-x-2 min-w-0">
                              <span
                                className={`w-1.5 h-1.5 rounded-full shrink-0 ${
                                  hasError
                                    ? 'bg-rose-500'
                                    : hasWarning
                                    ? 'bg-amber-500'
                                    : 'bg-emerald-600'
                                }`}
                              />
                              <span className="text-slate-800 font-medium truncate">
                                Executed {msg.ledgerItems.length} action
                                {msg.ledgerItems.length > 1 ? 's' : ''}
                                <span className="text-slate-400 font-normal ml-1.5 hidden sm:inline">
                                  ({uniqueToolNames})
                                </span>
                              </span>
                              <span className="text-slate-400 text-[10px]">· {totalDuration}ms</span>
                            </div>

                            <div className="flex items-center space-x-1.5 text-slate-400 shrink-0 text-[10px]">
                              <span>{isLedgerOpen ? 'Hide' : 'Details'}</span>
                              {isLedgerOpen ? (
                                <ChevronDown className="h-3 w-3" />
                              ) : (
                                <ChevronRight className="h-3 w-3" />
                              )}
                            </div>
                          </div>

                          {isLedgerOpen && (
                            <div className="p-2 border-t border-slate-100 space-y-1.5 bg-slate-50/60">
                              {msg.ledgerItems.map((item) => {
                                const isExpanded = expandedLedgerIds.has(item.id);
                                const isSuccess = item.status === 'SUCCESS';
                                const isWarning = item.status === 'WARNING_FORMULA_ERRORS';

                                return (
                                  <div
                                    key={item.id}
                                    className="bg-white border border-slate-200 hover:border-slate-300 transition-colors rounded-md font-mono text-[11px] overflow-hidden shadow-2xs"
                                  >
                                    <div className="p-2 flex items-center justify-between space-x-2">
                                      <div className="flex items-center space-x-2 min-w-0">
                                        <span
                                          className={`w-1.5 h-1.5 rounded-full shrink-0 ${
                                            isSuccess
                                              ? 'bg-emerald-600'
                                              : isWarning
                                              ? 'bg-amber-500'
                                              : 'bg-rose-500'
                                          }`}
                                        />
                                        <span className="font-semibold text-slate-800">
                                          {item.toolName}
                                        </span>

                                        {item.targetRange && (
                                          <span className="px-1.5 py-0.2 bg-slate-100 text-slate-700 rounded border border-slate-200 text-[10px] font-medium">
                                            {item.targetRange}
                                          </span>
                                        )}

                                        <span className="text-slate-400 text-[10px]">
                                          {item.durationMs}ms
                                        </span>
                                      </div>

                                      <button
                                        onClick={() => toggleLedgerExpand(item.id)}
                                        className="p-1 rounded hover:bg-slate-100 text-slate-400 hover:text-slate-700 transition cursor-pointer"
                                        title="Inspect Input & Receipt JSON"
                                      >
                                        <Code2 className="h-3 w-3" />
                                      </button>
                                    </div>

                                    <div className="px-2 pb-1.5 text-[10.5px] text-slate-600 truncate font-sans">
                                      {item.summary}
                                    </div>

                                    {isExpanded && (
                                      <div className="border-t border-slate-100 bg-slate-50 p-2 text-[10.5px] space-y-2">
                                        <div>
                                          <span className="text-slate-500 uppercase text-[9px] block mb-1 font-semibold tracking-wider">
                                            Input Arguments:
                                          </span>
                                          <pre className="text-slate-800 overflow-x-auto p-2 bg-white rounded border border-slate-200 max-h-36 font-mono text-[10.5px] leading-relaxed select-text cursor-text">
                                            {JSON.stringify(item.inputArgs, null, 2)}
                                          </pre>
                                        </div>
                                        <div>
                                          <span className="text-emerald-700 uppercase text-[9px] block mb-1 font-semibold tracking-wider">
                                            Receipt &amp; Verification:
                                          </span>
                                          <pre className="text-slate-800 overflow-x-auto p-2 bg-white rounded border border-slate-200 max-h-36 font-mono text-[10.5px] leading-relaxed select-text cursor-text">
                                            {JSON.stringify(item.resultData, null, 2)}
                                          </pre>
                                        </div>
                                      </div>
                                    )}
                                  </div>
                                );
                              })}
                            </div>
                          )}
                        </div>
                      );
                    })()}

                  {/* Interactive Chart Cards */}
                  {msg.ledgerItems?.some((it) => it.resultData?.chartPayload) && (
                    <div className="space-y-2">
                      {msg.ledgerItems
                        .filter((it) => it.resultData?.chartPayload)
                        .map((it) => (
                          <VisualChartCard key={it.id} payload={it.resultData.chartPayload} />
                        ))}
                    </div>
                  )}

                  {msg.content && (
                    <div className="space-y-1.5 w-full">
                      <div className="bg-white border border-slate-200 rounded-2xl rounded-tl-xs p-3.5 text-slate-800 text-[12.5px] leading-relaxed shadow-2xs font-sans select-text cursor-text">
                        <MarkdownMessage content={msg.content} />
                      </div>

                      {/* Copy button after message bubble */}
                      <div className="flex items-center space-x-1 pl-1">
                        <button
                          onClick={() => handleCopyMessage(msg.id, msg.content)}
                          className="inline-flex items-center space-x-1.5 px-2 py-1 rounded-md text-[11px] text-slate-500 hover:text-slate-800 hover:bg-slate-200/60 transition-colors cursor-pointer select-none border border-transparent hover:border-slate-200"
                          title="Copy message response"
                          aria-label="Copy message response"
                        >
                          {copiedMsgId === msg.id ? (
                            <>
                              <Check className="h-3 w-3 text-emerald-600" />
                              <span className="text-emerald-700 font-medium">Copied</span>
                            </>
                          ) : (
                            <>
                              <Copy className="h-3 w-3 text-slate-400 group-hover:text-slate-600" />
                              <span>Copy response</span>
                            </>
                          )}
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>
        ))}

        {/* HIGHLIGHTED IN-SHEET DIFF CONFIRMATION GATE BANNER */}
        {pendingConfirmation && (
          <div className="rounded-xl border-2 border-emerald-400 bg-emerald-50/90 p-3 shadow-md space-y-2.5 animate-in fade-in">
            <div className="flex items-start justify-between gap-2">
              <div className="flex items-center space-x-1.5">
                <ShieldCheck className="h-4 w-4 text-emerald-700 shrink-0" />
                <span className="font-semibold text-emerald-950 text-xs">
                  Review Staged Spreadsheet Changes
                </span>
              </div>
              <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-emerald-200/80 text-emerald-900">
                {pendingConfirmation.totalCellsAffected} cell(s) staged
              </span>
            </div>

            <p className="text-[11px] text-emerald-900/90 leading-snug">
              Changes are highlighted live on your spreadsheet canvas. Confirm to keep them, or
              Reject to revert to the pre-turn state.
            </p>

            {pendingConfirmation.createdSheets.length > 0 && (
              <div className="flex flex-wrap gap-1">
                {pendingConfirmation.createdSheets.map((sName) => (
                  <span
                    key={sName}
                    className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-white border border-emerald-300 text-emerald-800 font-semibold"
                  >
                    + [NEW SHEET] {sName}
                  </span>
                ))}
              </div>
            )}

            <div className="max-h-28 overflow-y-auto space-y-1 bg-white/90 rounded-lg p-2 border border-emerald-200 font-mono text-[10.5px]">
              {pendingConfirmation.modifiedRanges.map((mod, idx) => (
                <div key={idx} className="flex items-center justify-between text-slate-700">
                  <span className="font-semibold text-emerald-800">
                    {mod.sheetName}!{mod.rangeA1}
                  </span>
                  <span className="text-slate-500 truncate max-w-[180px]">{mod.toolName}</span>
                </div>
              ))}
            </div>

            <div className="flex items-center justify-end space-x-2 pt-1">
              <button
                onClick={() => handleConfirmationDecision('reject')}
                className="px-2.5 py-1.5 rounded-lg bg-white hover:bg-rose-50 text-rose-700 border border-rose-200 font-medium text-xs flex items-center space-x-1 transition cursor-pointer shadow-2xs"
              >
                <RotateCcw className="h-3 w-3" />
                <span>Reject &amp; Revert (Esc)</span>
              </button>
              <button
                onClick={() => handleConfirmationDecision('confirm')}
                className="px-3 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-700 text-white font-semibold text-xs flex items-center space-x-1 transition cursor-pointer shadow-2xs"
              >
                <Check className="h-3.5 w-3.5" />
                <span>Confirm Changes</span>
              </button>
            </div>
          </div>
        )}

        {/* Loading Indicator with Stop CTA */}
        {isRunning && !pendingConfirmation && (
          <div className="flex items-center justify-between text-slate-600 text-xs font-mono px-3 py-2 bg-white rounded-lg border border-slate-200 shadow-2xs">
            <div className="flex items-center space-x-2">
              <span className="w-2 h-2 rounded-full bg-emerald-600 animate-ping" />
              <span className="text-slate-700 font-sans">Processing spreadsheet instructions...</span>
            </div>
            <button
              onClick={handleStopRequest}
              className="text-[10.5px] font-sans font-medium text-rose-600 hover:text-rose-800 px-1.5 py-0.5 rounded hover:bg-rose-50 transition cursor-pointer"
            >
              Stop (Esc)
            </button>
          </div>
        )}

        <div ref={messagesEndRef} />
      </div>

      {/* 5. BOTTOM COMPOSER BOX */}
      <footer className="border-t border-slate-200 bg-white p-3 space-y-2 shrink-0">
        <div className="flex items-center justify-between text-[10.5px] font-mono">
          <div className="flex items-center space-x-1.5 text-slate-500">
            <MousePointer className="h-3 w-3 text-emerald-600" />
            <span className="text-slate-400">Target:</span>
            <span className="px-1.5 py-0.2 rounded bg-slate-100 border border-slate-200 text-slate-800 font-semibold tracking-tight">
              {currentSelection}
            </span>
          </div>

          <div className="flex items-center space-x-1.5 text-slate-400 text-[10px]">
            {modelConfig.adminPassword === 'sortd2026' && (
              <span className="px-1.5 py-0.2 rounded bg-emerald-50 border border-emerald-300 text-emerald-800 font-semibold text-[9.5px]">
                PRO
              </span>
            )}
            <span>Model:</span>
            <span className="text-slate-600 font-medium truncate max-w-[130px]">
              {modelConfig.model.split('/').pop()}
            </span>
          </div>
        </div>

        {/* Input Textarea & Submit / Stop Button */}
        <div className="relative bg-slate-50/70 border border-slate-200 focus-within:border-slate-400 focus-within:bg-white focus-within:ring-2 focus-within:ring-slate-100 rounded-xl transition-all shadow-2xs">
          <textarea
            ref={textareaRef}
            value={inputPrompt}
            onChange={(e) => setInputPrompt(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={`Ask ${activeProfile.name} to audit, calculate, clean, or format...`}
            rows={2}
            disabled={isRunning}
            className="w-full bg-transparent px-3 py-2 text-[12.5px] text-slate-900 placeholder-slate-400 focus:outline-none resize-none font-sans leading-relaxed"
          />

          <div className="px-2.5 pb-2 flex items-center justify-between">
            <span className="text-[10px] text-slate-400 font-mono">
              {isRunning ? 'Press Esc to stop request' : 'Enter to send · Shift+Enter for newline'}
            </span>

            {isRunning ? (
              <button
                onClick={handleStopRequest}
                className="px-3 py-1.5 rounded-lg bg-rose-600 hover:bg-rose-700 active:bg-rose-800 text-white font-medium text-xs transition flex items-center space-x-1.5 shadow-2xs cursor-pointer"
                title="Stop ongoing AI request immediately (Esc)"
              >
                <Square className="h-3 w-3 fill-current" />
                <span>Stop</span>
              </button>
            ) : (
              <button
                onClick={() => handleSend()}
                disabled={!inputPrompt.trim()}
                className="px-3 py-1.5 rounded-lg bg-slate-900 hover:bg-slate-800 active:bg-black disabled:bg-slate-100 disabled:text-slate-400 text-white font-medium text-xs transition flex items-center space-x-1.5 shadow-2xs cursor-pointer"
              >
                <ArrowUp className="h-3.5 w-3.5" />
                <span>Send</span>
              </button>
            )}
          </div>
        </div>

        {errorMessage && (
          <div className="p-1.5 bg-rose-50 border border-rose-200 rounded-md text-[11px] text-rose-700 flex items-center justify-between">
            <span className="truncate">{errorMessage}</span>
            <button
              onClick={() => setErrorMessage(null)}
              className="text-xs ml-2 hover:opacity-75"
            >
              ×
            </button>
          </div>
        )}
      </footer>

      {/* 6. SETTINGS MODAL */}
      {isSettingsOpen && (
        <div className="fixed inset-0 bg-slate-900/40 backdrop-blur-xs flex items-center justify-center z-50 p-4">
          <div className="bg-white border border-slate-200 rounded-xl w-full max-w-md p-5 text-xs font-sans space-y-4 shadow-xl">
            <div className="flex items-center justify-between border-b border-slate-100 pb-3">
              <div className="flex items-center space-x-2">
                <Settings2 className="h-4 w-4 text-emerald-600" />
                <h3 className="font-semibold text-slate-900 text-sm">
                  Workbench Settings
                </h3>
              </div>
              <div className="flex items-center space-x-2">
                {adminPasswordInput.trim() === 'sortd2026' ? (
                  <span className="px-2 py-0.5 rounded-full bg-emerald-50 border border-emerald-200 text-emerald-700 font-medium text-[10px] flex items-center gap-1">
                    <ShieldCheck className="h-3 w-3 text-emerald-600" /> Pro Admin
                  </span>
                ) : (
                  <span className="px-2 py-0.5 rounded-full bg-slate-100 text-slate-500 font-medium text-[10px]">
                    Standard Mode
                  </span>
                )}
                <button
                  onClick={() => setIsSettingsOpen(false)}
                  className="p-1 rounded-md text-slate-400 hover:text-slate-700 hover:bg-slate-100 cursor-pointer"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>
            </div>

            <div className="space-y-3.5">
              {/* Pro User / Admin Access Section */}
              <div className="rounded-xl border border-emerald-200/80 bg-emerald-50/40 p-3 space-y-2">
                <div className="flex items-center justify-between">
                  <div className="flex items-center space-x-1.5">
                    <ShieldCheck className="h-4 w-4 text-emerald-600" />
                    <span className="font-semibold text-slate-800 text-xs">Pro User / Admin Access</span>
                  </div>
                  {adminPasswordInput.trim() === 'sortd2026' && (
                    <span className="text-[10px] font-semibold text-emerald-700 flex items-center gap-0.5">
                      <Check className="h-3 w-3" /> Unlocked
                    </span>
                  )}
                </div>

                <p className="text-[11px] text-slate-600 leading-relaxed">
                  Enter the admin password to use the built-in managed AI key (Claude Haiku 5.5). No personal API key required!
                </p>

                <div className="space-y-1">
                  <input
                    type="password"
                    value={adminPasswordInput}
                    onChange={(e) => setAdminPasswordInput(e.target.value)}
                    placeholder="Enter password (e.g. sortd2026)"
                    className="w-full bg-white border border-slate-200 rounded-lg px-2.5 py-1.5 text-slate-800 text-[11px] focus:outline-none focus:border-emerald-500 font-mono"
                  />
                  {adminPasswordInput.trim() === 'sortd2026' ? (
                    <p className="text-[10.5px] text-emerald-700 font-medium flex items-center gap-1 pt-0.5">
                      <Check className="h-3 w-3" /> Admin access confirmed. Managed key active.
                    </p>
                  ) : adminPasswordInput.trim().length > 0 ? (
                    <p className="text-[10.5px] text-amber-600 pt-0.5">
                      Incorrect password. Please enter sortd2026 or use personal API key below.
                    </p>
                  ) : null}
                </div>
              </div>

              {/* Model Identifier */}
              <div>
                <div className="flex items-center justify-between mb-1">
                  <label className="text-slate-700 font-medium">Model Identifier</label>
                  <button
                    type="button"
                    onClick={() => setModelConfig({ ...modelConfig, model: 'anthropic/claude-haiku-5.5' })}
                    className="text-[10px] text-emerald-600 hover:text-emerald-700 hover:underline cursor-pointer"
                  >
                    Reset Default (Haiku 5.5)
                  </button>
                </div>
                <input
                  type="text"
                  value={modelConfig.model}
                  onChange={(e) => setModelConfig({ ...modelConfig, model: e.target.value })}
                  placeholder="e.g. anthropic/claude-haiku-5.5"
                  className="w-full bg-slate-50 border border-slate-200 rounded-lg px-2.5 py-1.5 text-slate-800 font-mono text-[11px] focus:outline-none focus:border-slate-400"
                />
                <div className="flex flex-wrap gap-1 mt-1.5">
                  <button
                    type="button"
                    onClick={() => setModelConfig({ ...modelConfig, model: 'anthropic/claude-haiku-5.5' })}
                    className={`px-1.5 py-0.5 text-[9.5px] rounded border cursor-pointer ${
                      modelConfig.model === 'anthropic/claude-haiku-5.5'
                        ? 'bg-emerald-50 border-emerald-300 text-emerald-800 font-medium'
                        : 'bg-slate-50 border-slate-200 text-slate-600 hover:bg-slate-100'
                    }`}
                  >
                    Claude Haiku 5.5 (Default)
                  </button>
                  <button
                    type="button"
                    onClick={() => setModelConfig({ ...modelConfig, model: 'anthropic/claude-3.5-haiku' })}
                    className={`px-1.5 py-0.5 text-[9.5px] rounded border cursor-pointer ${
                      modelConfig.model === 'anthropic/claude-3.5-haiku'
                        ? 'bg-emerald-50 border-emerald-300 text-emerald-800 font-medium'
                        : 'bg-slate-50 border-slate-200 text-slate-600 hover:bg-slate-100'
                    }`}
                  >
                    Claude 3.5 Haiku
                  </button>
                  <button
                    type="button"
                    onClick={() => setModelConfig({ ...modelConfig, model: 'google/gemini-2.5-flash' })}
                    className={`px-1.5 py-0.5 text-[9.5px] rounded border cursor-pointer ${
                      modelConfig.model === 'google/gemini-2.5-flash'
                        ? 'bg-emerald-50 border-emerald-300 text-emerald-800 font-medium'
                        : 'bg-slate-50 border-slate-200 text-slate-600 hover:bg-slate-100'
                    }`}
                  >
                    Gemini 2.5 Flash
                  </button>
                </div>
              </div>

              {/* Personal API Key (BYOK) */}
              <div>
                <label className="text-slate-700 block mb-1 font-medium flex items-center justify-between">
                  <span>Personal API Key (BYOK)</span>
                  <span className="text-[10px] text-slate-400 font-normal">
                    {adminPasswordInput.trim() === 'sortd2026'
                      ? 'Optional in Pro Admin mode'
                      : 'Stored in local browser storage only'}
                  </span>
                </label>
                <input
                  type="password"
                  value={modelConfig.apiKey || ''}
                  onChange={(e) => setModelConfig({ ...modelConfig, apiKey: e.target.value })}
                  placeholder={
                    adminPasswordInput.trim() === 'sortd2026'
                      ? 'Managed key active (optional custom override)'
                      : 'sk-or-v1-... or sk-...'
                  }
                  className="w-full bg-slate-50 border border-slate-200 rounded-lg px-2.5 py-1.5 text-slate-800 font-mono text-[11px] focus:outline-none focus:border-slate-400"
                />
              </div>

              {/* Provider Endpoint */}
              <div>
                <label className="text-slate-700 block mb-1 font-medium">Provider Endpoint</label>
                <select
                  value={modelConfig.provider}
                  onChange={(e) =>
                    setModelConfig({ ...modelConfig, provider: e.target.value as any })
                  }
                  className="w-full bg-slate-50 border border-slate-200 rounded-lg px-2.5 py-1.5 text-slate-800 focus:outline-none focus:border-slate-400"
                >
                  <option value="openrouter">
                    OpenRouter (Default · Haiku, Claude, Gemini, Llama)
                  </option>
                  <option value="openai">OpenAI Official</option>
                  <option value="custom">Custom Compatible Base URL</option>
                </select>
              </div>

              {modelConfig.provider === 'custom' && (
                <div>
                  <label className="text-slate-700 block mb-1 font-medium">Custom Base URL</label>
                  <input
                    type="text"
                    value={modelConfig.baseUrl || ''}
                    onChange={(e) => setModelConfig({ ...modelConfig, baseUrl: e.target.value })}
                    placeholder="https://api.example.com/v1"
                    className="w-full bg-slate-50 border border-slate-200 rounded-lg px-2.5 py-1.5 text-slate-800 font-mono text-[11px] focus:outline-none focus:border-slate-400"
                  />
                </div>
              )}
            </div>

            <div className="flex justify-end space-x-2 pt-3 border-t border-slate-100">
              <button
                onClick={() => setIsSettingsOpen(false)}
                className="px-3 py-1.5 rounded-lg bg-slate-100 hover:bg-slate-200 text-slate-700 text-xs font-medium cursor-pointer"
              >
                Cancel
              </button>
              <button
                onClick={() => handleSaveSettings(modelConfig)}
                className="px-3.5 py-1.5 rounded-lg bg-slate-900 hover:bg-slate-800 text-white font-medium text-xs shadow-2xs cursor-pointer"
              >
                Save Settings
              </button>
            </div>
          </div>
        </div>
      )}
    </aside>
  );
}
