'use client';

import React, { useState, useRef, useCallback } from 'react';
import dynamic from 'next/dynamic';
import {
  Upload,
  FileSpreadsheet,
  Plus,
  Sparkles,
  ShieldCheck,
  Cpu,
  Layers,
  ArrowRight,
  CheckCircle2,
  Table,
  Zap,
  MousePointer,
  RotateCcw,
} from 'lucide-react';

const SpreadsheetWorkspace = dynamic(
  () => import('@/components/SpreadsheetWorkspace'),
  {
    ssr: false,
    loading: () => (
      <div className="h-screen w-screen flex flex-col items-center justify-center bg-[#FAFAFA] text-slate-800">
        <div className="flex flex-col items-center space-y-4">
          <div className="h-10 w-10 rounded-xl bg-emerald-600 flex items-center justify-center text-white font-bold text-xl shadow-xs animate-pulse">
            S
          </div>
          <div className="flex flex-col items-center space-y-1">
            <h1 className="text-base font-semibold tracking-tight text-slate-900">
              Sortd AI Spreadsheet Studio
            </h1>
            <p className="text-xs text-slate-500">
              Mounting high-performance Univer canvas &amp; data engine...
            </p>
          </div>
          <div className="w-44 h-1 bg-slate-200 rounded-full overflow-hidden">
            <div className="w-1/2 h-full bg-emerald-600 rounded-full animate-pulse" />
          </div>
        </div>
      </div>
    ),
  }
);

