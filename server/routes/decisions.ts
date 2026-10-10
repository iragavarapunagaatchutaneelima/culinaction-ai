import { Router } from 'express';
import { z } from 'zod';
import { addDays, formatDate } from '../../shared/dates';
import { ENGINE_VERSION, runEngine } from '../../shared/engine';
import { canApprove, nextStatus, type PlanAction, type PlanStatus } from '../../shared/planState';
import { ruleBasedExplanation } from '../../shared/explain';
import type { PlanLineDraft, Recommendation } from '../../shared/types';
import { formatQty, roundQty, toBase, type BaseUnit } from '../../shared/units';
import type { AiProvider } from '../ai/provider';
import { requireRole, type OutletRow } from '../auth';
import type { Db } from '../db/database';
import { badRequest, conflict, forbidden, idParam, notFound, parse } from '../http';
import {
  audit,
  countIngredient,
  deductFromBatch,
  getBatch,
  getIngredient,
  iso,
  loadSnapshot,
  insertMany,
  outletToday,
  type Deps,
} from '../services';
import { isoDate, optText } from '../validation';
import { recordMenuItemWaste } from './operations';

interface PlanRow {
  id: number;
  outlet_id: number;
  run_id: number | null;
  title: string;
  plan_date: string;
  status: PlanStatus;
  created_by: number | null;
  decided_by: number | null;
  decided_at: string | null;
  rejection_reason: string | null;
  cancel_reason: string | null;
  submitted_at: string | null;
  completed_at: string | null;
  created_at: string;
  updated_at: string;
}

interface LineRow {
  id: number;
  plan_id: number;
  rec_item_id: number | null;
  rec_title: string | null;
  option_key: string | null;
  option_label: string | null;
  line_type: PlanLineDraft['type'];
  subject_type: PlanLineDraft['subjectType'];
  subject_id: number;
  subject_name: string;
  proposed_qty: number | null;
  approved_qty: number | null;
  unit: string | null;
  note: string | null;
  estimated_cost_paise: number | null;
  estimated_impact_paise: number | null;
  original_json: string;
}

interface TaskRow {
  id: number;
  plan_id: number;
  plan_line_id: number;
  due_date: string;
  title: string;
  status: 'open' | 'done' | 'skipped' | 'cancelled';
  target_qty: number | null;
  unit: string | null;
  actual_qty: number | null;
  notes: string | null;
  completed_by: number | null;
  completed_at: string | null;
}

const qtyLabel = (qty: number | null, unit: string | null) =>
  qty === null
    ? ''
    : unit === 'g' || unit === 'ml' || unit === 'pc'
      ? formatQty(qty, unit as BaseUnit)
      : `${qty}${unit ? ` ${unit}` : ''}`;

function taskTitle(l: LineRow, qty: number | null): string {
  const q = qtyLabel(qty, l.unit);
  switch (l.line_type) {
    case 'prep':
      return `Prepare ${qty ?? '?'} × ${l.subject_name}`;
    case 'purchase':
      return `Buy ${q} of ${l.subject_name}`;
    case 'reduce_purchase':
      return `Reduce next order of ${l.subject_name} by ${q}`;
    case 'discard':
      return `Remove and record waste: ${l.subject_name} (${q})`;
    case 'count':
      return `Count ${l.subject_name} and record actual quantity`;
    case 'dispose_order':
      return `Dispose of and record food from ${l.subject_name} (${q})`;
    case 'order_action':
      return `${l.subject_name}: ${l.note ?? 'follow up'}`;
    default:
      return `Check: ${l.subject_name}${l.note ? ` — ${l.note}` : ''}`;
  }
}

function lineDto(l: LineRow) {
  return {
    id: l.id,
    recItemId: l.rec_item_id,
    recTitle: l.rec_title,
    optionKey: l.option_key,
    optionLabel: l.option_label,
    type: l.line_type,
    subjectType: l.subject_type,
    subjectId: l.subject_id,
    subjectName: l.subject_name,
    proposedQty: l.proposed_qty,
    approvedQty: l.approved_qty,
    originalQty: (JSON.parse(l.original_json) as PlanLineDraft).qty,
    unit: l.unit,
    qtyLabel: qtyLabel(l.approved_qty ?? l.proposed_qty, l.unit),
    note: l.note,
    estimatedCostPaise: l.estimated_cost_paise,
    estimatedImpactPaise: l.estimated_impact_paise,
  };
}

function itemDto(row: {
  id: number;
  run_id: number;
  position: number;
  payload_json: string;
  ai_status: string | null;
  ai_explanation_json: string | null;
  ai_error: string | null;
  ai_model: string | null;
  ai_generated_at: string | null;
}) {
  const rec = JSON.parse(row.payload_json) as Recommendation;
  return {
    id: row.id,
    runId: row.run_id,
    position: row.position,
    ...rec,
    /** Deterministic summary built only from the engine's own text — always available, never AI. */
    ruleBased: ruleBasedExplanation(rec),
    ai: row.ai_status
      ? {
          status: row.ai_status,
          explanation: row.ai_explanation_json ? JSON.parse(row.ai_explanation_json) : null,
          error: row.ai_error,
          model: row.ai_model,
          generatedAt: row.ai_generated_at,
        }
      : null,
  };
}

