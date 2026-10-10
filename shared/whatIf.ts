// What-if simulator: pure arithmetic over recorded sales history, verified recipes and usable stock.
// Every number comes from inputs; uncertainty is shown by replaying the candidate quantity against
// each comparable historical day rather than by inventing a probability.

import { roundPaise } from './money';
import { roundQty, type BaseUnit } from './units';
import type { Forecast } from './forecast';

export interface PrepIngredientInput {
  ingredientId: number;
  name: string;
  baseUnit: BaseUnit;
  perPortion: number; // gross base units per portion (loss applied)
  usableQty: number; // usable stock now (safety-filtered)
  otherDemand: number; // forecast use by other verified dishes on the same date
  unitCostPaise: number | null;
}

export interface PrepScenarioResult {
  portions: number;
  ingredients: {
    ingredientId: number;
    name: string;
    baseUnit: BaseUnit;
    needed: number;
    usable: number;
    otherDemand: number;
    remainingAfter: number; // usable − needed − otherDemand (can be negative = shortfall)
    shortfall: number;
    costPaise: number | null;
  }[];
  stockFeasible: boolean;
  maxPortionsFromStock: number;
  ingredientCostPaise: number | null;
  history: null | {
    days: number;
    daysShort: number; // comparable days on which demand exceeded this quantity
    daysSurplus: number; // comparable days on which this quantity would have been left over
    avgSurplusPortions: number;
    avgShortPortions: number;
    estSurplusCostPaise: number | null; // avg surplus × ingredient cost per portion
    estLostSalesPaise: number | null; // avg short × selling price
  };
}

const r1 = (n: number) => Math.round(n * 10) / 10;

export function simulatePrep(
  portions: number,
  ingredients: PrepIngredientInput[],
  forecast: Forecast | null,
  pricePaise: number | null,
): PrepScenarioResult {
  if (!(portions >= 0) || !Number.isFinite(portions)) throw new Error('Portions must be zero or more');
  const rows = ingredients.map((i) => {
    const needed = roundQty(i.perPortion * portions);
    const remainingAfter = roundQty(i.usableQty - needed - i.otherDemand);
    return {
      ingredientId: i.ingredientId,
      name: i.name,
      baseUnit: i.baseUnit,
      needed,
      usable: i.usableQty,
      otherDemand: roundQty(i.otherDemand),
      remainingAfter,
      shortfall: remainingAfter < 0 ? roundQty(-remainingAfter) : 0,
      costPaise: i.unitCostPaise === null ? null : roundPaise(needed * i.unitCostPaise),
    };
  });
  const costKnown = ingredients.every((i) => i.unitCostPaise !== null);
  const cpp = costKnown ? ingredients.reduce((a, i) => a + i.perPortion * i.unitCostPaise!, 0) : null;
  const maxPortions = ingredients.length
    ? Math.max(
        0,
        Math.floor(
          Math.min(
            ...ingredients.map((i) =>
              i.perPortion > 0 ? Math.max(0, i.usableQty - i.otherDemand) / i.perPortion : Infinity,
            ),
          ) + 1e-9,
        ),
      )
    : 0;

  let history: PrepScenarioResult['history'] = null;
  if (forecast && forecast.method !== 'insufficient' && forecast.values.length) {
    const vals = forecast.values.map((v) => v.qty);
    const surplus = vals.map((v) => Math.max(0, portions - v));
    const short = vals.map((v) => Math.max(0, v - portions));
    const avgS = surplus.reduce((a, b) => a + b, 0) / vals.length;
    const avgSh = short.reduce((a, b) => a + b, 0) / vals.length;
    history = {
      days: vals.length,
      daysShort: short.filter((x) => x > 0).length,
      daysSurplus: surplus.filter((x) => x > 0).length,
      avgSurplusPortions: r1(avgS),
      avgShortPortions: r1(avgSh),
      estSurplusCostPaise: cpp === null ? null : roundPaise(avgS * cpp),
      estLostSalesPaise: pricePaise === null ? null : roundPaise(avgSh * pricePaise),
    };
  }

  return {
    portions,
    ingredients: rows,
    stockFeasible: rows.every((r) => r.shortfall === 0),
    maxPortionsFromStock: maxPortions,
    ingredientCostPaise: cpp === null ? null : roundPaise(cpp * portions),
    history,
  };
}

export interface PurchaseScenarioInput {
  usableQty: number;
  dailyUse: number | null; // forecast-based daily use (null when unknown)
  purchaseQty: number;
  useByDays: number | null; // days until the purchased batch's use-by/expiry, when known
  unitCostPaise: number | null;
  targetCoverDays: number;
}

export interface PurchaseScenarioResult {
  coverDaysNow: number | null;
  coverDaysAfter: number | null;
  exceedsTargetCover: boolean | null;
  atRiskQty: number | null; // purchased quantity not expected to be used before its date (FIFO)
  atRiskCostPaise: number | null;
  purchaseCostPaise: number | null;
  notes: string[];
}

export function simulatePurchase(p: PurchaseScenarioInput): PurchaseScenarioResult {
  const notes: string[] = [];
  const cost = p.unitCostPaise === null ? null : roundPaise(p.purchaseQty * p.unitCostPaise);
  if (p.dailyUse === null || p.dailyUse <= 0) {
    notes.push(
      'Daily use cannot be calculated (no verified recipe with sales history uses this ingredient).',
    );
    return {
      coverDaysNow: null,
      coverDaysAfter: null,
      exceedsTargetCover: null,
      atRiskQty: null,
      atRiskCostPaise: null,
      purchaseCostPaise: cost,
      notes,
    };
  }
  const after = p.usableQty + p.purchaseQty;
  let atRisk: number | null = null;
  if (p.useByDays !== null) {
    // Existing stock is used first; the new batch only gets what demand remains within its window.
    const usableFromNew = Math.max(0, p.dailyUse * (p.useByDays + 1) - p.usableQty);
    atRisk = roundQty(Math.max(0, p.purchaseQty - usableFromNew));
    notes.push('Assumes existing stock is used first and demand matches the forecast.');
  } else notes.push('No use-by/expiry entered for the purchase, so expiry risk is not calculated.');
  return {
    coverDaysNow: r1(p.usableQty / p.dailyUse),
    coverDaysAfter: r1(after / p.dailyUse),
    exceedsTargetCover: after / p.dailyUse > p.targetCoverDays,
    atRiskQty: atRisk,
    atRiskCostPaise:
      atRisk === null || p.unitCostPaise === null ? null : roundPaise(atRisk * p.unitCostPaise),
    purchaseCostPaise: cost,
    notes,
  };
}
