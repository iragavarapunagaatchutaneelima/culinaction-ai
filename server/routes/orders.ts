import { Router } from 'express';
import { z } from 'zod';
import { parseCsv, toCsv } from '../../shared/csv';
import { addDays } from '../../shared/dates';
import { assessOrders } from '../../shared/engine';
import {
  allowedEvents,
  applyEvent,
  CHANNEL_LABELS,
  durations,
  EVENT_LABELS,
  isOpen,
  ORDER_CHANNELS,
  ORDER_EVENTS,
  orderStage,
  preparedButUndelivered,
  OrderTransitionError,
  STAGE_LABELS,
  type OrderEvent,
  type OrderEventType,
  type OrderStatus,
} from '../../shared/orders';
import type { Snapshot } from '../../shared/types';
import { requireRole, type OutletRow } from '../auth';
import type { Db } from '../db/database';
import { badRequest, conflict, HttpError, idParam, notFound, parse } from '../http';
import { audit, iso, loadMenuSnaps, loadOrderSnaps, outletToday, type Deps } from '../services';
import { optText } from '../validation';

/** "YYYY-MM-DDTHH:mm" or "YYYY-MM-DD HH:mm" entered in IST, or a full ISO timestamp → UTC ISO. */
export function parseLocalDateTime(v: string): string | null {
  const t = v.trim();
  const m = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?$/.exec(t);
  const d = m
    ? new Date(`${m[1]}T${m[2]}:${m[3]}:${m[4] ?? '00'}+05:30`)
    : /Z$|[+-]\d{2}:\d{2}$/.test(t)
      ? new Date(t)
      : null;
  return d && !Number.isNaN(d.getTime()) ? d.toISOString() : null;
}

const localDateTime = z.string().transform((v, ctx) => {
  const r = parseLocalDateTime(v);
  if (!r) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Enter a date and time' });
    return z.NEVER;
  }
  return r;
});

export async function riskSnapshot(
  db: Db,
  outlet: OutletRow,
  now: Date,
  orderId?: number,
): Promise<Snapshot> {
  return {
    today: outletToday(outlet, now),
    planDate: outletToday(outlet, now),
    nowIso: iso(now),
    settings: {
      expiryWarnDays: outlet.expiry_warn_days,
      excessCoverDays: outlet.excess_cover_days,
      staleCountDays: outlet.stale_count_days,
      purchaseBufferPct: outlet.purchase_buffer_pct,
      prepWarnMin: outlet.prep_warn_min,
      readyWaitWarnMin: outlet.ready_wait_warn_min,
      readyWaitHighMin: outlet.ready_wait_high_min,
      deliveryTargetMin: outlet.delivery_target_min,
    },
    ingredients: [],
    menuItems: await loadMenuSnaps(db, outlet.id),
    sales: [],
    outcomes: [],
    pastForecasts: [],
    orders: await loadOrderSnaps(db, outlet.id, now, orderId),
  };
}

const median = (xs: number[]) => {
  const a = xs.filter((x) => x !== null && Number.isFinite(x)).sort((x, y) => x - y);
  if (!a.length) return null;
  return a.length % 2
    ? a[(a.length - 1) / 2]
    : Math.round(((a[a.length / 2 - 1] + a[a.length / 2]) / 2) * 10) / 10;
};