export async function runDto(db: Db, runId: number) {
  const run = (await db.get<{
    id: number;
    plan_date: string;
    business_today: string;
    engine_version: string;
    summary_json: string;
    stock_json: string;
    created_at: string;
    user_name: string | null;
    outlet_id: number;
  }>(
    'SELECT r.*, u.display_name AS user_name FROM recommendation_runs r LEFT JOIN users u ON u.id = r.created_by WHERE r.id = ?',
    [runId],
  ))!;
  const items = await db.all<Parameters<typeof itemDto>[0]>(
    'SELECT * FROM recommendation_items WHERE run_id = ? ORDER BY position',
    [runId],
  );
  const forecasts = await db.all(
    `SELECT f.menu_item_id AS menuItemId, m.name, f.method, f.forecast_mean AS mean, f.forecast_min AS min, f.forecast_max AS max, f.days_used AS daysUsed
     FROM forecast_snapshots f JOIN menu_items m ON m.id = f.menu_item_id WHERE f.run_id = ? ORDER BY m.name`,
    [runId],
  );
  // How much has changed since this run (any data edits recorded in the audit log)
  const changes = (await db.get<{ n: number }>(
    `SELECT COUNT(*) AS n FROM audit_events WHERE outlet_id = ? AND created_at > ? AND entity_type NOT IN ('recommendation_run','recommendation_item','plan','task')`,
    [run.outlet_id, run.created_at],
  ))!.n;
  const inPlans = await db.all<{ rec_item_id: number; plan_id: number; status: string }>(
    `SELECT DISTINCT pl.rec_item_id, p.id AS plan_id, p.status FROM plan_lines pl JOIN action_plans p ON p.id = pl.plan_id
     WHERE pl.rec_item_id IN (SELECT id FROM recommendation_items WHERE run_id = ?)`,
    [runId],
  );
  return {
    id: run.id,
    planDate: run.plan_date,
    today: run.business_today,
    engineVersion: run.engine_version,
    summary: JSON.parse(run.summary_json),
    stock: JSON.parse(run.stock_json),
    createdAt: run.created_at,
    createdBy: run.user_name,
    changesSinceRun: changes,
    forecasts,
    items: items.map((i) => ({
      ...itemDto(i),
      plans: inPlans.filter((p) => p.rec_item_id === i.id).map((p) => ({ id: p.plan_id, status: p.status })),
    })),
  };
}

/** Runs the engine on current records and stores the run, its items, forecasts and order risk assessments. */
export async function createRun(
  db: Db,
  outlet: OutletRow,
  userId: number,
  planDate: string,
  now: Date,
): Promise<number> {
  const today = outletToday(outlet, now);
  const result = runEngine(await loadSnapshot(db, outlet, planDate, now));
  const ts = iso(now);
  return db.tx(async () => {
    const { lastId } = await db.run(
      'INSERT INTO recommendation_runs (outlet_id, plan_date, business_today, engine_version, summary_json, stock_json, created_by, created_at) VALUES (?,?,?,?,?,?,?,?)',
      [
        outlet.id,
        planDate,
        today,
        ENGINE_VERSION,
        JSON.stringify(result.summary),
        JSON.stringify(result.stock),
        userId,
        ts,
      ],
    );
    await insertMany(
      db,
      'recommendation_items',
      [
        'run_id',
        'outlet_id',
        'position',
        'rec_key',
        'kind',
        'severity_tier',
        'title',
        'estimated_impact_paise',
        'confidence',
        'payload_json',
      ],
      result.recommendations.map((rec, i) => [
        lastId,
        outlet.id,
        i,
        rec.key,
        rec.kind,
        rec.severityTier,
        rec.title,
        rec.estimatedImpactPaise,
        rec.confidence,
        JSON.stringify(rec),
      ]),
      40,
    );
    await insertMany(
      db,
      'forecast_snapshots',
      [
        'run_id',
        'outlet_id',
        'target_date',
        'menu_item_id',
        'method',
        'forecast_mean',
        'forecast_min',
        'forecast_max',
        'days_used',
        'created_at',
      ],
      result.forecasts.map((f) => [
        lastId,
        outlet.id,
        f.targetDate,
        f.menuItemId,
        f.method,
        f.mean,
        f.min,
        f.max,
        f.daysUsed,
        ts,
      ]),
    );
    await insertMany(
      db,
      'risk_assessments',
      ['outlet_id', 'order_id', 'run_id', 'level', 'factors_json', 'assessed_at'],
      result.orderRisks.map((r) => [
        outlet.id,
        r.orderId,
        lastId,
        r.level,
        JSON.stringify({ factors: r.factors, missing: r.missing }),
        ts,
      ]),
    );
    await audit(
      db,
      {
        outletId: outlet.id,
        userId,
        entityType: 'recommendation_run',
        entityId: lastId,
        action: 'run',
        details: { planDate, count: result.recommendations.length },
      },
      now,
    );
    return lastId;
  });
}

