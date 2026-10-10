import { parseBusinessDate } from './dates';
import { parseRupeesToPaise } from './money';

/** RFC 4180 CSV parser: quoted fields, escaped quotes, CRLF/LF, optional UTF-8 BOM. */
export function parseCsv(text: string): string[][] {
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (inQuotes) {
      if (c === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i++;
        } else inQuotes = false;
      } else field += c;
    } else if (c === '"' && field === '') inQuotes = true;
    else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && src[i + 1] === '\n') i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else field += c;
  }
  if (inQuotes) throw new Error('CSV has an unterminated quoted field');
  if (field !== '' || row.length) {
    row.push(field);
    rows.push(row);
  }
  // drop fully blank lines
  return rows.filter((r) => r.some((f) => f.trim() !== ''));
}

/** Neutralise spreadsheet formula injection (=, +, -, @, tab, CR at start of a cell). */
export function safeCell(v: unknown): string {
  if (v === null || v === undefined) return '';
  let s = String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  if (/[",\n\r]/.test(s)) s = `"${s.replace(/"/g, '""')}"`;
  return s;
}

export function toCsv(header: string[], rows: unknown[][]): string {
  return (
    [header.map(safeCell).join(','), ...rows.map((r) => r.map(safeCell).join(','))].join('\r\n') + '\r\n'
  );
}

// ---- Sales CSV import ----

export const SALES_CSV_COLUMNS = [
  'date',
  'menu_item',
  'quantity',
  'service_period',
  'unit_price_inr',
] as const;
export const SALES_CSV_REQUIRED = ['date', 'menu_item', 'quantity'] as const;
export const SALES_CSV_TEMPLATE =
  'date,menu_item,quantity,service_period,unit_price_inr\r\n' +
  '# Replace this line with your own records. Dates: YYYY-MM-DD or DD/MM/YYYY. service_period and unit_price_inr are optional.\r\n';

export type ImportRowStatus = 'valid' | 'invalid' | 'duplicate_in_file' | 'duplicate_existing';

export interface ImportRow {
  line: number; // 1-based line number in the file (header = 1)
  raw: Record<string, string>;
  date: string | null;
  menuItemId: number | null;
  menuItemName: string;
  qty: number | null;
  servicePeriod: string;
  unitPricePaise: number | null;
  status: ImportRowStatus;
  errors: string[];
}

export interface ImportValidation {
  ok: boolean;
  headerErrors: string[];
  rows: ImportRow[];
  summary: {
    total: number;
    valid: number;
    invalid: number;
    duplicateInFile: number;
    duplicateExisting: number;
  };
}

export const saleKey = (date: string, menuItemId: number, period: string) =>
  `${date}|${menuItemId}|${period.trim().toLowerCase()}`;

export function validateSalesCsv(
  text: string,
  menuItems: { id: number; name: string }[],
  existingKeys: Set<string>,
  opts: { servicePeriods?: string[]; maxRows?: number; today?: string } = {},
): ImportValidation {
  const empty = { total: 0, valid: 0, invalid: 0, duplicateInFile: 0, duplicateExisting: 0 };
  let table: string[][];
  try {
    table = parseCsv(text);
  } catch (e) {
    return { ok: false, headerErrors: [(e as Error).message], rows: [], summary: empty };
  }
  table = table.filter((r) => !r[0]?.trim().startsWith('#'));
  if (table.length === 0)
    return { ok: false, headerErrors: ['The file is empty.'], rows: [], summary: empty };

  const header = table[0].map((h) => h.trim().toLowerCase());
  const headerErrors: string[] = [];
  for (const req of SALES_CSV_REQUIRED)
    if (!header.includes(req)) headerErrors.push(`Missing required column "${req}".`);
  const unknown = header.filter((h) => h && !(SALES_CSV_COLUMNS as readonly string[]).includes(h));
  if (unknown.length)
    headerErrors.push(
      `Unrecognised column(s): ${unknown.join(', ')}. Expected: ${SALES_CSV_COLUMNS.join(', ')}.`,
    );
  if (headerErrors.length) return { ok: false, headerErrors, rows: [], summary: empty };

  const maxRows = opts.maxRows ?? 5000;
  if (table.length - 1 > maxRows) {
    return {
      ok: false,
      headerErrors: [`Too many rows (${table.length - 1}). Maximum is ${maxRows} per import.`],
      rows: [],
      summary: empty,
    };
  }

  const byName = new Map(menuItems.map((m) => [m.name.trim().toLowerCase(), m]));
  const periods = opts.servicePeriods?.map((p) => p.toLowerCase());
  const seen = new Set<string>();
  const rows: ImportRow[] = [];

  table.slice(1).forEach((cells, i) => {
    const raw: Record<string, string> = {};
    header.forEach((h, j) => (raw[h] = (cells[j] ?? '').trim()));
    const errors: string[] = [];

    const date = parseBusinessDate(raw.date ?? '');
    if (!date) errors.push(`Invalid date "${raw.date ?? ''}" (use YYYY-MM-DD or DD/MM/YYYY).`);
    else if (opts.today && date > opts.today) errors.push(`Date ${date} is in the future.`);

    const name = raw.menu_item ?? '';
    const item = byName.get(name.toLowerCase());
    if (!name) errors.push('Menu item is blank.');
    else if (!item)
      errors.push(`Unknown menu item "${name}" — add it to the menu first or fix the spelling.`);

    let qty: number | null = null;
    const qRaw = raw.quantity ?? '';
    if (!/^\d+(\.\d+)?$/.test(qRaw)) errors.push(`Quantity "${qRaw}" must be a non-negative number.`);
    else {
      qty = Number(qRaw);
      if (qty > 100000) errors.push(`Quantity ${qty} is implausibly large.`);
    }

    const servicePeriod = raw.service_period ?? '';
    if (servicePeriod && periods && periods.length && !periods.includes(servicePeriod.toLowerCase())) {
      errors.push(
        `Service period "${servicePeriod}" is not one of this outlet's periods (${opts.servicePeriods!.join(', ')}).`,
      );
    }

    let unitPricePaise: number | null = null;
    try {
      unitPricePaise = parseRupeesToPaise(raw.unit_price_inr ?? '');
    } catch (e) {
      errors.push((e as Error).message);
    }

    let status: ImportRowStatus = errors.length ? 'invalid' : 'valid';
    if (status === 'valid' && date && item) {
      const k = saleKey(date, item.id, servicePeriod);
      if (seen.has(k)) {
        status = 'duplicate_in_file';
        errors.push('Duplicate of an earlier row in this file (same date, menu item and service period).');
      } else if (existingKeys.has(k)) {
        status = 'duplicate_existing';
        errors.push('A sales record for this date, menu item and service period already exists.');
      }
      seen.add(k);
    }

    rows.push({
      line: i + 2,
      raw,
      date,
      menuItemId: item?.id ?? null,
      menuItemName: item?.name ?? name,
      qty,
      servicePeriod,
      unitPricePaise,
      status,
      errors,
    });
  });

  const summary = {
    total: rows.length,
    valid: rows.filter((r) => r.status === 'valid').length,
    invalid: rows.filter((r) => r.status === 'invalid').length,
    duplicateInFile: rows.filter((r) => r.status === 'duplicate_in_file').length,
    duplicateExisting: rows.filter((r) => r.status === 'duplicate_existing').length,
  };
  return { ok: true, headerErrors: [], rows, summary };
}
