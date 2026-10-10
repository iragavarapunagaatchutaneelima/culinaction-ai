import { Router } from 'express';
import { z } from 'zod';
import { toCsv, saleKey } from '../../shared/csv';
import { addDays, businessDateOf } from '../../shared/dates';
import { roundPaise } from '../../shared/money';
import { WASTE_REASONS } from '../../shared/types';
import { roundQty, toBase, unitsCompatible } from '../../shared/units';
import { requireRole, type OutletRow } from '../auth';
import type { Db } from '../db/database';
import { badRequest, conflict, notFound, parse } from '../http';
import {
  audit,
  deductFifo,
  deductFromBatch,
  getBatch,
  getIngredient,
  iso,
  outletToday,
  type Deps,
} from '../services';
import { costing } from './menu';
import { existingSaleKeys } from './sales';
import { isoDate, nonNegQty, optText, positiveQty } from '../validation';

/** "YYYY-MM-DDTHH:mm" entered in IST → UTC ISO timestamp. */
const localDateTime = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/, 'Enter a date and time')
  .transform((v, ctx) => {
    const d = new Date(`${v}:00+05:30`);
    if (Number.isNaN(d.getTime())) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Invalid date/time' });
      return z.NEVER;
    }
    return d.toISOString();
  });

const wasteSchema = z.discriminatedUnion('subjectType', [
  z.object({
    subjectType: z.literal('ingredient'),
    ingredientId: z.number().int().positive(),
    batchId: z.number().int().positive().nullish(),
    qty: positiveQty,
    unit: z.string(),
    occurredAt: localDateTime,
    reason: z.enum(WASTE_REASONS),
    notes: optText(300),
    servicePeriod: optText(30),
    deductStock: z.boolean().default(true),
  }),
  z.object({
    subjectType: z.literal('menu_item'),
    menuItemId: z.number().int().positive(),
    qty: positiveQty,
    unit: z.literal('portions').default('portions'),
    occurredAt: localDateTime,
    reason: z.enum(WASTE_REASONS),
    notes: optText(300),
    servicePeriod: optText(30),
  }),
]);

