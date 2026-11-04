import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  executeComposeAggregation,
  executeGenerateFinancialModel,
} from '../formula_pro/executors';
import { executeFormatNumbers } from '../architect/executors';
import {
  executeReconcileAccountingCrossfoot,
  executeTraceDependencies,
} from '../auditor/executors';
import type { ToolExecutionContext } from '../../types';

function createMockContext(sheetsData: Record<string, { rows2D: any[][]; formulas2D?: (string | null)[][] }>): {
  ctx: ToolExecutionContext;
  sheetMap: Record<string, any>;
} {
  const sheetNames = Object.keys(sheetsData);
  let activeSheetName = sheetNames[0];

  const makeSheet = (name: string) => {
    const data = sheetsData[name];
    const rows = data.rows2D;
    const formulas = data.formulas2D || [];
    const alignments: Record<string, string> = {};
    const numberFormats: Record<string, string> = {};

    return {
      getName: () => name,
      getSheetName: () => name,
      getLastRow: () => Math.max(0, rows.length - 1),
      getLastColumn: () => Math.max(0, (rows[0]?.length || 1) - 1),
      getRowCount: () => Math.max(rows.length, 50),
      getColumnCount: () => Math.max(rows[0]?.length || 10, 26),
      getMaxRows: () => Math.max(rows.length, 50),
      getMaxColumns: () => Math.max(rows[0]?.length || 10, 26),
      insertRowsAfter: () => {},
      insertColumnsAfter: () => {},
      getRange: (rOrA1: any, c?: number, numR?: number, numC?: number) => {
        let startR = 0;
        let startC = 0;
        let h = 1;
        let w = 1;
        if (typeof rOrA1 === 'string') {
          const m = rOrA1.match(/^([A-Z]+)(\d+)(?::([A-Z]+)(\d+))?$/i);
          if (m) {
            const colToIdx = (col: string) => {
              let idx = 0;
              for (let i = 0; i < col.length; i++) {
                idx = idx * 26 + (col.toUpperCase().charCodeAt(i) - 64);
              }
              return idx - 1;
            };
            startC = colToIdx(m[1]);
            startR = parseInt(m[2], 10) - 1;
            if (m[3] && m[4]) {
              w = colToIdx(m[3]) - startC + 1;
              h = parseInt(m[4], 10) - startR + 1;
            }
          }
        } else {
          startR = rOrA1;
          startC = c ?? 0;
          h = numR ?? 1;
          w = numC ?? 1;
        }

        const slice2D = (matrix: any[][]) => {
          const out: any[][] = [];
          for (let r = startR; r < startR + h; r++) {
            const row: any[] = [];
            for (let col = startC; col < startC + w; col++) {
              row.push(matrix[r]?.[col] ?? null);
            }
            out.push(row);
          }
          return out;
        };

        return {
          getRow: () => startR,
          getColumn: () => startC,
          getValue: () => rows[startR]?.[startC] ?? null,
          getValues: () => slice2D(rows),
          getFormula: () => formulas[startR]?.[startC] ?? null,
          getFormulas: () => slice2D(formulas),
          setValue: (v: any) => {
            if (!rows[startR]) rows[startR] = [];
            if (typeof v === 'string' && v.startsWith('=')) {
              if (!formulas[startR]) formulas[startR] = [];
              formulas[startR][startC] = v;
              rows[startR][startC] = 100; // simulated evaluated value
            } else {
              rows[startR][startC] = v;
            }
          },
          setValues: (vals: any[][]) => {
            for (let r = 0; r < vals.length; r++) {
              if (!rows[startR + r]) rows[startR + r] = [];
              for (let col = 0; col < vals[r].length; col++) {
                const v = vals[r][col];
                if (typeof v === 'string' && v.startsWith('=')) {
                  if (!formulas[startR + r]) formulas[startR + r] = [];
                  formulas[startR + r][startC + col] = v;
                  rows[startR + r][startC + col] = 100;
                } else {
                  rows[startR + r][startC + col] = v;
                }
              }
            }
          },
          setNumberFormat: (fmt: string) => {
            numberFormats[`${startR},${startC}`] = fmt;
          },
          setHorizontalAlignment: (align: string) => {
            if (align === 'right') {
              throw new Error('Invalid horizontal alignment: right');
            }
            alignments[`${startR},${startC}`] = align;
          },
          setFontWeight: () => {},
          setFontColor: () => {},
          setBackgroundColor: () => {},
        };
      },
      _rows: rows,
      _formulas: formulas,
      _alignments: alignments,
      _numberFormats: numberFormats,
    };
  };

  const sheetMap: Record<string, ReturnType<typeof makeSheet>> = {};
  for (const name of sheetNames) {
    sheetMap[name] = makeSheet(name);
  }

  const univerAPI = {
    getActiveWorkbook: () => ({
      getActiveSheet: () => sheetMap[activeSheetName],
      getSheetByName: (name: string) => sheetMap[name] || null,
      getSheets: () => sheetNames.map((n) => sheetMap[n]),
      setActiveSheet: (sheet: any) => {
        activeSheetName = sheet.getName();
      },
    }),
  };

  return {
    ctx: { univerAPI } as ToolExecutionContext,
    sheetMap,
  };
}

