import { Router } from 'express';
import { z } from 'zod';
import { SALES_CSV_TEMPLATE, saleKey, toCsv, validateSalesCsv, type ImportRow } from '../../shared/csv';
import { addDays } from '../../shared/dates';
import { buildSalesIndex, forecastItem, METHOD_LABELS } from '../../shared/forecast';
import { requireRole } from '../auth';
import type { Db } from '../db/database';
import { badRequest, conflict, idParam, notFound, parse } from '../http';
import { audit, iso, loadMenuSnaps, outletToday, type Deps } from '../services';
import { isoDate, nonNegQty, optText, rupees } from '../validation';

const saleSchema = z.object({
  date: isoDate,
  menuItemId: z.number().int().positive(),
  qty: nonNegQty,
  servicePeriod: optText(30).transform((v) => v ?? ''),
  unitPriceInr: rupees,
});

export async function existingSaleKeys(db: Db, outletId: number): Promise<Set<string>> {
  return new Set(
    (
      await db.all<{ sale_date: string; menu_item_id: number; service_period: string }>(
        'SELECT sale_date, menu_item_id, service_period FROM sales_records WHERE outlet_id = ?',
        [outletId],
      )
    ).map((r) => saleKey(r.sale_date, r.menu_item_id, r.service_period)),
  );
}