export default function Home() {
  const [isStudioOpen, setIsStudioOpen] = useState(false);
  const [initialFile, setInitialFile] = useState<File | null>(null);
  const [isDraggingOver, setIsDraggingOver] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleLaunchWithFile = useCallback((file: File) => {
    setInitialFile(file);
    setIsStudioOpen(true);
  }, []);

  const handleLaunchBlank = useCallback(() => {
    setInitialFile(null);
    setIsStudioOpen(true);
  }, []);

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDraggingOver(true);
  };

  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDraggingOver(false);
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDraggingOver(false);
    const files = e.dataTransfer.files;
    if (files && files.length > 0) {
      handleLaunchWithFile(files[0]);
    }
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (files && files.length > 0) {
      handleLaunchWithFile(files[0]);
    }
  };

  // If Studio is active, render the full workspace
  if (isStudioOpen) {
    return (
      <main className="h-screen w-screen overflow-hidden bg-[#FAFAFA]">
        <SpreadsheetWorkspace
          initialFile={initialFile}
          onBackToHome={() => setIsStudioOpen(false)}
        />
      </main>
    );
  }

  // Otherwise, render the Executive Light Landing Page
  return (
    <div className="min-h-screen w-full bg-[#FAFAFA] text-slate-800 font-sans selection:bg-emerald-100 selection:text-emerald-900">
      {/* Hidden File Input */}
      <input
        ref={fileInputRef}
        type="file"
        accept=".xlsx,.xls,.csv"
        onChange={handleFileChange}
        className="hidden"
      />

      {/* TOP NAVIGATION BAR */}
      <nav className="h-16 border-b border-slate-200/80 bg-white/80 backdrop-blur-md sticky top-0 z-40 px-4 sm:px-8 flex items-center justify-between">
        <div className="flex items-center space-x-3">
          <div className="h-8 w-8 rounded-lg bg-emerald-600 flex items-center justify-center text-white font-bold text-base shadow-xs">
            S
          </div>
          <div className="flex items-baseline space-x-2">
            <span className="font-bold text-slate-900 text-lg tracking-tight">Sortd</span>
            <span className="text-[10px] uppercase font-mono tracking-wider px-2 py-0.5 rounded-full bg-slate-100 text-slate-600 border border-slate-200">
              AI Spreadsheet Studio
            </span>
          </div>
        </div>

        <div className="hidden md:flex items-center space-x-6 text-xs font-medium text-slate-600">
          <a href="#launch-deck" className="hover:text-slate-900 transition">
            Launch
          </a>
          <a href="#capabilities" className="hover:text-slate-900 transition">
            Capabilities
          </a>
          <a href="#architecture" className="hover:text-slate-900 transition">
            Architecture
          </a>
        </div>

        <div className="flex items-center space-x-2.5">
          <button
            onClick={handleLaunchBlank}
            className="hidden sm:flex items-center space-x-1.5 px-3 py-1.5 rounded-lg text-xs font-medium bg-white hover:bg-slate-50 text-slate-700 border border-slate-300 shadow-2xs transition cursor-pointer"
          >
            <Plus className="h-3.5 w-3.5 text-slate-500" />
            <span>Blank Canvas</span>
          </button>
          <button
            onClick={() => fileInputRef.current?.click()}
            className="flex items-center space-x-1.5 px-3.5 py-1.5 rounded-lg text-xs font-semibold bg-slate-900 hover:bg-slate-800 text-white shadow-2xs transition cursor-pointer"
          >
            <Upload className="h-3.5 w-3.5" />
            <span>Upload Sheet</span>
          </button>
        </div>
      </nav>

      {/* HERO SECTION */}
      <header className="max-w-5xl mx-auto pt-14 pb-10 px-4 sm:px-6 text-center">
        {/* Top Feature Pill */}
        <div className="inline-flex items-center space-x-2 px-3 py-1 rounded-full bg-white border border-slate-200 text-slate-700 text-xs shadow-2xs mb-6">
          <span className="flex h-2 w-2 rounded-full bg-emerald-600" />
          <span className="font-medium text-slate-800">
            Self-Healing Formulas &middot; Zero Spreadsheet Lock-In
          </span>
        </div>

        {/* Headline */}
        <h1 className="text-3xl sm:text-5xl lg:text-6xl font-extrabold tracking-tight text-slate-900 leading-[1.15] max-w-4xl mx-auto">
          The intelligent spreadsheet built for precision and speed.
        </h1>

        {/* Subtitle */}
        <p className="mt-5 text-sm sm:text-base text-slate-600 max-w-2xl mx-auto leading-relaxed">
          Clean messy data, audit formulas, and orchestrate complex financial models without switching windows. Upload an existing workbook or start with a clean grid.
        </p>

        {/* LAUNCH DECK: THE TWO CORE ACTIONS */}
        <div id="launch-deck" className="mt-10 grid grid-cols-1 md:grid-cols-2 gap-4 max-w-3xl mx-auto text-left">
          {/* Action 1: Upload Existing File (Prominent Dropzone) */}
          <div
            onDragOver={handleDragOver}
            onDragLeave={handleDragLeave}
            onDrop={handleDrop}
            onClick={() => fileInputRef.current?.click()}
            className={`group p-6 sm:p-7 rounded-2xl border transition-all duration-200 flex flex-col justify-between cursor-pointer ${
              isDraggingOver
                ? 'border-emerald-500 bg-emerald-50/50 shadow-md ring-2 ring-emerald-400/20'
                : 'border-slate-300/80 bg-white hover:border-slate-400 hover:shadow-sm'
            }`}
          >
            <div>
              <div className="h-11 w-11 rounded-xl bg-slate-50 border border-slate-200 flex items-center justify-center text-slate-700 group-hover:bg-emerald-50 group-hover:text-emerald-700 group-hover:border-emerald-200 transition mb-4">
                <Upload className="h-5 w-5" />
              </div>
              <h2 className="text-base font-bold text-slate-900 tracking-tight">
                Upload Spreadsheet
              </h2>
              <p className="text-xs text-slate-500 mt-1.5 leading-relaxed">
                Drop your Excel or CSV file here, or click to browse. Automatically parses sheets and launches your canvas.
              </p>
            </div>

            <div className="mt-6 flex items-center justify-between pt-4 border-t border-slate-100">
              <span className="text-[11px] font-mono text-slate-400">
                .xlsx &middot; .xls &middot; .csv
              </span>
              <span className="text-xs font-semibold text-slate-900 group-hover:text-emerald-700 flex items-center space-x-1">
                <span>Browse Files</span>
                <ArrowRight className="h-3.5 w-3.5 transition-transform group-hover:translate-x-0.5" />
              </span>
            </div>
          </div>

          {/* Action 2: Start with Blank Canvas */}
          <div
            onClick={handleLaunchBlank}
            className="group p-6 sm:p-7 rounded-2xl border border-slate-300/80 bg-white hover:border-slate-400 hover:shadow-sm transition-all duration-200 flex flex-col justify-between cursor-pointer"
          >
            <div>
              <div className="h-11 w-11 rounded-xl bg-slate-50 border border-slate-200 flex items-center justify-center text-slate-700 group-hover:bg-slate-100 group-hover:text-slate-900 transition mb-4">
                <Plus className="h-5 w-5" />
              </div>
              <h2 className="text-base font-bold text-slate-900 tracking-tight">
                Start Blank Canvas
              </h2>
              <p className="text-xs text-slate-500 mt-1.5 leading-relaxed">
                Open a clean, unpopulated grid. Build custom financial models, import data on the fly, or prompt the AI to generate structures.
              </p>
            </div>

            <div className="mt-6 flex items-center justify-between pt-4 border-t border-slate-100">
              <span className="text-[11px] font-mono text-slate-400">
                Fresh Workbook
              </span>
              <span className="text-xs font-semibold text-slate-900 group-hover:text-slate-700 flex items-center space-x-1">
                <span>Open Canvas</span>
                <ArrowRight className="h-3.5 w-3.5 transition-transform group-hover:translate-x-0.5" />
              </span>
            </div>
          </div>
        </div>

        {/* Quick Demo Option */}
        <div className="mt-4 flex items-center justify-center space-x-2 text-xs text-slate-500">
          <span>Want to explore first?</span>
          <button
            onClick={handleLaunchBlank}
            className="font-medium text-slate-800 hover:text-emerald-700 underline underline-offset-4 cursor-pointer"
          >
            Launch with Sample Financial Model &rarr;
          </button>
        </div>
      </header>

      {/* PRODUCT CAPABILITIES */}
      <section id="capabilities" className="max-w-5xl mx-auto py-12 px-4 sm:px-6">
        <div className="text-center max-w-xl mx-auto mb-10">
          <span className="text-[10px] font-mono uppercase tracking-wider text-slate-400 font-semibold block mb-1">
            Engine Capabilities
          </span>
          <h2 className="text-2xl sm:text-3xl font-bold tracking-tight text-slate-900">
            Built for actual work, not demos.
          </h2>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-5">
          {/* Pillar 1 */}
          <div className="p-5 rounded-xl border border-slate-200 bg-white shadow-2xs space-y-3">
            <div className="h-9 w-9 rounded-lg bg-emerald-50 border border-emerald-200 flex items-center justify-center text-emerald-700">
              <ShieldCheck className="h-4 w-4" />
            </div>
            <h3 className="text-sm font-bold text-slate-900 tracking-tight">
              Formula Verifier &amp; Self-Healing
            </h3>
            <p className="text-xs text-slate-600 leading-relaxed">
              Every formula generated by the AI is dry-run through an AST validator. Broken ranges, circular calculations, and syntax defects are caught before mutating your sheet.
            </p>
          </div>

          {/* Pillar 2 */}
          <div className="p-5 rounded-xl border border-slate-200 bg-white shadow-2xs space-y-3">
            <div className="h-9 w-9 rounded-lg bg-slate-100 border border-slate-200 flex items-center justify-center text-slate-700">
              <Cpu className="h-4 w-4" />
            </div>
            <h3 className="text-sm font-bold text-slate-900 tracking-tight">
              Multi-Agent Profiles
            </h3>
            <p className="text-xs text-slate-600 leading-relaxed">
              Seamlessly switch between specialized agents: <strong>Formula Pro</strong> for vector math, <strong>Sanitizer</strong> for deduplication and trimming, and <strong>Auditor</strong> for anomaly detection.
            </p>
          </div>

          {/* Pillar 3 */}
          <div className="p-5 rounded-xl border border-slate-200 bg-white shadow-2xs space-y-3">
            <div className="h-9 w-9 rounded-lg bg-slate-100 border border-slate-200 flex items-center justify-center text-slate-700">
              <Layers className="h-4 w-4" />
            </div>
            <h3 className="text-sm font-bold text-slate-900 tracking-tight">
              Zero Lock-In Architecture
            </h3>
            <p className="text-xs text-slate-600 leading-relaxed">
              Full bidirectional SheetJS integration. Import any standard Excel workbook, modify live in Univer, and export clean <code className="font-mono text-[11px] bg-slate-100 px-1 py-0.5 rounded text-slate-700">.xlsx</code> files instantly.
            </p>
          </div>
        </div>
      </section>

      {/* ARCHITECTURE HIGHLIGHT & TELEMETRY */}
      <section id="architecture" className="max-w-5xl mx-auto py-10 px-4 sm:px-6">
        <div className="rounded-2xl border border-slate-200 bg-white p-6 sm:p-8 shadow-xs">
          <div className="flex flex-col lg:flex-row items-start lg:items-center justify-between gap-6">
            <div className="space-y-2 max-w-lg">
              <span className="text-[10px] font-mono uppercase tracking-wider text-emerald-700 font-semibold px-2 py-0.5 rounded bg-emerald-50 border border-emerald-200">
                Workbook Radar Protocol
              </span>
              <h2 className="text-xl sm:text-2xl font-bold tracking-tight text-slate-900">
                Compact 250-token context telemetry.
              </h2>
              <p className="text-xs text-slate-600 leading-relaxed">
                Rather than flooding language models with massive raw spreadsheet dumps, Sortd extracts dimensional bounds, formula counts, column headers, and active selection into a high-density schema.
              </p>
            </div>

            <div className="w-full lg:w-auto flex flex-col sm:flex-row gap-3">
              <div className="p-3 rounded-lg bg-slate-50 border border-slate-200 text-center min-w-[130px]">
                <div className="text-lg font-bold font-mono text-slate-900">100%</div>
                <div className="text-[10.5px] text-slate-500 font-medium">Local Browser Execution</div>
              </div>
              <div className="p-3 rounded-lg bg-slate-50 border border-slate-200 text-center min-w-[130px]">
                <div className="text-lg font-bold font-mono text-slate-900">&lt; 15ms</div>
                <div className="text-[10.5px] text-slate-500 font-medium">Telemetry Extraction</div>
              </div>
              <div className="p-3 rounded-lg bg-slate-50 border border-slate-200 text-center min-w-[130px]">
                <div className="text-lg font-bold font-mono text-slate-900">BYOK</div>
                <div className="text-[10.5px] text-slate-500 font-medium">OpenRouter &amp; OpenAI</div>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* FOOTER */}
      <footer className="border-t border-slate-200 bg-white py-8 px-4 sm:px-8 mt-12 text-center text-xs text-slate-500">
        <div className="max-w-5xl mx-auto flex flex-col sm:flex-row items-center justify-between gap-4">
          <div className="flex items-center space-x-2">
            <div className="h-5 w-5 rounded bg-emerald-600 flex items-center justify-center text-white font-bold text-xs">
              S
            </div>
            <span className="font-semibold text-slate-800">Sortd AI</span>
            <span>&middot; Private &amp; secure browser spreadsheet studio</span>
          </div>

          <div className="flex items-center space-x-4 text-[11px] text-slate-500">
            <span>Client-side storage</span>
            <span>&middot;</span>
            <button
              onClick={handleLaunchBlank}
              className="text-slate-800 hover:text-emerald-700 font-medium underline underline-offset-4 cursor-pointer"
            >
              Open Studio
            </button>
          </div>
        </div>
      </footer>
    </div>
  );
}