export function orderRoutes({ db, now }: Deps) {
  const r = Router({ mergeParams: true });
  const anyRole = requireRole('owner', 'manager', 'staff');
  const editors = requireRole('owner', 'manager');

  async function nextRef(outletId: number) {
    const n = (await db.get<{ n: number }>('SELECT COUNT(*) AS n FROM orders WHERE outlet_id = ?', [
      outletId,
    ]))!.n;
    return `M-${n + 1001}`;
  }

  async function insertEvent(
    outlet: OutletRow,
    orderId: number,
    e: OrderEvent & { note?: string | null },
    userId: number,
    source = 'manual',
  ) {
    await db.run(
      'INSERT INTO order_events (order_id, outlet_id, event_type, occurred_at, reason, note, source, user_id, created_at) VALUES (?,?,?,?,?,?,?,?,?)',
      [orderId, outlet.id, e.type, e.at, e.reason ?? null, e.note ?? null, source, userId, iso(now())],
    );
  }

  r.get('/orders', anyRole, async (req, res) => {
    const view = String(req.query.view || 'open'); // open | recent | all
    const snap = await riskSnapshot(db, req.outlet!, now());
    const risks = assessOrders(snap);
    const names = new Map(snap.menuItems.map((m) => [m.id, m.name]));
    const since = addDays(outletToday(req.outlet!, now()), view === 'all' ? -14 : -2);
    let list = snap.orders!;
    if (view === 'open')
      list = list.filter(
        (o) => isOpen(o.status) || (!o.disposition && preparedButUndelivered(o.events, o.status)),
      );
    else list = list.filter((o) => o.placedAt.slice(0, 10) >= since || isOpen(o.status));
    const rank = { high: 0, moderate: 1, insufficient: 2, low: 3 } as const;
    res.json(
      list
        .map((o) => {
          const d = durations(o.events, o.status, snap.nowIso);
          const risk = risks.get(o.id)!;
          return {
            id: o.id,
            ref: o.ref,
            channel: o.channel,
            channelLabel: CHANNEL_LABELS[o.channel as keyof typeof CHANNEL_LABELS] ?? o.channel,
            status: o.status,
            placedAt: o.placedAt,
            items: o.items.map((i) => `${i.qty} × ${names.get(i.menuItemId) ?? '?'}`).join(', '),
            lastEvent: o.events.at(-1)
              ? {
                  type: o.events.at(-1)!.type,
                  label: EVENT_LABELS[o.events.at(-1)!.type],
                  at: o.events.at(-1)!.at,
                }
              : null,
            durations: d,
            risk: { level: risk.level, summary: risk.summary },
            needsDisposition: !o.disposition && preparedButUndelivered(o.events, o.status),
            delayReason: o.delayReason,
            source: 'source' in o ? (o as { source?: string }).source : undefined,
          };
        })
        .sort((a, b) =>
          isOpen(a.status) === isOpen(b.status)
            ? rank[a.risk.level] - rank[b.risk.level] || b.placedAt.localeCompare(a.placedAt)
            : isOpen(a.status)
              ? -1
              : 1,
        ),
    );
  });

  r.post('/orders', editors, async (req, res) => {
    const b = parse(
      z.object({
        orderRef: optText(40),
        channel: z.enum(ORDER_CHANNELS),
        placedAt: localDateTime,
        items: z
          .array(
            z.object({ menuItemId: z.number().int().positive(), qty: z.coerce.number().positive().max(500) }),
          )
          .min(1, 'Add at least one item')
          .max(30),
        estTravelMin: z.coerce
          .number()
          .int()
          .min(0)
          .max(240)
          .nullish()
          .transform((v) => v ?? null),
        packaging: optText(120),
        deliveryArea: optText(80),
        notes: optText(300),
      }),
      req.body,
    );
    if (Date.parse(b.placedAt) > now().getTime() + 5 * 60_000)
      throw badRequest('Order time cannot be in the future.', {
        fields: { placedAt: 'Cannot be in the future' },
      });
    for (const it of b.items) {
      if (
        !(await db.get('SELECT 1 FROM menu_items WHERE id = ? AND outlet_id = ?', [
          it.menuItemId,
          req.outlet!.id,
        ]))
      )
        throw notFound('Menu item');
    }
    const ref = b.orderRef || (await nextRef(req.outlet!.id));
    if (await db.get('SELECT 1 FROM orders WHERE outlet_id = ? AND order_ref = ?', [req.outlet!.id, ref]))
      throw conflict(`Order ${ref} already exists.`);
    const ts = iso(now());
    const id = await db.tx(async () => {
      const { lastId } = await db.run(
        `INSERT INTO orders (outlet_id, order_ref, channel, status, placed_at, est_travel_min, packaging, delivery_area, notes, source, created_by, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [
          req.outlet!.id,
          ref,
          b.channel,
          'received',
          b.placedAt,
          b.estTravelMin,
          b.packaging,
          b.deliveryArea,
          b.notes,
          'manual',
          req.user!.id,
          ts,
          ts,
        ],
      );
      for (const it of b.items)
        await db.run('INSERT INTO order_items (order_id, menu_item_id, qty) VALUES (?,?,?)', [
          lastId,
          it.menuItemId,
          it.qty,
        ]);
      await insertEvent(req.outlet!, lastId, { type: 'received', at: b.placedAt }, req.user!.id);
      await audit(
        db,
        {
          outletId: req.outlet!.id,
          userId: req.user!.id,
          entityType: 'order',
          entityId: lastId,
          action: 'create',
          details: { ref, channel: b.channel },
        },
        now(),
      );
      return lastId;
    });
    res.status(201).json(await detail(req.outlet!, id));
  });

  async function detail(outlet: OutletRow, id: number) {
    const row = await db.get<{
      id: number;
      order_ref: string;
      channel: string;
      status: OrderStatus;
      placed_at: string;
      est_travel_min: number | null;
      packaging: string | null;
      delivery_area: string | null;
      delay_reason: string | null;
      disposition: string | null;
      notes: string | null;
      source: string;
    }>('SELECT * FROM orders WHERE id = ? AND outlet_id = ?', [id, outlet.id]);
    if (!row) throw notFound('Order');
    const snap = await riskSnapshot(db, outlet, now(), id);
    const o = snap.orders![0];
    const risk = assessOrders(snap).get(id)!;
    const menu = new Map(snap.menuItems.map((m) => [m.id, m]));
    const events = await db.all<{
      id: number;
      event_type: OrderEventType;
      occurred_at: string;
      reason: string | null;
      note: string | null;
      source: string;
      user_name: string | null;
    }>(
      'SELECT e.*, u.display_name AS user_name FROM order_events e LEFT JOIN users u ON u.id = e.user_id WHERE e.order_id = ? ORDER BY e.occurred_at, e.id',
      [id],
    );
    const waste = await db.all(
      'SELECT id, menu_item_id AS menuItemId, qty, reason, cost_paise AS costPaise, cost_basis AS costBasis, occurred_at AS occurredAt FROM waste_logs WHERE order_id = ?',
      [id],
    );
    const latestRec = await db.get<{ id: number }>(
      `SELECT i.id FROM recommendation_items i WHERE i.outlet_id = ? AND i.rec_key IN (?, ?) ORDER BY i.id DESC LIMIT 1`,
      [outlet.id, `pickup_delay:${id}`, `order_disposition:${id}`],
    );
    return {
      id: row.id,
      ref: row.order_ref,
      channel: row.channel,
      channelLabel: CHANNEL_LABELS[row.channel as keyof typeof CHANNEL_LABELS] ?? row.channel,
      status: row.status,
      placedAt: row.placed_at,
      estTravelMin: row.est_travel_min,
      packaging: row.packaging,
      deliveryArea: row.delivery_area,
      delayReason: row.delay_reason,
      disposition: row.disposition,
      notes: row.notes,
      source: row.source,
      items: o.items.map((i) => {
        const m = menu.get(i.menuItemId);
        return {
          menuItemId: i.menuItemId,
          name: m?.name ?? '?',
          qty: i.qty,
          handlingClass: m?.handlingClass ?? null,
          maxHoldMin: m?.handlingMaxHoldMin ?? null,
          handlingVerified: !!m?.handlingVerified,
        };
      }),
      events: events.map((e) => ({
        id: e.id,
        type: e.event_type,
        label: EVENT_LABELS[e.event_type],
        at: e.occurred_at,
        reason: e.reason,
        note: e.note,
        source: e.source,
        userName: e.user_name,
      })),
      durations: durations(o.events, o.status, snap.nowIso),
      stage: { key: orderStage(o.events, o.status), label: STAGE_LABELS[orderStage(o.events, o.status)] },
      allowedEvents: allowedEvents(o.status, o.events).map((t) => ({ type: t, label: EVENT_LABELS[t] })),
      risk,
      thresholds: {
        prepWarnMin: outlet.prep_warn_min,
        readyWaitWarnMin: outlet.ready_wait_warn_min,
        readyWaitHighMin: outlet.ready_wait_high_min,
        deliveryTargetMin: outlet.delivery_target_min,
      },
      waste,
      latestRecommendationId: latestRec?.id ?? null,
    };
  }

  r.get('/orders/:id', anyRole, async (req, res) => res.json(await detail(req.outlet!, idParam(req, 'id'))));

  r.post('/orders/:id/events', anyRole, async (req, res) => {
    const id = idParam(req, 'id');
    const b = parse(
      z.object({ type: z.enum(ORDER_EVENTS), at: localDateTime, reason: optText(200), note: optText(300) }),
      req.body,
    );
    const order = await db.get<{ status: OrderStatus }>(
      'SELECT status FROM orders WHERE id = ? AND outlet_id = ?',
      [id, req.outlet!.id],
    );
    if (!order) throw notFound('Order');
    if (['cancelled', 'marked_uncollected', 'returned'].includes(b.type) && !b.reason)
      throw badRequest('Give a reason for this event.', { fields: { reason: 'Required' } });
    const history = (
      await db.all<{ event_type: OrderEventType; occurred_at: string }>(
        'SELECT event_type, occurred_at FROM order_events WHERE order_id = ? ORDER BY occurred_at, id',
        [id],
      )
    ).map((e) => ({ type: e.event_type, at: e.occurred_at }));
    let next: OrderStatus;
    try {
      next = applyEvent(order.status, history, { type: b.type, at: b.at }, iso(now()));
    } catch (e) {
      if (e instanceof OrderTransitionError) throw new HttpError(409, e.message, 'invalid_transition');
      throw e;
    }
    await db.tx(async () => {
      await insertEvent(
        req.outlet!,
        id,
        { type: b.type, at: b.at, reason: b.reason, note: b.note },
        req.user!.id,
      );
      await db.run('UPDATE orders SET status = ?, updated_at = ? WHERE id = ?', [next, iso(now()), id]);
      await audit(
        db,
        {
          outletId: req.outlet!.id,
          userId: req.user!.id,
          entityType: 'order',
          entityId: id,
          action: `event:${b.type}`,
          details: b,
        },
        now(),
      );
    });
    res.status(201).json(await detail(req.outlet!, id));
  });

  r.put('/orders/:id', anyRole, async (req, res) => {
    const id = idParam(req, 'id');
    const b = parse(
      z.object({
        estTravelMin: z.coerce
          .number()
          .int()
          .min(0)
          .max(240)
          .nullish()
          .transform((v) => v ?? null),
        packaging: optText(120),
        deliveryArea: optText(80),
        delayReason: optText(200),
        notes: optText(300),
      }),
      req.body,
    );
    const before = await db.get('SELECT * FROM orders WHERE id = ? AND outlet_id = ?', [id, req.outlet!.id]);
    if (!before) throw notFound('Order');
    await db.tx(async () => {
      await db.run(
        'UPDATE orders SET est_travel_min = ?, packaging = ?, delivery_area = ?, delay_reason = ?, notes = ?, updated_at = ? WHERE id = ?',
        [b.estTravelMin, b.packaging, b.deliveryArea, b.delayReason, b.notes, iso(now()), id],
      );
      await audit(
        db,
        {
          outletId: req.outlet!.id,
          userId: req.user!.id,
          entityType: 'order',
          entityId: id,
          action: 'update',
          details: { before, after: b },
        },
        now(),
      );
    });
    res.json(await detail(req.outlet!, id));
  });

  r.get('/delivery/summary', anyRole, async (req, res) => {
    const snap = await riskSnapshot(db, req.outlet!, now());
    const since = Date.parse(snap.nowIso) - 7 * 86400000;
    const recent = snap.orders!.filter((o) => Date.parse(o.placedAt) >= since);
    const ds = recent.map((o) => durations(o.events, o.status, snap.nowIso));
    const risks = assessOrders(snap);
    const open = snap.orders!.filter((o) => isOpen(o.status));
    const reasons = new Map<string, number>();
    for (const o of recent)
      for (const e of o.events) if (e.reason) reasons.set(e.reason, (reasons.get(e.reason) ?? 0) + 1);
    const byStatus: Record<string, number> = {};
    for (const o of recent) byStatus[o.status] = (byStatus[o.status] ?? 0) + 1;
    res.json({
      windowDays: 7,
      orders: recent.length,
      byStatus,
      medians: {
        prepMin: median(ds.map((d) => d.prepMin!).filter((x) => x !== null)),
        packMin: median(ds.map((d) => d.packMin!).filter((x) => x !== null)),
        readyWaitMin: median(
          ds
            .filter((d) => !d.readyWaitOngoing)
            .map((d) => d.readyWaitMin!)
            .filter((x) => x !== null),
        ),
        deliveryMin: median(ds.map((d) => d.deliveryMin!).filter((x) => x !== null)),
        totalMin: median(
          ds
            .filter((d) => !d.totalOngoing)
            .map((d) => d.totalMin!)
            .filter((x) => x !== null),
        ),
      },
      samples: {
        prep: ds.filter((d) => d.prepMin !== null).length,
        readyWait: ds.filter((d) => d.readyWaitMin !== null && !d.readyWaitOngoing).length,
        delivery: ds.filter((d) => d.deliveryMin !== null).length,
      },
      waitedOverWarning: ds.filter(
        (d) => d.readyWaitMin !== null && d.readyWaitMin >= req.outlet!.ready_wait_warn_min,
      ).length,
      openByRisk: open.reduce<Record<string, number>>((a, o) => {
        const l = risks.get(o.id)!.level;
        a[l] = (a[l] ?? 0) + 1;
        return a;
      }, {}),
      delayReasons: [...reasons.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 8)
        .map(([reason, count]) => ({ reason, count })),
      thresholds: {
        prepWarnMin: req.outlet!.prep_warn_min,
        readyWaitWarnMin: req.outlet!.ready_wait_warn_min,
        readyWaitHighMin: req.outlet!.ready_wait_high_min,
        deliveryTargetMin: req.outlet!.delivery_target_min,
      },
    });
  });

  // ---- CSV import of order events (dry-run preview, then commit re-validates) ----
  const ORDER_CSV_COLUMNS = [
    'order_ref',
    'event',
    'occurred_at',
    'channel',
    'items',
    'est_travel_min',
    'packaging',
    'reason',
  ];

  async function validateOrderCsv(outlet: OutletRow, text: string) {
    let table: string[][];
    try {
      table = parseCsv(text).filter((r) => !r[0]?.trim().startsWith('#'));
    } catch (e) {
      throw badRequest((e as Error).message);
    }
    if (!table.length) throw badRequest('The file is empty.');
    const header = table[0].map((h) => h.trim().toLowerCase());
    for (const req of ['order_ref', 'event', 'occurred_at'])
      if (!header.includes(req))
        throw badRequest(`Missing required column "${req}". Expected: ${ORDER_CSV_COLUMNS.join(', ')}.`);
    if (table.length - 1 > 3000) throw badRequest('Too many rows (maximum 3000 per import).');
    const menu = new Map((await loadMenuSnaps(db, outlet.id)).map((m) => [m.name.toLowerCase(), m]));
    const existing = new Map<string, { status: OrderStatus; history: OrderEvent[] }>();
    const rows: {
      line: number;
      ref: string;
      event: string;
      at: string | null;
      status: 'valid' | 'invalid';
      errors: string[];
      creates: boolean;
      items: { menuItemId: number; qty: number }[];
      channel: string | null;
      estTravelMin: number | null;
      packaging: string | null;
      reason: string | null;
    }[] = [];
    for (const [i, cells] of table.slice(1).entries()) {
      const raw: Record<string, string> = {};
      header.forEach((h, j) => (raw[h] = (cells[j] ?? '').trim()));
      const errors: string[] = [];
      const ref = raw.order_ref;
      const type = raw.event as OrderEventType;
      const at = parseLocalDateTime(raw.occurred_at ?? '');
      if (!ref) errors.push('order_ref is blank.');
      if (!(ORDER_EVENTS as readonly string[]).includes(type))
        errors.push(`Unknown event "${raw.event}". Use one of: ${ORDER_EVENTS.join(', ')}.`);
      if (!at) errors.push(`Invalid occurred_at "${raw.occurred_at}" (use YYYY-MM-DD HH:mm, India time).`);
      let state = ref ? existing.get(ref) : undefined;
      if (ref && !state) {
        const o = await db.get<{ id: number; status: OrderStatus }>(
          'SELECT id, status FROM orders WHERE outlet_id = ? AND order_ref = ?',
          [outlet.id, ref],
        );
        if (o) {
          const h = (
            await db.all<{ event_type: OrderEventType; occurred_at: string }>(
              'SELECT event_type, occurred_at FROM order_events WHERE order_id = ? ORDER BY occurred_at, id',
              [o.id],
            )
          ).map((e) => ({ type: e.event_type, at: e.occurred_at }));
          state = { status: o.status, history: h };
          existing.set(ref, state);
        }
      }
      const creates = !state && type === 'received';
      const items: { menuItemId: number; qty: number }[] = [];
      let channel: string | null = null;
      if (creates) {
        channel = raw.channel || '';
        if (!(ORDER_CHANNELS as readonly string[]).includes(channel))
          errors.push(`New order needs a channel (${ORDER_CHANNELS.join(', ')}).`);
        for (const part of (raw.items ?? '')
          .split(';')
          .map((p) => p.trim())
          .filter(Boolean)) {
          const m = /^(.+?)\s*[x×]\s*(\d+(?:\.\d+)?)$/i.exec(part);
          const name = (m ? m[1] : part).trim().toLowerCase();
          const item = menu.get(name);
          if (!item) errors.push(`Unknown menu item "${m ? m[1] : part}".`);
          else items.push({ menuItemId: item.id, qty: m ? Number(m[2]) : 1 });
        }
        if (!items.length && !errors.some((e) => e.startsWith('Unknown menu')))
          errors.push('New order needs items, e.g. "Masala Dosa x2; Filter Coffee x1".');
      } else if (!state && type && ref)
        errors.push(`Order ${ref} does not exist yet — its first row must be a "received" event.`);
      if (!errors.length && at) {
        try {
          const next = applyEvent(state?.status ?? null, state?.history ?? [], { type, at }, iso(now()));
          const s2 = state ?? { status: next, history: [] };
          s2.status = next;
          s2.history.push({ type, at });
          existing.set(ref, s2);
        } catch (e) {
          errors.push((e as Error).message);
        }
      }
      const travel = raw.est_travel_min ? Number(raw.est_travel_min) : null;
      if (raw.est_travel_min && !(Number.isInteger(travel) && travel! >= 0 && travel! <= 240))
        errors.push('est_travel_min must be a whole number of minutes (0–240).');
      rows.push({
        line: i + 2,
        ref,
        event: raw.event,
        at,
        status: errors.length ? 'invalid' : 'valid',
        errors,
        creates,
        items,
        channel,
        estTravelMin: travel,
        packaging: raw.packaging || null,
        reason: raw.reason || null,
      });
    }
    return rows;
  }

  r.get('/orders/import/template.csv', anyRole, (_req, res) => {
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="culinaction-order-events-template.csv"');
    res.send(
      'order_ref,event,occurred_at,channel,items,est_travel_min,packaging,reason\r\n' +
        '# Replace with your own records. One row per event, in time order. occurred_at is India time (YYYY-MM-DD HH:mm).\r\n' +
        '# The first row of a new order must be "received" with channel and items ("Dish name x2; Other dish x1").\r\n',
    );
  });

  r.post('/orders/import/preview', editors, async (req, res) => {
    const b = parse(z.object({ csvText: z.string().min(1).max(1_000_000) }), req.body);
    const rows = await validateOrderCsv(req.outlet!, b.csvText);
    res.json({
      rows,
      summary: {
        total: rows.length,
        valid: rows.filter((r) => r.status === 'valid').length,
        invalid: rows.filter((r) => r.status === 'invalid').length,
      },
    });
  });

  r.post('/orders/import/commit', editors, async (req, res) => {
    const b = parse(z.object({ csvText: z.string().min(1).max(1_000_000) }), req.body);
    const rows = await validateOrderCsv(req.outlet!, b.csvText); // re-validated against current data
    const ts = iso(now());
    let imported = 0;
    await db.tx(async () => {
      const ids = new Map<string, number>();
      for (const r2 of rows) {
        if (r2.status !== 'valid') continue;
        let id =
          ids.get(r2.ref) ??
          (
            await db.get<{ id: number }>('SELECT id FROM orders WHERE outlet_id = ? AND order_ref = ?', [
              req.outlet!.id,
              r2.ref,
            ])
          )?.id;
        if (r2.creates) {
          id = (
            await db.run(
              `INSERT INTO orders (outlet_id, order_ref, channel, status, placed_at, est_travel_min, packaging, source, created_by, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
              [
                req.outlet!.id,
                r2.ref,
                r2.channel,
                'received',
                r2.at,
                r2.estTravelMin,
                r2.packaging,
                'csv_import',
                req.user!.id,
                ts,
                ts,
              ],
            )
          ).lastId;
          for (const it of r2.items)
            await db.run('INSERT INTO order_items (order_id, menu_item_id, qty) VALUES (?,?,?)', [
              id,
              it.menuItemId,
              it.qty,
            ]);
        }
        if (!id) continue;
        ids.set(r2.ref, id);
        await insertEvent(
          req.outlet!,
          id,
          { type: r2.event as OrderEventType, at: r2.at!, reason: r2.reason },
          req.user!.id,
          'csv_import',
        );
        const st = (
          await db.all<{ event_type: OrderEventType; occurred_at: string }>(
            'SELECT event_type, occurred_at FROM order_events WHERE order_id = ? ORDER BY occurred_at, id',
            [id],
          )
        ).map((e) => ({ type: e.event_type, at: e.occurred_at }));
        const statusNow = st.reduce<OrderStatus | null>(
          (s, e, k) => applyEvent(s, st.slice(0, k), e, iso(now())),
          null,
        )!;
        await db.run('UPDATE orders SET status = ?, updated_at = ? WHERE id = ?', [statusNow, ts, id]);
        imported++;
      }
      await audit(
        db,
        {
          outletId: req.outlet!.id,
          userId: req.user!.id,
          entityType: 'order_import',
          entityId: null,
          action: 'commit',
          details: { imported, skipped: rows.length - imported },
        },
        now(),
      );
    });
    res.json({ imported, notImported: rows.length - imported });
  });

  r.get('/export/orders.csv', anyRole, async (req, res) => {
    const rows = await db.all<Record<string, unknown>>(
      `SELECT o.order_ref, e.event_type, e.occurred_at, o.channel, o.status, e.reason, o.source FROM order_events e JOIN orders o ON o.id = e.order_id
       WHERE o.outlet_id = ? ORDER BY o.placed_at, e.occurred_at`,
      [req.outlet!.id],
    );
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="order-events.csv"');
    res.send(
      toCsv(
        ['order_ref', 'event', 'occurred_at_utc', 'channel', 'current_status', 'reason', 'source'],
        rows.map((x) => Object.values(x)),
      ),
    );
  });

  return r;
}
