// Outcome metrics. Every number here is computed from recorded rows; anything that
// cannot be computed is returned as null with a reason, never defaulted to zero.

export interface WasteRow {
  date: string;
  subjectType: 'ingredient' | 'menu_item';
  menuItemId: number | null;
  ingredientId: number | null;
  name: string;
  qty: number;
  unit: string;
  reason: string;
  costPaise: number | null;
  costBasis: 'batch_cost' | 'recipe_estimate' | null;
}

export interface ForecastPair {
  date: string;
  menuItemId: number;
  name: string;
  forecast: number;
  actual: number;
}

export interface PrepTaskRow {
  taskId: number;
  planDate: string;
  menuItemId: number;
  name: string;
  plannedQty: number;
}

export interface OutcomeRow {
  date: string;
  menuItemId: number;
  prepared: number;
  sold: number;
  remaining: number;
  discarded: number;
}

export interface PrepOutcomeComparison {
  taskId: number;
  name: string;
  date: string;
  planned: number;
  prepared: number;
  sold: number;
  discarded: number;
  baselineDays: number;
  baselineDiscardedAvg: number | null;
  observedDiscardDiff: number | null; // baseline avg − actual (positive = fewer discarded)
  observedDiffCostPaise: number | null; // estimate, using recipe cost per portion
  note: string;
}

const r2 = (x: number) => Math.round(x * 100) / 100;

export function wastePer100(discardedPortions: number, portionsSold: number): number | null {
  if (!(portionsSold > 0)) return null;
  return r2((discardedPortions / portionsSold) * 100);
}

export function forecastError(pairs: ForecastPair[]) {
  if (!pairs.length) return { pairs: 0, mae: null as number | null, wape: null as number | null };
  const absErr = pairs.reduce((a, p) => a + Math.abs(p.actual - p.forecast), 0);
  const actualSum = pairs.reduce((a, p) => a + p.actual, 0);
  return {
    pairs: pairs.length,
    mae: r2(absErr / pairs.length),
    // weighted absolute percentage error — defined only when actual demand > 0
    wape: actualSum > 0 ? r2((absErr / actualSum) * 100) : null,
  };
}

export function summariseWaste(rows: WasteRow[]) {
  let recordedCostPaise = 0;
  let estimatedCostPaise = 0;
  let withoutCost = 0;
  const byDay = new Map<string, { recorded: number; estimated: number }>();
  const byReason = new Map<string, number>();
  const reasonCost = new Map<string, { recorded: number; estimated: number; unknown: number }>();
  let discardedPortions = 0;
  for (const w of rows) {
    const d = byDay.get(w.date) ?? { recorded: 0, estimated: 0 };
    if (w.costPaise === null) withoutCost++;
    else if (w.costBasis === 'batch_cost') {
      recordedCostPaise += w.costPaise;
      d.recorded += w.costPaise;
    } else {
      estimatedCostPaise += w.costPaise;
      d.estimated += w.costPaise;
    }
    byDay.set(w.date, d);
    byReason.set(w.reason, (byReason.get(w.reason) ?? 0) + 1);
    const rc = reasonCost.get(w.reason) ?? { recorded: 0, estimated: 0, unknown: 0 };
    if (w.costPaise === null) rc.unknown++;
    else if (w.costBasis === 'batch_cost') rc.recorded += w.costPaise;
    else rc.estimated += w.costPaise;
    reasonCost.set(w.reason, rc);
    if (w.subjectType === 'menu_item') discardedPortions += w.qty;
  }
  return {
    entries: rows.length,
    recordedCostPaise,
    estimatedCostPaise,
    entriesWithoutCost: withoutCost,
    discardedPortions: r2(discardedPortions),
    byDay: [...byDay.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([date, v]) => ({ date, ...v })),
    byReason: [...byReason.entries()]
      .map(([reason, count]) => ({ reason, count, ...reasonCost.get(reason)! }))
      .sort((a, b) => b.recorded + b.estimated - (a.recorded + a.estimated)),
  };
}

/**
 * Compare a completed prep task's actual outcome with the item's own earlier outcomes.
 * This is an observed difference on a small sample, NOT proof of savings.
 */
export function comparePrepOutcome(
  task: PrepTaskRow,
  outcomes: OutcomeRow[],
  costPerPortionPaise: number | null,
  minBaseline = 3,
): PrepOutcomeComparison | null {
  const actual = outcomes.filter((o) => o.menuItemId === task.menuItemId && o.date === task.planDate);
  if (!actual.length) return null;
  const prepared = actual.reduce((a, o) => a + o.prepared, 0);
  const sold = actual.reduce((a, o) => a + o.sold, 0);
  const discarded = actual.reduce((a, o) => a + o.discarded, 0);
  const prior = outcomes
    .filter((o) => o.menuItemId === task.menuItemId && o.date < task.planDate)
    .sort((a, b) => (a.date < b.date ? 1 : -1));
  const priorDates = [...new Set(prior.map((o) => o.date))].slice(0, 7);
  const base = {
    taskId: task.taskId,
    name: task.name,
    date: task.planDate,
    planned: task.plannedQty,
    prepared,
    sold,
    discarded,
    baselineDays: priorDates.length,
  };
  if (priorDates.length < minBaseline) {
    return {
      ...base,
      baselineDiscardedAvg: null,
      observedDiscardDiff: null,
      observedDiffCostPaise: null,
      note: `Needs at least ${minBaseline} earlier recorded outcomes for this dish to compare (has ${priorDates.length}).`,
    };
  }
  const perDay = priorDates.map((d) =>
    prior.filter((o) => o.date === d).reduce((a, o) => a + o.discarded, 0),
  );
  const avg = r2(perDay.reduce((a, b) => a + b, 0) / perDay.length);
  const diff = r2(avg - discarded);
  return {
    ...base,
    baselineDiscardedAvg: avg,
    observedDiscardDiff: diff,
    observedDiffCostPaise: costPerPortionPaise === null ? null : Math.round(diff * costPerPortionPaise),
    note: `Compared with the average of the previous ${priorDates.length} recorded services. One day is not proof of a lasting change.`,
  };
}