export function decisionRoutes({ db, now, ai }: Deps & { ai: AiProvider }) {
  const r = Router({ mergeParams: true });
  const editors = requireRole('owner', 'manager');
  const anyRole = requireRole('owner', 'manager', 'staff');

  // ---------------- Recommendations ----------------

  r.post('/recommendations/run', editors, async (req, res) => {
    const today = outletToday(req.outlet!, now());
    const b = parse(z.object({ planDate: isoDate.optional() }), req.body ?? {});
    const planDate = b.planDate ?? today;
    if (planDate < today || planDate > addDays(today, 7))
      throw badRequest('Plan date must be between today and 7 days ahead.', {
        fields: { planDate: 'Today to +7 days' },
      });
    const runId = await createRun(db, req.outlet!, req.user!.id, planDate, now());
    res.status(201).json(await runDto(db, runId));
  });

  r.get('/recommendations/latest', anyRole, async (req, res) => {
    const run = await db.get<{ id: number }>(
      'SELECT id FROM recommendation_runs WHERE outlet_id = ? ORDER BY id DESC LIMIT 1',
      [req.outlet!.id],
    );
    res.json(run ? await runDto(db, run.id) : null);
  });

  r.get('/recommendations/runs', anyRole, async (req, res) => {
    res.json(
      (
        await db.all(
          `SELECT r.id, r.plan_date AS planDate, r.created_at AS createdAt, r.summary_json AS summary, u.display_name AS createdBy,
                (SELECT COUNT(*) FROM recommendation_items i WHERE i.run_id = r.id) AS itemCount
         FROM recommendation_runs r LEFT JOIN users u ON u.id = r.created_by WHERE r.outlet_id = ? ORDER BY r.id DESC LIMIT 30`,
          [req.outlet!.id],
        )
      ).map((x) => ({ ...x, summary: JSON.parse(x.summary as string) })),
    );
  });

  r.get('/recommendations/runs/:rid', anyRole, async (req, res) => {
    const rid = idParam(req, 'rid');
    if (
      !(await db.get('SELECT 1 FROM recommendation_runs WHERE id = ? AND outlet_id = ?', [
        rid,
        req.outlet!.id,
      ]))
    )
      throw notFound('Recommendation run');
    res.json(await runDto(db, rid));
  });

  const getItem = async (outletId: number, iid: number) => {
    const row = await db.get<Parameters<typeof itemDto>[0]>(
      'SELECT * FROM recommendation_items WHERE id = ? AND outlet_id = ?',
      [iid, outletId],
    );
    if (!row) throw notFound('Recommendation');
    return row;
  };

  r.get('/recommendations/items/:iid', anyRole, async (req, res) => {
    const row = await getItem(req.outlet!.id, idParam(req, 'iid'));
    const plans = await db.all(
      'SELECT DISTINCT p.id, p.title, p.status FROM plan_lines pl JOIN action_plans p ON p.id = pl.plan_id WHERE pl.rec_item_id = ?',
      [row.id],
    );
    res.json({ ...itemDto(row), plans });
  });

  // Explicit user action only — never called on page render.
  r.post('/recommendations/items/:iid/explain', editors, async (req, res) => {
    const row = await getItem(req.outlet!.id, idParam(req, 'iid'));
    const rec = JSON.parse(row.payload_json) as Recommendation;
    if (req.user!.isDemo) {
      // Demo visitors share the server's AI budget: cap explanation requests per demo session.
      const used = (await db.get<{ n: number }>(
        "SELECT COUNT(*) AS n FROM audit_events WHERE user_id = ? AND action = 'explain'",
        [req.user!.id],
      ))!.n;
      if (used >= 15)
        throw badRequest(
          'The demo limit for AI explanations has been reached. The rule-based summary is still available.',
        );
    }
    const result = await ai.explain(rec, { outletType: req.outlet!.outlet_type, city: req.outlet!.city });
    const ts = iso(now());
    if (result.ok) {
      await db.run(
        "UPDATE recommendation_items SET ai_status = 'ok', ai_explanation_json = ?, ai_error = NULL, ai_model = ?, ai_generated_at = ? WHERE id = ?",
        [JSON.stringify(result.explanation), result.model, ts, row.id],
      );
    } else {
      await db.run(
        'UPDATE recommendation_items SET ai_status = ?, ai_error = ?, ai_explanation_json = NULL, ai_generated_at = ? WHERE id = ?',
        [result.code, result.message, ts, row.id],
      );
    }
    await db.run(
      'INSERT OR REPLACE INTO provider_status (id, provider, model, last_checked_at, last_result, last_error) VALUES (1, ?, ?, ?, ?, ?)',
      [
        ai.status().provider,
        ai.status().model,
        ts,
        result.ok ? 'ok' : result.code,
        result.ok ? null : result.message,
      ],
    );
    await audit(
      db,
      {
        outletId: req.outlet!.id,
        userId: req.user!.id,
        entityType: 'recommendation_item',
        entityId: row.id,
        action: 'explain',
        details: { ok: result.ok, code: result.ok ? null : result.code },
      },
      now(),
    );
    res
      .status(result.ok ? 200 : result.code === 'not_configured' ? 503 : 502)
      .json(itemDto(await getItem(req.outlet!.id, row.id)));
  });

  // ---------------- Action plans ----------------

  const getPlan = async (outletId: number, pid: number) => {
    const p = await db.get<PlanRow>('SELECT * FROM action_plans WHERE id = ? AND outlet_id = ?', [
      pid,
      outletId,
    ]);
    if (!p) throw notFound('Plan');
    return p;
  };

  async function planDto(p: PlanRow) {
    const users = async (id: number | null) =>
      id
        ? ((await db.get<{ display_name: string }>('SELECT display_name FROM users WHERE id = ?', [id]))
            ?.display_name ?? null)
        : null;
    const lines = await db.all<LineRow>('SELECT * FROM plan_lines WHERE plan_id = ? ORDER BY id', [p.id]);
    const tasks = await db.all<TaskRow & { completed_by_name: string | null }>(
      'SELECT t.*, u.display_name AS completed_by_name FROM tasks t LEFT JOIN users u ON u.id = t.completed_by WHERE t.plan_id = ? ORDER BY t.id',
      [p.id],
    );
    const history = (
      await db.all(
        `SELECT h.id, h.action, h.from_status AS fromStatus, h.to_status AS toStatus, h.reason, h.changes_json AS changes, h.created_at AS createdAt, u.display_name AS userName
       FROM approval_history h LEFT JOIN users u ON u.id = h.user_id WHERE h.plan_id = ? ORDER BY h.id`,
        [p.id],
      )
    ).map((h) => ({ ...h, changes: h.changes ? JSON.parse(h.changes as string) : null }));
    return {
      id: p.id,
      runId: p.run_id,
      title: p.title,
      planDate: p.plan_date,
      status: p.status,
      createdBy: await users(p.created_by),
      createdAt: p.created_at,
      submittedAt: p.submitted_at,
      decidedBy: await users(p.decided_by),
      decidedAt: p.decided_at,
      rejectionReason: p.rejection_reason,
      cancelReason: p.cancel_reason,
      completedAt: p.completed_at,
      lines: lines.map(lineDto),
      tasks: tasks.map((t) => ({
        id: t.id,
        lineId: t.plan_line_id,
        title: t.title,
        status: t.status,
        dueDate: t.due_date,
        targetQty: t.target_qty,
        unit: t.unit,
        actualQty: t.actual_qty,
        notes: t.notes,
        completedBy: t.completed_by_name,
        completedAt: t.completed_at,
      })),
      history,
    };
  }

  async function history(
    planId: number,
    action: string,
    from: string,
    to: string,
    userId: number,
    reason: string | null,
    changes: unknown = null,
  ) {
    await db.run(
      'INSERT INTO approval_history (plan_id, action, from_status, to_status, user_id, reason, changes_json, created_at) VALUES (?,?,?,?,?,?,?,?)',
      [
        planId,
        action,
        from,
        to,
        userId,
        reason,
        changes === null ? null : JSON.stringify(changes),
        iso(now()),
      ],
    );
  }

  r.post('/plans', editors, async (req, res) => {
    const b = parse(
      z.object({
        runId: z.number().int().positive(),
        title: optText(120),
        selections: z
          .array(z.object({ itemId: z.number().int().positive(), optionKey: z.string().min(1).max(4) }))
          .min(1, 'Choose at least one option')
          .max(50),
      }),
      req.body,
    );
    const run = await db.get<{ id: number; plan_date: string }>(
      'SELECT id, plan_date FROM recommendation_runs WHERE id = ? AND outlet_id = ?',
      [b.runId, req.outlet!.id],
    );
    if (!run) throw notFound('Recommendation run');
    const ts = iso(now());
    const pid = await db.tx(async () => {
      const { lastId } = await db.run(
        'INSERT INTO action_plans (outlet_id, run_id, title, plan_date, status, created_by, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)',
        [
          req.outlet!.id,
          run.id,
          b.title ?? `Plan for ${formatDate(run.plan_date)}`,
          run.plan_date,
          'draft',
          req.user!.id,
          ts,
          ts,
        ],
      );
      let n = 0;
      const seenItems = new Set<number>();
      for (const s of b.selections) {
        if (seenItems.has(s.itemId)) throw badRequest('Choose only one option per recommendation.');
        seenItems.add(s.itemId);
        const item = await db.get<{ payload_json: string; run_id: number }>(
          'SELECT payload_json, run_id FROM recommendation_items WHERE id = ? AND outlet_id = ?',
          [s.itemId, req.outlet!.id],
        );
        if (!item || item.run_id !== run.id)
          throw badRequest('A selected recommendation does not belong to this run.');
        const rec = JSON.parse(item.payload_json) as Recommendation;
        const opt = rec.options.find((o) => o.key === s.optionKey);
        if (!opt) throw badRequest(`Option ${s.optionKey} does not exist for "${rec.title}".`);
        if (!opt.feasible)
          throw badRequest(
            `Option ${s.optionKey} for "${rec.title}" is not feasible: ${opt.infeasibleReason ?? ''}`,
          );
        for (const l of opt.lines) {
          await db.run(
            `INSERT INTO plan_lines (plan_id, rec_item_id, rec_title, option_key, option_label, line_type, subject_type, subject_id, subject_name, proposed_qty, unit, note, estimated_cost_paise, estimated_impact_paise, original_json)
             VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
            [
              lastId,
              s.itemId,
              rec.title,
              opt.key,
              opt.label,
              l.type,
              l.subjectType,
              l.subjectId,
              l.subjectName,
              l.qty,
              l.unit,
              l.note,
              l.estimatedCostPaise,
              rec.estimatedImpactPaise,
              JSON.stringify(l),
            ],
          );
          n++;
        }
      }
      if (!n)
        throw badRequest(
          'The chosen options contain no actions to plan (e.g. "keep current purchasing"). Nothing to approve.',
        );
      await history(lastId, 'create', 'draft', 'draft', req.user!.id, null, { selections: b.selections });
      await audit(
        db,
        {
          outletId: req.outlet!.id,
          userId: req.user!.id,
          entityType: 'plan',
          entityId: lastId,
          action: 'create',
          details: b,
        },
        now(),
      );
      return lastId;
    });
    res.status(201).json(await planDto(await getPlan(req.outlet!.id, pid)));
  });

  r.get('/plans', anyRole, async (req, res) => {
    const status = String(req.query.status ?? '');
    const rows = await db.all<PlanRow & { line_count: number; open_tasks: number }>(
      `SELECT p.*, (SELECT COUNT(*) FROM plan_lines l WHERE l.plan_id = p.id) AS line_count, (SELECT COUNT(*) FROM tasks t WHERE t.plan_id = p.id AND t.status = 'open') AS open_tasks
       FROM action_plans p WHERE p.outlet_id = ? ${status ? 'AND p.status = ?' : ''} ORDER BY p.id DESC LIMIT 100`,
      status ? [req.outlet!.id, status] : [req.outlet!.id],
    );
    res.json(
      rows.map((p) => ({
        id: p.id,
        title: p.title,
        planDate: p.plan_date,
        status: p.status,
        createdAt: p.created_at,
        lineCount: p.line_count,
        openTasks: p.open_tasks,
      })),
    );
  });

  r.get('/plans/:pid', anyRole, async (req, res) =>
    res.json(await planDto(await getPlan(req.outlet!.id, idParam(req, 'pid')))),
  );

  async function applyLineEdit(p: PlanRow, lineId: number, qty: number | null, userId: number, role: string) {
    if (p.status === 'draft') {
      if (role === 'staff') throw forbidden();
    } else if (p.status === 'awaiting_approval') {
      if (!canApprove(role as never, !!(await req_managers(p))))
        throw forbidden('Only an approver can edit quantities while a plan awaits approval.');
    } else throw conflict('Quantities can only be edited before approval.');
    const line = await db.get<LineRow>('SELECT * FROM plan_lines WHERE id = ? AND plan_id = ?', [
      lineId,
      p.id,
    ]);
    if (!line) throw notFound('Plan line');
    if (line.proposed_qty === null) throw badRequest('This action has no quantity to edit.');
    if (qty === null || !(qty >= 0))
      throw badRequest('Quantity must be zero or more.', { fields: { qty: 'Must be zero or more' } });
    if (line.line_type === 'discard')
      throw badRequest('Discard quantities come from the recorded batch and cannot be edited here.');
    const newQty = line.line_type === 'prep' || line.unit === 'pc' ? Math.round(qty) : roundQty(qty);
    await db.run('UPDATE plan_lines SET proposed_qty = ? WHERE id = ?', [newQty, lineId]);
    await db.run('UPDATE action_plans SET updated_at = ? WHERE id = ?', [iso(now()), p.id]);
    await history(p.id, 'edit_line', p.status, p.status, userId, null, {
      lineId,
      subject: line.subject_name,
      from: line.proposed_qty,
      to: newQty,
    });
    return newQty;
  }
  const req_managers = async (p: PlanRow) =>
    (await db.get<{ managers_can_approve: number }>('SELECT managers_can_approve FROM outlets WHERE id = ?', [
      p.outlet_id,
    ]))!.managers_can_approve;

  r.put('/plans/:pid/lines/:lid', editors, async (req, res) => {
    const p = await getPlan(req.outlet!.id, idParam(req, 'pid'));
    const b = parse(z.object({ qty: z.coerce.number().finite().min(0).max(10_000_000) }), req.body);
    // Quantities are entered in display units for ingredients (kg/L) — client sends base units.
    await db.tx(async () => await applyLineEdit(p, idParam(req, 'lid'), b.qty, req.user!.id, req.role!));
    res.json(await planDto(await getPlan(req.outlet!.id, p.id)));
  });

  r.delete('/plans/:pid/lines/:lid', editors, async (req, res) => {
    const p = await getPlan(req.outlet!.id, idParam(req, 'pid'));
    if (p.status !== 'draft') throw conflict('Lines can only be removed from a draft plan.');
    await db.tx(async () => {
      const line = await db.get<LineRow>('SELECT * FROM plan_lines WHERE id = ? AND plan_id = ?', [
        idParam(req, 'lid'),
        p.id,
      ]);
      if (!line) throw notFound('Plan line');
      await db.run('DELETE FROM plan_lines WHERE id = ?', [line.id]);
      await history(p.id, 'remove_line', 'draft', 'draft', req.user!.id, null, {
        subject: line.subject_name,
        type: line.line_type,
      });
    });
    res.json(await planDto(await getPlan(req.outlet!.id, p.id)));
  });

  r.post('/plans/:pid/:action', editors, async (req, res) => {
    if (!['submit', 'approve', 'reject', 'cancel', 'complete'].includes(req.params.action as string))
      throw notFound('Action');
    const p = await getPlan(req.outlet!.id, idParam(req, 'pid'));
    const action = req.params.action as PlanAction;
    const b = parse(
      z.object({
        reason: optText(500),
        lineEdits: z
          .array(z.object({ lineId: z.number().int(), qty: z.coerce.number().min(0) }))
          .max(100)
          .optional(),
      }),
      req.body ?? {},
    );
    const to = nextStatus(p.status, action, {
      role: req.role!,
      managersCanApprove: !!req.outlet!.managers_can_approve,
      reason: b.reason,
    });
    const ts = iso(now());
    await db.tx(async () => {
      if (action === 'submit' && !(await db.get('SELECT 1 FROM plan_lines WHERE plan_id = ?', [p.id])))
        throw badRequest('The plan has no actions.');
      if (action === 'approve') {
        for (const e of b.lineEdits ?? []) await applyLineEdit(p, e.lineId, e.qty, req.user!.id, req.role!);
        const lines = await db.all<LineRow>('SELECT * FROM plan_lines WHERE plan_id = ?', [p.id]);
        for (const l of lines) {
          await db.run('UPDATE plan_lines SET approved_qty = proposed_qty WHERE id = ?', [l.id]);
          if (l.line_type === 'prep' && l.proposed_qty === 0) continue; // nothing to do
          await db.run(
            'INSERT INTO tasks (outlet_id, plan_id, plan_line_id, due_date, title, status, target_qty, unit, created_at) VALUES (?,?,?,?,?,?,?,?,?)',
            [
              req.outlet!.id,
              p.id,
              l.id,
              p.plan_date,
              taskTitle(l, l.proposed_qty),
              'open',
              l.proposed_qty,
              l.unit,
              ts,
            ],
          );
        }
      }
      if (action === 'complete') {
        const open = (await db.get<{ n: number }>(
          "SELECT COUNT(*) AS n FROM tasks WHERE plan_id = ? AND status = 'open'",
          [p.id],
        ))!.n;
        if (open) throw conflict(`${open} task(s) are still open. Complete or skip them first.`);
      }
      if (action === 'cancel')
        await db.run("UPDATE tasks SET status = 'cancelled' WHERE plan_id = ? AND status = 'open'", [p.id]);
      await db.run(
        `UPDATE action_plans SET status = ?, updated_at = ?,
           submitted_at = CASE WHEN ? = 'submit' THEN ? ELSE submitted_at END,
           decided_by = CASE WHEN ? IN ('approve','reject') THEN ? ELSE decided_by END,
           decided_at = CASE WHEN ? IN ('approve','reject') THEN ? ELSE decided_at END,
           rejection_reason = CASE WHEN ? = 'reject' THEN ? ELSE rejection_reason END,
           cancel_reason = CASE WHEN ? = 'cancel' THEN ? ELSE cancel_reason END,
           completed_at = CASE WHEN ? = 'complete' THEN ? ELSE completed_at END
         WHERE id = ?`,
        [
          to,
          ts,
          action,
          ts,
          action,
          req.user!.id,
          action,
          ts,
          action,
          b.reason,
          action,
          b.reason,
          action,
          ts,
          p.id,
        ],
      );
      await history(p.id, action, p.status, to, req.user!.id, b.reason);
      await audit(
        db,
        {
          outletId: req.outlet!.id,
          userId: req.user!.id,
          entityType: 'plan',
          entityId: p.id,
          action,
          details: { from: p.status, to, reason: b.reason },
        },
        now(),
      );
    });
    res.json(await planDto(await getPlan(req.outlet!.id, p.id)));
  });

  // ---------------- Tasks ----------------

  r.get('/tasks', anyRole, async (req, res) => {
    const status = String(req.query.status || 'open');
    const rows = await db.all(
      `SELECT t.id, t.title, t.status, t.due_date AS dueDate, t.target_qty AS targetQty, t.unit, t.actual_qty AS actualQty, t.notes, t.completed_at AS completedAt,
              p.id AS planId, p.title AS planTitle, pl.line_type AS type, pl.subject_type AS subjectType, pl.subject_id AS subjectId, pl.subject_name AS subjectName, pl.note AS lineNote,
              u.display_name AS completedBy,
              (SELECT o.id FROM service_outcomes o WHERE o.task_id = t.id LIMIT 1) AS outcomeId
       FROM tasks t JOIN action_plans p ON p.id = t.plan_id JOIN plan_lines pl ON pl.id = t.plan_line_id LEFT JOIN users u ON u.id = t.completed_by
       WHERE t.outlet_id = ? ${status === 'all' ? '' : 'AND t.status = ?'} ORDER BY t.due_date, t.id LIMIT 300`,
      status === 'all' ? [req.outlet!.id] : [req.outlet!.id, status],
    );
    res.json(rows);
  });

  async function maybeAutoComplete(planId: number, userId: number) {
    const p = (await db.get<PlanRow>('SELECT * FROM action_plans WHERE id = ?', [planId]))!;
    if (p.status !== 'approved') return;
    const open = (await db.get<{ n: number }>(
      "SELECT COUNT(*) AS n FROM tasks WHERE plan_id = ? AND status = 'open'",
      [planId],
    ))!.n;
    if (open) return;
    const ts = iso(now());
    await db.run(
      "UPDATE action_plans SET status = 'completed', completed_at = ?, updated_at = ? WHERE id = ?",
      [ts, ts, planId],
    );
    await history(planId, 'complete', 'approved', 'completed', userId, 'All tasks closed');
  }

  r.post('/tasks/:tid/:action', anyRole, async (req, res) => {
    if (!['complete', 'skip'].includes(req.params.action as string)) throw notFound('Action');
    const tid = idParam(req, 'tid');
    const t = await db.get<
      TaskRow & { line_type: string; subject_type: string; subject_id: number; subject_name: string }
    >(
      'SELECT t.*, pl.line_type, pl.subject_type, pl.subject_id, pl.subject_name FROM tasks t JOIN plan_lines pl ON pl.id = t.plan_line_id WHERE t.id = ? AND t.outlet_id = ?',
      [tid, req.outlet!.id],
    );
    if (!t) throw notFound('Task');
    if (t.status !== 'open') throw conflict('This task is already closed.');
    const b = parse(
      z.object({
        actualQty: z.coerce.number().finite().min(0).max(10_000_000).nullish(),
        notes: optText(300),
        qualityOk: z.boolean().optional(),
        delayReason: optText(200),
      }),
      req.body ?? {},
    );
    const ts = iso(now());
    const effects: string[] = [];
    await db.tx(async () => {
      if (req.params.action === 'skip') {
        if (!b.notes) throw badRequest('Give a reason for skipping.', { fields: { notes: 'Required' } });
        await db.run(
          "UPDATE tasks SET status = 'skipped', notes = ?, completed_by = ?, completed_at = ? WHERE id = ?",
          [b.notes, req.user!.id, ts, tid],
        );
      } else {
        const c = { db, outlet: req.outlet!, userId: req.user!.id, now: now() };
        let actual = b.actualQty ?? null;
        if ((t.line_type === 'prep' || t.line_type === 'count') && actual === null)
          throw badRequest('Enter the actual quantity.', { fields: { actualQty: 'Required' } });
        if (t.line_type === 'discard') {
          const batch = await getBatch(db, req.outlet!.id, t.subject_id);
          const ing = await getIngredient(db, req.outlet!.id, batch.ingredient_id);
          const qty = Math.min(actual ?? t.target_qty ?? 0, batch.qty_remaining);
          if (qty > 0) {
            const { lastId } = await db.run(
              `INSERT INTO waste_logs (outlet_id, subject_type, ingredient_id, batch_id, qty, unit, qty_base, occurred_at, business_date, reason, notes, task_id, source, created_by, created_at)
               VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
              [
                req.outlet!.id,
                'ingredient',
                ing.id,
                batch.id,
                qty,
                ing.base_unit,
                qty,
                ts,
                outletToday(req.outlet!, now()),
                'expired',
                b.notes ?? `Removed via plan task #${tid}`,
                tid,
                'task',
                req.user!.id,
                ts,
              ],
            );
            const d = await deductFromBatch(c, ing, batch, qty, {
              type: 'waste',
              reason: `Removed from use (task #${tid})`,
              refType: 'waste_log',
              refId: lastId,
            });
            if (d.costPaise !== null)
              await db.run("UPDATE waste_logs SET cost_paise = ?, cost_basis = 'batch_cost' WHERE id = ?", [
                d.costPaise,
                lastId,
              ]);
            effects.push(
              `Recorded ${formatQty(qty, ing.base_unit)} of ${ing.name} as waste and removed it from stock`,
            );
          } else effects.push('Batch already empty — no stock change');
          actual = qty;
        }
        if (t.line_type === 'count') {
          const ing = await getIngredient(db, req.outlet!.id, t.subject_id);
          const r2 = await countIngredient(
            c,
            ing,
            toBase(actual!, ing.base_unit, ing.base_unit),
            `Stock count (task #${tid})`,
            'task',
            tid,
          );
          effects.push(
            `Stock of ${ing.name} set to counted ${formatQty(r2.after, ing.base_unit)} (was ${formatQty(r2.before, ing.base_unit)})`,
          );
        }
        if (t.line_type === 'verify' && t.subject_type === 'batch' && b.qualityOk) {
          const batch = await getBatch(db, req.outlet!.id, t.subject_id);
          const today = outletToday(req.outlet!, now());
          if (batch.date_type === 'best_before' && batch.date_value && batch.date_value < today) {
            await db.run('UPDATE inventory_batches SET quality_checked_on = ?, updated_at = ? WHERE id = ?', [
              today,
              ts,
              batch.id,
            ]);
            effects.push('Quality check recorded for today');
          } else {
            await db.run(
              'UPDATE inventory_batches SET storage_verified_on = ?, updated_at = ? WHERE id = ?',
              [today, ts, batch.id],
            );
            effects.push('Storage check recorded for today');
          }
        }
        if (t.line_type === 'order_action' || t.line_type === 'dispose_order') {
          const order = await db.get<{
            id: number;
            order_ref: string;
            status: string;
            disposition: string | null;
          }>('SELECT id, order_ref, status, disposition FROM orders WHERE id = ? AND outlet_id = ?', [
            t.subject_id,
            req.outlet!.id,
          ]);
          if (!order) throw notFound('Order');
          if (b.delayReason) {
            await db.run('UPDATE orders SET delay_reason = ?, updated_at = ? WHERE id = ?', [
              b.delayReason,
              ts,
              order.id,
            ]);
            effects.push(`Delay reason recorded on order ${order.order_ref}`);
          }
          if (t.line_type === 'dispose_order') {
            if (order.disposition)
              throw conflict(`Order ${order.order_ref} already has a recorded disposition.`);
            if (!['cancelled', 'uncollected', 'returned'].includes(order.status))
              throw conflict(
                `Order ${order.order_ref} is ${order.status}; only cancelled, uncollected or returned orders can be disposed.`,
              );
            const reason =
              order.status === 'returned'
                ? 'returned'
                : order.status === 'uncollected'
                  ? 'uncollected_order'
                  : 'cancelled_order';
            const items = await db.all<{ menu_item_id: number; qty: number; name: string }>(
              'SELECT oi.menu_item_id, oi.qty, m.name FROM order_items oi JOIN menu_items m ON m.id = oi.menu_item_id WHERE oi.order_id = ?',
              [order.id],
            );
            for (const it of items) {
              await recordMenuItemWaste(db, req.outlet!, req.user!.id, now(), {
                menuItemId: it.menu_item_id,
                qty: it.qty,
                occurredAt: ts,
                reason,
                notes: b.notes ?? `Order ${order.order_ref} (plan task #${tid})`,
                servicePeriod: null,
                source: 'task',
                orderId: order.id,
              });
            }
            await db.run('UPDATE orders SET disposition = ?, status = ?, updated_at = ? WHERE id = ?', [
              'disposed',
              'closed',
              ts,
              order.id,
            ]);
            await db.run(
              'INSERT INTO order_events (order_id, outlet_id, event_type, occurred_at, reason, note, source, user_id, created_at) VALUES (?,?,?,?,?,?,?,?,?)',
              [
                order.id,
                req.outlet!.id,
                'closed',
                ts,
                'Food disposed and recorded',
                `Plan task #${tid}`,
                'task',
                req.user!.id,
                ts,
              ],
            );
            effects.push(
              `Recorded ${items.reduce((a, i) => a + i.qty, 0)} portion(s) from order ${order.order_ref} as waste (${reason.replace('_', ' ')}) and closed the order`,
            );
          }
        }
        if (t.line_type === 'purchase')
          effects.push('No stock was added. Record a stock receipt in Inventory when the delivery arrives.');
        await db.run(
          "UPDATE tasks SET status = 'done', actual_qty = ?, notes = ?, completed_by = ?, completed_at = ? WHERE id = ?",
          [actual, b.notes, req.user!.id, ts, tid],
        );
      }
      await audit(
        db,
        {
          outletId: req.outlet!.id,
          userId: req.user!.id,
          entityType: 'task',
          entityId: tid,
          action: String(req.params.action),
          details: { ...b, effects },
        },
        now(),
      );
      await maybeAutoComplete(t.plan_id, req.user!.id);
    });
    res.json({ ok: true, effects });
  });

  return r;
}

export type { PlanRow };
