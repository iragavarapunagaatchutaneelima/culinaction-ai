import { describe, expect, it } from 'vitest';
import { compareRecommendations, ingredientState, runEngine } from '../../shared/engine';
import type { Recommendation } from '../../shared/types';
import { batch, dailySales, ingredient, menuItem, snapshot } from './fixtures';

const PLAN = '2026-10-10';

describe('stock state', () => {
  it('excludes unsafe stock from usable quantity and weights cost over usable batches', () => {
    const ing = ingredient({
      id: 1,
      name: 'Paneer',
      batches: [
        batch({ qtyRemaining: 1000, unitCostPaise: 30, dateType: 'use_by', dateValue: '2026-10-09' }), // expired
        batch({ qtyRemaining: 2000, unitCostPaise: 32, dateType: 'use_by', dateValue: '2026-10-14' }),
        batch({ qtyRemaining: 1000, unitCostPaise: 35 }),
      ],
    });
    const s = ingredientState(ing, PLAN, 2);
    expect(s.usableQty).toBe(3000);
    expect(s.excludedQty).toBe(1000);
    expect(s.unitCostPaise).toBeCloseTo((2000 * 32 + 1000 * 35) / 3000, 6);
    expect(s.costComplete).toBe(true);
  });
});

describe('decision engine', () => {
  it('flags unsafe stock as tier 1 and never offers to use it', () => {
    const snap = snapshot({
      ingredients: [
        ingredient({
          id: 1,
          name: 'Milk',
          baseUnit: 'ml',
          batches: [
            batch({ qtyRemaining: 5000, unitCostPaise: 6, dateType: 'use_by', dateValue: '2026-10-08' }),
          ],
        }),
      ],
    });
    const res = runEngine(snap);
    const r = res.recommendations.find((x) => x.kind === 'unsafe_stock')!;
    expect(r.severityTier).toBe(1);
    expect(res.recommendations[0].kind).toBe('unsafe_stock');
    expect(r.options).toHaveLength(1);
    expect(r.options[0].lines.every((l) => l.type === 'discard')).toBe(true);
    expect(r.estimatedImpactPaise).toBe(30000);
    expect(res.stock[0].usableQty).toBe(0);
  });

  it('detects a stockout using recipe quantities, loss factor and forecast', () => {
    // Biryani: 200 g rice per portion with 0% loss; forecast 30/day → 6 kg needed; only 4 kg usable.
    const snap = snapshot({
      ingredients: [
        ingredient({
          id: 1,
          name: 'Basmati rice',
          batches: [batch({ qtyRemaining: 4000, unitCostPaise: 9 })],
        }),
      ],
      menuItems: [
        menuItem({
          id: 10,
          name: 'Veg biryani',
          pricePaise: 18000,
          lines: [{ ingredientId: 1, qty: 200, unit: 'g', lossPct: 0 }],
        }),
      ],
      sales: dailySales(10, PLAN, 28, 30),
    });
    const r = runEngine(snap).recommendations.find((x) => x.kind === 'stockout_risk')!;
    expect(r).toBeDefined();
    expect(r.problem).toContain('6 kg');
    expect(r.problem).toContain('Shortfall ≈ 2 kg');
    const [buy, cap] = r.options;
    expect(buy.lines[0]).toMatchObject({ type: 'purchase', qty: 2200 }); // 2 kg + 10% buffer
    expect(buy.estimatedCostPaise).toBe(19800);
    expect(cap.lines[0]).toMatchObject({ type: 'prep', qty: 20 }); // 4000 / 200
    expect(r.estimatedImpactPaise).toBe(10 * 18000); // 10 unmet portions × ₹180
    expect(r.confidence).toBe('high');
  });

  it('applies the preparation loss factor', () => {
    // 90 g net with 10% loss → 100 g gross per portion. 10 portions forecast → 1000 g; 900 g usable.
    const snap = snapshot({
      ingredients: [ingredient({ id: 1, name: 'Onion', batches: [batch({ qtyRemaining: 900 })] })],
      menuItems: [
        menuItem({
          id: 10,
          name: 'Onion uttapam',
          lines: [{ ingredientId: 1, qty: 90, unit: 'g', lossPct: 10 }],
        }),
      ],
      sales: dailySales(10, PLAN, 28, 10),
    });
    const r = runEngine(snap).recommendations.find((x) => x.kind === 'stockout_risk')!;
    expect(r.problem).toContain('Shortfall ≈ 100 g');
  });

  it('aggregates demand across dishes that share an ingredient', () => {
    const snap = snapshot({
      ingredients: [ingredient({ id: 1, name: 'Idli batter', batches: [batch({ qtyRemaining: 5000 })] })],
      menuItems: [
        menuItem({ id: 10, name: 'Idli', lines: [{ ingredientId: 1, qty: 100, unit: 'g', lossPct: 0 }] }),
        menuItem({
          id: 11,
          name: 'Mini idli',
          lines: [{ ingredientId: 1, qty: 0.08, unit: 'kg', lossPct: 0 }],
        }),
      ],
      sales: [...dailySales(10, PLAN, 28, 30), ...dailySales(11, PLAN, 28, 30)],
    });
    // 30×100 + 30×80 = 5400 g > 5000 g
    const r = runEngine(snap).recommendations.find((x) => x.kind === 'stockout_risk')!;
    expect(r.problem).toContain('5.4 kg');
    expect(r.evidence.recipes).toHaveLength(2);
  });

  it('excludes unverified recipes and reports them as a data gap', () => {
    const snap = snapshot({
      ingredients: [ingredient({ id: 1, name: 'Rice', batches: [batch({ qtyRemaining: 100 })] })],
      menuItems: [
        menuItem({
          id: 10,
          name: 'Curd rice',
          recipeVerified: false,
          lines: [{ ingredientId: 1, qty: 200, unit: 'g', lossPct: 0 }],
        }),
      ],
      sales: dailySales(10, PLAN, 28, 50),
    });
    const res = runEngine(snap);
    expect(res.recommendations.some((r) => r.kind === 'stockout_risk')).toBe(false);
    expect(res.recommendations.find((r) => r.key === 'data_gap:unverified_recipe')?.missingInfo).toEqual([
      'Curd rice',
    ]);
  });

  it('reports incompatible recipe units instead of guessing a conversion', () => {
    const snap = snapshot({
      ingredients: [
        ingredient({ id: 1, name: 'Eggs', baseUnit: 'pc', batches: [batch({ qtyRemaining: 30 })] }),
      ],
      menuItems: [
        menuItem({ id: 10, name: 'Egg puff', lines: [{ ingredientId: 1, qty: 50, unit: 'g', lossPct: 0 }] }),
      ],
      sales: dailySales(10, PLAN, 28, 50),
    });
    const res = runEngine(snap);
    expect(res.recommendations.some((r) => r.kind === 'stockout_risk')).toBe(false);
    const gap = res.recommendations.find((r) => r.key === 'data_gap:invalid_recipe_lines')!;
    expect(gap.missingInfo[0]).toMatch(/cannot be converted/);
  });

  it('computes expiry waste risk with FIFO and offers three alternatives', () => {
    // Paneer: lot expiring 11/10 (2 kg) + an undated lot. Forecast use 10 × 100 g/day over 2 days = 2 kg... make it 5/day → 1 kg.
    const snap = snapshot({
      ingredients: [
        ingredient({
          id: 1,
          name: 'Paneer',
          batches: [
            batch({
              qtyRemaining: 2000,
              unitCostPaise: 40,
              lotCode: 'P1',
              dateType: 'use_by',
              dateValue: '2026-10-11',
            }),
            batch({ qtyRemaining: 1000, unitCostPaise: 40 }),
          ],
        }),
      ],
      menuItems: [
        menuItem({
          id: 10,
          name: 'Paneer tikka',
          lines: [{ ingredientId: 1, qty: 100, unit: 'g', lossPct: 0 }],
        }),
      ],
      sales: dailySales(10, PLAN, 28, (i) => (i % 2 === 0 ? 4 : 6)),
    });
    const r = runEngine(snap).recommendations.find((x) => x.kind === 'expiry_waste_risk')!;
    expect(r).toBeDefined();
    expect(r.options.map((o) => o.key)).toEqual(['A', 'B', 'C']);
    // Expected use over 2 days ≈ 2 × 5 × 100 g = 1 kg → 1 kg at risk → ₹400
    expect(r.title).toMatch(/^1 kg of Paneer/);
    expect(r.estimatedImpactPaise).toBe(40000);
    expect(r.options[1].lines[0]).toMatchObject({ type: 'reduce_purchase', qty: 1000 });
  });

  it('marks "prioritise dishes" infeasible when no verified recipe uses the ingredient', () => {
    const snap = snapshot({
      ingredients: [
        ingredient({
          id: 1,
          name: 'Cream',
          baseUnit: 'ml',
          batches: [batch({ qtyRemaining: 500, dateType: 'expiry', dateValue: '2026-10-11' })],
        }),
      ],
    });
    const r = runEngine(snap).recommendations.find((x) => x.kind === 'expiry_waste_risk')!;
    expect(r.options[0].feasible).toBe(false);
    expect(r.options[0].infeasibleReason).toMatch(/No verified menu item/);
    expect(r.confidence).toBe('low');
  });

  it('recommends preparation adjustments from recorded outcomes', () => {
    const outcomes = [1, 2, 3, 4].map((i) => ({
      id: i,
      date: `2026-10-0${i + 4}`,
      menuItemId: 10,
      prepared: 60,
      sold: 40,
      remaining: 0,
      discarded: 20,
    }));
    const snap = snapshot({
      ingredients: [
        ingredient({ id: 1, name: 'Rava', batches: [batch({ qtyRemaining: 50000, unitCostPaise: 5 })] }),
      ],
      menuItems: [
        menuItem({ id: 10, name: 'Upma', lines: [{ ingredientId: 1, qty: 80, unit: 'g', lossPct: 0 }] }),
      ],
      sales: dailySales(10, PLAN, 28, 40),
      outcomes,
    });
    const r = runEngine(snap).recommendations.find((x) => x.kind === 'prep_adjustment')!;
    expect(r.severityTier).toBe(3);
    expect(r.options.map((o) => o.lines[0].qty)).toEqual([40, 40, 60]);
    // 20 portions × 80 g × 5 paise = ₹80
    expect(r.estimatedImpactPaise).toBe(8000);
  });

  it('does not produce demand-based recommendations without sales history', () => {
    const snap = snapshot({
      ingredients: [ingredient({ id: 1, name: 'Rice', batches: [batch({ qtyRemaining: 10 })] })],
      menuItems: [
        menuItem({
          id: 10,
          name: 'Lemon rice',
          lines: [{ ingredientId: 1, qty: 200, unit: 'g', lossPct: 0 }],
        }),
      ],
    });
    const res = runEngine(snap);
    expect(res.recommendations.map((r) => r.kind)).not.toContain('stockout_risk');
    expect(res.recommendations.some((r) => r.key === 'data_gap:no_sales')).toBe(true);
    expect(res.forecasts[0].method).toBe('insufficient');
  });

  it('is deterministic for identical input', () => {
    const snap = snapshot({
      ingredients: [
        ingredient({
          id: 1,
          name: 'A',
          batches: [batch({ id: 1, qtyRemaining: 100, dateType: 'use_by', dateValue: '2026-10-01' })],
        }),
        ingredient({
          id: 2,
          name: 'B',
          batches: [batch({ id: 2, qtyRemaining: 100, dateType: 'use_by', dateValue: '2026-10-01' })],
        }),
      ],
    });
    expect(JSON.stringify(runEngine(snap))).toBe(JSON.stringify(runEngine(snap)));
  });
});

