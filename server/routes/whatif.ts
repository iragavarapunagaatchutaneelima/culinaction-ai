import { Router } from 'express';
import { z } from 'zod';
import { addDays } from '../../shared/dates';
import { dailyUseOf, prepInputs } from '../../shared/engine';
import { METHOD_LABELS } from '../../shared/forecast';
import { simulatePrep, simulatePurchase } from '../../shared/whatIf';
import { toBase, unitsCompatible } from '../../shared/units';
import { requireRole } from '../auth';
import { badRequest, notFound, parse } from '../http';
import { loadSnapshot, outletToday, type Deps } from '../services';
import { isoDate, unitCode } from '../validation';

/** What-if simulator: read-only calculations over current records. Nothing is saved. */
export function whatIfRoutes({ db, now }: Deps) {
  const r = Router({ mergeParams: true });
  const anyRole = requireRole('owner', 'manager', 'staff');

  r.post('/whatif/prep', anyRole, async (req, res) => {
    const b = parse(
      z.object({
        menuItemId: z.number().int().positive(),
        date: isoDate.optional(),
        portions: z.array(z.coerce.number().int().min(0).max(5000)).min(1).max(6),
      }),
      req.body,
    );
    const today = outletToday(req.outlet!, now());
    const date = b.date ?? today;
    if (date < today || date > addDays(today, 7))
      throw badRequest('Date must be between today and 7 days ahead.');
    const snap = await loadSnapshot(db, req.outlet!, date, now());
    const inp = prepInputs(snap, b.menuItemId);
    if (!inp.ok) throw badRequest(inp.reason);
    const fc = inp.forecast;
    res.json({
      date,
      item: { id: inp.item.id, name: inp.item.name, pricePaise: inp.item.pricePaise },
      forecast: {
        method: fc.method,
        methodLabel: METHOD_LABELS[fc.method],
        mean: fc.mean,
        min: fc.min,
        max: fc.max,
        daysUsed: fc.daysUsed,
        values: fc.values,
        explanation: fc.explanation,
      },
      suggestions: fc.mean === null ? [] : [Math.ceil(fc.mean), Math.ceil(fc.max!)],
      scenarios: b.portions.map((p) => simulatePrep(p, inp.ingredients, fc, inp.item.pricePaise)),
      method:
        'Ingredient use = portions × verified recipe quantity (incl. prep loss). Remaining = usable stock − this dish − forecast use by other dishes. History replay = the quantity compared with each comparable day’s recorded sales.',
    });
  });

  r.post('/whatif/purchase', anyRole, async (req, res) => {
    const b = parse(
      z.object({
        ingredientId: z.number().int().positive(),
        qty: z.coerce.number().positive().max(10_000_000),
        unit: unitCode,
        useByDays: z.coerce
          .number()
          .int()
          .min(0)
          .max(365)
          .nullish()
          .transform((v) => v ?? null),
      }),
      req.body,
    );
    const snap = await loadSnapshot(db, req.outlet!, outletToday(req.outlet!, now()), now());
    const d = dailyUseOf(snap, b.ingredientId);
    if (!d) throw notFound('Ingredient');
    if (!unitsCompatible(b.unit, d.baseUnit))
      throw badRequest(`${d.name} is measured in ${d.baseUnit}; "${b.unit}" cannot be converted.`, {
        fields: { unit: 'Incompatible unit' },
      });
    const qtyBase = toBase(b.qty, b.unit, d.baseUnit as 'g');
    res.json({
      ingredient: {
        id: b.ingredientId,
        name: d.name,
        baseUnit: d.baseUnit,
        usableQty: d.usableQty,
        dailyUse: d.dailyUse,
        unitCostPaise: d.unitCostPaise,
      },
      purchaseQtyBase: qtyBase,
      result: simulatePurchase({
        usableQty: d.usableQty,
        dailyUse: d.dailyUse,
        purchaseQty: qtyBase,
        useByDays: b.useByDays,
        unitCostPaise: d.unitCostPaise,
        targetCoverDays: req.outlet!.excess_cover_days,
      }),
      targetCoverDays: req.outlet!.excess_cover_days,
    });
  });

  return r;
}
