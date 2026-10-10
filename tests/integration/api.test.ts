import { afterEach, describe, expect, it } from 'vitest';
import { addDays } from '../../shared/dates';
import { client, createOutlet, erroringProvider, makeApp, setupOwner, tempDbPath } from './helpers';

const TODAY = '2026-10-10';
let cleanups: (() => unknown)[] = [];
afterEach(async () => {
  for (const c of cleanups) await c();
  cleanups = [];
});

async function fresh(ai?: Parameters<typeof makeApp>[1]) {
  const t = tempDbPath();
  const { db, app } = await makeApp(t.path, ai);
  cleanups.push(async () => {
    await db.close();
    t.cleanup();
  });
  return { db, app, path: t.path, c: client(app) };
}

async function seedKitchen(c: ReturnType<typeof client>, oid: number) {
  const rice = await c.post(`/api/outlets/${oid}/ingredients`, {
    name: 'Basmati rice',
    category: 'Grains',
    baseUnit: 'g',
    initialStock: { qty: 4, unit: 'kg', totalCostInr: '360', receivedOn: '2026-10-08' },
  });
  expect(rice.status).toBe(201);
  const item = await c.post(`/api/outlets/${oid}/menu-items`, {
    name: 'Veg Biryani',
    category: 'Rice',
    priceInr: '180',
  });
  expect(item.status).toBe(201);
  const recipe = await c.put(`/api/outlets/${oid}/menu-items/${item.body.id}/recipe`, {
    verified: true,
    lines: [{ ingredientId: rice.body.id, qty: 200, unit: 'g', lossPct: 0 }],
  });
  expect(recipe.status).toBe(200);
  return { riceId: rice.body.id as number, itemId: item.body.id as number };
}

function salesCsv(days: number, perDay: number, name = 'Veg Biryani') {
  const rows = ['date,menu_item,quantity,service_period'];
  for (let i = 1; i <= days; i++) rows.push(`${addDays(TODAY, -i)},${name},${perDay},Lunch`);
  return rows.join('\n');
}

describe('auth and security', () => {
  it('requires the CSRF header on mutations and a session for outlet data', async () => {
    const { app, c } = await fresh();
    const { default: request } = await import('supertest');
    const noHeader = await request(app)
      .post('/api/auth/setup')
      .send({ username: 'x', displayName: 'x', password: 'password1' });
    expect(noHeader.status).toBe(403);
    expect((await request(app).get('/api/outlets/1')).status).toBe(401);
    await setupOwner(c);
    expect(
      (await c.post('/api/auth/setup', { username: 'second', displayName: 'S', password: 'password-2' }))
        .status,
    ).toBe(409);
  });

  it('rejects wrong passwords and throttles repeated failures', async () => {
    const { app, c } = await fresh();
    await setupOwner(c, 'throttle_user');
    const other = client(app);
    for (let i = 0; i < 5; i++)
      expect(
        (await other.post('/api/auth/login', { username: 'throttle_user', password: 'wrong-pass' })).status,
      ).toBe(401);
    expect(
      (await other.post('/api/auth/login', { username: 'throttle_user', password: 'test-password-1' }))
        .status,
    ).toBe(429);
  });

  it('prevents cross-outlet data access and enforces roles on the server', async () => {
    const { app, c } = await fresh();
    await setupOwner(c);
    const oid = await createOutlet(c);
    await seedKitchen(c, oid);
    // owner adds a staff member
    expect(
      (
        await c.post(`/api/outlets/${oid}/members`, {
          username: 'staff1',
          displayName: 'Staff One',
          role: 'staff',
          password: 'staff-pass-1',
        })
      ).status,
    ).toBe(201);
    const staff = client(app);
    expect(
      (await staff.post('/api/auth/login', { username: 'staff1', password: 'staff-pass-1' })).status,
    ).toBe(200);
    expect((await staff.get(`/api/outlets/${oid}/ingredients`)).status).toBe(200);
    expect(
      (await staff.post(`/api/outlets/${oid}/ingredients`, { name: 'X', category: 'Y', baseUnit: 'g' }))
        .status,
    ).toBe(403);
    expect((await staff.post(`/api/outlets/${oid}/recommendations/run`, {})).status).toBe(403);
    // staff creates their own outlet; owner cannot see it and vice versa
    const staffOutlet = await createOutlet(staff, 'Staff Cafe');
    expect((await c.get(`/api/outlets/${staffOutlet}/ingredients`)).status).toBe(404);
    // and records from another outlet cannot be addressed through this outlet
    const ing = await staff.post(`/api/outlets/${staffOutlet}/ingredients`, {
      name: 'Milk',
      category: 'Dairy',
      baseUnit: 'ml',
    });
    expect((await c.get(`/api/outlets/${oid}/ingredients/${ing.body.id}`)).status).toBe(404);
  });
});

