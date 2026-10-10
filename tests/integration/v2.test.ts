// Integration tests for v2: demo mode isolation, orders/delivery, what-if, AI validation, outcomes.
// AI provider responses here are deterministic FIXTURES injected at the HTTP boundary — they test
// validation logic only and say nothing about whether a live provider works.
import { afterEach, describe, expect, it } from 'vitest';
import { createAnthropicProvider, type AiProvider } from '../../server/ai/provider';
import { client, createOutlet, makeApp, NOW, setupOwner, tempDbPath } from './helpers';

let cleanups: (() => unknown)[] = [];
afterEach(async () => {
  for (const c of cleanups) await c();
  cleanups = [];
});

async function fresh(ai?: AiProvider) {
  const t = tempDbPath();
  const { db, app } = await makeApp(t.path, ai);
  cleanups.push(async () => {
    await db.close();
    t.cleanup();
  });
  return { db, app, real: client(app), demo: client(app, 'demo') };
}

const ago = (min: number) => {
  const d = new Date(NOW.getTime() - min * 60_000 + 330 * 60_000); // as IST wall clock
  return d.toISOString().slice(0, 16);
};

/** Messages API response fixture whose text is the given JSON. */
const aiFixture = (json: unknown): typeof fetch =>
  (async () =>
    new Response(
      JSON.stringify({
        id: 'msg_fixture',
        type: 'message',
        role: 'assistant',
        model: 'claude-opus-5-5',
        content: [{ type: 'text', text: JSON.stringify(json) }],
        stop_reason: 'end_turn',
        stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 1 },
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )) as typeof fetch;
const fixtureProvider = (json: unknown) =>
  createAnthropicProvider({
    apiKey: 'test-key-not-real',
    model: 'claude-opus-5-5',
    timeoutMs: 2000,
    fetch: aiFixture(json),
  });

describe('demo mode', () => {
  it('starts without an account, seeds four flagged outlets, and never exposes them to real users', async () => {
    const { demo, real, db } = await fresh();
    const start = await demo.post('/api/demo/start');
    expect(start.status).toBe(201);
    expect(start.body.outlets).toHaveLength(4);
    expect(start.headers['set-cookie'][0]).toMatch(/^ca_demo=.*HttpOnly; SameSite=Strict/);
    const me = await demo.get('/api/auth/me');
    expect(me.body.user.isDemo).toBe(true);
    expect(me.body.outlets.every((o: { isIllustrative: boolean }) => o.isIllustrative)).toBe(true);
    const oid = start.body.outlets[0].id;
    expect((await demo.get(`/api/outlets/${oid}/orders?view=all`)).body.length).toBeGreaterThan(10);

    // A real owner can still complete first-time setup (demo users do not count) …
    await setupOwner(real);
    // … and cannot see demo outlets, while the demo cookie is useless in real mode.
    expect((await real.get(`/api/outlets/${oid}/ingredients`)).status).toBe(404);
    expect((await real.get('/api/auth/me')).body.outlets).toHaveLength(0);
    // Every demo row is labelled
    const unlabeled = await db.get<{ n: number }>(
      "SELECT COUNT(*) AS n FROM sales_records s JOIN outlets o ON o.id = s.outlet_id WHERE o.is_illustrative = 1 AND s.source != 'illustrative'",
    );
    expect(unlabeled!.n).toBe(0);
  });

  it('keeps demo users out of real-only actions', async () => {
    const { demo } = await fresh();
    await demo.post('/api/demo/start');
    expect(
      (await demo.post('/api/outlets', { name: 'X', outletType: 'cafe', city: 'Hyderabad' })).status,
    ).toBe(403);
    const oid = (await demo.get('/api/auth/me')).body.outlets[0].id;
    expect(
      (
        await demo.post(`/api/outlets/${oid}/members`, {
          username: 'abc',
          displayName: 'A',
          role: 'staff',
          password: 'password-12',
        })
      ).status,
    ).toBe(403);
    expect((await demo.del(`/api/outlets/${oid}`, { confirmName: 'x' })).status).toBe(403);
    // demo users cannot sign in with a password
    expect(
      (
        await demo.post('/api/auth/login', {
          username: 'demo-anything',
          password: 'demo-account-no-password-login',
        })
      ).status,
    ).toBe(401);
  });

  it('reset regenerates only this visitor’s demo outlets and leaves real data untouched', async () => {
    const { demo, real, db, app } = await fresh();
    await setupOwner(real);
    const realOutlet = await createOutlet(real, 'Real Kitchen');
    await real.post(`/api/outlets/${realOutlet}/ingredients`, {
      name: 'Rice',
      category: 'Grains',
      baseUnit: 'g',
      initialStock: { qty: 5, unit: 'kg', receivedOn: '2026-10-09' },
    });
    const first = await demo.post('/api/demo/start');
    const second = client(app, 'demo');
    const otherStart = await second.post('/api/demo/start'); // a second visitor
    const before = await db.get<{ real: number; outlets: number }>(
      'SELECT (SELECT COUNT(*) FROM ingredients WHERE outlet_id = ?) AS real, (SELECT COUNT(*) FROM outlets) AS outlets',
      [realOutlet],
    );
    const oid = first.body.outlets[0].id;
    await demo.post(`/api/outlets/${oid}/orders`, {
      channel: 'takeaway',
      placedAt: ago(5),
      items: [{ menuItemId: (await demo.get(`/api/outlets/${oid}/menu-items`)).body[0].id, qty: 1 }],
    });
    const reset = await demo.post('/api/demo/reset');
    expect(reset.status).toBe(200);
    expect(reset.body.outlets.map((o: { id: number }) => o.id)).not.toContain(oid);
    const after = await db.get<{ real: number; outlets: number }>(
      'SELECT (SELECT COUNT(*) FROM ingredients WHERE outlet_id = ?) AS real, (SELECT COUNT(*) FROM outlets) AS outlets',
      [realOutlet],
    );
    expect(after).toEqual(before); // same number of outlets overall, real ingredients unchanged
    // the other visitor's sandbox still works
    expect((await second.get(`/api/outlets/${otherStart.body.outlets[0].id}/dashboard`)).status).toBe(200);
    // real users cannot reset anything
    expect((await real.post('/api/demo/reset')).status).toBe(403);
  });

  it('scenario triggers work in demo outlets and are refused elsewhere', async () => {
    const { demo, real } = await fresh();
    const outlets = (await demo.post('/api/demo/start')).body.outlets as { id: number; outletType: string }[];
    const biryani = outlets.find((o) => o.outletType === 'biryani')!.id;
    const bakery = outlets.find((o) => o.outletType === 'bakery')!.id;
    const s1 = await demo.post(`/api/outlets/${biryani}/demo/scenarios/1`);
    expect(s1.body.navigate).toMatch(/^recommendations\/\d+$/);
    const rec = await demo.get(
      `/api/outlets/${biryani}/${s1.body.navigate.replace('recommendations/', 'recommendations/items/')}`,
    );
    expect(rec.body.kind).toBe('prep_adjustment');
    expect(rec.body.title).toMatch(/Chicken Dum Biryani/);
    const s2 = await demo.post(`/api/outlets/${bakery}/demo/scenarios/2`);
    expect(
      (
        await demo.get(
          `/api/outlets/${bakery}/${s2.body.navigate.replace('recommendations/', 'recommendations/items/')}`,
        )
      ).body.kind,
    ).toBe('expiry_waste_risk');
    const s3 = await demo.post(`/api/outlets/${biryani}/demo/scenarios/3`);
    const r3 = (
      await demo.get(
        `/api/outlets/${biryani}/${s3.body.navigate.replace('recommendations/', 'recommendations/items/')}`,
      )
    ).body;
    expect(r3.kind).toBe('order_disposition');
    expect(r3.options[1].feasible).toBe(true); // held 22 min < 60 min verified limit
    const s4 = await demo.post(`/api/outlets/${biryani}/demo/scenarios/4`);
    const order = (
      await demo.get(
        `/api/outlets/${biryani}/${s4.body.navigate.replace('recommendations/', 'recommendations/items/')}`,
      )
    ).body;
    expect(order.status).toBe('ready_for_pickup');
    expect(order.risk.level).toBe('high');
    expect(order.durations.readyWaitMin).toBe(26);
    expect((await demo.post(`/api/outlets/${biryani}/demo/scenarios/5`)).body.navigate).toMatch(
      /^whatif\?item=\d+$/,
    );
    // real outlet: refused
    await setupOwner(real);
    const ro = await createOutlet(real);
    expect((await real.post(`/api/outlets/${ro}/demo/scenarios/1`)).status).toBe(403);
  }, 30000);
});

describe('orders and delivery timeline', () => {
  async function kitchen() {
    const f = await fresh();
    await setupOwner(f.real);
    const oid = await createOutlet(f.real);
    const item = (
      await f.real.post(`/api/outlets/${oid}/menu-items`, {
        name: 'Veg Biryani',
        category: 'Rice',
        priceInr: '200',
        handlingClass: 'hot',
        handlingMaxHoldMin: 45,
        handlingVerified: true,
      })
    ).body;
    return { ...f, oid, itemId: item.id as number };
  }

  it('records a validated lifecycle and computes durations from recorded timestamps', async () => {
    const { real, oid, itemId } = await kitchen();
    const o = await real.post(`/api/outlets/${oid}/orders`, {
      channel: 'aggregator',
      placedAt: ago(40),
      items: [{ menuItemId: itemId, qty: 2 }],
      estTravelMin: 15,
      packaging: 'Foil',
    });
    expect(o.status).toBe(201);
    expect(o.body).toMatchObject({ status: 'received', ref: 'M-1001' });
    const base = `/api/outlets/${oid}/orders/${o.body.id}/events`;
    expect((await real.post(base, { type: 'picked_up', at: ago(30) })).status).toBe(409); // skipped steps
    for (const [type, min] of [
      ['prep_started', 38],
      ['prep_completed', 25],
      ['ready_for_pickup', 24],
    ] as const) {
      expect((await real.post(base, { type, at: ago(min) })).status).toBe(201);
    }
    expect((await real.post(base, { type: 'picked_up', at: ago(30) })).body.error.message).toMatch(
      /earlier than the previous/,
    );
    const d = (await real.get(`/api/outlets/${oid}/orders/${o.body.id}`)).body;
    expect(d.durations).toMatchObject({
      prepMin: 13,
      readyWaitMin: 24,
      readyWaitOngoing: true,
      packMin: null,
    });
    expect(d.risk.level).toBe('high'); // 24 ≥ 20-minute high threshold
    expect(d.allowedEvents.map((e: { type: string }) => e.type)).toContain('picked_up');
    expect((await real.post(base, { type: 'marked_uncollected', at: ago(1) })).status).toBe(400); // reason required
  });

  it('imports order events from CSV with row-level validation', async () => {
    const { real, oid } = await kitchen();
    const day = '2026-10-09';
    const csv = [
      'order_ref,event,occurred_at,channel,items,est_travel_min,packaging,reason',
      `A1,received,${day} 12:00,aggregator,Veg Biryani x2,20,Foil,`,
      `A1,prep_started,${day} 12:02,,,,,`,
      `A1,prep_completed,${day} 12:20,,,,,`,
      `A1,ready_for_pickup,${day} 12:21,,,,,`,
      `A1,picked_up,${day} 12:35,,,,,Rider late`,
      `A1,delivered,${day} 12:55,,,,,`,
      `B2,prep_started,${day} 13:00,,,,,`, // order doesn't exist
      `C3,received,${day} 13:00,aggregator,Pizza x1,,,`, // unknown item
      `A1,prep_started,${day} 13:10,,,,,`, // invalid transition after delivered
    ].join('\n');
    const prev = await real.post(`/api/outlets/${oid}/orders/import/preview`, { csvText: csv });
    expect(prev.body.summary).toEqual({ total: 9, valid: 6, invalid: 3 });
    const commit = await real.post(`/api/outlets/${oid}/orders/import/commit`, { csvText: csv });
    expect(commit.body).toEqual({ imported: 6, notImported: 3 });
    const list = (await real.get(`/api/outlets/${oid}/orders?view=all`)).body;
    expect(list[0]).toMatchObject({ ref: 'A1', status: 'delivered' });
    expect(list[0].durations).toMatchObject({ prepMin: 18, readyWaitMin: 14, deliveryMin: 20, totalMin: 55 });
    const sum = (await real.get(`/api/outlets/${oid}/delivery/summary`)).body;
    expect(sum.delayReasons).toEqual([{ reason: 'Rider late', count: 1 }]);
  });

  it('disposal task records categorised waste, closes the order and never offers resale', async () => {
    const { real, oid, itemId } = await kitchen();
    await real.post(`/api/outlets/${oid}/ingredients`, {
      name: 'Rice',
      category: 'Grains',
      baseUnit: 'g',
      initialStock: { qty: 10, unit: 'kg', totalCostInr: '900', receivedOn: '2026-10-09' },
    });
    const ing = (await real.get(`/api/outlets/${oid}/ingredients`)).body.items[0];
    await real.put(`/api/outlets/${oid}/menu-items/${itemId}/recipe`, {
      verified: true,
      lines: [{ ingredientId: ing.id, qty: 200, unit: 'g' }],
    });
    const o = (
      await real.post(`/api/outlets/${oid}/orders`, {
        channel: 'takeaway',
        placedAt: ago(90),
        items: [{ menuItemId: itemId, qty: 2 }],
      })
    ).body;
    const ev = `/api/outlets/${oid}/orders/${o.id}/events`;
    await real.post(ev, { type: 'prep_started', at: ago(88) });
    await real.post(ev, { type: 'prep_completed', at: ago(70) });
    await real.post(ev, { type: 'ready_for_pickup', at: ago(69) });
    await real.post(ev, { type: 'marked_uncollected', at: ago(2), reason: 'Customer did not come' });
    const run = (await real.post(`/api/outlets/${oid}/recommendations/run`, {})).body;
    const rec = run.items.find((i: { kind: string }) => i.kind === 'order_disposition');
    expect(rec.options[1].feasible).toBe(false); // 70 min held > 45 min verified limit
    const plan = (
      await real.post(`/api/outlets/${oid}/plans`, {
        runId: run.id,
        selections: [{ itemId: rec.id, optionKey: 'A' }],
      })
    ).body;
    await real.post(`/api/outlets/${oid}/plans/${plan.id}/submit`);
    const ap = (await real.post(`/api/outlets/${oid}/plans/${plan.id}/approve`)).body;
    const done = await real.post(`/api/outlets/${oid}/tasks/${ap.tasks[0].id}/complete`, {});
    expect(done.body.effects[0]).toMatch(/Recorded 2 portion\(s\).*uncollected order/);
    const order = (await real.get(`/api/outlets/${oid}/orders/${o.id}`)).body;
    expect(order).toMatchObject({ status: 'closed', disposition: 'disposed' });
    expect(order.waste[0]).toMatchObject({
      reason: 'uncollected_order',
      costPaise: 3600,
      costBasis: 'recipe_estimate',
    });
    // A second disposal attempt is refused
    const run2 = (await real.post(`/api/outlets/${oid}/recommendations/run`, {})).body;
    expect(run2.items.some((i: { kind: string }) => i.kind === 'order_disposition')).toBe(false);
  });
});

describe('what-if simulator', () => {
  it('calculates from persisted records and refuses unverified recipes', async () => {
    const { real } = await fresh();
    await setupOwner(real);
    const oid = await createOutlet(real);
    await real.post(`/api/outlets/${oid}/ingredients`, {
      name: 'Rice',
      category: 'Grains',
      baseUnit: 'g',
      initialStock: { qty: 6, unit: 'kg', totalCostInr: '540', receivedOn: '2026-10-09' },
    });
    const ing = (await real.get(`/api/outlets/${oid}/ingredients`)).body.items[0];
    const item = (
      await real.post(`/api/outlets/${oid}/menu-items`, {
        name: 'Veg Biryani',
        category: 'Rice',
        priceInr: '200',
      })
    ).body;
    await real.put(`/api/outlets/${oid}/menu-items/${item.id}/recipe`, {
      verified: false,
      lines: [{ ingredientId: ing.id, qty: 200, unit: 'g' }],
    });
    expect(
      (await real.post(`/api/outlets/${oid}/whatif/prep`, { menuItemId: item.id, portions: [10] })).body.error
        .message,
    ).toMatch(/no verified/);
    await real.put(`/api/outlets/${oid}/menu-items/${item.id}/recipe`, {
      verified: true,
      lines: [{ ingredientId: ing.id, qty: 200, unit: 'g' }],
    });
    const r = (
      await real.post(`/api/outlets/${oid}/whatif/prep`, { menuItemId: item.id, portions: [20, 40] })
    ).body;
    expect(r.forecast.method).toBe('insufficient');
    expect(r.scenarios[0]).toMatchObject({
      portions: 20,
      stockFeasible: true,
      maxPortionsFromStock: 30,
      ingredientCostPaise: 36000, // 4 kg × ₹90/kg = ₹360
      history: null,
    });
    expect(r.scenarios[1].ingredients[0]).toMatchObject({ needed: 8000, shortfall: 2000 });
    const p = (
      await real.post(`/api/outlets/${oid}/whatif/purchase`, { ingredientId: ing.id, qty: 2, unit: 'kg' })
    ).body;
    expect(p.result.coverDaysAfter).toBeNull(); // no sales history → not guessed
    expect(
      (await real.post(`/api/outlets/${oid}/whatif/purchase`, { ingredientId: ing.id, qty: 2, unit: 'L' }))
        .status,
    ).toBe(400);
  });
});

describe('AI explanation validation (fixture responses)', () => {
  async function withRec(ai: AiProvider) {
    const f = await fresh(ai);
    await setupOwner(f.real);
    const oid = await createOutlet(f.real);
    // cream with an expiry date and no verified recipe → option A (prioritise dishes) is infeasible
    await f.real.post(`/api/outlets/${oid}/ingredients`, {
      name: 'Cream',
      category: 'Dairy',
      baseUnit: 'ml',
      initialStock: {
        qty: 500,
        unit: 'ml',
        receivedOn: '2026-10-09',
        dateType: 'expiry',
        dateValue: '2026-10-11',
      },
    });
    const run = (await f.real.post(`/api/outlets/${oid}/recommendations/run`, {})).body;
    const rec = run.items.find((i: { kind: string }) => i.kind === 'expiry_waste_risk');
    return { ...f, oid, rec };
  }
  const valid = {
    summary: 'Some cream may not be used before its expiry date because no verified dish uses it.',
    why: ['No verified recipe uses this ingredient, so expected use cannot be calculated.'],
    tradeoffs: [{ option: 'C', pros: ['Keeps current practice'], cons: ['The value at risk remains'] }],
    uncertainty: ['Confidence is low.'],
    information_to_collect: ['A verified recipe that uses cream'],
    suggested_next_step: 'Re-check the batch on its date.',
    recommended_option: 'C',
  };

  it('accepts a valid, evidence-grounded explanation', async () => {
    const { real, oid, rec } = await withRec(fixtureProvider(valid));
    const r = await real.post(`/api/outlets/${oid}/recommendations/items/${rec.id}/explain`);
    expect(r.status).toBe(200);
    expect(r.body.ai).toMatchObject({ status: 'ok', model: 'claude-opus-5-5' });
    expect(r.body.ai.explanation.recommended_option).toBe('C');
  });

  it('rejects an explanation that favours an option blocked by a constraint, keeping the rule-based summary', async () => {
    const { real, oid, rec } = await withRec(fixtureProvider({ ...valid, recommended_option: 'A' }));
    expect(rec.options[0].feasible).toBe(false);
    const r = await real.post(`/api/outlets/${oid}/recommendations/items/${rec.id}/explain`);
    expect(r.status).toBe(502);
    expect(r.body.ai).toMatchObject({ status: 'safety_conflict', explanation: null });
    expect(r.body.ruleBased.summary).toBe(rec.problem);
    expect(r.body.ruleBased.recommended_option).not.toBe('A');
  });

  it('rejects unsupported quantities and options that do not exist', async () => {
    const a = await withRec(fixtureProvider({ ...valid, summary: 'About 999 ml will be wasted.' }));
    expect(
      (await a.real.post(`/api/outlets/${a.oid}/recommendations/items/${a.rec.id}/explain`)).body.ai.status,
    ).toBe('unsupported_claims');
    const b = await withRec(fixtureProvider({ ...valid, recommended_option: 'Z' }));
    expect(
      (await b.real.post(`/api/outlets/${b.oid}/recommendations/items/${b.rec.id}/explain`)).body.ai.status,
    ).toBe('unsupported_claims');
  });

  it('rejects malformed output and still serves the deterministic summary', async () => {
    const { real, oid, rec } = await withRec(fixtureProvider({ summary: 42 }));
    const r = await real.post(`/api/outlets/${oid}/recommendations/items/${rec.id}/explain`);
    expect(r.body.ai.status).toBe('invalid_output');
    expect(r.body.ruleBased.why.length).toBeGreaterThan(0);
    // the rest of the app is unaffected
    expect((await real.get(`/api/outlets/${oid}/dashboard`)).status).toBe(200);
  });
});

describe('service outcomes v2', () => {
  it('records transferred portions and validates the total', async () => {
    const { real } = await fresh();
    await setupOwner(real);
    const oid = await createOutlet(real);
    const item = (await real.post(`/api/outlets/${oid}/menu-items`, { name: 'Upma', category: 'Breakfast' }))
      .body;
    const bad = await real.post(`/api/outlets/${oid}/outcomes`, {
      date: '2026-10-10',
      menuItemId: item.id,
      prepared: 10,
      sold: 6,
      remaining: 0,
      transferred: 3,
      discarded: 2,
    });
    expect(bad.status).toBe(400);
    const ok = await real.post(`/api/outlets/${oid}/outcomes`, {
      date: '2026-10-10',
      menuItemId: item.id,
      prepared: 10,
      sold: 6,
      remaining: 0,
      transferred: 2,
      discarded: 2,
      discardReason: 'unsold_cooked',
    });
    expect(ok.status).toBe(201);
    const list = (await real.get(`/api/outlets/${oid}/outcomes`)).body;
    expect(list[0]).toMatchObject({ transferred: 2, discarded: 2 });
    const waste = (await real.get(`/api/outlets/${oid}/waste?from=2026-10-01&to=2026-10-10`)).body;
    expect(waste[0].reason).toBe('unsold_cooked');
  });
});

describe('menu handling fields', () => {
  it('treats blank handling fields as "not specified" and requires both before verification', async () => {
    const { real } = await fresh();
    await setupOwner(real);
    const oid = await createOutlet(real);
    const blank = await real.post(`/api/outlets/${oid}/menu-items`, {
      name: 'Tea',
      category: 'Beverages',
      handlingClass: '',
      handlingMaxHoldMin: '',
    });
    expect(blank.status).toBe(201);
    expect(blank.body).toMatchObject({
      handlingClass: null,
      handlingMaxHoldMin: null,
      handlingVerified: false,
    });
    const bad = await real.post(`/api/outlets/${oid}/menu-items`, {
      name: 'Coffee',
      category: 'Beverages',
      handlingVerified: true,
    });
    expect(bad.status).toBe(400);
    expect(bad.body.error.details.fields.handlingVerified).toBeDefined();
  });
});

describe('order disposition counts', () => {
  it('only counts orders whose food was actually prepared', async () => {
    const { real } = await fresh();
    await setupOwner(real);
    const oid = await createOutlet(real);
    const item = (await real.post(`/api/outlets/${oid}/menu-items`, { name: 'Dosa', category: 'Dosa' })).body;
    const early = (
      await real.post(`/api/outlets/${oid}/orders`, {
        channel: 'takeaway',
        placedAt: ago(30),
        items: [{ menuItemId: item.id, qty: 1 }],
      })
    ).body;
    await real.post(`/api/outlets/${oid}/orders/${early.id}/events`, {
      type: 'cancelled',
      at: ago(25),
      reason: 'Customer cancelled',
    });
    const late = (
      await real.post(`/api/outlets/${oid}/orders`, {
        channel: 'takeaway',
        placedAt: ago(30),
        items: [{ menuItemId: item.id, qty: 1 }],
      })
    ).body;
    for (const [type, m] of [
      ['prep_started', 28],
      ['prep_completed', 20],
    ] as const)
      await real.post(`/api/outlets/${oid}/orders/${late.id}/events`, { type, at: ago(m) });
    await real.post(`/api/outlets/${oid}/orders/${late.id}/events`, {
      type: 'cancelled',
      at: ago(10),
      reason: 'Customer cancelled',
    });
    const dash = (await real.get(`/api/outlets/${oid}/dashboard`)).body;
    expect(dash.delivery.needsDisposition).toBe(1);
    const list = (await real.get(`/api/outlets/${oid}/orders?view=open`)).body;
    expect(list.map((o: { id: number }) => o.id)).toEqual([late.id]);
  });
});
