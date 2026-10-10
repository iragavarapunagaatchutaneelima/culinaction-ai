import { Router } from 'express';
import { addDays } from '../../shared/dates';
import {
  comparePrepOutcome,
  forecastError,
  summariseWaste,
  wastePer100,
  type ForecastPair,
  type OutcomeRow,
  type WasteRow,
} from '../../shared/metrics';
import type { AiProvider } from '../ai/provider';
import { requireRole } from '../auth';
import { badRequest } from '../http';
import { outletToday, type Deps } from '../services';
import { ingredientSummaries } from './inventory';
import { costing } from './menu';
import { runDto } from './decisions';
import { outletDto } from './outlets';

const ISO = /^\d{4}-\d{2}-\d{2}$/;

export function insightRoutes({ db, now, ai }: Deps & { ai: AiProvider }) {
  const r = Router({ mergeParams: true });
  const anyRole = requireRole('owner', 'manager', 'staff');
  const editors = requireRole('owner', 'manager');

  r.get('/dashboard', anyRole, async (req, res) => {
    const o = req.outlet!;
    const today = outletToday(o, now());
    const count = async (sql: string, params: (string | number)[] = [o.id]) =>
      (await db.get<{ n: number }>(sql, params))!.n;
    const ings = await ingredientSummaries(db, o, now());
    const salesDays = await count(
      'SELECT COUNT(DISTINCT sale_date) AS n FROM sales_records WHERE outlet_id = ?',
    );
    const checklist = [
      { key: 'outlet', label: 'Create outlet profile', done: true, to: 'settings' },
      {
        key: 'ingredients',
        label: 'Add ingredients with current stock',
        done: ings.some((i) => i.batchCount > 0),
        to: 'inventory',
      },
      {
        key: 'costs',
        label: 'Record purchase costs for stock',
        done: ings.some((i) => i.unitCostPaise !== null),
        to: 'inventory',
      },
      {
        key: 'menu',
        label: 'Add menu items',
        done: (await count('SELECT COUNT(*) AS n FROM menu_items WHERE outlet_id = ?')) > 0,
        to: 'menu',
      },
      {
        key: 'recipes',
        label: 'Enter and verify at least one recipe',
        done:
          (await count(
            'SELECT COUNT(*) AS n FROM recipes r JOIN menu_items m ON m.id = r.menu_item_id WHERE m.outlet_id = ? AND r.verified = 1',
          )) > 0,
        to: 'menu',
      },
      {
        key: 'sales',
        label: 'Record at least 7 days of sales',
        done: salesDays >= 7,
        detail: `${salesDays} day(s) recorded`,
        to: 'sales',
      },
      {
        key: 'run',
        label: 'Run the decision engine',
        done: (await count('SELECT COUNT(*) AS n FROM recommendation_runs WHERE outlet_id = ?')) > 0,
        to: 'recommendations',
      },
      {
        key: 'plan',
        label: 'Approve an action plan',
        done:
          (await count(
            "SELECT COUNT(*) AS n FROM action_plans WHERE outlet_id = ? AND status IN ('approved','completed')",
          )) > 0,
        to: 'plans',
      },
      {
        key: 'outcome',
        label: 'Record a service outcome',
        done: (await count('SELECT COUNT(*) AS n FROM service_outcomes WHERE outlet_id = ?')) > 0,
        to: 'outcomes',
      },
    ];
    const latestRun = await db.get<{ id: number }>(
      'SELECT id FROM recommendation_runs WHERE outlet_id = ? ORDER BY id DESC LIMIT 1',
      [o.id],
    );
    const run = latestRun ? await runDto(db, latestRun.id) : null;
    const lastOutcomeDate = (await db.get<{ d: string | null }>(
      'SELECT MAX(business_date) AS d FROM service_outcomes WHERE outlet_id = ?',
      [o.id],
    ))!.d;
    const lastService = lastOutcomeDate
      ? await db.get<{ items: number; prepared: number; sold: number; remaining: number; discarded: number }>(
          'SELECT COUNT(*) AS items, SUM(qty_prepared) AS prepared, SUM(qty_sold) AS sold, SUM(qty_remaining) AS remaining, SUM(qty_discarded) AS discarded FROM service_outcomes WHERE outlet_id = ? AND business_date = ?',
          [o.id, lastOutcomeDate],
        )
      : null;
    const pick = (f: (i: (typeof ings)[0]) => boolean) =>
      ings
        .filter(f)
        .map((i) => ({ id: i.id, name: i.name, usableLabel: i.usableLabel, nearestDate: i.nearestDate }));
    res.json({
      outlet: outletDto(o, req.role),
      today,
      checklist,
      stock: {
        ingredientCount: ings.length,
        unsafe: pick((i) => i.flags.unsafe),
        verify: pick((i) => i.flags.verify),
        expiring: pick((i) => i.flags.expiring),
        outOfStockInRecipes: pick((i) => i.flags.outOfStock && i.usedInMenuItems > 0),
        costMissing: pick((i) => i.costMissing),
      },
      run: run && {
        id: run.id,
        planDate: run.planDate,
        createdAt: run.createdAt,
        changesSinceRun: run.changesSinceRun,
        summary: run.summary,
        top: run.items
          .filter((i) => i.severityTier <= 3)
          .slice(0, 4)
          .map((i) => ({
            id: i.id,
            title: i.title,
            kind: i.kind,
            tier: i.severityTier,
            confidence: i.confidence,
            impactPaise: i.estimatedImpactPaise,
            impactLabel: i.impactLabel,
          })),
        stockouts: run.items
          .filter((i) => i.kind === 'stockout_risk')
          .map((i) => ({ id: i.id, title: i.title })),
        gaps: run.items.filter((i) => i.kind === 'data_gap').map((i) => ({ id: i.id, title: i.title })),
      },
      approvals: await db.all(
        "SELECT id, title, plan_date AS planDate, submitted_at AS submittedAt FROM action_plans WHERE outlet_id = ? AND status = 'awaiting_approval' ORDER BY submitted_at",
        [o.id],
      ),
      drafts: await count("SELECT COUNT(*) AS n FROM action_plans WHERE outlet_id = ? AND status = 'draft'"),
      tasks: {
        open: await count("SELECT COUNT(*) AS n FROM tasks WHERE outlet_id = ? AND status = 'open'"),
        dueToday: await count(
          "SELECT COUNT(*) AS n FROM tasks WHERE outlet_id = ? AND status = 'open' AND due_date = ?",
          [o.id, today],
        ),
        overdue: await count(
          "SELECT COUNT(*) AS n FROM tasks WHERE outlet_id = ? AND status = 'open' AND due_date < ?",
          [o.id, today],
        ),
      },
      lastService: lastService && { date: lastOutcomeDate, ...lastService },
      salesHistory: {
        days: salesDays,
        last: (await db.get<{ d: string | null }>(
          'SELECT MAX(sale_date) AS d FROM sales_records WHERE outlet_id = ?',
          [o.id],
        ))!.d,
      },
    });
  });

  r.get('/analytics', anyRole, async (req, res) => {
    const o = req.outlet!;
    const today = outletToday(o, now());
    const from = String(req.query.from || addDays(today, -27));
    const to = String(req.query.to || today);
    if (!ISO.test(from) || !ISO.test(to) || from > to) throw badRequest('Invalid date range');

    const waste = (
      await db.all<{
        business_date: string;
        subject_type: 'ingredient' | 'menu_item';
        menu_item_id: number | null;
        ingredient_id: number | null;
        name: string;
        qty: number;
        unit: string;
        reason: string;
        cost_paise: number | null;
        cost_basis: 'batch_cost' | 'recipe_estimate' | null;
      }>(
        `SELECT w.*, COALESCE(i.name, m.name) AS name FROM waste_logs w LEFT JOIN ingredients i ON i.id = w.ingredient_id LEFT JOIN menu_items m ON m.id = w.menu_item_id
         WHERE w.outlet_id = ? AND w.business_date BETWEEN ? AND ?`,
        [o.id, from, to],
      )
    ).map<WasteRow>((w) => ({
      date: w.business_date,
      subjectType: w.subject_type,
      menuItemId: w.menu_item_id,
      ingredientId: w.ingredient_id,
      name: w.name,
      qty: w.qty,
      unit: w.unit,
      reason: w.reason,
      costPaise: w.cost_paise,
      costBasis: w.cost_basis,
    }));
    const wasteSummary = summariseWaste(waste);

    const salesByDay = await db.all<{ date: string; portions: number }>(
      'SELECT sale_date AS date, SUM(qty) AS portions FROM sales_records WHERE outlet_id = ? AND sale_date BETWEEN ? AND ? GROUP BY sale_date ORDER BY sale_date',
      [o.id, from, to],
    );
    const portionsSold = salesByDay.reduce((a, d) => a + d.portions, 0);

    // Forecast vs actual: latest stored forecast per (date, item) on trading days within range
    const pairs = await db.all<ForecastPair>(
      `SELECT f.target_date AS date, f.menu_item_id AS menuItemId, m.name, f.forecast_mean AS forecast,
              COALESCE((SELECT SUM(s.qty) FROM sales_records s WHERE s.outlet_id = f.outlet_id AND s.sale_date = f.target_date AND s.menu_item_id = f.menu_item_id), 0) AS actual
       FROM forecast_snapshots f JOIN menu_items m ON m.id = f.menu_item_id
       WHERE f.outlet_id = ? AND f.forecast_mean IS NOT NULL AND f.target_date BETWEEN ? AND ? AND f.target_date < ?
         AND f.id = (SELECT MAX(id) FROM forecast_snapshots g WHERE g.outlet_id = f.outlet_id AND g.target_date = f.target_date AND g.menu_item_id = f.menu_item_id)
         AND EXISTS (SELECT 1 FROM sales_records s2 WHERE s2.outlet_id = f.outlet_id AND s2.sale_date = f.target_date)
       ORDER BY f.target_date DESC, m.name`,
      [o.id, from, to, today],
    );

    const planCounts = await db.all<{ status: string; n: number }>(
      'SELECT status, COUNT(*) AS n FROM action_plans WHERE outlet_id = ? AND plan_date BETWEEN ? AND ? GROUP BY status',
      [o.id, from, to],
    );
    const taskCounts = await db.all<{ status: string; n: number }>(
      'SELECT status, COUNT(*) AS n FROM tasks WHERE outlet_id = ? AND due_date BETWEEN ? AND ? GROUP BY status',
      [o.id, from, to],
    );
    const approvedImpact = (await db.get<{ total: number | null; n: number; unknown: number }>(
      `SELECT SUM(i.estimated_impact_paise) AS total, COUNT(*) AS n, SUM(i.estimated_impact_paise IS NULL) AS unknown FROM recommendation_items i
       WHERE i.id IN (SELECT DISTINCT pl.rec_item_id FROM plan_lines pl JOIN action_plans p ON p.id = pl.plan_id
                      WHERE p.outlet_id = ? AND p.status IN ('approved','completed') AND p.plan_date BETWEEN ? AND ?)`,
      [o.id, from, to],
    ))!;

    // Measured outcomes of completed prep tasks
    const outcomes = (
      await db.all<{
        business_date: string;
        menu_item_id: number;
        qty_prepared: number;
        qty_sold: number;
        qty_remaining: number;
        qty_discarded: number;
      }>('SELECT * FROM service_outcomes WHERE outlet_id = ?', [o.id])
    ).map<OutcomeRow>((x) => ({
      date: x.business_date,
      menuItemId: x.menu_item_id,
      prepared: x.qty_prepared,
      sold: x.qty_sold,
      remaining: x.qty_remaining,
      discarded: x.qty_discarded,
    }));
    const prepTasks = await db.all<{
      id: number;
      due_date: string;
      subject_id: number;
      subject_name: string;
      approved_qty: number | null;
    }>(
      `SELECT t.id, t.due_date, pl.subject_id, pl.subject_name, pl.approved_qty FROM tasks t JOIN plan_lines pl ON pl.id = t.plan_line_id
       WHERE t.outlet_id = ? AND t.status = 'done' AND pl.line_type = 'prep' AND t.due_date BETWEEN ? AND ? ORDER BY t.due_date DESC`,
      [o.id, from, to],
    );
    const cost = await costing(db, o, now());
    const comparisons = prepTasks.map((t) => ({
      taskId: t.id,
      name: t.subject_name,
      date: t.due_date,
      result: comparePrepOutcome(
        {
          taskId: t.id,
          planDate: t.due_date,
          menuItemId: t.subject_id,
          name: t.subject_name,
          plannedQty: t.approved_qty ?? 0,
        },
        outcomes,
        cost.perPortion(t.subject_id),
      ),
    }));

    res.json({
      from,
      to,
      today,
      waste: wasteSummary,
      sales: { portionsSold, days: salesByDay.length, byDay: salesByDay },
      wastePer100Portions: {
        value: wastePer100(wasteSummary.discardedPortions, portionsSold),
        discardedPortions: wasteSummary.discardedPortions,
        portionsSold,
      },
      forecastError: { ...forecastError(pairs), recent: pairs.slice(0, 15) },
      actions: {
        plans: Object.fromEntries(planCounts.map((p) => [p.status, p.n])),
        tasks: Object.fromEntries(taskCounts.map((t) => [t.status, t.n])),
      },
      estimatedImpactOfApprovedRecommendations: {
        totalPaise: approvedImpact.total,
        recommendations: approvedImpact.n,
        withoutEstimate: approvedImpact.unknown ?? 0,
      },
      prepComparisons: comparisons,
    });
  });

  r.get('/ai/status', anyRole, async (_req, res) => {
    const last = await db.get(
      'SELECT provider, model, last_checked_at AS lastCheckedAt, last_result AS lastResult, last_error AS lastError FROM provider_status WHERE id = 1',
    );
    res.json({ ...ai.status(), last: last ?? null });
  });

  r.get('/audit', editors, async (req, res) => {
    res.json(
      await db.all(
        `SELECT a.id, a.entity_type AS entityType, a.entity_id AS entityId, a.action, a.details_json AS details, a.created_at AS createdAt, u.display_name AS userName
         FROM audit_events a LEFT JOIN users u ON u.id = a.user_id WHERE a.outlet_id = ? ORDER BY a.id DESC LIMIT 300`,
        [req.outlet!.id],
      ),
    );
  });

  r.get('/export/all.json', editors, async (req, res) => {
    const id = req.outlet!.id;
    const q = async (sql: string) => await db.all(sql, [id]);
    const data = {
      exportedAt: now().toISOString(),
      note: req.outlet!.is_illustrative
        ? 'ILLUSTRATIVE WORKSPACE — sample data, not a real restaurant.'
        : 'Records entered or imported by this outlet.',
      outlet: outletDto(req.outlet!),
      ingredients: await q('SELECT * FROM ingredients WHERE outlet_id = ?'),
      batches: await q('SELECT * FROM inventory_batches WHERE outlet_id = ?'),
      stockMovements: await q('SELECT * FROM stock_movements WHERE outlet_id = ?'),
      menuItems: await q('SELECT * FROM menu_items WHERE outlet_id = ?'),
      recipes: await q(
        'SELECT r.* FROM recipes r JOIN menu_items m ON m.id = r.menu_item_id WHERE m.outlet_id = ?',
      ),
      recipeIngredients: await q(
        'SELECT ri.* FROM recipe_ingredients ri JOIN recipes r ON r.id = ri.recipe_id JOIN menu_items m ON m.id = r.menu_item_id WHERE m.outlet_id = ?',
      ),
      sales: await q('SELECT * FROM sales_records WHERE outlet_id = ?'),
      wasteLogs: await q('SELECT * FROM waste_logs WHERE outlet_id = ?'),
      serviceOutcomes: await q('SELECT * FROM service_outcomes WHERE outlet_id = ?'),
      actionPlans: await q('SELECT * FROM action_plans WHERE outlet_id = ?'),
      planLines: await q(
        'SELECT pl.* FROM plan_lines pl JOIN action_plans p ON p.id = pl.plan_id WHERE p.outlet_id = ?',
      ),
      tasks: await q('SELECT * FROM tasks WHERE outlet_id = ?'),
      approvalHistory: await q(
        'SELECT h.* FROM approval_history h JOIN action_plans p ON p.id = h.plan_id WHERE p.outlet_id = ?',
      ),
      auditEvents: await q('SELECT * FROM audit_events WHERE outlet_id = ?'),
    };
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="culinaction-export-${outletToday(req.outlet!, now())}.json"`,
    );
    res.json(data);
  });

  return r;
}
