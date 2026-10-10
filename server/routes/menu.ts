import { Router } from 'express';
import { z } from 'zod';
import { ingredientState } from '../../shared/engine';
import { roundPaise } from '../../shared/money';
import { roundQty, toBase, unitsCompatible } from '../../shared/units';
import { requireRole } from '../auth';
import type { Db } from '../db/database';
import { badRequest, idParam, notFound, parse } from '../http';
import { audit, iso, loadIngredientSnaps, outletToday, type Deps } from '../services';
import { optText, positiveQty, reqText, rupees, unitCode } from '../validation';

interface MenuRow {
  id: number;
  name: string;
  category: string;
  price_paise: number | null;
  allergens: string | null;
  allergens_verified: number;
  active: number;
  handling_class: string | null;
  handling_max_hold_min: number | null;
  handling_verified: number;
  created_at: string;
  updated_at: string;
  recipe_id: number | null;
  yield_portions: number | null;
  recipe_notes: string | null;
  verified: number | null;
  verified_at: string | null;
  verified_by_name: string | null;
  recipe_updated_at: string | null;
}

const itemSchema = z
  .object({
    name: reqText(80, 'Menu item name'),
    category: reqText(40, 'Category'),
    priceInr: rupees,
    allergens: optText(200),
    allergensVerified: z.boolean().default(false),
    active: z.boolean().default(true),
    // blank form fields mean "not specified"
    handlingClass: z.preprocess(
      (v) => (v === '' ? null : v),
      z.enum(['hot', 'cold', 'ambient', 'frozen']).nullable().default(null),
    ),
    handlingMaxHoldMin: z.preprocess(
      (v) => (v === '' || v === undefined ? null : v),
      z.coerce.number().int().min(1, 'At least 1 minute').max(1440).nullable(),
    ),
    handlingVerified: z.boolean().default(false),
  })
  .refine((v) => !v.handlingVerified || (v.handlingClass && v.handlingMaxHoldMin), {
    message: 'Enter the handling type and maximum holding time before marking them verified',
    path: ['handlingVerified'],
  });

const recipeSchema = z.object({
  yieldPortions: z.coerce
    .number()
    .positive()
    .max(10000)
    .nullish()
    .transform((v) => v ?? null),
  notes: optText(500),
  verified: z.boolean(),
  lines: z
    .array(
      z.object({
        ingredientId: z.number().int().positive(),
        qty: positiveQty,
        unit: unitCode,
        lossPct: z.coerce.number().min(0, 'Cannot be negative').max(99, 'Must be below 100').default(0),
      }),
    )
    .max(40, 'At most 40 ingredients'),
});

/** Cost per portion and per-line costing, computed from current usable stock costs. */
export async function costing(
  db: Db,
  outlet: { id: number; timezone: string; expiry_warn_days: number },
  now: Date,
) {
  const today = outletToday(outlet as never, now);
  const states = new Map(
    (await loadIngredientSnaps(db, outlet.id)).map((s) => [
      s.id,
      ingredientState(s, today, outlet.expiry_warn_days),
    ]),
  );
  const lines = await db.all<{
    menu_item_id: number;
    ingredient_id: number;
    qty: number;
    unit: string;
    loss_pct: number;
    name: string;
    base_unit: string;
  }>(
    `SELECT r.menu_item_id, ri.ingredient_id, ri.qty, ri.unit, ri.loss_pct, i.name, i.base_unit FROM recipe_ingredients ri
     JOIN recipes r ON r.id = ri.recipe_id JOIN menu_items m ON m.id = r.menu_item_id JOIN ingredients i ON i.id = ri.ingredient_id
     WHERE m.outlet_id = ? ORDER BY ri.id`,
    [outlet.id],
  );
  const byItem = new Map<number, ReturnType<typeof lineCost>[]>();
  function lineCost(l: (typeof lines)[0]) {
    const st = states.get(l.ingredient_id);
    let grossBase: number | null = null;
    let error: string | null = null;
    try {
      grossBase = roundQty(toBase(l.qty, l.unit, l.base_unit as never) / (1 - l.loss_pct / 100));
    } catch (e) {
      error = (e as Error).message;
    }
    const unitCost = st?.unitCostPaise ?? null;
    return {
      ingredientId: l.ingredient_id,
      ingredientName: l.name,
      baseUnit: l.base_unit,
      qty: l.qty,
      unit: l.unit,
      lossPct: l.loss_pct,
      grossBase,
      unitCostPaise: unitCost,
      lineCostPaise: grossBase !== null && unitCost !== null ? roundPaise(grossBase * unitCost) : null,
      usableQty: st?.usableQty ?? 0,
      error,
    };
  }
  for (const l of lines) {
    const arr = byItem.get(l.menu_item_id) ?? [];
    arr.push(lineCost(l));
    byItem.set(l.menu_item_id, arr);
  }
  const perPortion = (itemId: number): number | null => {
    const ls = byItem.get(itemId);
    if (!ls?.length || ls.some((l) => l.lineCostPaise === null)) return null;
    return ls.reduce((a, l) => a + l.lineCostPaise!, 0);
  };
  return { byItem, perPortion };
}

