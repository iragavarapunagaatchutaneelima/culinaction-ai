import { addDays, diffDays, weekday } from './dates';

/**
 * Transparent demand baseline — simple averages, NOT machine learning.
 * See docs/ARCHITECTURE.md "Demand baseline".
 */

export const SAME_WEEKDAY_WINDOW = 28;
export const SAME_WEEKDAY_MIN_DAYS = 2;
export const RECENT_WINDOW = 14;
export const RECENT_MIN_DAYS = 3;

export type ForecastMethod = 'same_weekday' | 'recent_days' | 'insufficient';

export interface Forecast {
  menuItemId: number;
  targetDate: string;
  method: ForecastMethod;
  from: string | null;
  to: string | null;
  daysUsed: number;
  values: { date: string; qty: number }[];
  mean: number | null;
  min: number | null;
  max: number | null;
  explanation: string;
}

export interface SaleRow {
  date: string;
  menuItemId: number;
  qty: number;
}

/** Index: trading days (any sales recorded) and per-item per-day quantities. */
export interface SalesIndex {
  tradingDays: Set<string>;
  byItemDay: Map<number, Map<string, number>>;
}

export function buildSalesIndex(sales: SaleRow[]): SalesIndex {
  const tradingDays = new Set<string>();
  const byItemDay = new Map<number, Map<string, number>>();
  for (const s of sales) {
    tradingDays.add(s.date);
    let m = byItemDay.get(s.menuItemId);
    if (!m) byItemDay.set(s.menuItemId, (m = new Map()));
    m.set(s.date, (m.get(s.date) ?? 0) + s.qty);
  }
  return { tradingDays, byItemDay };
}

function stats(values: { date: string; qty: number }[]) {
  const qs = values.map((v) => v.qty);
  const mean = Math.round((qs.reduce((a, b) => a + b, 0) / qs.length) * 100) / 100;
  return { mean, min: Math.min(...qs), max: Math.max(...qs) };
}

export function forecastItem(index: SalesIndex, menuItemId: number, targetDate: string): Forecast {
  const itemDays = index.byItemDay.get(menuItemId) ?? new Map<string, number>();
  const daysBefore = [...index.tradingDays].filter((d) => d < targetDate).sort();
  const wd = weekday(targetDate);

  const sameWd = daysBefore.filter(
    (d) => diffDays(d, targetDate) <= SAME_WEEKDAY_WINDOW && weekday(d) === wd,
  );
  if (sameWd.length >= SAME_WEEKDAY_MIN_DAYS) {
    const values = sameWd.map((date) => ({ date, qty: itemDays.get(date) ?? 0 }));
    const s = stats(values);
    return {
      menuItemId,
      targetDate,
      method: 'same_weekday',
      from: sameWd[0],
      to: sameWd[sameWd.length - 1],
      daysUsed: values.length,
      values,
      ...s,
      explanation: `Average of ${values.length} recorded same-weekday trading day(s) in the ${SAME_WEEKDAY_WINDOW} days before the target date. Days with sales recorded for other items but none for this item count as 0.`,
    };
  }

  const recent = daysBefore.filter((d) => diffDays(d, targetDate) <= RECENT_WINDOW);
  if (recent.length >= RECENT_MIN_DAYS) {
    const values = recent.map((date) => ({ date, qty: itemDays.get(date) ?? 0 }));
    const s = stats(values);
    return {
      menuItemId,
      targetDate,
      method: 'recent_days',
      from: recent[0],
      to: recent[recent.length - 1],
      daysUsed: values.length,
      values,
      ...s,
      explanation: `Fewer than ${SAME_WEEKDAY_MIN_DAYS} same-weekday days available, so this is the average of ${values.length} recorded trading day(s) in the last ${RECENT_WINDOW} days (weekday pattern ignored).`,
    };
  }

  return {
    menuItemId,
    targetDate,
    method: 'insufficient',
    from: null,
    to: null,
    daysUsed: recent.length,
    values: [],
    mean: null,
    min: null,
    max: null,
    explanation: `Insufficient sales history: need at least ${SAME_WEEKDAY_MIN_DAYS} same-weekday trading days in the last ${SAME_WEEKDAY_WINDOW} days, or ${RECENT_MIN_DAYS} trading days in the last ${RECENT_WINDOW} days. Found ${recent.length} recent trading day(s).`,
  };
}

export const METHOD_LABELS: Record<ForecastMethod, string> = {
  same_weekday: 'Same-weekday average',
  recent_days: 'Recent-days average',
  insufficient: 'Insufficient data',
};

/** Dates from `from` to `to` inclusive. */
export function dateRange(from: string, to: string): string[] {
  const out: string[] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) out.push(d);
  return out;
}
