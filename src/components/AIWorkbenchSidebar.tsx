'use client';

import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  Undo2,
  Redo2,
  Settings2,
  ChevronDown,
  ChevronRight,
  Terminal,
  X,
  Play,
  Code2,
  FileSpreadsheet,
  MousePointer,
  Sparkles,
  ArrowUp,
  CheckCircle2,
  AlertTriangle,
} from 'lucide-react';
import {
  ProfileId,
  ChatMessage,
  ToolExecutionLedgerItem,
  ModelConfig,
  WorkbookRadar,
  OpenAIMessage,
} from '@/ai/types';
import { getAllProfiles, getProfile, getActiveToolsForProfile } from '@/ai/registry';
import { generateWorkbookRadar } from '@/ai/radar';
import { runAgentLoop } from '@/ai/orchestrator';
import MarkdownMessage from '@/components/MarkdownMessage';

interface AIWorkbenchSidebarProps {
  univerAPI: any;
  isOpen: boolean;
  onClose: () => void;
  width: number;
  onWidthChange: (width: number) => void;
  isDragging: boolean;
  setIsDragging: (dragging: boolean) => void;
  currentSelection: string;
}

const DEFAULT_STARTER_PROMPTS = [
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
}: AIWorkbenchSidebarProps) {
  // Profiles & Tools
  const profiles = getAllProfiles();
  const [activeProfileId, setActiveProfileId] = useState<ProfileId>('core');
  const [isProfileMenuOpen, setIsProfileMenuOpen] = useState(false);
  const activeProfile = getProfile(activeProfileId);
  const activeTools = getActiveToolsForProfile(activeProfileId);

  // Settings & BYOK
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [modelConfig, setModelConfig] = useState<ModelConfig>({
    provider: 'openrouter',
    model: 'google/gemini-2.5-flash',
    apiKey: '',
  });

  // Radar Telemetry Strip
  const [radar, setRadar] = useState<WorkbookRadar | null>(null);
  const [isRadarOpen, setIsRadarOpen] = useState(false);

  // Chat & Execution state
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [rawHistory, setRawHistory] = useState<OpenAIMessage[]>([]);
  const [inputPrompt, setInputPrompt] = useState('');
  const [isRunning, setIsRunning] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

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

  // Load Settings from localStorage on mount
  useEffect(() => {
    try {
      const savedConfig = localStorage.getItem('sortd_model_config');
      if (savedConfig) {
        setModelConfig(JSON.parse(savedConfig));
      }
    } catch {
      // ignore
    }
  }, []);

  // Save Settings to localStorage
  const handleSaveSettings = (newConfig: ModelConfig) => {
    setModelConfig(newConfig);
    try {
      localStorage.setItem('sortd_model_config', JSON.stringify(newConfig));
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

  // Scroll to bottom on new messages
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, isRunning]);

  // Drag-to-resize listener
  const handleMouseDown = (e: React.MouseEvent) => {
    e.preventDefault();
    setIsDragging(true);

    const startX = e.clientX;
    const startWidth = width;

    const onMouseMove = (moveEvent: MouseEvent) => {
      const deltaX = startX - moveEvent.clientX; // drag left expands right-side panel
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

  // Single-click Undo on Univer instance
  const handleUndo = async () => {
    try {
      if (univerAPI?.undo) {
        await univerAPI.undo();
        refreshRadar();
      }
    } catch (e) {
      console.warn('Undo action failed:', e);
    }
  };

  // Single-click Redo on Univer instance
  const handleRedo = async () => {
    try {
      if (univerAPI?.redo) {
        await univerAPI.redo();
        refreshRadar();
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
      className="relative h-full flex flex-col bg-[#FAFAFA] text-slate-800 border-l border-slate-200 select-none font-sans z-20 shrink-0 text-xs shadow-xs"
    >
      {/* 1. VERTICAL DRAG RESIZE HANDLE */}
      <div
        onMouseDown={handleMouseDown}
        className="absolute -left-1.5 top-0 bottom-0 w-3 cursor-col-resize z-30 group flex items-center justify-center"
        title="Drag to resize AI Workbench"
      >
        <div
          className={`w-1 h-full transition-colors ${
            isDragging
              ? 'bg-slate-400'
              : 'bg-transparent group-hover:bg-slate-300'
          }`}
        />
      </div>

      {/* 2. WORKBENCH HEADER BAR (Refined Light Aesthetic) */}
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

            {/* Profile Dropdown Menu */}
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
                          <span className="font-medium text-slate-900 text-xs">
                            {p.name}
                          </span>
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

        {/* Quick Actions (Undo, Redo, Settings, Close) - Consolidated in Header */}
        <div className="flex items-center space-x-1">
          <button
            onClick={handleUndo}
            className="p-1.5 rounded-md hover:bg-slate-100 text-slate-500 hover:text-slate-800 transition cursor-pointer"
            title="Univer Undo (Ctrl+Z)"
          >
            <Undo2 className="h-3.5 w-3.5" />
          </button>
          <button
            onClick={handleRedo}
            className="p-1.5 rounded-md hover:bg-slate-100 text-slate-500 hover:text-slate-800 transition cursor-pointer"
            title="Univer Redo (Ctrl+Y)"
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
            className="p-1.5 rounded-md hover:bg-slate-100 text-slate-400 hover:text-slate-700 transition cursor-pointer ml-1"
            title="Collapse Workbench (Ctrl+B)"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      </header>

      {/* 3. WORKBOOK RADAR TELEMETRY STRIP (Clean & Noise-Free) */}
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

        <span className="text-[10px] text-slate-400 font-sans">
          Live sync
        </span>
      </div>

      {/* Expanded Radar Summary Details */}
      {isRadarOpen && radar && (
        <div className="bg-white border-b border-slate-200 px-3 py-2 text-[10.5px] font-mono space-y-1 text-slate-600">
          <div className="flex justify-between">
            <span>Worksheets:</span>
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
      <div className="flex-1 overflow-y-auto px-3 py-3 space-y-3.5 bg-[#FAFBFB]">
        {messages.length === 0 && (
          <div className="h-full flex flex-col justify-center items-center text-center px-3 py-8 space-y-3.5">
            <div className="h-10 w-10 rounded-xl border border-slate-200 bg-white flex items-center justify-center text-slate-700 shadow-2xs">
              <Sparkles className="h-5 w-5 text-emerald-600" />
            </div>
            <div>
              <h3 className="font-semibold text-slate-900 text-sm">
                Sortd AI Assistant
              </h3>
              <p className="text-[11px] text-slate-500 mt-1 max-w-xs leading-relaxed">
                Active Profile: <span className="text-slate-800 font-medium">{activeProfile.name}</span>.
                Inspects workbook state, generates formulas, and transforms sheets with zero formula errors.
              </p>
            </div>

            {/* Quick Starter Chips */}
            <div className="w-full space-y-1.5 pt-2 text-left">
              <span className="text-[10px] uppercase font-mono tracking-wider text-slate-400 block px-1">
                Suggested Prompts
              </span>
              {DEFAULT_STARTER_PROMPTS.map((starter, idx) => (
                <button
                  key={idx}
                  onClick={() => handleSend(starter)}
                  className="w-full text-left p-2.5 rounded-lg bg-white hover:bg-slate-50 border border-slate-200 hover:border-slate-300 text-slate-700 text-[11px] transition flex items-center justify-between group cursor-pointer shadow-2xs"
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
            {/* User Message Bubble (Clearly differentiated, right-aligned style) */}
            {msg.role === 'user' && (
              <div className="flex flex-col items-end pl-8">
                <div className="flex items-center space-x-1.5 mb-1 text-[10px] text-slate-400 font-medium">
                  <span>You</span>
                </div>
                <div className="bg-slate-100 text-slate-900 border border-slate-200/80 rounded-2xl rounded-tr-xs px-3.5 py-2.5 text-[12.5px] leading-relaxed break-words font-sans shadow-2xs max-w-full">
                  {msg.content}
                </div>
              </div>
            )}

            {/* Assistant Message (Clean white card, distinct avatar) */}
            {msg.role === 'assistant' && (
              <div className="flex flex-col items-start pr-4 space-y-1.5">
                <div className="flex items-center space-x-1.5 text-[10px] text-slate-400 font-medium">
                  <div className="w-4 h-4 rounded bg-emerald-600 flex items-center justify-center text-[9px] font-bold text-white shadow-2xs">
                    S
                  </div>
                  <span className="text-slate-600 font-semibold">Sortd AI</span>
                </div>

                <div className="w-full space-y-2">
                  {/* Action Ledger (Tool executions) - Clean, noise-free accordion without duplicate undo */}
                  {msg.ledgerItems && msg.ledgerItems.length > 0 && (() => {
                    const isLedgerOpen = expandedLedgerMsgIds.has(msg.id);
                    const totalDuration = msg.ledgerItems.reduce((acc, i) => acc + i.durationMs, 0);
                    const hasWarning = msg.ledgerItems.some((i) => i.status === 'WARNING_FORMULA_ERRORS');
                    const hasError = msg.ledgerItems.some((i) => i.status === 'ERROR');
                    const uniqueToolNames = Array.from(new Set(msg.ledgerItems.map((i) => i.toolName))).join(', ');

                    return (
                      <div className="rounded-lg border border-slate-200 bg-white overflow-hidden shadow-2xs">
                        {/* Thin Collapsible Header Bar */}
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
                              Executed {msg.ledgerItems.length} action{msg.ledgerItems.length > 1 ? 's' : ''}
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

                        {/* Expanded Details List */}
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

                                  {/* Summary Text */}
                                  <div className="px-2 pb-1.5 text-[10.5px] text-slate-600 truncate font-sans">
                                    {item.summary}
                                  </div>

                                  {/* Expandable JSON Detail Drawer */}
                                  {isExpanded && (
                                    <div className="border-t border-slate-100 bg-slate-50 p-2 text-[10.5px] space-y-2">
                                      <div>
                                        <span className="text-slate-500 uppercase text-[9px] block mb-1 font-semibold tracking-wider">
                                          Input Arguments:
                                        </span>
                                        <pre className="text-slate-800 overflow-x-auto p-2 bg-white rounded border border-slate-200 max-h-36 font-mono text-[10.5px] leading-relaxed">
                                          {JSON.stringify(item.inputArgs, null, 2)}
                                        </pre>
                                      </div>
                                      <div>
                                        <span className="text-emerald-700 uppercase text-[9px] block mb-1 font-semibold tracking-wider">
                                          Receipt &amp; Verification:
                                        </span>
                                        <pre className="text-slate-800 overflow-x-auto p-2 bg-white rounded border border-slate-200 max-h-36 font-mono text-[10.5px] leading-relaxed">
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

                  {/* Natural Language Response with rich markdown rendering */}
                  {msg.content && (
                    <div className="bg-white border border-slate-200 rounded-2xl rounded-tl-xs p-3.5 text-slate-800 text-[12.5px] leading-relaxed shadow-2xs font-sans">
                      <MarkdownMessage content={msg.content} />
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>
        ))}

        {/* Loading Indicator */}
        {isRunning && (
          <div className="flex items-center space-x-2 text-slate-600 text-xs font-mono px-3 py-2 bg-white rounded-lg border border-slate-200 shadow-2xs animate-pulse">
            <span className="w-2 h-2 rounded-full bg-emerald-600 animate-ping" />
            <span className="text-slate-700 font-sans">Processing spreadsheet instructions...</span>
          </div>
        )}

        <div ref={messagesEndRef} />
      </div>

      {/* 5. BOTTOM COMPOSER BOX (Clean Light Design) */}
      <footer className="border-t border-slate-200 bg-white p-3 space-y-2 shrink-0">
        {/* Selection Context Pill & Profile Indicator */}
        <div className="flex items-center justify-between text-[10.5px] font-mono">
          <div className="flex items-center space-x-1.5 text-slate-500">
            <MousePointer className="h-3 w-3 text-emerald-600" />
            <span className="text-slate-400">Target:</span>
            <span className="px-1.5 py-0.2 rounded bg-slate-100 border border-slate-200 text-slate-800 font-semibold tracking-tight">
              {currentSelection}
            </span>
          </div>

          <div className="flex items-center space-x-1.5 text-slate-400 text-[10px]">
            <span>Model:</span>
            <span className="text-slate-600 font-medium truncate max-w-[130px]">
              {modelConfig.model.split('/').pop()}
            </span>
          </div>
        </div>

        {/* Input Textarea & Submit */}
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
              Enter to send · Shift+Enter for newline
            </span>
            <button
              onClick={() => handleSend()}
              disabled={!inputPrompt.trim() || isRunning}
              className="px-3 py-1.5 rounded-lg bg-slate-900 hover:bg-slate-800 active:bg-black disabled:bg-slate-100 disabled:text-slate-400 text-white font-medium text-xs transition flex items-center space-x-1.5 shadow-2xs cursor-pointer"
            >
              <ArrowUp className="h-3.5 w-3.5" />
              <span>Send</span>
            </button>
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

      {/* 6. SETTINGS MODAL (BYOK & Model Picker - Clean Light Style) */}
      {isSettingsOpen && (
        <div className="fixed inset-0 bg-slate-900/40 backdrop-blur-xs flex items-center justify-center z-50 p-4">
          <div className="bg-white border border-slate-200 rounded-xl w-full max-w-md p-5 text-xs font-sans space-y-4 shadow-xl">
            <div className="flex items-center justify-between border-b border-slate-100 pb-3">
              <div className="flex items-center space-x-2">
                <Settings2 className="h-4 w-4 text-emerald-600" />
                <h3 className="font-semibold text-slate-900 text-sm">
                  Workbench Settings &amp; BYOK
                </h3>
              </div>
              <button
                onClick={() => setIsSettingsOpen(false)}
                className="p-1 rounded-md text-slate-400 hover:text-slate-700 hover:bg-slate-100"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <div className="space-y-3.5">
              <div>
                <label className="text-slate-700 block mb-1 font-medium">
                  Provider Endpoint
                </label>
                <select
                  value={modelConfig.provider}
                  onChange={(e) =>
                    setModelConfig({ ...modelConfig, provider: e.target.value as any })
                  }
                  className="w-full bg-slate-50 border border-slate-200 rounded-lg px-2.5 py-1.5 text-slate-800 focus:outline-none focus:border-slate-400"
                >
                  <option value="openrouter">OpenRouter (Default · Gemini, Claude, Llama, DeepSeek)</option>
                  <option value="openai">OpenAI Official</option>
                  <option value="custom">Custom Compatible Base URL</option>
                </select>
              </div>

              <div>
                <label className="text-slate-700 block mb-1 font-medium">
                  Model Identifier
                </label>
                <input
                  type="text"
                  value={modelConfig.model}
                  onChange={(e) =>
                    setModelConfig({ ...modelConfig, model: e.target.value })
                  }
                  placeholder="e.g. google/gemini-2.5-flash, anthropic/claude-3.7-sonnet"
                  className="w-full bg-slate-50 border border-slate-200 rounded-lg px-2.5 py-1.5 text-slate-800 font-mono text-[11px] focus:outline-none focus:border-slate-400"
                />
              </div>

              <div>
                <label className="text-slate-700 block mb-1 font-medium flex items-center justify-between">
                  <span>API Key (BYOK)</span>
                  <span className="text-[10px] text-slate-400 font-normal">
                    Stored in local browser storage only
                  </span>
                </label>
                <input
                  type="password"
                  value={modelConfig.apiKey || ''}
                  onChange={(e) =>
                    setModelConfig({ ...modelConfig, apiKey: e.target.value })
                  }
                  placeholder="sk-or-v1-... or sk-..."
                  className="w-full bg-slate-50 border border-slate-200 rounded-lg px-2.5 py-1.5 text-slate-800 font-mono text-[11px] focus:outline-none focus:border-slate-400"
                />
              </div>

              {modelConfig.provider === 'custom' && (
                <div>
                  <label className="text-slate-700 block mb-1 font-medium">
                    Custom Base URL
                  </label>
                  <input
                    type="text"
                    value={modelConfig.baseUrl || ''}
                    onChange={(e) =>
                      setModelConfig({ ...modelConfig, baseUrl: e.target.value })
                    }
                    placeholder="https://api.example.com/v1"
                    className="w-full bg-slate-50 border border-slate-200 rounded-lg px-2.5 py-1.5 text-slate-800 font-mono text-[11px] focus:outline-none focus:border-slate-400"
                  />
                </div>
              )}
            </div>

            <div className="flex justify-end space-x-2 pt-3 border-t border-slate-100">
              <button
                onClick={() => setIsSettingsOpen(false)}
                className="px-3 py-1.5 rounded-lg bg-slate-100 hover:bg-slate-200 text-slate-700 text-xs font-medium"
              >
                Cancel
              </button>
              <button
                onClick={() => handleSaveSettings(modelConfig)}
                className="px-3.5 py-1.5 rounded-lg bg-slate-900 hover:bg-slate-800 text-white font-medium text-xs shadow-2xs"
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