export function salesRoutes({ db, now }: Deps) {
  const r = Router({ mergeParams: true });
  const editors = requireRole('owner', 'manager');
  const anyRole = requireRole('owner', 'manager', 'staff');

  function validatePeriod(outletPeriods: string[], p: string) {
    if (p && outletPeriods.length && !outletPeriods.map((x) => x.toLowerCase()).includes(p.toLowerCase())) {
      throw badRequest(`Service period must be one of: ${outletPeriods.join(', ')}`, {
        fields: { servicePeriod: 'Not one of this outlet’s periods' },
      });
    }
  }

  r.get('/sales', anyRole, async (req, res) => {
    const today = outletToday(req.outlet!, now());
    const from = String(req.query.from || addDays(today, -13));
    const to = String(req.query.to || today);
    const menuItemId = req.query.menuItemId ? Number(req.query.menuItemId) : null;
    const rows = await db.all(
      `SELECT s.id, s.sale_date AS date, s.menu_item_id AS menuItemId, m.name AS menuItemName, s.service_period AS servicePeriod, s.qty,
              s.unit_price_paise AS unitPricePaise, s.source, s.import_id AS importId, s.created_at AS createdAt, s.updated_at AS updatedAt
       FROM sales_records s JOIN menu_items m ON m.id = s.menu_item_id
       WHERE s.outlet_id = ? AND s.sale_date BETWEEN ? AND ? ${menuItemId ? 'AND s.menu_item_id = ?' : ''}
       ORDER BY s.sale_date DESC, m.name LIMIT 2000`,
      menuItemId ? [req.outlet!.id, from, to, menuItemId] : [req.outlet!.id, from, to],
    );
    const stats = await db.get<{ days: number; first: string | null; last: string | null; n: number }>(
      'SELECT COUNT(DISTINCT sale_date) AS days, MIN(sale_date) AS first, MAX(sale_date) AS last, COUNT(*) AS n FROM sales_records WHERE outlet_id = ?',
      [req.outlet!.id],
    );
    res.json({ from, to, rows, history: stats });
  });

  r.post('/sales', editors, async (req, res) => {
    const b = parse(saleSchema, req.body);
    if (b.date > outletToday(req.outlet!, now()))
      throw badRequest('Sales cannot be recorded for a future date.', {
        fields: { date: 'Cannot be in the future' },
      });
    if (
      !(await db.get('SELECT 1 FROM menu_items WHERE id = ? AND outlet_id = ?', [
        b.menuItemId,
        req.outlet!.id,
      ]))
    )
      throw notFound('Menu item');
    validatePeriod(JSON.parse(req.outlet!.service_periods), b.servicePeriod);
    if ((await existingSaleKeys(db, req.outlet!.id)).has(saleKey(b.date, b.menuItemId, b.servicePeriod))) {
      throw conflict(
        'Sales for this item, date and service period are already recorded. Edit the existing record instead.',
      );
    }
    const ts = iso(now());
    const id = await db.tx(async () => {
      const { lastId } = await db.run(
        'INSERT INTO sales_records (outlet_id, sale_date, menu_item_id, service_period, qty, unit_price_paise, source, created_by, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)',
        [
          req.outlet!.id,
          b.date,
          b.menuItemId,
          b.servicePeriod,
          b.qty,
          b.unitPriceInr,
          'manual',
          req.user!.id,
          ts,
          ts,
        ],
      );
      await audit(
        db,
        {
          outletId: req.outlet!.id,
          userId: req.user!.id,
          entityType: 'sale',
          entityId: lastId,
          action: 'create',
          details: b,
        },
        now(),
      );
      return lastId;
    });
    res.status(201).json({ id });
  });

  r.put('/sales/:id', editors, async (req, res) => {
    const id = idParam(req, 'id');
    const before = await db.get<{ sale_date: string }>(
      'SELECT * FROM sales_records WHERE id = ? AND outlet_id = ?',
      [id, req.outlet!.id],
    );
    if (!before) throw notFound('Sales record');
    const b = parse(z.object({ qty: nonNegQty, unitPriceInr: rupees }), req.body);
    await db.tx(async () => {
      await db.run('UPDATE sales_records SET qty = ?, unit_price_paise = ?, updated_at = ? WHERE id = ?', [
        b.qty,
        b.unitPriceInr,
        iso(now()),
        id,
      ]);
      await audit(
        db,
        {
          outletId: req.outlet!.id,
          userId: req.user!.id,
          entityType: 'sale',
          entityId: id,
          action: 'update',
          details: { before, after: b },
        },
        now(),
      );
    });
    res.json({ ok: true });
  });

  r.delete('/sales/:id', editors, async (req, res) => {
    const id = idParam(req, 'id');
    const before = await db.get('SELECT * FROM sales_records WHERE id = ? AND outlet_id = ?', [
      id,
      req.outlet!.id,
    ]);
    if (!before) throw notFound('Sales record');
    await db.tx(async () => {
      await db.run('DELETE FROM sales_records WHERE id = ?', [id]);
      await audit(
        db,
        {
          outletId: req.outlet!.id,
          userId: req.user!.id,
          entityType: 'sale',
          entityId: id,
          action: 'delete',
          details: { before },
        },
        now(),
      );
    });
    res.json({ ok: true });
  });

  r.get('/sales/template.csv', anyRole, (_req, res) => {
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="culinaction-sales-template.csv"');
    res.send(SALES_CSV_TEMPLATE);
  });

  // Step 1: validate and store a preview. Nothing is written to sales_records yet.
  r.post('/sales/import/preview', editors, async (req, res) => {
    const b = parse(
      z.object({
        filename: optText(120),
        csvText: z.string().min(1, 'The file is empty').max(1_000_000, 'File is larger than 1 MB'),
      }),
      req.body,
    );
    const menu = await db.all<{ id: number; name: string }>(
      'SELECT id, name FROM menu_items WHERE outlet_id = ?',
      [req.outlet!.id],
    );
    const v = validateSalesCsv(b.csvText, menu, await existingSaleKeys(db, req.outlet!.id), {
      servicePeriods: JSON.parse(req.outlet!.service_periods),
      today: outletToday(req.outlet!, now()),
    });
    if (!v.ok)
      return void res.status(400).json({
        error: {
          code: 'csv_header',
          message: v.headerErrors.join(' '),
          details: { headerErrors: v.headerErrors },
        },
      });
    const { lastId } = await db.run(
      `INSERT INTO sales_imports (outlet_id, filename, status, total_rows, valid_rows, invalid_rows, duplicate_rows, payload, created_by, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
      [
        req.outlet!.id,
        b.filename,
        'previewed',
        v.summary.total,
        v.summary.valid,
        v.summary.invalid,
        v.summary.duplicateInFile + v.summary.duplicateExisting,
        JSON.stringify(v.rows),
        req.user!.id,
        iso(now()),
      ],
    );
    res.json({ importId: lastId, summary: v.summary, rows: v.rows });
  });

  // Step 2: user confirmed. Re-check duplicates (data may have changed) and save valid rows only.
  r.post('/sales/import/:importId/commit', editors, async (req, res) => {
    const importId = idParam(req, 'importId');
    const imp = await db.get<{ status: string; payload: string }>(
      'SELECT status, payload FROM sales_imports WHERE id = ? AND outlet_id = ?',
      [importId, req.outlet!.id],
    );
    if (!imp) throw notFound('Import');
    if (imp.status !== 'previewed') throw conflict('This import has already been saved.');
    const rows = JSON.parse(imp.payload) as ImportRow[];
    const ts = iso(now());
    const result = await db.tx(async () => {
      const keys = await existingSaleKeys(db, req.outlet!.id);
      let imported = 0;
      let skipped = 0;
      for (const row of rows) {
        if (row.status !== 'valid') continue;
        const k = saleKey(row.date!, row.menuItemId!, row.servicePeriod);
        if (keys.has(k)) {
          skipped++;
          continue;
        }
        await db.run(
          'INSERT INTO sales_records (outlet_id, sale_date, menu_item_id, service_period, qty, unit_price_paise, source, import_id, created_by, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
          [
            req.outlet!.id,
            row.date,
            row.menuItemId,
            row.servicePeriod,
            row.qty,
            row.unitPricePaise,
            'csv_import',
            importId,
            req.user!.id,
            ts,
            ts,
          ],
        );
        keys.add(k);
        imported++;
      }
      await db.run(
        "UPDATE sales_imports SET status = 'committed', imported_rows = ?, committed_at = ? WHERE id = ?",
        [imported, ts, importId],
      );
      await audit(
        db,
        {
          outletId: req.outlet!.id,
          userId: req.user!.id,
          entityType: 'sales_import',
          entityId: importId,
          action: 'commit',
          details: { imported, skipped },
        },
        now(),
      );
      return {
        imported,
        skippedAsDuplicate: skipped,
        notImported: rows.filter((r2) => r2.status !== 'valid').length,
      };
    });
    res.json(result);
  });

  r.get('/sales/imports', anyRole, async (req, res) => {
    res.json(
      await db.all(
        `SELECT i.id, i.filename, i.status, i.total_rows AS totalRows, i.valid_rows AS validRows, i.invalid_rows AS invalidRows, i.duplicate_rows AS duplicateRows,
                i.imported_rows AS importedRows, i.created_at AS createdAt, i.committed_at AS committedAt, u.display_name AS userName
         FROM sales_imports i LEFT JOIN users u ON u.id = i.created_by WHERE i.outlet_id = ? ORDER BY i.id DESC LIMIT 20`,
        [req.outlet!.id],
      ),
    );
  });

  r.get('/sales/forecast', anyRole, async (req, res) => {
    const date = String(req.query.date || outletToday(req.outlet!, now()));
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw badRequest('Invalid date');
    const sales = (
      await db.all<{ sale_date: string; menu_item_id: number; qty: number }>(
        'SELECT sale_date, menu_item_id, qty FROM sales_records WHERE outlet_id = ? AND sale_date >= ? AND sale_date < ?',
        [req.outlet!.id, addDays(date, -40), date],
      )
    ).map((s) => ({ date: s.sale_date, menuItemId: s.menu_item_id, qty: s.qty }));
    const index = buildSalesIndex(sales);
    const items = (await loadMenuSnaps(db, req.outlet!.id)).filter((m) => m.active);
    res.json({
      date,
      items: items.map((m) => {
        const f = forecastItem(index, m.id, date);
        return { ...f, name: m.name, methodLabel: METHOD_LABELS[f.method] };
      }),
    });
  });

  r.get('/export/sales.csv', anyRole, async (req, res) => {
    const rows = await db.all<Record<string, unknown>>(
      `SELECT s.sale_date, m.name, s.service_period, s.qty, s.unit_price_paise, s.source FROM sales_records s JOIN menu_items m ON m.id = s.menu_item_id
       WHERE s.outlet_id = ? ORDER BY s.sale_date, m.name`,
      [req.outlet!.id],
    );
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="sales.csv"');
    res.send(
      toCsv(
        ['date', 'menu_item', 'quantity', 'service_period', 'unit_price_inr', 'source'],
        rows.map((s) => [
          s.sale_date,
          s.name,
          s.qty,
          s.service_period,
          s.unit_price_paise === null ? '' : ((s.unit_price_paise as number) / 100).toFixed(2),
          s.source,
        ]),
      ),
    );
  });

  return r;
}
