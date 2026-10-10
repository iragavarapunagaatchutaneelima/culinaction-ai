// Money is stored as integer paise (1 ₹ = 100 paise).

/** Round half away from zero to whole paise. */
export function roundPaise(n: number): number {
  if (!Number.isFinite(n)) throw new Error('Money value must be finite');
  const r = Math.sign(n) * Math.round(Math.abs(n) + Number.EPSILON * Math.abs(n));
  return r === 0 ? 0 : r; // avoid -0
}

/**
 * Parse a rupee amount written by a person ("120", "120.5", "1,250.75") into paise
 * without floating-point error. Returns null for blank input, throws on invalid input.
 */
export function parseRupeesToPaise(input: string | number | null | undefined): number | null {
  if (input === null || input === undefined) return null;
  const s = String(input).trim().replace(/,/g, '').replace(/^₹\s*/, '');
  if (s === '') return null;
  const m = /^(\d+)(?:\.(\d{1,2}))?$/.exec(s);
  if (!m) throw new Error(`"${input}" is not a valid rupee amount (use digits with up to 2 decimals)`);
  const rupees = Number(m[1]);
  const paise = m[2] ? Number(m[2].padEnd(2, '0')) : 0;
  return rupees * 100 + paise;
}

export function paiseToRupees(paise: number): number {
  return paise / 100;
}

const inr = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', minimumFractionDigits: 2 });

export function formatINR(paise: number | null | undefined): string {
  if (paise === null || paise === undefined) return '—';
  return inr.format(roundPaise(paise) / 100);
}

/** Cost of `qtyBase` units at `unitCostPaise` per base unit, rounded to paise. */
export function costOf(qtyBase: number, unitCostPaise: number): number {
  return roundPaise(qtyBase * unitCostPaise);
}
