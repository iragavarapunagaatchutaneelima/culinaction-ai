import { todayInTz } from '../shared/dates';
import { costOf } from '../shared/money';
import { batchSafety, fifoCompare } from '../shared/safety';
import type { BatchSnap, DateType, IngredientSnap, MenuItemSnap, Snapshot } from '../shared/types';
import { roundQty, type BaseUnit } from '../shared/units';
import type { OutletRow } from './auth';
import type { Db } from './db/database';
import { conflict, notFound } from './http';

export interface Deps {
  db: Db;
  now: () => Date;
}

export const iso = (d: Date) => d.toISOString();
export const outletToday = (o: OutletRow, now: Date) => todayInTz(o.timezone, now);

export async function audit(
  db: Db,
  e: {
    outletId: number | null;
    userId: number | null;
    entityType: string;
    entityId: number | null;
    action: string;
    details?: unknown;
  },
  now: Date,
) {
  await db.run(
    'INSERT INTO audit_events (outlet_id, user_id, entity_type, entity_id, action, details_json, created_at) VALUES (?,?,?,?,?,?,?)',
    [
      e.outletId,
      e.userId,
      e.entityType,
      e.entityId,
      e.action,
      e.details === undefined ? null : JSON.stringify(e.details),
      iso(now),
    ],
  );
}

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

export interface IngredientRow {
  id: number;
  outlet_id: number;
  name: string;
  category: string;
  base_unit: BaseUnit;
  storage_notes: string | null;
  supplier_name: string | null;
  source: string;
  last_counted_at: string | null;
  archived: number;
  created_at: string;
  updated_at: string;
}

export interface BatchRow {
  id: number;
  outlet_id: number;
  ingredient_id: number;
  lot_code: string | null;
  qty_received: number;
  qty_remaining: number;
  unit_cost_paise: number | null;
  total_cost_paise: number | null;
  received_on: string;
  date_type: DateType | null;
  date_value: string | null;
  quarantined: number;
  quality_checked_on: string | null;
  source: string;
  created_at: string;
  updated_at: string;
}

export const batchToSnap = (b: BatchRow): BatchSnap => ({
  id: b.id,
  lotCode: b.lot_code,
  qtyRemaining: b.qty_remaining,
  unitCostPaise: b.unit_cost_paise,
  receivedOn: b.received_on,
  dateType: b.date_type,
  dateValue: b.date_value,
  quarantined: !!b.quarantined,
  qualityCheckedOn: b.quality_checked_on,
});

export async function getIngredient(db: Db, outletId: number, id: number): Promise<IngredientRow> {
  const row = await db.get<IngredientRow>('SELECT * FROM ingredients WHERE id = ? AND outlet_id = ?', [
    id,
    outletId,
  ]);
  if (!row) throw notFound('Ingredient');
  return row;
}

export async function getBatch(db: Db, outletId: number, id: number): Promise<BatchRow> {
  const row = await db.get<BatchRow>('SELECT * FROM inventory_batches WHERE id = ? AND outlet_id = ?', [
    id,
    outletId,
  ]);
  if (!row) throw notFound('Batch');
  return row;
}

// ---------------------------------------------------------------------------
// Stock operations (all callers wrap these in db.tx)
// ---------------------------------------------------------------------------

interface MoveCtx {
  db: Db;
  outlet: OutletRow;
  userId: number | null;
  now: Date;
}

