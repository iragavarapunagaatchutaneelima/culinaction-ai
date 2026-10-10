// Centralised unit handling. Every quantity in the database is stored in the
// ingredient's BASE unit (g, ml or pc). This is the only module that converts.

export type Dimension = 'mass' | 'volume' | 'count';
export type BaseUnit = 'g' | 'ml' | 'pc';
export type UnitCode = 'g' | 'kg' | 'ml' | 'L' | 'pc';

interface UnitDef {
  dimension: Dimension;
  factor: number; // multiply by this to get base units
  label: string;
}

export const UNITS: Record<UnitCode, UnitDef> = {
  g: { dimension: 'mass', factor: 1, label: 'g' },
  kg: { dimension: 'mass', factor: 1000, label: 'kg' },
  ml: { dimension: 'volume', factor: 1, label: 'ml' },
  L: { dimension: 'volume', factor: 1000, label: 'L' },
  pc: { dimension: 'count', factor: 1, label: 'pieces' },
};

export const UNIT_CODES = Object.keys(UNITS) as UnitCode[];
export const BASE_UNITS: BaseUnit[] = ['g', 'ml', 'pc'];

const BASE_FOR: Record<Dimension, BaseUnit> = { mass: 'g', volume: 'ml', count: 'pc' };

export class IncompatibleUnitError extends Error {
  constructor(
    public readonly from: string,
    public readonly to: string,
  ) {
    super(`Cannot convert ${from} to ${to}: they measure different things (no conversion is defined).`);
    this.name = 'IncompatibleUnitError';
  }
}

export class UnknownUnitError extends Error {
  constructor(public readonly unit: string) {
    super(`Unknown unit "${unit}". Use one of: ${UNIT_CODES.join(', ')}.`);
    this.name = 'UnknownUnitError';
  }
}

export function isUnitCode(u: string): u is UnitCode {
  return Object.prototype.hasOwnProperty.call(UNITS, u);
}

export function unitDef(u: string): UnitDef {
  if (!isUnitCode(u)) throw new UnknownUnitError(u);
  return UNITS[u];
}

export function dimensionOf(u: string): Dimension {
  return unitDef(u).dimension;
}

export function baseUnitOf(u: string): BaseUnit {
  return BASE_FOR[dimensionOf(u)];
}

export function unitsCompatible(a: string, b: string): boolean {
  return isUnitCode(a) && isUnitCode(b) && UNITS[a].dimension === UNITS[b].dimension;
}

/** Units that may be used for an ingredient whose base unit is `base`. */
export function unitsForBase(base: BaseUnit): UnitCode[] {
  return UNIT_CODES.filter((u) => UNITS[u].dimension === dimensionOf(base));
}

/** Round to 3 decimals to keep floating-point noise out of stored quantities. */
export function roundQty(n: number): number {
  return Math.round(n * 1000) / 1000;
}

export function convert(qty: number, from: string, to: string): number {
  const f = unitDef(from);
  const t = unitDef(to);
  if (f.dimension !== t.dimension) throw new IncompatibleUnitError(from, to);
  return roundQty((qty * f.factor) / t.factor);
}

/** Convert a quantity in `unit` to the base unit `base`. Throws if incompatible. */
export function toBase(qty: number, unit: string, base: BaseUnit): number {
  return convert(qty, unit, base);
}

/** Add two quantities that may be in different units; result in `resultUnit`. */
export function addQuantities(
  a: { qty: number; unit: string },
  b: { qty: number; unit: string },
  resultUnit: string,
) {
  return roundQty(convert(a.qty, a.unit, resultUnit) + convert(b.qty, b.unit, resultUnit));
}

/** Human-friendly display of a base-unit quantity, e.g. 2500 g → "2.5 kg". */
export function formatQty(qtyBase: number | null | undefined, base: BaseUnit): string {
  if (qtyBase === null || qtyBase === undefined || Number.isNaN(qtyBase)) return '—';
  const abs = Math.abs(qtyBase);
  const fmt = (n: number) => Number(n.toFixed(n % 1 === 0 ? 0 : n < 10 ? 2 : 1)).toLocaleString('en-IN');
  if (base === 'g') return abs >= 1000 ? `${fmt(qtyBase / 1000)} kg` : `${fmt(qtyBase)} g`;
  if (base === 'ml') return abs >= 1000 ? `${fmt(qtyBase / 1000)} L` : `${fmt(qtyBase)} ml`;
  return `${fmt(qtyBase)} pc`;
}

/** Round a purchase quantity up to a practical step (10 g / 10 ml / 1 pc). */
export function roundUpPurchase(qtyBase: number, base: BaseUnit): number {
  const step = base === 'pc' ? 1 : 10;
  return Math.ceil(roundQty(qtyBase) / step) * step;
}
