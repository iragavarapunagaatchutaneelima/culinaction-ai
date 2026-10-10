import { describe, expect, it } from 'vitest';
import { parseCsv, safeCell, saleKey, toCsv, validateSalesCsv } from '../../shared/csv';
import { comparePrepOutcome, forecastError, summariseWaste, wastePer100 } from '../../shared/metrics';
import { nextStatus, TransitionError } from '../../shared/planState';

const menu = [
  { id: 1, name: 'Masala Dosa' },
  { id: 2, name: 'Filter Coffee' },
];

describe('CSV parsing and export safety', () => {
  it('parses quotes, escaped quotes, CRLF and BOM', () => {
    expect(parseCsv('﻿a,b\r\n"x, y","he said ""hi"""\n')).toEqual([
      ['a', 'b'],
      ['x, y', 'he said "hi"'],
    ]);
  });
  it('rejects unterminated quotes', () => {
    expect(() => parseCsv('a,"b')).toThrow(/unterminated/);
  });
  it('neutralises formula injection in exports', () => {
    expect(safeCell('=HYPERLINK("x")')).toBe(`"'=HYPERLINK(""x"")"`);
    expect(safeCell('+91')).toBe("'+91");
    expect(safeCell('-5')).toBe("'-5");
    expect(safeCell('@SUM')).toBe("'@SUM");
    expect(safeCell('Dosa')).toBe('Dosa');
    expect(toCsv(['a'], [['=1']])).toBe("a\r\n'=1\r\n");
  });
});

describe('sales CSV validation', () => {
  it('accepts valid rows and both date formats', () => {
    const v = validateSalesCsv(
      'date,menu_item,quantity\n2026-10-01,Masala Dosa,40\n02/10/2026,filter coffee,85\n',
      menu,
      new Set(),
    );
    expect(v.ok).toBe(true);
    expect(v.summary).toMatchObject({ total: 2, valid: 2 });
    expect(v.rows[1]).toMatchObject({ date: '2026-10-02', menuItemId: 2, qty: 85 });
  });
  it('reports missing required columns', () => {
    const v = validateSalesCsv('date,item,qty\n2026-10-01,Masala Dosa,4\n', menu, new Set());
    expect(v.ok).toBe(false);
    expect(v.headerErrors.join(' ')).toMatch(/menu_item/);
  });
  it('reports invalid dates, quantities, unknown items and prices without dropping rows', () => {
    const v = validateSalesCsv(
      'date,menu_item,quantity,unit_price_inr\n2026-13-01,Masala Dosa,4,\n2026-10-01,Pizza,4,\n2026-10-01,Masala Dosa,-3,\n2026-10-01,Filter Coffee,2,abc\n',
      menu,
      new Set(),
    );
    expect(v.summary).toMatchObject({ total: 4, invalid: 4, valid: 0 });
    expect(v.rows[0].errors[0]).toMatch(/Invalid date/);
    expect(v.rows[1].errors[0]).toMatch(/Unknown menu item "Pizza"/);
    expect(v.rows[2].errors[0]).toMatch(/non-negative/);
    expect(v.rows[3].errors[0]).toMatch(/rupee/);
  });
  it('detects duplicates within the file and against existing records', () => {
    const existing = new Set([saleKey('2026-10-02', 1, '')]);
    const v = validateSalesCsv(
      'date,menu_item,quantity,service_period\n2026-10-01,Masala Dosa,4,Breakfast\n2026-10-01,Masala Dosa,5,breakfast\n2026-10-02,Masala Dosa,9,\n',
      menu,
      existing,
    );
    expect(v.rows.map((r) => r.status)).toEqual(['valid', 'duplicate_in_file', 'duplicate_existing']);
  });
  it('rejects future dates when today is supplied', () => {
    const v = validateSalesCsv('date,menu_item,quantity\n2026-10-11,Masala Dosa,4\n', menu, new Set(), {
      today: '2026-10-10',
    });
    expect(v.rows[0].status).toBe('invalid');
  });
});