export function menuRoutes({ db, now }: Deps) {
  const r = Router({ mergeParams: true });
  const editors = requireRole('owner', 'manager');
  const anyRole = requireRole('owner', 'manager', 'staff');

  const rows = async (outletId: number, id?: number) =>
    await db.all<MenuRow>(
      `SELECT m.*, r.id AS recipe_id, r.yield_portions, r.notes AS recipe_notes, r.verified, r.verified_at, u.display_name AS verified_by_name, r.updated_at AS recipe_updated_at
       FROM menu_items m LEFT JOIN recipes r ON r.menu_item_id = m.id LEFT JOIN users u ON u.id = r.verified_by
       WHERE m.outlet_id = ? ${id ? 'AND m.id = ?' : ''} ORDER BY m.category, m.name`,
      id ? [outletId, id] : [outletId],
    );

  function dto(m: MenuRow, cost: Awaited<ReturnType<typeof costing>>) {
    const lines = cost.byItem.get(m.id) ?? [];
    const cpp = cost.perPortion(m.id);
    return {
      id: m.id,
      name: m.name,
      category: m.category,
      pricePaise: m.price_paise,
      allergens: m.allergens,
      allergensVerified: !!m.allergens_verified,
      handlingClass: m.handling_class,
      handlingMaxHoldMin: m.handling_max_hold_min,
      handlingVerified: !!m.handling_verified,
      active: !!m.active,
      updatedAt: m.updated_at,
      recipe: {
        exists: lines.length > 0,
        lineCount: lines.length,
        verified: !!m.verified,
        verifiedAt: m.verified_at,
        verifiedBy: m.verified_by_name,
        yieldPortions: m.yield_portions,
        notes: m.recipe_notes,
        updatedAt: m.recipe_updated_at,
        invalidLines: lines.filter((l) => l.error).length,
      },
      costPerPortionPaise: cpp,
      costMissingFor: lines.filter((l) => l.unitCostPaise === null).map((l) => l.ingredientName),
      foodCostPct: cpp !== null && m.price_paise ? Math.round((cpp / m.price_paise) * 1000) / 10 : null,
    };
  }

  r.get('/menu-items', anyRole, async (req, res) => {
    const cost = await costing(db, req.outlet!, now());
    res.json((await rows(req.outlet!.id)).map((m) => dto(m, cost)));
  });

  r.get('/menu-items/:id', anyRole, async (req, res) => {
    const id = idParam(req, 'id');
    const m = (await rows(req.outlet!.id, id))[0];
    if (!m) throw notFound('Menu item');
    const cost = await costing(db, req.outlet!, now());
    const lines = cost.byItem.get(id) ?? [];
    // Which other dishes share each ingredient
    const shared = await db.all<{ ingredient_id: number; id: number; name: string }>(
      `SELECT ri.ingredient_id, m.id, m.name FROM recipe_ingredients ri JOIN recipes r ON r.id = ri.recipe_id JOIN menu_items m ON m.id = r.menu_item_id
       WHERE m.outlet_id = ? AND m.id != ? AND ri.ingredient_id IN (SELECT ingredient_id FROM recipe_ingredients ri2 JOIN recipes r2 ON r2.id = ri2.recipe_id WHERE r2.menu_item_id = ?)`,
      [req.outlet!.id, id, id],
    );
    res.json({
      ...dto(m, cost),
      lines: lines.map((l) => ({
        ...l,
        sharedWith: shared
          .filter((s) => s.ingredient_id === l.ingredientId)
          .map((s) => ({ id: s.id, name: s.name })),
      })),
    });
  });

  r.post('/menu-items', editors, async (req, res) => {
    const b = parse(itemSchema, req.body);
    const ts = iso(now());
    const id = await db.tx(async () => {
      const { lastId } = await db.run(
        'INSERT INTO menu_items (outlet_id, name, category, price_paise, allergens, allergens_verified, active, handling_class, handling_max_hold_min, handling_verified, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
        [
          req.outlet!.id,
          b.name,
          b.category,
          b.priceInr,
          b.allergens,
          b.allergensVerified ? 1 : 0,
          b.active ? 1 : 0,
          b.handlingClass,
          b.handlingMaxHoldMin,
          b.handlingVerified ? 1 : 0,
          ts,
          ts,
        ],
      );
      await db.run('INSERT INTO recipes (menu_item_id, verified, updated_at) VALUES (?,0,?)', [lastId, ts]);
      await audit(
        db,
        {
          outletId: req.outlet!.id,
          userId: req.user!.id,
          entityType: 'menu_item',
          entityId: lastId,
          action: 'create',
          details: b,
        },
        now(),
      );
      return lastId;
    });
    res.status(201).json(dto((await rows(req.outlet!.id, id))[0], await costing(db, req.outlet!, now())));
  });

  r.put('/menu-items/:id', editors, async (req, res) => {
    const id = idParam(req, 'id');
    const before = (await rows(req.outlet!.id, id))[0];
    if (!before) throw notFound('Menu item');
    const b = parse(itemSchema, req.body);
    await db.tx(async () => {
      await db.run(
        'UPDATE menu_items SET name=?, category=?, price_paise=?, allergens=?, allergens_verified=?, active=?, handling_class=?, handling_max_hold_min=?, handling_verified=?, updated_at=? WHERE id=?',
        [
          b.name,
          b.category,
          b.priceInr,
          b.allergens,
          b.allergensVerified ? 1 : 0,
          b.active ? 1 : 0,
          b.handlingClass,
          b.handlingMaxHoldMin,
          b.handlingVerified ? 1 : 0,
          iso(now()),
          id,
        ],
      );
      await audit(
        db,
        {
          outletId: req.outlet!.id,
          userId: req.user!.id,
          entityType: 'menu_item',
          entityId: id,
          action: 'update',
          details: { before, after: b },
        },
        now(),
      );
    });
    res.json(dto((await rows(req.outlet!.id, id))[0], await costing(db, req.outlet!, now())));
  });

  r.put('/menu-items/:id/recipe', editors, async (req, res) => {
    const id = idParam(req, 'id');
    const item = (await rows(req.outlet!.id, id))[0];
    if (!item) throw notFound('Menu item');
    const b = parse(recipeSchema, req.body);
    const fields: Record<string, string> = {};
    const seen = new Set<number>();
    for (const [i, l] of b.lines.entries()) {
      const ing = await db.get<{ base_unit: string; name: string }>(
        'SELECT base_unit, name FROM ingredients WHERE id = ? AND outlet_id = ?',
        [l.ingredientId, req.outlet!.id],
      );
      if (!ing) fields[`lines.${i}.ingredientId`] = 'Unknown ingredient';
      else if (!unitsCompatible(l.unit, ing.base_unit))
        fields[`lines.${i}.unit`] =
          `${ing.name} is measured in ${ing.base_unit}; "${l.unit}" cannot be converted`;
      if (seen.has(l.ingredientId)) fields[`lines.${i}.ingredientId`] = 'Ingredient listed twice';
      seen.add(l.ingredientId);
    }
    if (Object.keys(fields).length) throw badRequest('Some recipe lines are invalid.', { fields });
    if (b.verified && b.lines.length === 0)
      throw badRequest('A recipe with no ingredients cannot be marked verified.', {
        fields: { verified: 'Add ingredients first' },
      });
    const ts = iso(now());
    await db.tx(async () => {
      let recipeId = item.recipe_id;
      if (!recipeId)
        recipeId = (
          await db.run('INSERT INTO recipes (menu_item_id, verified, updated_at) VALUES (?,0,?)', [id, ts])
        ).lastId;
      const beforeLines = await db.all(
        'SELECT ingredient_id, qty, unit, loss_pct FROM recipe_ingredients WHERE recipe_id = ?',
        [recipeId],
      );
      await db.run('DELETE FROM recipe_ingredients WHERE recipe_id = ?', [recipeId]);
      for (const l of b.lines)
        await db.run(
          'INSERT INTO recipe_ingredients (recipe_id, ingredient_id, qty, unit, loss_pct) VALUES (?,?,?,?,?)',
          [recipeId, l.ingredientId, l.qty, l.unit, l.lossPct],
        );
      await db.run(
        'UPDATE recipes SET yield_portions=?, notes=?, verified=?, verified_by=?, verified_at=?, updated_at=? WHERE id=?',
        [
          b.yieldPortions,
          b.notes,
          b.verified ? 1 : 0,
          b.verified ? req.user!.id : null,
          b.verified ? ts : null,
          ts,
          recipeId,
        ],
      );
      await audit(
        db,
        {
          outletId: req.outlet!.id,
          userId: req.user!.id,
          entityType: 'recipe',
          entityId: recipeId,
          action: 'update',
          details: { menuItemId: id, before: beforeLines, after: b },
        },
        now(),
      );
    });
    res.json(dto((await rows(req.outlet!.id, id))[0], await costing(db, req.outlet!, now())));
  });

  return r;
}