describe('Task 5: Formula Pro, Architect & Auditor Overhaul', () => {
  it('1. executeComposeAggregation supports contains wildcard ("*val*") and single-word header columns', async () => {
    const { ctx } = createMockContext({
      Sales: {
        rows2D: [
          ['Region', 'Revenue'],
          ['North East', 100],
          ['South West', 200],
        ],
      },
    });

    const res = await executeComposeAggregation(
      {
        targetCell: 'D2',
        functionType: 'SUMIFS',
        measureColumn: 'Revenue',
        criteria: [{ column: 'Region', operator: 'contains', value: 'North' }],
        startRow: 2,
        endRow: 3,
      },
      ctx
    );

    assert.equal(res.status, 'SUCCESS');
    assert.ok(res.formula.includes('SUMIFS'), `Expected SUMIFS in formula, got: ${res.formula}`);
    assert.ok(res.formula.includes('"*North*"'), `Expected wildcard "*North*" in formula, got: ${res.formula}`);
    assert.ok(res.formula.includes('$B$2:$B$3'), `Expected Revenue resolved to $B$2:$B$3, got: ${res.formula}`);
  });

  it('2. executeGenerateFinancialModel handles 0% interest rate without division-by-zero and respects startCell', async () => {
    const { ctx, sheetMap } = createMockContext({
      Model: {
        rows2D: [['Existing Header']],
      },
    });

    const res = await executeGenerateFinancialModel(
      {
        modelType: 'loan_amortization',
        principal: 12000,
        annualInterestRate: 0,
        loanTermYears: 1,
        paymentsPerYear: 12,
        startCell: 'C3',
      },
      ctx
    );

    assert.equal(res.status, 'SUCCESS');
    assert.equal(res.monthlyPayment, 1000);
    assert.equal(res.totalInterestPaid, 0);
    // Verify startCell C3 (row index 2, col index 2) received header "Payment #" without overwriting A1 ("Existing Header")
    assert.equal(sheetMap['Model']._rows[0]?.[0], 'Existing Header');
    assert.equal(sheetMap['Model']._rows[2]?.[2], 'Payment #');
    // Row 4 (index 3) is Payment #1; Column E (index 4) is Payment (PMT)
    const pmtVal = sheetMap['Model']._rows[3]?.[4];
    assert.equal(pmtVal, 1000, `Expected 0% interest monthly payment on $12,000 over 12 months to equal 1000, got: ${pmtVal}`);
  });

  it('3. executeFormatNumbers uses UniverJS-safe alignment ("normal" instead of "right") and does not throw', async () => {
    const { ctx, sheetMap } = createMockContext({
      Finance: {
        rows2D: [
          ['Amount'],
          [1250.5],
          [3400.75],
        ],
      },
    });

    const res = await executeFormatNumbers(
      {
        rangeA1: 'A2:A3',
        formatType: 'currency',
      },
      ctx
    );

    assert.equal(res.status, 'SUCCESS');
    assert.equal(sheetMap['Finance']._alignments['1,0'], 'normal');
  });

  it('4. executeReconcileAccountingCrossfoot verifies balance_sheet_identity (Assets == Liabilities + Equity)', async () => {
    const { ctx } = createMockContext({
      BalanceSheet: {
        rows2D: [
          ['Line Item', 'Amount'],
          ['Total Assets', 6200],
          ['Total Liabilities', 3500],
          ['Total Equity', 2500], // 6200 != 3500 + 2500 (discrepancy = 200)
        ],
      },
    });

    const res = await executeReconcileAccountingCrossfoot(
      {
        mode: 'balance_sheet_identity',
      },
      ctx
    );

    assert.equal(res.isBalanced, false);
    assert.equal(res.discrepancy, 200);
    assert.ok(res.message.includes('DISCREPANCY'), `Expected DISCREPANCY in message, got: ${res.message}`);
  });

  it('5. executeTraceDependencies detects downstream formulas that reference targetCell inside a range (B2:B5)', async () => {
    const { ctx } = createMockContext({
      Sheet1: {
        rows2D: [
          ['Item', 'Cost'],
          ['A', 10],
          ['B', 20],
          ['C', 30],
          ['D', 40],
          ['Total', 100],
        ],
        formulas2D: [
          [null, null],
          [null, null],
          [null, null],
          [null, null],
          [null, null],
          [null, '=SUM(B2:B5)'],
        ],
      },
    });

    const res = await executeTraceDependencies(
      {
        cellCoordinate: 'B4',
        direction: 'dependents',
      },
      ctx
    );

    assert.equal(res.status, 'SUCCESS');
    assert.equal(res.dependentsCount, 1);
    assert.equal(res.dependents[0].coordinate, 'B6');
  });
});
