import { Router } from 'express';
import { addDays } from '../../shared/dates';
import { replay, type OrderEvent } from '../../shared/orders';
import {
  clearCookie,
  createSession,
  DEMO_COOKIE,
  destroySession,
  readCookie,
  requireAuth,
  requireRole,
  sessionCookie,
  type OutletRow,
} from '../auth';
import { createDemoUser, DEMO_OUTLET_KEYS, purgeExpiredDemos, resetDemo, seedDemo } from '../demo';
import { forbidden, HttpError, idParam } from '../http';
import { audit, iso, outletToday, type Deps } from '../services';
import { createRun } from './decisions';

async function demoOutlets(db: Deps['db'], userId: number) {
  return db.all<{ id: number; name: string; outletType: string }>(
    `SELECT o.id, o.name, o.outlet_type AS outletType FROM outlets o JOIN outlet_members m ON m.outlet_id = o.id
     WHERE m.user_id = ? AND o.is_illustrative = 1 ORDER BY o.id`,
    [userId],
  );
}

/** Public demo endpoints (no account needed). Uses its own cookie; real sessions are untouched. */
export function demoRoutes({ db, now }: Deps, secureCookies: boolean) {
  const r = Router();

  r.post('/start', async (req, res) => {
    if (req.user?.isDemo)
      return void res.json({ outlets: await demoOutlets(db, req.user.id), resumed: true });
    let userId: number;
    try {
      userId = await createDemoUser(db, now());
    } catch (e) {
      if ((e as Error).message === 'DEMO_CAPACITY')
        throw new HttpError(
          503,
          'Too many demo sessions are active right now. Please try again later.',
          'demo_capacity',
        );
      throw e;
    }
    await seedDemo(db, userId, now());
    const s = await createSession(db, userId, now());
    // demo sessions last 24 hours
    const expires = new Date(now().getTime() + 24 * 3600_000);
    await db.run('UPDATE sessions SET expires_at = ? WHERE user_id = ?', [expires.toISOString(), userId]);
    res.setHeader('Set-Cookie', sessionCookie(s.token, expires, secureCookies, DEMO_COOKIE));
    res.status(201).json({ outlets: await demoOutlets(db, userId), resumed: false });
  });

  r.get('/status', (req, res) => res.json({ active: !!req.user?.isDemo, outletKeys: DEMO_OUTLET_KEYS }));

  r.post('/reset', requireAuth, async (req, res) => {
    if (!req.user!.isDemo) throw forbidden('Reset is only available in Demo Mode.');
    await resetDemo(db, req.user!.id, now());
    res.json({ outlets: await demoOutlets(db, req.user!.id) });
  });

  r.post('/end', async (req, res) => {
    const token = readCookie(req, DEMO_COOKIE);
    if (token) await destroySession(db, token);
    res.setHeader('Set-Cookie', clearCookie(DEMO_COOKIE));
    await purgeExpiredDemos(db, now());
    res.json({ ok: true });
  });

  return r;
}