export async function recordMenuItemWaste(
  db: Db,
  outlet: OutletRow,
  userId: number,
  now: Date,
  w: {
    menuItemId: number;
    qty: number;
    occurredAt: string;
    reason: string;
    notes: string | null;
    servicePeriod: string | null;
    outcomeId?: number | null;
    orderId?: number | null;
    source: string;
  },
) {
  const cpp = (await costing(db, outlet, now)).perPortion(w.menuItemId);
  const cost = cpp === null ? null : roundPaise(w.qty * cpp);
  const { lastId } = await db.run(
    `INSERT INTO waste_logs (outlet_id, subject_type, menu_item_id, qty, unit, qty_base, occurred_at, business_date, reason, notes, service_period, cost_paise, cost_basis, outcome_id, order_id, source, created_by, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [
      outlet.id,
      'menu_item',
      w.menuItemId,
      w.qty,
      'portions',
      w.qty,
      w.occurredAt,
      businessDateOf(w.occurredAt, outlet.timezone),
      w.reason,
      w.notes,
      w.servicePeriod,
      cost,
      cost === null ? null : 'recipe_estimate',
      w.outcomeId ?? null,
      w.orderId ?? null,
      w.source,
      userId,
      iso(now),
    ],
  );
  return lastId;
}

export function operationsRoutes({ db, now }: Deps) {
  const r = Router({ mergeParams: true });
  const anyRole = requireRole('owner', 'manager', 'staff');

  r.get('/waste', anyRole, async (req, res) => {
    const today = outletToday(req.outlet!, now());
    const from = String(req.query.from || addDays(today, -29));
    const to = String(req.query.to || today);
    res.json(
      await db.all(
        `SELECT w.id, w.subject_type AS subjectType, w.ingredient_id AS ingredientId, w.menu_item_id AS menuItemId, COALESCE(i.name, m.name) AS name,
                w.qty, w.unit, w.qty_base AS qtyBase, i.base_unit AS baseUnit, w.occurred_at AS occurredAt, w.business_date AS date, w.reason, w.notes, w.service_period AS servicePeriod,
                w.cost_paise AS costPaise, w.cost_basis AS costBasis, w.outcome_id AS outcomeId, w.task_id AS taskId, w.source, u.display_name AS userName, w.batch_id AS batchId
         FROM waste_logs w LEFT JOIN ingredients i ON i.id = w.ingredient_id LEFT JOIN menu_items m ON m.id = w.menu_item_id LEFT JOIN users u ON u.id = w.created_by
         WHERE w.outlet_id = ? AND w.business_date BETWEEN ? AND ? ORDER BY w.occurred_at DESC LIMIT 1000`,
        [req.outlet!.id, from, to],
      ),
    );
  });

  r.post('/waste', anyRole, async (req, res) => {
    const b = parse(wasteSchema, req.body);
    if (b.occurredAt > new Date(now().getTime() + 5 * 60000).toISOString())
      throw badRequest('Waste cannot be recorded in the future.', {
        fields: { occurredAt: 'Cannot be in the future' },
      });
    const c = { db, outlet: req.outlet!, userId: req.user!.id, now: now() };
    const id = await db.tx(async () => {
      if (b.subjectType === 'menu_item') {
        if (
          !(await db.get('SELECT 1 FROM menu_items WHERE id = ? AND outlet_id = ?', [
            b.menuItemId,
            req.outlet!.id,
          ]))
        )
          throw notFound('Menu item');
        return await recordMenuItemWaste(db, req.outlet!, req.user!.id, now(), { ...b, source: 'manual' });
      }
      const ing = await getIngredient(db, req.outlet!.id, b.ingredientId);
      if (!unitsCompatible(b.unit, ing.base_unit))
        throw badRequest(`${ing.name} is measured in ${ing.base_unit}; "${b.unit}" cannot be converted.`, {
          fields: { unit: 'Incompatible unit' },
        });
      const qtyBase = toBase(b.qty, b.unit, ing.base_unit);
      const { lastId } = await db.run(
        `INSERT INTO waste_logs (outlet_id, subject_type, ingredient_id, batch_id, qty, unit, qty_base, occurred_at, business_date, reason, notes, service_period, source, created_by, created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [
          req.outlet!.id,
          'ingredient',
          ing.id,
          b.batchId ?? null,
          b.qty,
          b.unit,
          qtyBase,
          b.occurredAt,
          businessDateOf(b.occurredAt, req.outlet!.timezone),
          b.reason,
          b.notes,
          b.servicePeriod,
          'manual',
          req.user!.id,
          iso(now()),
        ],
      );
      if (b.deductStock) {
        const reason = `Waste: ${b.reason.replace('_', ' ')}${b.notes ? ` — ${b.notes}` : ''}`;
        const batch = b.batchId ? await getBatch(db, req.outlet!.id, b.batchId) : null;
        if (batch && batch.ingredient_id !== ing.id)
          throw badRequest('Batch does not belong to this ingredient.');
        const deductions = batch
          ? [
              await deductFromBatch(c, ing, batch, qtyBase, {
                type: 'waste',
                reason,
                refType: 'waste_log',
                refId: lastId,
              }),
            ]
          : await deductFifo(c, ing, qtyBase, {
              type: 'waste',
              reason,
              usableOnly: false,
              refType: 'waste_log',
              refId: lastId,
            });
        const known = deductions.every((d) => d.costPaise !== null);
        if (known)
          await db.run("UPDATE waste_logs SET cost_paise = ?, cost_basis = 'batch_cost' WHERE id = ?", [
            deductions.reduce((a, d) => a + d.costPaise!, 0),
            lastId,
          ]);
      }
      return lastId;
    });
    await audit(
      db,
      {
        outletId: req.outlet!.id,
        userId: req.user!.id,
        entityType: 'waste_log',
        entityId: id,
        action: 'create',
        details: b,
      },
      now(),
    );
    res.status(201).json({ id });
  });

  r.get('/outcomes', anyRole, async (req, res) => {
    const today = outletToday(req.outlet!, now());
    const from = String(req.query.from || addDays(today, -29));
    const to = String(req.query.to || today);
    res.json(
      await db.all(
        `SELECT o.id, o.business_date AS date, o.service_period AS servicePeriod, o.menu_item_id AS menuItemId, m.name AS menuItemName,
                o.qty_prepared AS prepared, o.qty_sold AS sold, o.qty_remaining AS remaining, o.qty_transferred AS transferred, o.qty_discarded AS discarded, o.task_id AS taskId, o.notes,
                o.source, o.created_at AS createdAt, u.display_name AS userName
         FROM service_outcomes o JOIN menu_items m ON m.id = o.menu_item_id LEFT JOIN users u ON u.id = o.created_by
         WHERE o.outlet_id = ? AND o.business_date BETWEEN ? AND ? ORDER BY o.business_date DESC, m.name`,
        [req.outlet!.id, from, to],
      ),
    );
  });

  r.post('/outcomes', anyRole, async (req, res) => {
    const b = parse(
      z.object({
        date: isoDate,
        servicePeriod: optText(30).transform((v) => v ?? ''),
        menuItemId: z.number().int().positive(),
        prepared: nonNegQty,
        sold: nonNegQty,
        remaining: nonNegQty,
        transferred: nonNegQty.default(0),
        discarded: nonNegQty,
        notes: optText(300),
        taskId: z.number().int().positive().nullish(),
        recordSales: z.boolean().default(false),
        deductIngredients: z.boolean().default(false),
        discardReason: z.enum(WASTE_REASONS).default('over_preparation'),
      }),
      req.body,
    );
    const today = outletToday(req.outlet!, now());
    if (b.date > today)
      throw badRequest('Outcomes cannot be recorded for a future date.', {
        fields: { date: 'Cannot be in the future' },
      });
    const accounted = roundQty(b.sold + b.remaining + b.transferred + b.discarded);
    if (accounted > b.prepared + 1e-9) {
      throw badRequest(
        `Sold + remaining + transferred + discarded (${accounted}) is more than prepared (${b.prepared}).`,
        {
          fields: { prepared: 'Must be at least sold + remaining + discarded' },
        },
      );
    }
    const item = await db.get<{ id: number; name: string }>(
      'SELECT id, name FROM menu_items WHERE id = ? AND outlet_id = ?',
      [b.menuItemId, req.outlet!.id],
    );
    if (!item) throw notFound('Menu item');
    if (b.taskId) {
      const t = await db.get<{ line_type: string; subject_id: number }>(
        'SELECT pl.line_type, pl.subject_id FROM tasks t JOIN plan_lines pl ON pl.id = t.plan_line_id WHERE t.id = ? AND t.outlet_id = ?',
        [b.taskId, req.outlet!.id],
      );
      if (!t || t.line_type !== 'prep' || t.subject_id !== b.menuItemId)
        throw badRequest('The linked task is not a preparation task for this menu item.');
    }
    const c = { db, outlet: req.outlet!, userId: req.user!.id, now: now() };
    const ts = iso(now());
    const result = await db.tx(async () => {
      const { lastId } = await db.run(
        `INSERT INTO service_outcomes (outlet_id, business_date, service_period, menu_item_id, qty_prepared, qty_sold, qty_remaining, qty_transferred, qty_discarded, task_id, notes, source, created_by, created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [
          req.outlet!.id,
          b.date,
          b.servicePeriod,
          b.menuItemId,
          b.prepared,
          b.sold,
          b.remaining,
          b.transferred,
          b.discarded,
          b.taskId ?? null,
          b.notes,
          'manual',
          req.user!.id,
          ts,
        ],
      );
      const effects: string[] = [];
      if (b.recordSales) {
        if (
          (await existingSaleKeys(db, req.outlet!.id)).has(saleKey(b.date, b.menuItemId, b.servicePeriod))
        ) {
          throw conflict(
            'Sales for this item, date and service period are already recorded. Untick "add sold quantity to sales" to avoid double counting.',
          );
        }
        await db.run(
          'INSERT INTO sales_records (outlet_id, sale_date, menu_item_id, service_period, qty, source, created_by, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)',
          [
            req.outlet!.id,
            b.date,
            b.menuItemId,
            b.servicePeriod,
            b.sold,
            'service_outcome',
            req.user!.id,
            ts,
            ts,
          ],
        );
        effects.push(`Recorded ${b.sold} sold in sales history`);
      }
      if (b.deductIngredients && b.prepared > 0) {
        const lines = await db.all<{ ingredient_id: number; qty: number; unit: string; loss_pct: number }>(
          'SELECT ri.ingredient_id, ri.qty, ri.unit, ri.loss_pct FROM recipe_ingredients ri JOIN recipes r ON r.id = ri.recipe_id WHERE r.menu_item_id = ?',
          [b.menuItemId],
        );
        if (!lines.length)
          throw badRequest(
            `${item.name} has no recipe, so ingredients cannot be deducted. Untick "deduct ingredients" or add the recipe.`,
          );
        for (const l of lines) {
          const ing = await getIngredient(db, req.outlet!.id, l.ingredient_id);
          const qty = roundQty((toBase(l.qty, l.unit, ing.base_unit) / (1 - l.loss_pct / 100)) * b.prepared);
          await deductFifo(c, ing, qty, {
            type: 'consumption',
            reason: `Prepared ${b.prepared} × ${item.name} (outcome #${lastId})`,
            usableOnly: true,
            refType: 'service_outcome',
            refId: lastId,
          });
        }
        effects.push(`Deducted ingredients for ${b.prepared} portions`);
      }
      if (b.discarded > 0) {
        await recordMenuItemWaste(db, req.outlet!, req.user!.id, now(), {
          menuItemId: b.menuItemId,
          qty: b.discarded,
          occurredAt: ts,
          reason: b.discardReason,
          notes: `From service outcome #${lastId}`,
          servicePeriod: b.servicePeriod || null,
          outcomeId: lastId,
          source: 'service_outcome',
        });
        effects.push(`Logged ${b.discarded} discarded portions as waste`);
      }
      await audit(
        db,
        {
          outletId: req.outlet!.id,
          userId: req.user!.id,
          entityType: 'service_outcome',
          entityId: lastId,
          action: 'create',
          details: { ...b, effects },
        },
        now(),
      );
      return { id: lastId, effects, unaccounted: roundQty(b.prepared - accounted) };
    });
    res.status(201).json(result);
  });

  r.get('/export/waste.csv', anyRole, async (req, res) => {
    const rows = await db.all<Record<string, unknown>>(
      `SELECT w.business_date, w.occurred_at, w.subject_type, COALESCE(i.name, m.name) AS name, w.qty, w.unit, w.reason, w.cost_paise, w.cost_basis, w.notes, w.source
       FROM waste_logs w LEFT JOIN ingredients i ON i.id = w.ingredient_id LEFT JOIN menu_items m ON m.id = w.menu_item_id WHERE w.outlet_id = ? ORDER BY w.occurred_at`,
      [req.outlet!.id],
    );
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="waste.csv"');
    res.send(
      toCsv(
        [
          'date',
          'occurred_at_utc',
          'type',
          'item',
          'qty',
          'unit',
          'reason',
          'cost_inr',
          'cost_basis',
          'notes',
          'source',
        ],
        rows.map((w) => [
          w.business_date,
          w.occurred_at,
          w.subject_type,
          w.name,
          w.qty,
          w.unit,
          w.reason,
          w.cost_paise === null ? '' : ((w.cost_paise as number) / 100).toFixed(2),
          w.cost_basis,
          w.notes,
          w.source,
        ]),
      ),
    );
  });

  r.get('/export/outcomes.csv', anyRole, async (req, res) => {
    const rows = await db.all<Record<string, unknown>>(
      `SELECT o.business_date, o.service_period, m.name, o.qty_prepared, o.qty_sold, o.qty_remaining, o.qty_discarded, o.notes FROM service_outcomes o
       JOIN menu_items m ON m.id = o.menu_item_id WHERE o.outlet_id = ? ORDER BY o.business_date`,
      [req.outlet!.id],
    );
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="service-outcomes.csv"');
    res.send(
      toCsv(
        ['date', 'service_period', 'menu_item', 'prepared', 'sold', 'remaining', 'discarded', 'notes'],
        rows.map((o) => Object.values(o)),
      ),
    );
  });

  return r;
}
