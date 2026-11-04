import { AIToolDefinition } from '../../types';
import {
  executeAuditFormulaIntegrity,
  executeTraceDependencies,
  executeReconcileAccountingCrossfoot,
  executeScanFormulaContinuity,
  executeDetectForensicAnomalies,
  executeInspectHiddenAndExternal,
} from './executors';

export const AUDITOR_TOOLS: AIToolDefinition[] = [
  {
    name: 'audit_formula_integrity',
    description:
      'Performs an exhaustive audit of formula health across a range or entire active worksheet. Isolates all calculation errors (#REF!, #DIV/0!, #VALUE!, #NAME?, #N/A), flags circular reference hazards, and pinpoints bad-practice hardcoded constants inside formulas.',
    parameters: {
      type: 'object',
      properties: {
        range: {
          type: 'string',
          description: 'Optional range to audit (e.g. "A1:Z100"). If omitted, scans all populated cells.',
        },
        flagHardcodedConstants: {
          type: 'boolean',
          description:
            'Whether to flag hardcoded numbers embedded in formulas (e.g. =A1*1.15 or =B2*0.2). Default true.',
        },
        sheetName: {
          type: 'string',
          description: 'Optional sheet name to audit. Defaults to active worksheet.',
        },
      },
    },
    execute: executeAuditFormulaIntegrity,
  },
  {
    name: 'trace_dependencies',
    description:
      'Traces upstream precedent cells or downstream dependent cells for a specific coordinate. Maps the calculation tree, flags broken upstream links, and detects unreferenced orphan cells.',
    parameters: {
      type: 'object',
      properties: {
        cellCoordinate: {
          type: 'string',
          description: 'Target cell coordinate to trace (e.g. "D15" or "NetTotal_Calc").',
        },
        direction: {
          type: 'string',
          enum: ['precedents', 'dependents', 'both'],
          description:
            'Direction to trace: "precedents" (upstream inputs), "dependents" (downstream blast radius), or "both". Default "both".',
        },
        sheetName: {
          type: 'string',
          description: 'Optional sheet name.',
        },
      },
      required: ['cellCoordinate'],
    },
    execute: executeTraceDependencies,
  },
  {
    name: 'reconcile_accounting_crossfoot',
    description:
      'Executes forensic accounting reconciliation and cross-footing verification. Checks whether horizontal row sums equal vertical column sums, verifies double-entry Debits == Credits, or tests the Balance Sheet identity (Assets == Liabilities + Equity) down to 0.01 tolerance.',
    parameters: {
      type: 'object',
      properties: {
        mode: {
          type: 'string',
          enum: ['cross_foot', 'debit_credit', 'balance_sheet_identity'],
          description:
            'Reconciliation mode: "cross_foot" (row total vs col total), "debit_credit" (sum debits == sum credits), or "balance_sheet_identity" (assets == liabilities + equity).',
        },
        range: {
          type: 'string',
          description: 'Table range containing row and column totals (e.g. "B2:G20").',
        },
        debitColumn: {
          type: 'string',
          description: 'Column letter or header for Debits (if mode is "debit_credit").',
        },
        creditColumn: {
          type: 'string',
          description: 'Column letter or header for Credits (if mode is "debit_credit").',
        },
        tolerance: {
          type: 'number',
          description: 'Allowed rounding discrepancy tolerance. Default 0.01.',
        },
        sheetName: {
          type: 'string',
          description: 'Optional worksheet name.',
        },
      },
      required: ['mode'],
    },
    execute: executeReconcileAccountingCrossfoot,
  },
  {
    name: 'scan_formula_continuity',
    description:
      'Audits formula ranges for structural continuity gaps. Identifies omitted rows at the boundaries of SUM/AVERAGE/COUNT ranges (e.g. SUM stops at row 18 while data extends to row 25) and flags inconsistent formulas where a row breaks columnar pattern.',
    parameters: {
      type: 'object',
      properties: {
        range: {
          type: 'string',
          description: 'Data table range to audit (e.g. "A1:Q50").',
        },
        sheetName: {
          type: 'string',
          description: 'Optional worksheet name.',
        },
      },
      required: ['range'],
    },
    execute: executeScanFormulaContinuity,
  },
  {
    name: 'detect_forensic_anomalies',
    description:
      'Executes forensic and statistical anomaly detection on a numeric column. Evaluates Benford’s Law first-digit distribution for fabricated numbers, isolates 3.5-sigma and IQR statistical spikes, and identifies forbidden negative numbers.',
    parameters: {
      type: 'object',
      properties: {
        column: {
          type: 'string',
          description: 'Column letter or header name to analyze (e.g. "NetTotal" or "G").',
        },
        checkBenfordLaw: {
          type: 'boolean',
          description:
            'Whether to compute Benford’s Law first-digit conformance test for fraud/manipulation detection. Default true.',
        },
        strictlyNonNegative: {
          type: 'boolean',
          description: 'Whether negative values should be flagged as domain rule violations. Default false.',
        },
        sheetName: {
          type: 'string',
          description: 'Optional sheet name.',
        },
      },
      required: ['column'],
    },
    execute: executeDetectForensicAnomalies,
  },
  {
    name: 'inspect_hidden_and_external',
    description:
      'Audits the structural security and governance of the workbook. Discovers hidden worksheets, hidden rows, hidden columns, and external remote workbook references.',
    parameters: {
      type: 'object',
      properties: {
        sheetName: {
          type: 'string',
          description: 'Optional sheet name. Defaults to auditing all sheets.',
        },
      },
    },
    execute: executeInspectHiddenAndExternal,
  },
];
