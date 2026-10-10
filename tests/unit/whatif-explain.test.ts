import { describe, expect, it } from 'vitest';
import { defaultOption, ruleBasedExplanation } from '../../shared/explain';
import { buildSalesIndex, forecastItem } from '../../shared/forecast';
import { runEngine } from '../../shared/engine';
import { simulatePrep, simulatePurchase } from '../../shared/whatIf';
import { batch, dailySales, ingredient, menuItem, snapshot } from './fixtures';

const rice = {
  ingredientId: 1,
  name: 'Rice',
  baseUnit: 'g' as const,
  perPortion: 200,
  usableQty: 10000,
  otherDemand: 2000,
  unitCostPaise: 9,
};

describe('what-if: preparation', () => {
  const fc = forecastItem(
    buildSalesIndex([
      { date: '2026-10-03', menuItemId: 1, qty: 30 },
      { date: '2026-09-26', menuItemId: 1, qty: 40 },
      { date: '2026-09-19', menuItemId: 1, qty: 35 },
    ]),
    1,
    '2026-10-10',
  );

  it('computes ingredient use, remaining stock and shortfall from the recipe', () => {
    const r = simulatePrep(45, [rice], fc, 18000);
    expect(r.ingredients[0]).toMatchObject({ needed: 9000, remainingAfter: -1000, shortfall: 1000 });
    expect(r.stockFeasible).toBe(false);
    expect(r.maxPortionsFromStock).toBe(40); // (10000 − 2000) / 200
    expect(r.ingredientCostPaise).toBe(45 * 200 * 9);
  });

  it('replays the quantity against each comparable day', () => {
    const r = simulatePrep(35, [rice], fc, 18000);
    // history 30, 40, 35 → surplus 5,0,0 → avg 1.7; short 0,5,0 → avg 1.7
    expect(r.history).toMatchObject({
      days: 3,
      daysShort: 1,
      daysSurplus: 1,
      avgSurplusPortions: 1.7,
      avgShortPortions: 1.7,
    });
    expect(r.history!.estSurplusCostPaise).toBe(Math.round((5 / 3) * 1800));
    expect(r.history!.estLostSalesPaise).toBe(Math.round((5 / 3) * 18000));
  });

  it('shows no history comparison when sales history is insufficient', () => {
    const thin = forecastItem(buildSalesIndex([]), 1, '2026-10-10');
    expect(simulatePrep(20, [rice], thin, null).history).toBeNull();
    expect(() => simulatePrep(-1, [rice], thin, null)).toThrow();
  });
});

describe('what-if: purchasing', () => {
  it('calculates cover and expiry risk with existing stock used first', () => {
    const r = simulatePurchase({
      usableQty: 2000,
      dailyUse: 1000,
      purchaseQty: 5000,
      useByDays: 3,
      unitCostPaise: 10,
      targetCoverDays: 5,
    });
    // demand within 4 days (today + 3) = 4000; existing 2000 used first → new batch can use 2000 → 3000 at risk
    expect(r).toMatchObject({
      coverDaysNow: 2,
      coverDaysAfter: 7,
      exceedsTargetCover: true,
      atRiskQty: 3000,
      atRiskCostPaise: 30000,
      purchaseCostPaise: 50000,
    });
  });
  it('refuses to guess cover when daily use is unknown', () => {
    const r = simulatePurchase({
      usableQty: 2000,
      dailyUse: null,
      purchaseQty: 5000,
      useByDays: 3,
      unitCostPaise: 10,
      targetCoverDays: 5,
    });
    expect(r.coverDaysAfter).toBeNull();
    expect(r.notes[0]).toMatch(/cannot be calculated/);
  });
});

describe('rule-based explanation', () => {
  it('only rearranges engine text and picks the first feasible actionable option', () => {
    const s = snapshot({
      ingredients: [
        ingredient({
          id: 1,
          name: 'Cream',
          baseUnit: 'ml',
          batches: [batch({ qtyRemaining: 500, dateType: 'expiry', dateValue: '2026-10-11' })],
        }),
      ],
    });
    const rec = runEngine(s).recommendations.find((r) => r.kind === 'expiry_waste_risk')!;
    const e = ruleBasedExplanation(rec);
    expect(e.summary).toBe(rec.problem);
    expect(e.why).toEqual(rec.calculation.slice(0, 6));
    expect(rec.options[0].feasible).toBe(false); // no verified recipe uses cream
    expect(e.recommended_option).toBe(defaultOption(rec));
    expect(e.recommended_option).not.toBe('A');
    expect(e.tradeoffs.find((t) => t.option === 'A')!.cons[0]).toMatch(/Not feasible/);
  });
  it('works for a recommendation with sales history', () => {
    const s = snapshot({
      ingredients: [ingredient({ id: 1, name: 'Rice', batches: [batch({ qtyRemaining: 100 })] })],
      menuItems: [
        menuItem({
          id: 10,
          name: 'Lemon rice',
          lines: [{ ingredientId: 1, qty: 200, unit: 'g', lossPct: 0 }],
        }),
      ],
      sales: dailySales(10, '2026-10-10', 28, 10),
    });
    const rec = runEngine(s).recommendations.find((r) => r.kind === 'stockout_risk')!;
    expect(ruleBasedExplanation(rec).uncertainty[0]).toMatch(/Confidence is high/);
  });
});