describe('ranking', () => {
  const rec = (p: Partial<Recommendation>): Recommendation =>
    ({
      severityTier: 2,
      estimatedImpactPaise: null,
      confidence: 'medium',
      sortKey: 'x',
      ...p,
    }) as Recommendation;

  it('orders by tier, then impact, then confidence, then sort key', () => {
    const list = [
      rec({ sortKey: 'd', severityTier: 3, estimatedImpactPaise: 999999 }),
      rec({ sortKey: 'c', estimatedImpactPaise: null }),
      rec({ sortKey: 'b', estimatedImpactPaise: 500 }),
      rec({ sortKey: 'a', estimatedImpactPaise: 100 }),
      rec({ sortKey: 'e', severityTier: 1, estimatedImpactPaise: 1 }),
    ].sort(compareRecommendations);
    expect(list.map((r) => r.sortKey)).toEqual(['e', 'b', 'a', 'c', 'd']);
  });

  it('breaks ties deterministically by confidence then sort key', () => {
    const list = [
      rec({ sortKey: 'z', estimatedImpactPaise: 100, confidence: 'low' }),
      rec({ sortKey: 'y', estimatedImpactPaise: 100, confidence: 'high' }),
      rec({ sortKey: 'b', estimatedImpactPaise: 100, confidence: 'medium' }),
      rec({ sortKey: 'a', estimatedImpactPaise: 100, confidence: 'medium' }),
    ].sort(compareRecommendations);
    expect(list.map((r) => r.sortKey)).toEqual(['y', 'a', 'b', 'z']);
  });
});
