# Sheet Auditor Profile Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the complete 7th persona profile (`auditor`) with 6 specialized forensic and accounting audit tools, bringing the Sortd platform to 100% completion across all 7 AI profiles.

**Architecture:**
1. Build `src/ai/profiles/auditor/executors.ts` implementing forensic formula parsing, cross-footing arithmetic, Benford's Law distribution analysis, dependency tree tracing, continuity scanning, and hidden element inspection.
2. Build `src/ai/profiles/auditor/tools.ts` with strict JSON schemas.
3. Build `src/ai/profiles/auditor/prompt.ts` with institutional accounting guidelines (Big 4 / FAST standard).
4. Update `src/ai/profiles/auditor/index.ts` and verify with TypeScript and Next.js production builds.

**Tech Stack:** TypeScript, React 19, Next.js 16, Univer API.

**Spec:** `docs/superpowers/specs/2026-10-31-auditor-profile-design.md`

## Global Constraints
- Preserve workbook data integrity; audit tools are non-destructive diagnostic tools.
- Adhere strictly to 0.01 currency tolerance in accounting reconciliations.
- Produce rich, actionable audit reports highlighting exact cell coordinates and discrepancy deltas.

---

### Task 1: Auditor Tools & Prompt Scaffolding
**Files:**
- Create: `src/ai/profiles/auditor/tools.ts`
- Create: `src/ai/profiles/auditor/prompt.ts`
- Modify: `src/ai/profiles/auditor/index.ts`

- [ ] **Step 1: Define tool definitions in `tools.ts`**
- [ ] **Step 2: Define system prompt in `prompt.ts`**
- [ ] **Step 3: Update `index.ts` to export full module**

---

### Task 2: Auditor Executors Engine
**Files:**
- Create: `src/ai/profiles/auditor/executors.ts`

- [ ] **Step 1: Implement `executeAuditFormulaIntegrity`**
- [ ] **Step 2: Implement `executeTraceDependencies`**
- [ ] **Step 3: Implement `executeReconcileAccountingCrossfoot`**
- [ ] **Step 4: Implement `executeScanFormulaContinuity`**
- [ ] **Step 5: Implement `executeDetectForensicAnomalies`**
- [ ] **Step 6: Implement `executeInspectHiddenAndExternal`**

---

### Task 3: Verification & Build
**Files:**
- All modified files

- [ ] **Step 1: Run `npx tsc --noEmit`**
- [ ] **Step 2: Run `npm run build`**
- [ ] **Step 3: Confirm all 7 profiles are active in `PROFILE_REGISTRY`**