describe('plan state machine', () => {
  const owner = { role: 'owner' as const, managersCanApprove: true };
  it('follows the allowed path', () => {
    expect(nextStatus('draft', 'submit', owner)).toBe('awaiting_approval');
    expect(nextStatus('awaiting_approval', 'approve', owner)).toBe('approved');
    expect(nextStatus('approved', 'complete', owner)).toBe('completed');
    expect(nextStatus('awaiting_approval', 'reject', { ...owner, reason: 'Supplier closed' })).toBe(
      'rejected',
    );
    expect(nextStatus('approved', 'cancel', { ...owner, reason: 'Event cancelled' })).toBe('cancelled');
  });
  it('rejects invalid transitions', () => {
    expect(() => nextStatus('draft', 'approve', owner)).toThrow(TransitionError);
    expect(() => nextStatus('completed', 'cancel', { ...owner, reason: 'x' })).toThrow(/completed/);
    expect(() => nextStatus('rejected', 'submit', owner)).toThrow(TransitionError);
  });
  it('requires a reason to reject or cancel', () => {
    expect(() => nextStatus('awaiting_approval', 'reject', owner)).toThrow(/reason/);
    expect(() => nextStatus('awaiting_approval', 'reject', { ...owner, reason: '  ' })).toThrow(/reason/);
  });
  it('enforces roles', () => {
    expect(() => nextStatus('draft', 'submit', { role: 'staff', managersCanApprove: true })).toThrow(/Staff/);
    expect(() =>
      nextStatus('awaiting_approval', 'approve', { role: 'manager', managersCanApprove: false }),
    ).toThrow(/owner/);
    expect(nextStatus('awaiting_approval', 'approve', { role: 'manager', managersCanApprove: true })).toBe(
      'approved',
    );
  });
});

describe('metrics', () => {
  it('computes waste per 100 portions only with a valid denominator', () => {
    expect(wastePer100(6, 200)).toBe(3);
    expect(wastePer100(6, 0)).toBeNull();
  });
  it('separates recorded and estimated waste cost', () => {
    const s = summariseWaste([
      {
        date: '2026-10-01',
        subjectType: 'ingredient',
        ingredientId: 1,
        menuItemId: null,
        name: 'Milk',
        qty: 1000,
        unit: 'ml',
        reason: 'expired',
        costPaise: 6000,
        costBasis: 'batch_cost',
      },
      {
        date: '2026-10-01',
        subjectType: 'menu_item',
        ingredientId: null,
        menuItemId: 2,
        name: 'Idli',
        qty: 12,
        unit: 'portions',
        reason: 'over_preparation',
        costPaise: 1800,
        costBasis: 'recipe_estimate',
      },
      {
        date: '2026-10-02',
        subjectType: 'menu_item',
        ingredientId: null,
        menuItemId: 3,
        name: 'Vada',
        qty: 4,
        unit: 'portions',
        reason: 'spoilage',
        costPaise: null,
        costBasis: null,
      },
    ]);
    expect(s).toMatchObject({
      recordedCostPaise: 6000,
      estimatedCostPaise: 1800,
      entriesWithoutCost: 1,
      discardedPortions: 16,
    });
    expect(s.byDay).toHaveLength(2);
  });
  it('computes forecast error', () => {
    expect(forecastError([])).toMatchObject({ pairs: 0, mae: null });
    const e = forecastError([
      { date: 'd', menuItemId: 1, name: 'a', forecast: 10, actual: 12 },
      { date: 'd', menuItemId: 2, name: 'b', forecast: 20, actual: 16 },
    ]);
    expect(e).toEqual({ pairs: 2, mae: 3, wape: 21.43 });
  });
  it('compares realised outcome with baseline only when enough history exists', () => {
    const task = { taskId: 1, planDate: '2026-10-10', menuItemId: 5, name: 'Upma', plannedQty: 40 };
    const outs = [
      { date: '2026-10-10', menuItemId: 5, prepared: 40, sold: 38, remaining: 0, discarded: 2 },
      { date: '2026-10-09', menuItemId: 5, prepared: 60, sold: 40, remaining: 0, discarded: 20 },
      { date: '2026-10-08', menuItemId: 5, prepared: 60, sold: 42, remaining: 0, discarded: 18 },
    ];
    expect(comparePrepOutcome(task, outs, 400)?.observedDiscardDiff).toBeNull();
    outs.push({ date: '2026-10-07', menuItemId: 5, prepared: 60, sold: 38, remaining: 0, discarded: 22 });
    const c = comparePrepOutcome(task, outs, 400)!;
    expect(c.baselineDiscardedAvg).toBe(20);
    expect(c.observedDiscardDiff).toBe(18);
    expect(c.observedDiffCostPaise).toBe(7200);
    expect(comparePrepOutcome({ ...task, planDate: '2026-10-11' }, outs, 400)).toBeNull();
  });
});
