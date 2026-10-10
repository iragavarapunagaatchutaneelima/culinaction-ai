import { Router } from 'express';
import { z } from 'zod';
import { toCsv } from '../../shared/csv';
import { ingredientState } from '../../shared/engine';
import { batchSafety } from '../../shared/safety';
import { formatQty, toBase, unitsCompatible, type BaseUnit } from '../../shared/units';
import { requireRole } from '../auth';
import type { Db } from '../db/database';
import { badRequest, idParam, parse } from '../http';
import {
  adjustBatch,
  audit,
  batchToSnap,
  countIngredient,
  deductFifo,
  getBatch,
  getIngredient,
  iso,
  loadIngredientSnaps,
  outletToday,
  receiveStock,
  type BatchRow,
  type Deps,
  type IngredientRow,
} from '../services';
import {
  dateTypeField,
  isoDate,
  nonNegQty,
  optIsoDate,
  optText,
  positiveQty,
  reqText,
  rupees,
  unitCode,
} from '../validation';

const receiptSchema = z
  .object({
    qty: positiveQty,
    unit: unitCode,
    totalCostInr: rupees,
    receivedOn: isoDate,
    lotCode: optText(40),
    dateType: dateTypeField,
    dateValue: optIsoDate,
  })
  .refine((v) => (v.dateType === null) === (v.dateValue === null), {
    message: 'Choose a date type and enter the date together, or leave both blank',
    path: ['dateValue'],
  });

const ingredientSchema = z.object({
  name: reqText(80, 'Ingredient name'),
  category: reqText(40, 'Category').default('General'),
  baseUnit: z.enum(['g', 'ml', 'pc'], {
    errorMap: () => ({ message: 'Choose how this ingredient is measured' }),
  }),
  storageNotes: optText(300),
  supplierName: optText(80),
});

function checkUnit(unit: string, base: BaseUnit) {
  if (!unitsCompatible(unit, base)) {
    throw badRequest(`Unit "${unit}" cannot be used for an ingredient measured in ${base}.`, {
      fields: {
        unit: `Use a ${base === 'g' ? 'weight (g, kg)' : base === 'ml' ? 'volume (ml, L)' : 'count (pc)'} unit`,
      },
    });
  }
}

export async function ingredientSummaries(
  db: Db,
  outlet: { id: number; timezone: string; expiry_warn_days: number },
  now: Date,
) {
  const today = outletToday(outlet as never, now);
  const rows = await db.all<IngredientRow>('SELECT * FROM ingredients WHERE outlet_id = ? AND archived = 0', [
    outlet.id,
  ]);
  const snaps = new Map((await loadIngredientSnaps(db, outlet.id)).map((s) => [s.id, s]));
  const deps = await db.all<{ ingredient_id: number; n: number }>(
    `SELECT ri.ingredient_id, COUNT(*) AS n FROM recipe_ingredients ri JOIN recipes r ON r.id = ri.recipe_id JOIN menu_items m ON m.id = r.menu_item_id
     WHERE m.outlet_id = ? GROUP BY ri.ingredient_id`,
    [outlet.id],
  );
  const depCount = new Map(deps.map((d) => [d.ingredient_id, d.n]));
  return rows.map((row) => {
    const st = ingredientState(snaps.get(row.id)!, today, outlet.expiry_warn_days);
    const statuses = st.batches.map((b) => b.safety.status);
    const dated = st.batches
      .filter((b) => b.batch.dateValue)
      .sort((a, b) => (a.batch.dateValue! < b.batch.dateValue! ? -1 : 1));
    return {
      id: row.id,
      name: row.name,
      category: row.category,
      baseUnit: row.base_unit,
      usableQty: st.usableQty,
      excludedQty: st.excludedQty,
      usableLabel: formatQty(st.usableQty, row.base_unit),
      unitCostPaise: st.unitCostPaise,
      costMissing: st.usableQty > 0 && !st.costComplete,
      batchCount: st.batches.length,
      nearestDate: dated[0]
        ? { type: dated[0].batch.dateType, value: dated[0].batch.dateValue, status: dated[0].safety.status }
        : null,
      undatedQty: st.batches
        .filter((b) => !b.batch.dateValue && b.safety.usable)
        .reduce((a, b) => a + b.batch.qtyRemaining, 0),
      flags: {
        unsafe: statuses.includes('unsafe'),
        verify: statuses.includes('verify'),
        expiring: statuses.includes('expiring'),
        outOfStock: st.usableQty <= 0,
      },
      storageNotes: row.storage_notes,
      supplierName: row.supplier_name,
      source: row.source,
      lastCountedAt: row.last_counted_at,
      updatedAt: row.updated_at,
      usedInMenuItems: depCount.get(row.id) ?? 0,
    };
  });
}