/** Scenario triggers inside a demo outlet. Server-side checks: demo session AND illustrative outlet. */
export function demoScenarioRoutes({ db, now }: Deps) {
  const r = Router({ mergeParams: true });

  async function runAndFind(outlet: OutletRow, userId: number, pred: (key: string, kind: string) => boolean) {
    const runId = await createRun(db, outlet, userId, outletToday(outlet, now()), now());
    const items = await db.all<{ id: number; rec_key: string; kind: string }>(
      'SELECT id, rec_key, kind FROM recommendation_items WHERE run_id = ? ORDER BY position',
      [runId],
    );
    return items.find((i) => pred(i.rec_key, i.kind)) ?? null;
  }

  async function createLiveOrder(
    outlet: OutletRow,
    userId: number,
    ref: string,
    events: OrderEvent[],
    travel: number | null,
    delayReason: string | null,
  ) {
    const status = replay(events, iso(now()));
    const item = await db.get<{ id: number }>(
      `SELECT m.id FROM menu_items m JOIN recipes r ON r.menu_item_id = m.id WHERE m.outlet_id = ? AND r.verified = 1 AND m.handling_verified = 1 ORDER BY m.handling_max_hold_min, m.id LIMIT 1`,
      [outlet.id],
    );
    if (!item) throw new HttpError(409, 'This outlet has no dish with a verified handling limit.', 'demo');
    const ts = iso(now());
    const id = (
      await db.run(
        `INSERT INTO orders (outlet_id, order_ref, channel, status, placed_at, est_travel_min, packaging, delay_reason, notes, source, created_by, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [
          outlet.id,
          ref,
          'aggregator',
          status,
          events[0].at,
          travel,
          'Sealed container in insulated bag',
          delayReason,
          'Created by a demo scenario (simulated, not a live order)',
          'illustrative',
          userId,
          ts,
          ts,
        ],
      )
    ).lastId;
    await db.run('INSERT INTO order_items (order_id, menu_item_id, qty) VALUES (?,?,?)', [id, item.id, 2]);
    for (const e of events)
      await db.run(
        'INSERT INTO order_events (order_id, outlet_id, event_type, occurred_at, reason, source, user_id, created_at) VALUES (?,?,?,?,?,?,?,?)',
        [id, outlet.id, e.type, e.at, e.reason ?? null, 'illustrative', userId, ts],
      );
    return id;
  }

  r.post('/demo/scenarios/:n', requireRole('owner'), async (req, res) => {
    if (!req.user?.isDemo || !req.outlet?.is_illustrative)
      throw forbidden('Scenarios can only be triggered in Demo Mode.');
    const n = idParam(req, 'n');
    const o = req.outlet!;
    const uid = req.user!.id;
    const ago = (min: number) => new Date(now().getTime() - min * 60_000).toISOString();
    const suffix = Date.now().toString(36).slice(-4).toUpperCase();
    let out: { navigate: string; message: string };
    switch (n) {
      case 1: {
        const item = await runAndFind(o, uid, (_k, kind) => kind === 'prep_adjustment');
        if (!item)
          throw new HttpError(
            409,
            'No preparation surplus pattern in this outlet. Try Charminar Biryani House.',
            'demo',
          );
        out = {
          navigate: `recommendations/${item.id}`,
          message: 'Recommendations recalculated. Showing the preparation surplus finding.',
        };
        break;
      }
      case 2: {
        const item = await runAndFind(o, uid, (_k, kind) => kind === 'expiry_waste_risk');
        if (!item)
          throw new HttpError(
            409,
            'No ingredient is near its use-by date in this outlet. Try Secunderabad Bake Studio.',
            'demo',
          );
        out = {
          navigate: `recommendations/${item.id}`,
          message: 'Showing the ingredient nearing its recorded use-by date.',
        };
        break;
      }
      case 3: {
        const id = await createLiveOrder(
          o,
          uid,
          `DEMO-U${suffix}`,
          [
            { type: 'received', at: ago(40) },
            { type: 'prep_started', at: ago(38) },
            { type: 'prep_completed', at: ago(22) },
            { type: 'pack_started', at: ago(21) },
            { type: 'pack_completed', at: ago(19) },
            { type: 'ready_for_pickup', at: ago(18) },
            { type: 'marked_uncollected', at: ago(1), reason: 'Rider cancelled the trip (simulated)' },
          ],
          20,
          null,
        );
        const item = await runAndFind(o, uid, (k) => k === `order_disposition:${id}`);
        out = {
          navigate: item ? `recommendations/${item.id}` : `orders/${id}`,
          message: 'Simulated uncollected order created. Choose what happens to the prepared food.',
        };
        break;
      }
      case 4: {
        const id = await createLiveOrder(
          o,
          uid,
          `DEMO-P${suffix}`,
          [
            { type: 'received', at: ago(48) },
            { type: 'prep_started', at: ago(46) },
            { type: 'prep_completed', at: ago(30) },
            { type: 'pack_started', at: ago(29) },
            { type: 'pack_completed', at: ago(27) },
            { type: 'rider_assigned', at: ago(27) },
            { type: 'ready_for_pickup', at: ago(26) },
          ],
          20,
          null,
        );
        await createRun(db, o, uid, outletToday(o, now()), now());
        out = {
          navigate: `orders/${id}`,
          message: 'Simulated order waiting 26 minutes for pickup. Review its timeline and risk.',
        };
        break;
      }
      case 5: {
        const item = await db.get<{ id: number }>(
          `SELECT m.id FROM menu_items m JOIN recipes r ON r.menu_item_id = m.id WHERE m.outlet_id = ? AND r.verified = 1 ORDER BY m.id LIMIT 1`,
          [o.id],
        );
        out = {
          navigate: `whatif${item ? `?item=${item.id}` : ''}`,
          message: 'Compare preparation quantities.',
        };
        break;
      }
      case 6:
        out = {
          navigate: 'verify',
          message: 'Outcome verification compares approved actions with what was recorded afterwards.',
        };
        break;
      default:
        throw new HttpError(404, 'Unknown scenario', 'not_found');
    }
    await audit(
      db,
      {
        outletId: o.id,
        userId: uid,
        entityType: 'demo_scenario',
        entityId: n,
        action: 'trigger',
        details: { since: addDays(outletToday(o, now()), 0) },
      },
      now(),
    );
    res.json(out);
  });

  return r;
}