async function movement(
  c: MoveCtx,
  m: {
    ingredientId: number;
    batchId: number | null;
    type: string;
    delta: number;
    reason: string;
    refType?: string | null;
    refId?: number | null;
  },
) {
  await c.db.run(
    `INSERT INTO stock_movements (outlet_id, ingredient_id, batch_id, movement_type, qty_delta, reason, reference_type, reference_id, user_id, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
    [
      c.outlet.id,
      m.ingredientId,
      m.batchId,
      m.type,
      roundQty(m.delta),
      m.reason,
      m.refType ?? null,
      m.refId ?? null,
      c.userId,
      iso(c.now),
    ],
  );
}

export async function receiveStock(
  c: MoveCtx,
  ing: IngredientRow,
  r: {
    qtyBase: number;
    totalCostPaise: number | null;
    receivedOn: string;
    lotCode: string | null;
    dateType: DateType | null;
    dateValue: string | null;
    source: string;
    reason?: string;
  },
): Promise<number> {
  const unitCost = r.totalCostPaise === null ? null : r.totalCostPaise / r.qtyBase;
  const ts = iso(c.now);
  const { lastId } = await c.db.run(
    `INSERT INTO inventory_batches (outlet_id, ingredient_id, lot_code, qty_received, qty_remaining, unit_cost_paise, total_cost_paise, received_on, date_type, date_value, source, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [
      c.outlet.id,
      ing.id,
      r.lotCode,
      r.qtyBase,
      r.qtyBase,
      unitCost,
      r.totalCostPaise,
      r.receivedOn,
      r.dateType,
      r.dateValue,
      r.source,
      ts,
      ts,
    ],
  );
  await movement(c, {
    ingredientId: ing.id,
    batchId: lastId,
    type: 'receipt',
    delta: r.qtyBase,
    reason: r.reason ?? 'Stock receipt',
  });
  await c.db.run('UPDATE ingredients SET last_counted_at = ?, updated_at = ? WHERE id = ?', [ts, ts, ing.id]);
  return lastId;
}

export interface Deduction {
  batchId: number;
  qty: number;
  costPaise: number | null;
}

/**
 * Deduct quantity earliest-date-first. For consumption, only usable (safe) batches are eligible.
 * Throws 409 if there is not enough eligible stock — nothing is deducted in that case.
 */
export async function deductFifo(
  c: MoveCtx,
  ing: IngredientRow,
  qtyBase: number,
  o: { type: 'consumption' | 'waste'; reason: string; usableOnly: boolean; refType?: string; refId?: number },
): Promise<Deduction[]> {
  const today = outletToday(c.outlet, c.now);
  const batches = (
    await c.db.all<BatchRow>(
      'SELECT * FROM inventory_batches WHERE ingredient_id = ? AND qty_remaining > 0',
      [ing.id],
    )
  )
    .map((b) => ({ row: b, snap: batchToSnap(b) }))
    .filter((b) => !o.usableOnly || batchSafety(b.snap, today, c.outlet.expiry_warn_days).usable)
    .sort((a, b) => fifoCompare(a.snap, b.snap));
  const available = roundQty(batches.reduce((a, b) => a + b.row.qty_remaining, 0));
  if (qtyBase > available + 1e-9) {
    throw conflict(
      `Not enough ${o.usableOnly ? 'usable ' : ''}${ing.name} in stock: need ${roundQty(qtyBase)} ${ing.base_unit}, have ${available} ${ing.base_unit}.` +
        (o.usableOnly ? ' Expired, unsafe or unchecked batches cannot be consumed.' : ''),
      { ingredientId: ing.id, needed: qtyBase, available },
    );
  }
  let left = qtyBase;
  const out: Deduction[] = [];
  for (const { row } of batches) {
    if (left <= 1e-9) break;
    const take = roundQty(Math.min(left, row.qty_remaining));
    await c.db.run('UPDATE inventory_batches SET qty_remaining = ?, updated_at = ? WHERE id = ?', [
      roundQty(row.qty_remaining - take),
      iso(c.now),
      row.id,
    ]);
    await movement(c, {
      ingredientId: ing.id,
      batchId: row.id,
      type: o.type,
      delta: -take,
      reason: o.reason,
      refType: o.refType,
      refId: o.refId,
    });
    out.push({
      batchId: row.id,
      qty: take,
      costPaise: row.unit_cost_paise === null ? null : costOf(take, row.unit_cost_paise),
    });
    left = roundQty(left - take);
  }
  return out;
}

export async function deductFromBatch(
  c: MoveCtx,
  ing: IngredientRow,
  batch: BatchRow,
  qtyBase: number,
  o: { type: 'waste' | 'consumption'; reason: string; refType?: string; refId?: number },
): Promise<Deduction> {
  if (qtyBase > batch.qty_remaining + 1e-9)
    throw conflict(`Batch has only ${batch.qty_remaining} ${ing.base_unit} remaining.`);
  const take = roundQty(qtyBase);
  await c.db.run('UPDATE inventory_batches SET qty_remaining = ?, updated_at = ? WHERE id = ?', [
    roundQty(batch.qty_remaining - take),
    iso(c.now),
    batch.id,
  ]);
  await movement(c, {
    ingredientId: ing.id,
    batchId: batch.id,
    type: o.type,
    delta: -take,
    reason: o.reason,
    refType: o.refType,
    refId: o.refId,
  });
  return {
    batchId: batch.id,
    qty: take,
    costPaise: batch.unit_cost_paise === null ? null : costOf(take, batch.unit_cost_paise),
  };
}

export async function adjustBatch(
  c: MoveCtx,
  ing: IngredientRow,
  batch: BatchRow,
  newQty: number,
  reason: string,
) {
  const delta = roundQty(newQty - batch.qty_remaining);
  if (delta === 0) return;
  await c.db.run('UPDATE inventory_batches SET qty_remaining = ?, updated_at = ? WHERE id = ?', [
    roundQty(newQty),
    iso(c.now),
    batch.id,
  ]);
  await movement(c, { ingredientId: ing.id, batchId: batch.id, type: 'adjustment', delta, reason });
}

/** Physical count: bring recorded stock to the counted total. */
export async function countIngredient(
  c: MoveCtx,
  ing: IngredientRow,
  counted: number,
  reason: string,
  refType?: string,
  refId?: number,
) {
  const today = outletToday(c.outlet, c.now);
  const batches = await c.db.all<BatchRow>(
    'SELECT * FROM inventory_batches WHERE ingredient_id = ? AND qty_remaining > 0',
    [ing.id],
  );
  const total = roundQty(batches.reduce((a, b) => a + b.qty_remaining, 0));
  const diff = roundQty(counted - total);
  const ts = iso(c.now);
  if (diff < 0) {
    // Remove the shortfall from usable batches first (FIFO), then from excluded ones.
    const ordered = batches
      .map((row) => ({ row, snap: batchToSnap(row) }))
      .sort((a, b) => {
        const ua = batchSafety(a.snap, today, c.outlet.expiry_warn_days).usable ? 0 : 1;
        const ub = batchSafety(b.snap, today, c.outlet.expiry_warn_days).usable ? 0 : 1;
        return ua - ub || fifoCompare(a.snap, b.snap);
      });
    let left = -diff;
    for (const { row } of ordered) {
      if (left <= 1e-9) break;
      const take = roundQty(Math.min(left, row.qty_remaining));
      await c.db.run('UPDATE inventory_batches SET qty_remaining = ?, updated_at = ? WHERE id = ?', [
        roundQty(row.qty_remaining - take),
        ts,
        row.id,
      ]);
      await movement(c, {
        ingredientId: ing.id,
        batchId: row.id,
        type: 'count',
        delta: -take,
        reason,
        refType,
        refId,
      });
      left = roundQty(left - take);
    }
  } else if (diff > 0) {
    const { lastId } = await c.db.run(
      `INSERT INTO inventory_batches (outlet_id, ingredient_id, lot_code, qty_received, qty_remaining, unit_cost_paise, total_cost_paise, received_on, source, created_at, updated_at)
       VALUES (?,?,?,?,?,NULL,NULL,?,?,?,?)`,
      [c.outlet.id, ing.id, 'COUNT-SURPLUS', diff, diff, today, 'adjustment', ts, ts],
    );
    await movement(c, {
      ingredientId: ing.id,
      batchId: lastId,
      type: 'count',
      delta: diff,
      reason: `${reason} (surplus found; cost unknown)`,
      refType,
      refId,
    });
  } else {
    await movement(c, {
      ingredientId: ing.id,
      batchId: null,
      type: 'count',
      delta: 0,
      reason: `${reason} (matches records)`,
      refType,
      refId,
    });
  }
  await c.db.run('UPDATE ingredients SET last_counted_at = ?, updated_at = ? WHERE id = ?', [ts, ts, ing.id]);
  return { before: total, after: counted, diff };
}

// ---------------------------------------------------------------------------
// Snapshot for the engine
// ---------------------------------------------------------------------------

export async function loadMenuSnaps(db: Db, outletId: number): Promise<MenuItemSnap[]> {
  const items = await db.all<{
    id: number;
    name: string;
    category: string;
    price_paise: number | null;
    active: number;
    allergens: string | null;
    allergens_verified: number;
    verified: number | null;
  }>(
    `SELECT m.*, r.verified FROM menu_items m LEFT JOIN recipes r ON r.menu_item_id = m.id WHERE m.outlet_id = ? ORDER BY m.name`,
    [outletId],
  );
  const lines = await db.all<{
    menu_item_id: number;
    ingredient_id: number;
    qty: number;
    unit: string;
    loss_pct: number;
  }>(
    `SELECT r.menu_item_id, ri.ingredient_id, ri.qty, ri.unit, ri.loss_pct FROM recipe_ingredients ri JOIN recipes r ON r.id = ri.recipe_id
     JOIN menu_items m ON m.id = r.menu_item_id WHERE m.outlet_id = ? ORDER BY ri.id`,
    [outletId],
  );
  return items.map((m) => ({
    id: m.id,
    name: m.name,
    category: m.category,
    pricePaise: m.price_paise,
    active: !!m.active,
    recipeVerified: !!m.verified,
    allergens: m.allergens,
    allergensVerified: !!m.allergens_verified,
    lines: lines
      .filter((l) => l.menu_item_id === m.id)
      .map((l) => ({ ingredientId: l.ingredient_id, qty: l.qty, unit: l.unit, lossPct: l.loss_pct })),
  }));
}

export async function loadIngredientSnaps(db: Db, outletId: number): Promise<IngredientSnap[]> {
  const ings = await db.all<IngredientRow>(
    'SELECT * FROM ingredients WHERE outlet_id = ? AND archived = 0 ORDER BY name',
    [outletId],
  );
  const batches = await db.all<BatchRow>(
    'SELECT * FROM inventory_batches WHERE outlet_id = ? AND qty_remaining > 0',
    [outletId],
  );
  return ings.map((i) => ({
    id: i.id,
    name: i.name,
    category: i.category,
    baseUnit: i.base_unit,
    lastCountedAt: i.last_counted_at,
    batches: batches.filter((b) => b.ingredient_id === i.id).map(batchToSnap),
  }));
}

export async function loadSnapshot(
  db: Db,
  outlet: OutletRow,
  planDate: string,
  now: Date,
): Promise<Snapshot> {
  const today = outletToday(outlet, now);
  const from = new Date(Date.parse(planDate) - 60 * 86400000).toISOString().slice(0, 10);
  return {
    today,
    planDate,
    nowIso: iso(now),
    settings: {
      expiryWarnDays: outlet.expiry_warn_days,
      excessCoverDays: outlet.excess_cover_days,
      staleCountDays: outlet.stale_count_days,
      purchaseBufferPct: outlet.purchase_buffer_pct,
    },
    ingredients: await loadIngredientSnaps(db, outlet.id),
    menuItems: await loadMenuSnaps(db, outlet.id),
    sales: (
      await db.all<{ id: number; sale_date: string; menu_item_id: number; qty: number }>(
        'SELECT id, sale_date, menu_item_id, qty FROM sales_records WHERE outlet_id = ? AND sale_date >= ?',
        [outlet.id, from],
      )
    ).map((s) => ({ id: s.id, date: s.sale_date, menuItemId: s.menu_item_id, qty: s.qty })),
    outcomes: (
      await db.all<{
        id: number;
        business_date: string;
        menu_item_id: number;
        qty_prepared: number;
        qty_sold: number;
        qty_remaining: number;
        qty_discarded: number;
      }>('SELECT * FROM service_outcomes WHERE outlet_id = ? AND business_date >= ?', [outlet.id, from])
    ).map((o) => ({
      id: o.id,
      date: o.business_date,
      menuItemId: o.menu_item_id,
      prepared: o.qty_prepared,
      sold: o.qty_sold,
      remaining: o.qty_remaining,
      discarded: o.qty_discarded,
    })),
    // latest stored forecast per (date, item), last 14 days
    pastForecasts: (
      await db.all<{ target_date: string; menu_item_id: number; forecast_mean: number }>(
        `SELECT f.target_date, f.menu_item_id, f.forecast_mean FROM forecast_snapshots f
         WHERE f.outlet_id = ? AND f.forecast_mean IS NOT NULL AND f.target_date >= ? AND f.target_date < ?
           AND f.id = (SELECT MAX(id) FROM forecast_snapshots g WHERE g.outlet_id = f.outlet_id AND g.target_date = f.target_date AND g.menu_item_id = f.menu_item_id)`,
        [outlet.id, new Date(Date.parse(today) - 14 * 86400000).toISOString().slice(0, 10), today],
      )
    ).map((f) => ({ date: f.target_date, menuItemId: f.menu_item_id, mean: f.forecast_mean })),
  };
}
