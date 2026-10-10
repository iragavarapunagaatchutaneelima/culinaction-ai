// Display helpers re-using the shared, tested domain formatters.
export { formatDate, formatDateTime, addDays } from '../../shared/dates';
export { formatINR } from '../../shared/money';
export { formatQty, unitsForBase, type BaseUnit } from '../../shared/units';
import type { BaseUnit } from '../../shared/units';
import { formatQty } from '../../shared/units';

export const UNIT_NAME: Record<string, string> = { g: 'weight', ml: 'volume', pc: 'count' };

/** Default display unit for an ingredient: kg / L for bulk, else base. */
export function defaultUnit(base: BaseUnit, preferredMass = 'kg', preferredVolume = 'L') {
  return base === 'g' ? preferredMass : base === 'ml' ? preferredVolume : 'pc';
}

export function qtyLabel(qty: number | null | undefined, unit: string | null | undefined) {
  if (qty === null || qty === undefined) return '—';
  if (unit === 'g' || unit === 'ml' || unit === 'pc') return formatQty(qty, unit);
  return `${Number(qty.toFixed(2))}${unit ? ` ${unit}` : ''}`;
}

/** Cost stored per base unit (paise per g/ml/pc) → display per kg / L / pc. */
export function unitCostLabel(paisePerBase: number | null, base: BaseUnit) {
  if (paisePerBase === null) return 'No cost recorded';
  const per = base === 'pc' ? 1 : 1000;
  const n = (paisePerBase * per) / 100;
  return `₹${n.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} / ${base === 'g' ? 'kg' : base === 'ml' ? 'L' : 'pc'}`;
}

export const DATE_TYPE_LABEL: Record<string, string> = {
  use_by: 'Use-by',
  expiry: 'Expiry',
  best_before: 'Best-before',
};

export const WASTE_REASON_LABELS: Record<string, string> = {
  spoilage: 'Ingredient spoilage',
  expired: 'Expired stock / past safe-use date',
  over_preparation: 'Excess preparation',
  unsold_cooked: 'Unsold cooked food',
  cancelled_order: 'Cancelled prepared order',
  uncollected_order: 'Uncollected order',
  prep_trim: 'Preparation waste / trim',
  returned: 'Customer-returned food',
  other: 'Other recorded disposal',
};

export const OUTLET_TYPE_LABELS: Record<string, string> = {
  cafe: 'Café / coffee shop',
  bakery: 'Bakery / dessert outlet',
  tiffin: 'South Indian breakfast & tiffin',
  biryani: 'Biryani & rice meals',
  restaurant: 'General restaurant / meal combos',
};

/** Today's date (YYYY-MM-DD) in Asia/Kolkata. */
export function todayIST(): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}
/** Current IST time as "YYYY-MM-DDTHH:mm" for datetime-local inputs. */
export function nowISTLocal(): string {
  const p = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(new Date());
  const g = (t: string) => p.find((x) => x.type === t)!.value;
  return `${g('year')}-${g('month')}-${g('day')}T${g('hour') === '24' ? '00' : g('hour')}:${g('minute')}`;
}

export function num(v: string): number | null {
  const t = v.trim();
  if (t === '') return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : NaN;
}