export function inventoryRoutes({ db, now }: Deps) {
  const r = Router({ mergeParams: true });
  const editors = requireRole('owner', 'manager');
  const anyRole = requireRole('owner', 'manager', 'staff');
  const ctx = (req: Parameters<Parameters<typeof r.get>[1]>[0]) => ({
    db,
    outlet: req.outlet!,
    userId: req.user!.id,
    now: now(),
  });

  r.get('/ingredients', anyRole, async (req, res) => {
    const q = String(req.query.q ?? '')
      .trim()
      .toLowerCase();
    const category = String(req.query.category ?? '');
    const status = String(req.query.status ?? '');
    const sort = String(req.query.sort ?? 'name');
    let list = await ingredientSummaries(db, req.outlet!, now());
    if (q)
      list = list.filter(
        (i) => i.name.toLowerCase().includes(q) || (i.supplierName ?? '').toLowerCase().includes(q),
      );
    if (category) list = list.filter((i) => i.category === category);
    if (status)
      list = list.filter(
        (i) => i.flags[status as keyof typeof i.flags] || (status === 'costMissing' && i.costMissing),
      );
    const sorters: Record<string, (a: (typeof list)[0], b: (typeof list)[0]) => number> = {
      name: (a, b) => a.name.localeCompare(b.name),
      qty: (a, b) => a.usableQty - b.usableQty || a.name.localeCompare(b.name),
      category: (a, b) => a.category.localeCompare(b.category) || a.name.localeCompare(b.name),
      date: (a, b) =>
        (a.nearestDate?.value ?? '9999').localeCompare(b.nearestDate?.value ?? '9999') ||
        a.name.localeCompare(b.name),
      updated: (a, b) => b.updatedAt.localeCompare(a.updatedAt),
    };
    list.sort(sorters[sort] ?? sorters.name);
    const categories = (
      await db.all<{ category: string }>(
        'SELECT DISTINCT category FROM ingredients WHERE outlet_id = ? ORDER BY category',
        [req.outlet!.id],
      )
    ).map((c) => c.category);
    res.json({ items: list, categories });
  });

  r.post('/ingredients', editors, async (req, res) => {
    const b = parse(ingredientSchema.extend({ initialStock: z.unknown().optional() }), req.body);
    const stock = b.initialStock ? parse(receiptSchema, b.initialStock) : null;
    if (stock) checkUnit(stock.unit, b.baseUnit);
    if (stock && stock.receivedOn > outletToday(req.outlet!, now()))
      throw badRequest('Received date cannot be in the future.', {
        fields: { 'initialStock.receivedOn': 'Cannot be in the future' },
      });
    const ts = iso(now());
    const id = await db.tx(async () => {
      const { lastId } = await db.run(
        'INSERT INTO ingredients (outlet_id, name, category, base_unit, storage_notes, supplier_name, source, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)',
        [req.outlet!.id, b.name, b.category, b.baseUnit, b.storageNotes, b.supplierName, 'manual', ts, ts],
      );
      const ing = await getIngredient(db, req.outlet!.id, lastId);
      if (stock) {
        await receiveStock(ctx(req), ing, {
          qtyBase: toBase(stock.qty, stock.unit, b.baseUnit),
          totalCostPaise: stock.totalCostInr,
          receivedOn: stock.receivedOn,
          lotCode: stock.lotCode,
          dateType: stock.dateType,
          dateValue: stock.dateValue,
          source: 'manual',
          reason: 'Opening stock',
        });
      }
      await audit(
        db,
        {
          outletId: req.outlet!.id,
          userId: req.user!.id,
          entityType: 'ingredient',
          entityId: lastId,
          action: 'create',
          details: { ...b, initialStock: stock },
        },
        now(),
      );
      return lastId;
    });
    res.status(201).json(await detail(id, req.outlet!.id, req));
  });

  async function detail(
    id: number,
    outletId: number,
    req: { outlet?: { timezone: string; expiry_warn_days: number } },
  ) {
    const ing = await getIngredient(db, outletId, id);
    const today = outletToday(req.outlet as never, now());
    const batches = await db.all<BatchRow>(
      `SELECT * FROM inventory_batches WHERE ingredient_id = ? ORDER BY qty_remaining = 0, COALESCE(date_value, '9999'), received_on`,
      [id],
    );
    const usedIn = await db.all<{
      id: number;
      name: string;
      qty: number;
      unit: string;
      loss_pct: number;
      verified: number;
    }>(
      `SELECT m.id, m.name, ri.qty, ri.unit, ri.loss_pct, r.verified FROM recipe_ingredients ri JOIN recipes r ON r.id = ri.recipe_id JOIN menu_items m ON m.id = r.menu_item_id
       WHERE ri.ingredient_id = ? ORDER BY m.name`,
      [id],
    );
    const movements = await db.all(
      `SELECT sm.id, sm.movement_type AS type, sm.qty_delta AS qtyDelta, sm.reason, sm.batch_id AS batchId, sm.reference_type AS refType, sm.reference_id AS refId,
              sm.created_at AS createdAt, u.display_name AS userName
       FROM stock_movements sm LEFT JOIN users u ON u.id = sm.user_id WHERE sm.ingredient_id = ? ORDER BY sm.id DESC LIMIT 200`,
      [id],
    );
    const summary = (await ingredientSummaries(db, req.outlet as never, now())).find((s) => s.id === id)!;
    return {
      ...summary,
      batches: batches.map((b) => {
        const s = batchSafety(batchToSnap(b), today, req.outlet!.expiry_warn_days);
        return {
          id: b.id,
          lotCode: b.lot_code,
          qtyReceived: b.qty_received,
          qtyRemaining: b.qty_remaining,
          unitCostPaise: b.unit_cost_paise,
          totalCostPaise: b.total_cost_paise,
          receivedOn: b.received_on,
          dateType: b.date_type,
          dateValue: b.date_value,
          quarantined: !!b.quarantined,
          qualityCheckedOn: b.quality_checked_on,
          storageVerifiedOn: b.storage_verified_on ?? null,
          source: b.source,
          status: b.qty_remaining > 0 ? s.status : 'empty',
          statusReason: s.reason,
        };
      }),
      usedIn: usedIn.map((u) => ({
        id: u.id,
        name: u.name,
        qty: u.qty,
        unit: u.unit,
        lossPct: u.loss_pct,
        verified: !!u.verified,
      })),
      movements,
      createdAt: ing.created_at,
    };
  }

  r.get('/ingredients/:id', anyRole, async (req, res) =>
    res.json(await detail(idParam(req, 'id'), req.outlet!.id, req)),
  );

  r.put('/ingredients/:id', editors, async (req, res) => {
    const id = idParam(req, 'id');
    const ing = await getIngredient(db, req.outlet!.id, id);
    const b = parse(ingredientSchema, req.body);
    if (b.baseUnit !== ing.base_unit) {
      const used = await db.get(
        'SELECT 1 FROM inventory_batches WHERE ingredient_id = ? UNION SELECT 1 FROM recipe_ingredients WHERE ingredient_id = ?',
        [id, id],
      );
      if (used)
        throw badRequest(
          'The measurement type cannot change once stock or recipes exist. Create a new ingredient instead.',
          { fields: { baseUnit: 'Locked — stock or recipes exist' } },
        );
    }
    await db.tx(async () => {
      await db.run(
        'UPDATE ingredients SET name=?, category=?, base_unit=?, storage_notes=?, supplier_name=?, updated_at=? WHERE id=?',
        [b.name, b.category, b.baseUnit, b.storageNotes, b.supplierName, iso(now()), id],
      );
      await audit(
        db,
        {
          outletId: req.outlet!.id,
          userId: req.user!.id,
          entityType: 'ingredient',
          entityId: id,
          action: 'update',
          details: { before: ing, after: b },
        },
        now(),
      );
    });
    res.json(await detail(id, req.outlet!.id, req));
  });

  r.post('/ingredients/:id/archive', editors, async (req, res) => {
    const id = idParam(req, 'id');
    await getIngredient(db, req.outlet!.id, id);
    if (await db.get('SELECT 1 FROM recipe_ingredients WHERE ingredient_id = ?', [id]))
      throw badRequest('Remove this ingredient from all recipes before archiving it.');
    await db.tx(async () => {
      await db.run('UPDATE ingredients SET archived = 1, updated_at = ? WHERE id = ?', [iso(now()), id]);
      await audit(
        db,
        {
          outletId: req.outlet!.id,
          userId: req.user!.id,
          entityType: 'ingredient',
          entityId: id,
          action: 'archive',
        },
        now(),
      );
    });
    res.json({ ok: true });
  });

  r.post('/ingredients/:id/receipts', editors, async (req, res) => {
    const id = idParam(req, 'id');
    const ing = await getIngredient(db, req.outlet!.id, id);
    const b = parse(receiptSchema, req.body);
    checkUnit(b.unit, ing.base_unit);
    if (b.receivedOn > outletToday(req.outlet!, now()))
      throw badRequest('Received date cannot be in the future.', {
        fields: { receivedOn: 'Cannot be in the future' },
      });
    const batchId = await db.tx(async () => {
      const bid = await receiveStock(ctx(req), ing, {
        qtyBase: toBase(b.qty, b.unit, ing.base_unit),
        totalCostPaise: b.totalCostInr,
        receivedOn: b.receivedOn,
        lotCode: b.lotCode,
        dateType: b.dateType,
        dateValue: b.dateValue,
        source: 'manual',
      });
      await audit(
        db,
        {
          outletId: req.outlet!.id,
          userId: req.user!.id,
          entityType: 'batch',
          entityId: bid,
          action: 'receive',
          details: b,
        },
        now(),
      );
      return bid;
    });
    res.status(201).json({ batchId, ingredient: await detail(id, req.outlet!.id, req) });
  });

  r.post('/ingredients/:id/consumption', requireRole('owner', 'manager', 'staff'), async (req, res) => {
    const id = idParam(req, 'id');
    const ing = await getIngredient(db, req.outlet!.id, id);
    const b = parse(z.object({ qty: positiveQty, unit: unitCode, reason: reqText(200, 'Reason') }), req.body);
    checkUnit(b.unit, ing.base_unit);
    await db.tx(async () => {
      const d = await deductFifo(ctx(req), ing, toBase(b.qty, b.unit, ing.base_unit), {
        type: 'consumption',
        reason: b.reason,
        usableOnly: true,
      });
      await audit(
        db,
        {
          outletId: req.outlet!.id,
          userId: req.user!.id,
          entityType: 'ingredient',
          entityId: id,
          action: 'consume',
          details: { ...b, deductions: d },
        },
        now(),
      );
    });
    res.json(await detail(id, req.outlet!.id, req));
  });

  r.post('/ingredients/:id/count', editors, async (req, res) => {
    const id = idParam(req, 'id');
    const ing = await getIngredient(db, req.outlet!.id, id);
    const b = parse(z.object({ qty: nonNegQty, unit: unitCode, reason: optText(200) }), req.body);
    checkUnit(b.unit, ing.base_unit);
    const result = await db.tx(async () => {
      const r2 = await countIngredient(
        ctx(req),
        ing,
        toBase(b.qty, b.unit, ing.base_unit),
        b.reason ?? 'Physical stock count',
      );
      await audit(
        db,
        {
          outletId: req.outlet!.id,
          userId: req.user!.id,
          entityType: 'ingredient',
          entityId: id,
          action: 'count',
          details: { ...b, ...r2 },
        },
        now(),
      );
      return r2;
    });
    res.json({ result, ingredient: await detail(id, req.outlet!.id, req) });
  });

  r.post('/batches/:bid/adjust', editors, async (req, res) => {
    const batch = await getBatch(db, req.outlet!.id, idParam(req, 'bid'));
    const ing = await getIngredient(db, req.outlet!.id, batch.ingredient_id);
    const b = parse(z.object({ qty: nonNegQty, unit: unitCode, reason: reqText(200, 'Reason') }), req.body);
    checkUnit(b.unit, ing.base_unit);
    await db.tx(async () => {
      await adjustBatch(ctx(req), ing, batch, toBase(b.qty, b.unit, ing.base_unit), b.reason);
      await audit(
        db,
        {
          outletId: req.outlet!.id,
          userId: req.user!.id,
          entityType: 'batch',
          entityId: batch.id,
          action: 'adjust',
          details: { before: batch.qty_remaining, ...b },
        },
        now(),
      );
    });
    res.json(await detail(ing.id, req.outlet!.id, req));
  });

  // Operator safety flags. Marking unsafe is allowed for any role; clearing it is owner/manager only.
  r.post('/batches/:bid/flags', anyRole, async (req, res) => {
    const batch = await getBatch(db, req.outlet!.id, idParam(req, 'bid'));
    const b = parse(
      z.object({
        quarantined: z.boolean().optional(),
        qualityChecked: z.literal(true).optional(),
        storageVerified: z.literal(true).optional(),
        note: optText(200),
      }),
      req.body,
    );
    if (b.quarantined === false && req.role === 'staff')
      throw badRequest('Only an owner or manager can clear an unsafe flag.');
    if (b.qualityChecked && batch.date_type !== 'best_before')
      throw badRequest('Quality checks apply to best-before dated batches only.');
    await db.tx(async () => {
      if (b.quarantined !== undefined)
        await db.run('UPDATE inventory_batches SET quarantined = ?, updated_at = ? WHERE id = ?', [
          b.quarantined ? 1 : 0,
          iso(now()),
          batch.id,
        ]);
      if (b.storageVerified)
        await db.run('UPDATE inventory_batches SET storage_verified_on = ?, updated_at = ? WHERE id = ?', [
          outletToday(req.outlet!, now()),
          iso(now()),
          batch.id,
        ]);
      if (b.qualityChecked)
        await db.run('UPDATE inventory_batches SET quality_checked_on = ?, updated_at = ? WHERE id = ?', [
          outletToday(req.outlet!, now()),
          iso(now()),
          batch.id,
        ]);
      await audit(
        db,
        {
          outletId: req.outlet!.id,
          userId: req.user!.id,
          entityType: 'batch',
          entityId: batch.id,
          action: 'flags',
          details: b,
        },
        now(),
      );
    });
    res.json(await detail(batch.ingredient_id, req.outlet!.id, req));
  });

  r.get('/movements', anyRole, async (req, res) => {
    const ingredientId = req.query.ingredientId ? Number(req.query.ingredientId) : null;
    const type = String(req.query.type ?? '');
    const params: (string | number)[] = [req.outlet!.id];
    let where = 'sm.outlet_id = ?';
    if (ingredientId) {
      where += ' AND sm.ingredient_id = ?';
      params.push(ingredientId);
    }
    if (type) {
      where += ' AND sm.movement_type = ?';
      params.push(type);
    }
    res.json(
      await db.all(
        `SELECT sm.id, sm.movement_type AS type, sm.qty_delta AS qtyDelta, sm.reason, sm.batch_id AS batchId, sm.created_at AS createdAt, sm.reference_type AS refType, sm.reference_id AS refId,
                i.id AS ingredientId, i.name AS ingredientName, i.base_unit AS baseUnit, u.display_name AS userName
         FROM stock_movements sm JOIN ingredients i ON i.id = sm.ingredient_id LEFT JOIN users u ON u.id = sm.user_id
         WHERE ${where} ORDER BY sm.id DESC LIMIT 500`,
        params,
      ),
    );
  });

  r.get('/export/inventory.csv', anyRole, async (req, res) => {
    const today = outletToday(req.outlet!, now());
    const rows = await db.all<
      BatchRow & { name: string; category: string; base_unit: string; supplier_name: string | null }
    >(
      `SELECT b.*, i.name, i.category, i.base_unit, i.supplier_name FROM inventory_batches b JOIN ingredients i ON i.id = b.ingredient_id
       WHERE b.outlet_id = ? ORDER BY i.name, b.received_on`,
      [req.outlet!.id],
    );
    const csv = toCsv(
      [
        'ingredient',
        'category',
        'base_unit',
        'lot',
        'qty_received',
        'qty_remaining',
        'unit_cost_inr_per_base_unit',
        'total_cost_inr',
        'received_on',
        'date_type',
        'date',
        'status',
        'supplier',
        'source',
      ],
      rows.map((b) => [
        b.name,
        b.category,
        b.base_unit,
        b.lot_code,
        b.qty_received,
        b.qty_remaining,
        b.unit_cost_paise === null ? '' : (b.unit_cost_paise / 100).toFixed(4),
        b.total_cost_paise === null ? '' : (b.total_cost_paise / 100).toFixed(2),
        b.received_on,
        b.date_type,
        b.date_value,
        b.qty_remaining > 0
          ? batchSafety(batchToSnap(b), today, req.outlet!.expiry_warn_days).status
          : 'empty',
        b.supplier_name,
        b.source,
      ]),
    );
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="inventory-${today}.csv"`);
    res.send(csv);
  });

  return r;
}