describe('inventory', () => {
  it('creates, edits and moves stock with a persisted movement history', async () => {
    const { c } = await fresh();
    await setupOwner(c);
    const oid = await createOutlet(c);
    const { riceId } = await seedKitchen(c, oid);
    const base = `/api/outlets/${oid}`;

    let d = (await c.get(`${base}/ingredients/${riceId}`)).body;
    expect(d.usableQty).toBe(4000);
    expect(d.unitCostPaise).toBeCloseTo(9, 6); // ₹360 / 4000 g

    expect(
      (
        await c.put(`${base}/ingredients/${riceId}`, {
          name: 'Basmati rice (aged)',
          category: 'Grains',
          baseUnit: 'g',
          supplierName: 'Local wholesaler',
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await c.post(`${base}/ingredients/${riceId}/receipts`, {
          qty: 1,
          unit: 'kg',
          totalCostInr: '95',
          receivedOn: TODAY,
          dateType: 'best_before',
          dateValue: '2026-12-31',
          lotCode: 'R2',
        })
      ).status,
    ).toBe(201);
    expect(
      (
        await c.post(`${base}/ingredients/${riceId}/consumption`, {
          qty: 500,
          unit: 'g',
          reason: 'Staff meal',
        })
      ).status,
    ).toBe(200);
    const count = await c.post(`${base}/ingredients/${riceId}/count`, { qty: 4.4, unit: 'kg' });
    expect(count.body.result).toMatchObject({ before: 4500, after: 4400, diff: -100 });

    d = (await c.get(`${base}/ingredients/${riceId}`)).body;
    expect(d.name).toBe('Basmati rice (aged)');
    expect(d.usableQty).toBe(4400);
    expect(d.movements.map((m: { type: string }) => m.type)).toEqual([
      'count',
      'consumption',
      'receipt',
      'receipt',
    ]);
    expect(d.movements[1].reason).toBe('Staff meal');
  });

  it('rejects incompatible units and invalid quantities', async () => {
    const { c } = await fresh();
    await setupOwner(c);
    const oid = await createOutlet(c);
    const { riceId } = await seedKitchen(c, oid);
    const r1 = await c.post(`/api/outlets/${oid}/ingredients/${riceId}/receipts`, {
      qty: 2,
      unit: 'L',
      receivedOn: TODAY,
    });
    expect(r1.status).toBe(400);
    expect(r1.body.error.details.fields.unit).toBeDefined();
    const r2 = await c.post(`/api/outlets/${oid}/ingredients/${riceId}/receipts`, {
      qty: -1,
      unit: 'kg',
      receivedOn: TODAY,
    });
    expect(r2.status).toBe(400);
    expect(r2.body.error.details.fields.qty).toMatch(/greater than zero/);
    const r3 = await c.post(`/api/outlets/${oid}/ingredients/${riceId}/receipts`, {
      qty: 1,
      unit: 'kg',
      receivedOn: TODAY,
      dateType: 'use_by',
    });
    expect(r3.status).toBe(400);
  });

  it('never consumes expired stock', async () => {
    const { c } = await fresh();
    await setupOwner(c);
    const oid = await createOutlet(c);
    const milk = await c.post(`/api/outlets/${oid}/ingredients`, {
      name: 'Milk',
      category: 'Dairy',
      baseUnit: 'ml',
      initialStock: {
        qty: 2,
        unit: 'L',
        totalCostInr: '124',
        receivedOn: '2026-10-07',
        dateType: 'use_by',
        dateValue: '2026-10-09',
      },
    });
    const r = await c.post(`/api/outlets/${oid}/ingredients/${milk.body.id}/consumption`, {
      qty: 500,
      unit: 'ml',
      reason: 'Coffee',
    });
    expect(r.status).toBe(409);
    expect(r.body.error.message).toMatch(/Expired, unsafe or unchecked batches cannot be consumed/);
    const detail = (await c.get(`/api/outlets/${oid}/ingredients/${milk.body.id}`)).body;
    expect(detail.flags.unsafe).toBe(true);
    expect(detail.usableQty).toBe(0);
  });

  it('neutralises formula injection in CSV exports', async () => {
    const { c } = await fresh();
    await setupOwner(c);
    const oid = await createOutlet(c);
    await c.post(`/api/outlets/${oid}/ingredients`, {
      name: '=HYPERLINK("http://x")',
      category: 'Test',
      baseUnit: 'g',
      initialStock: { qty: 1, unit: 'kg', receivedOn: TODAY },
    });
    const csv = await c.get(`/api/outlets/${oid}/export/inventory.csv`);
    expect(csv.status).toBe(200);
    expect(csv.text).toContain(`"'=HYPERLINK(""http://x"")"`);
  });
});

describe('recipes', () => {
  it('links ingredients, rejects incompatible recipe units and computes cost per portion', async () => {
    const { c } = await fresh();
    await setupOwner(c);
    const oid = await createOutlet(c);
    const { riceId, itemId } = await seedKitchen(c, oid);
    const bad = await c.put(`/api/outlets/${oid}/menu-items/${itemId}/recipe`, {
      verified: true,
      lines: [{ ingredientId: riceId, qty: 1, unit: 'pc' }],
    });
    expect(bad.status).toBe(400);
    expect(bad.body.error.details.fields['lines.0.unit']).toMatch(/cannot be converted/);
    const item = (await c.get(`/api/outlets/${oid}/menu-items/${itemId}`)).body;
    expect(item.recipe.verified).toBe(true);
    expect(item.costPerPortionPaise).toBe(1800); // 200 g × 9 paise
    expect(item.foodCostPct).toBe(10);
    const ing = (await c.get(`/api/outlets/${oid}/ingredients/${riceId}`)).body;
    expect(ing.usedIn.map((u: { name: string }) => u.name)).toEqual(['Veg Biryani']);
  });
});

describe('sales import', () => {
  it('previews, reports invalid and duplicate rows, and saves valid rows only after confirmation', async () => {
    const { c } = await fresh();
    await setupOwner(c);
    const oid = await createOutlet(c);
    await seedKitchen(c, oid);
    const base = `/api/outlets/${oid}`;
    expect(
      (
        await c.post(`${base}/sales`, {
          date: '2026-10-01',
          menuItemId: (await c.get(`${base}/menu-items`)).body[0].id,
          qty: 5,
          servicePeriod: 'Lunch',
        })
      ).status,
    ).toBe(201);

    const csv = [
      'date,menu_item,quantity,service_period',
      '2026-10-02,Veg Biryani,30,Lunch',
      '03/10/2026,Veg Biryani,28,Lunch',
      '2026-10-03,Veg Biryani,99,Lunch', // duplicate in file
      '2026-10-01,Veg Biryani,7,Lunch', // duplicate of existing record
      '2026-10-04,Chicken 65,10,Lunch', // unknown item
      '2026-10-05,Veg Biryani,abc,Lunch', // invalid qty
      '2026-10-06,Veg Biryani,12,Dinner', // invalid period
    ].join('\n');
    const prev = await c.post(`${base}/sales/import/preview`, { filename: 'test.csv', csvText: csv });
    expect(prev.status).toBe(200);
    expect(prev.body.summary).toEqual({
      total: 7,
      valid: 2,
      invalid: 3,
      duplicateInFile: 1,
      duplicateExisting: 1,
    });
    // Nothing saved yet
    expect((await c.get(`${base}/sales?from=2026-10-01&to=2026-10-09`)).body.rows).toHaveLength(1);

    const commit = await c.post(`${base}/sales/import/${prev.body.importId}/commit`);
    expect(commit.body).toEqual({ imported: 2, skippedAsDuplicate: 0, notImported: 5 });
    expect((await c.post(`${base}/sales/import/${prev.body.importId}/commit`)).status).toBe(409);
    const rows = (await c.get(`${base}/sales?from=2026-10-01&to=2026-10-09`)).body.rows;
    expect(rows).toHaveLength(3);
    expect(rows.filter((r: { source: string }) => r.source === 'csv_import')).toHaveLength(2);
  });

  it('rejects files with missing columns', async () => {
    const { c } = await fresh();
    await setupOwner(c);
    const oid = await createOutlet(c);
    const r = await c.post(`/api/outlets/${oid}/sales/import/preview`, { csvText: 'day,item\n2026-10-01,x' });
    expect(r.status).toBe(400);
    expect(r.body.error.message).toMatch(/menu_item/);
  });
});

describe('decision workflow end to end', () => {
  it('runs the engine on persisted data, approves a plan, records outcome and computes metrics', async () => {
    const { c, app } = await fresh();
    await setupOwner(c);
    const oid = await createOutlet(c);
    const { riceId, itemId } = await seedKitchen(c, oid);
    const base = `/api/outlets/${oid}`;
    const prev = await c.post(`${base}/sales/import/preview`, { csvText: salesCsv(28, 30) });
    await c.post(`${base}/sales/import/${prev.body.importId}/commit`);

    // 1. Run engine
    const run = await c.post(`${base}/recommendations/run`, {});
    expect(run.status).toBe(201);
    const stockout = run.body.items.find((i: { kind: string }) => i.kind === 'stockout_risk');
    expect(stockout.problem).toContain('6 kg'); // 30 × 200 g
    expect(stockout.evidence.sales[0].daysUsed).toBe(4);
    expect(stockout.evidence.recipes[0].qtyPerServing).toBe('200 g');
    expect(run.body.forecasts[0]).toMatchObject({ method: 'same_weekday', mean: 30 });

    // 2. Draft a plan with the "cap preparation" option; edit; submit
    const plan = await c.post(`${base}/plans`, {
      runId: run.body.id,
      selections: [{ itemId: stockout.id, optionKey: 'B' }],
    });
    expect(plan.status).toBe(201);
    expect(plan.body.status).toBe('draft');
    const line = plan.body.lines[0];
    expect(line).toMatchObject({ type: 'prep', proposedQty: 20 });
    expect(
      (await c.put(`${base}/plans/${plan.body.id}/lines/${line.id}`, { qty: 18 })).body.lines[0].proposedQty,
    ).toBe(18);
    expect((await c.post(`${base}/plans/${plan.body.id}/approve`)).status).toBe(409); // must submit first
    expect((await c.post(`${base}/plans/${plan.body.id}/submit`)).body.status).toBe('awaiting_approval');

    // A staff member cannot approve
    await c.post(`${base}/members`, {
      username: 'staff2',
      displayName: 'Staff',
      role: 'staff',
      password: 'staff-pass-2',
    });
    const staff = client(app);
    await staff.post('/api/auth/login', { username: 'staff2', password: 'staff-pass-2' });
    expect((await staff.post(`${base}/plans/${plan.body.id}/approve`)).status).toBe(403);

    // 3. Approve → creates tasks; history keeps original and edited values
    const approved = await c.post(`${base}/plans/${plan.body.id}/approve`);
    expect(approved.body.status).toBe('approved');
    expect(approved.body.lines[0]).toMatchObject({ originalQty: 20, proposedQty: 18, approvedQty: 18 });
    expect(approved.body.history.map((h: { action: string }) => h.action)).toEqual([
      'create',
      'edit_line',
      'submit',
      'approve',
    ]);
    expect(approved.body.tasks).toHaveLength(1);
    const taskId = approved.body.tasks[0].id;

    // 4. Staff completes the task with the actual quantity → plan auto-completes
    expect((await staff.post(`${base}/tasks/${taskId}/complete`, {})).status).toBe(400);
    expect((await staff.post(`${base}/tasks/${taskId}/complete`, { actualQty: 18 })).status).toBe(200);
    expect((await c.get(`${base}/plans/${plan.body.id}`)).body.status).toBe('completed');

    // 5. Record the actual service outcome, deducting ingredients and adding sales
    const out = await staff.post(`${base}/outcomes`, {
      date: TODAY,
      servicePeriod: 'Lunch',
      menuItemId: itemId,
      prepared: 18,
      sold: 17,
      remaining: 0,
      discarded: 1,
      taskId,
      recordSales: true,
      deductIngredients: true,
    });
    expect(out.status).toBe(201);
    expect(out.body.effects).toHaveLength(3);
    const rice = (await c.get(`${base}/ingredients/${riceId}`)).body;
    expect(rice.usableQty).toBe(400); // 4000 − 18 × 200
    // Over-reporting is rejected
    expect(
      (
        await c.post(`${base}/outcomes`, {
          date: TODAY,
          servicePeriod: 'Breakfast',
          menuItemId: itemId,
          prepared: 5,
          sold: 6,
          remaining: 0,
          discarded: 0,
        })
      ).status,
    ).toBe(400);

    // 6. Metrics come only from recorded rows
    const a = (await c.get(`${base}/analytics?from=2026-10-01&to=${TODAY}`)).body;
    expect(a.waste.discardedPortions).toBe(1);
    expect(a.waste.estimatedCostPaise).toBe(1800); // 1 portion × recipe cost estimate
    expect(a.waste.recordedCostPaise).toBe(0);
    expect(a.sales.portionsSold).toBe(9 * 30 + 17);
    expect(a.wastePer100Portions.value).toBeCloseTo((1 / 287) * 100, 2);
    expect(a.actions.plans).toEqual({ completed: 1 });
    expect(a.prepComparisons[0].result.observedDiscardDiff).toBeNull(); // no earlier outcomes → no claim
    expect(a.estimatedImpactOfApprovedRecommendations.recommendations).toBe(1);

    // 7. Audit trail exists
    const audit = (await c.get(`${base}/audit`)).body;
    expect(
      audit.some(
        (e: { entityType: string; action: string }) => e.entityType === 'plan' && e.action === 'approve',
      ),
    ).toBe(true);
  });

  it('requires a reason to reject and records it', async () => {
    const { c } = await fresh();
    await setupOwner(c);
    const oid = await createOutlet(c);
    await seedKitchen(c, oid);
    const base = `/api/outlets/${oid}`;
    const prev = await c.post(`${base}/sales/import/preview`, { csvText: salesCsv(28, 30) });
    await c.post(`${base}/sales/import/${prev.body.importId}/commit`);
    const run = (await c.post(`${base}/recommendations/run`, {})).body;
    const rec = run.items.find((i: { kind: string }) => i.kind === 'stockout_risk');
    const plan = (
      await c.post(`${base}/plans`, { runId: run.id, selections: [{ itemId: rec.id, optionKey: 'A' }] })
    ).body;
    await c.post(`${base}/plans/${plan.id}/submit`);
    expect((await c.post(`${base}/plans/${plan.id}/reject`, {})).status).toBe(400);
    const rej = await c.post(`${base}/plans/${plan.id}/reject`, { reason: 'Supplier closed today' });
    expect(rej.body).toMatchObject({
      status: 'rejected',
      rejectionReason: 'Supplier closed today',
      tasks: [],
    });
    expect(rej.body.history.at(-1)).toMatchObject({ action: 'reject', reason: 'Supplier closed today' });
  });

  it('discard tasks remove unsafe stock and record waste at batch cost', async () => {
    const { c } = await fresh();
    await setupOwner(c);
    const oid = await createOutlet(c);
    const base = `/api/outlets/${oid}`;
    const milk = await c.post(`${base}/ingredients`, {
      name: 'Milk',
      category: 'Dairy',
      baseUnit: 'ml',
      initialStock: {
        qty: 2,
        unit: 'L',
        totalCostInr: '124',
        receivedOn: '2026-10-07',
        dateType: 'use_by',
        dateValue: '2026-10-09',
      },
    });
    const run = (await c.post(`${base}/recommendations/run`, {})).body;
    expect(run.items[0].kind).toBe('unsafe_stock');
    const plan = (
      await c.post(`${base}/plans`, {
        runId: run.id,
        selections: [{ itemId: run.items[0].id, optionKey: 'A' }],
      })
    ).body;
    await c.post(`${base}/plans/${plan.id}/submit`);
    const ap = (await c.post(`${base}/plans/${plan.id}/approve`)).body;
    const done = await c.post(`${base}/tasks/${ap.tasks[0].id}/complete`, {});
    expect(done.body.effects[0]).toMatch(/2 L of Milk as waste/);
    expect((await c.get(`${base}/ingredients/${milk.body.id}`)).body.excludedQty).toBe(0);
    const waste = (await c.get(`${base}/waste?from=2026-10-01&to=${TODAY}`)).body;
    expect(waste[0]).toMatchObject({ reason: 'expired', costPaise: 12400, costBasis: 'batch_cost' });
  });

  it('rejects plan options marked infeasible', async () => {
    const { c } = await fresh();
    await setupOwner(c);
    const oid = await createOutlet(c);
    const base = `/api/outlets/${oid}`;
    await c.post(`${base}/ingredients`, {
      name: 'Cream',
      category: 'Dairy',
      baseUnit: 'ml',
      initialStock: { qty: 500, unit: 'ml', receivedOn: TODAY, dateType: 'expiry', dateValue: '2026-10-11' },
    });
    const run = (await c.post(`${base}/recommendations/run`, {})).body;
    const rec = run.items.find((i: { kind: string }) => i.kind === 'expiry_waste_risk');
    const r = await c.post(`${base}/plans`, {
      runId: run.id,
      selections: [{ itemId: rec.id, optionKey: 'A' }],
    });
    expect(r.status).toBe(400);
    expect(r.body.error.message).toMatch(/not feasible/);
  });
});

describe('AI explanation layer', () => {
  it('reports "not configured" honestly when no API key is set', async () => {
    const { c } = await fresh();
    await setupOwner(c);
    const oid = await createOutlet(c);
    await c.post(`/api/outlets/${oid}/ingredients`, {
      name: 'Milk',
      category: 'Dairy',
      baseUnit: 'ml',
      initialStock: {
        qty: 1,
        unit: 'L',
        receivedOn: '2026-10-07',
        dateType: 'use_by',
        dateValue: '2026-10-09',
      },
    });
    const status = (await c.get(`/api/outlets/${oid}/ai/status`)).body;
    expect(status).toMatchObject({ configured: false, provider: null });
    const run = (await c.post(`/api/outlets/${oid}/recommendations/run`, {})).body;
    const r = await c.post(`/api/outlets/${oid}/recommendations/items/${run.items[0].id}/explain`);
    expect(r.status).toBe(503);
    expect(r.body.ai).toMatchObject({ status: 'not_configured', explanation: null });
    // deterministic recommendation is still intact
    expect(r.body.calculation.length).toBeGreaterThan(0);
  });

  it.each([
    [500, 'provider_error'],
    [429, 'rate_limited'],
    [401, 'auth'],
  ])(
    'maps provider HTTP %i to %s without fabricating an explanation',
    async (status, code) => {
      const { c } = await fresh(erroringProvider(status));
      await setupOwner(c);
      const oid = await createOutlet(c);
      await c.post(`/api/outlets/${oid}/ingredients`, {
        name: 'Milk',
        category: 'Dairy',
        baseUnit: 'ml',
        initialStock: {
          qty: 1,
          unit: 'L',
          receivedOn: '2026-10-07',
          dateType: 'use_by',
          dateValue: '2026-10-09',
        },
      });
      const run = (await c.post(`/api/outlets/${oid}/recommendations/run`, {})).body;
      const r = await c.post(`/api/outlets/${oid}/recommendations/items/${run.items[0].id}/explain`);
      expect(r.status).toBe(502);
      expect(r.body.ai.status).toBe(code);
      expect(r.body.ai.explanation).toBeNull();
      const st = (await c.get(`/api/outlets/${oid}/ai/status`)).body;
      expect(st.last.lastResult).toBe(code);
    },
    20000,
  );
});

describe('persistence', () => {
  it('keeps data across an application restart', async () => {
    const t = tempDbPath();
    cleanups.push(t.cleanup);
    const first = await makeApp(t.path);
    const c1 = client(first.app);
    await setupOwner(c1);
    const oid = await createOutlet(c1);
    await seedKitchen(c1, oid);
    await first.db.close();

    const second = await makeApp(t.path);
    cleanups.unshift(() => second.db.close());
    const c2 = client(second.app);
    expect(
      (await c2.post('/api/auth/login', { username: 'owner1', password: 'test-password-1' })).status,
    ).toBe(200);
    const list = (await c2.get(`/api/outlets/${oid}/ingredients`)).body.items;
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ name: 'Basmati rice', usableQty: 4000 });
  });
});

describe('data deletion', () => {
  it('deletes an outlet and all of its records (owner only, name confirmed)', async () => {
    const { c, db } = await fresh();
    await setupOwner(c);
    const oid = await createOutlet(c, 'Delete Me');
    await seedKitchen(c, oid);
    const prev = await c.post(`/api/outlets/${oid}/sales/import/preview`, { csvText: salesCsv(28, 30) });
    await c.post(`/api/outlets/${oid}/sales/import/${prev.body.importId}/commit`);
    await c.post(`/api/outlets/${oid}/recommendations/run`, {});
    expect((await c.del(`/api/outlets/${oid}`, { confirmName: 'wrong' })).status).toBe(400);
    expect((await c.del(`/api/outlets/${oid}`, { confirmName: 'Delete Me' })).status).toBe(200);
    expect((await c.get(`/api/outlets/${oid}/ingredients`)).status).toBe(404);
    for (const table of [
      'ingredients',
      'inventory_batches',
      'stock_movements',
      'menu_items',
      'recipes',
      'sales_records',
      'recommendation_runs',
      'recommendation_items',
    ]) {
      const row = await db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table}`);
      expect(row!.n, table).toBe(0);
    }
  });
});
