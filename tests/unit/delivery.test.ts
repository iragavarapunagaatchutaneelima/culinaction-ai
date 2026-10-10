// TEST FIXTURES ONLY — synthetic order timelines for isolated unit tests.
import { describe, expect, it } from 'vitest';
import { assessDeliveryRisk, type RiskInput } from '../../shared/deliveryRisk';
import { runEngine } from '../../shared/engine';
import {
  allowedEvents,
  applyEvent,
  durations,
  orderStage,
  OrderTransitionError,
  preparedButUndelivered,
  replay,
  type OrderEvent,
} from '../../shared/orders';
import type { OrderSnap } from '../../shared/types';
import { batch, dailySales, ingredient, menuItem, snapshot } from './fixtures';

const NOW = '2026-10-10T07:00:00.000Z';
const at = (minAgo: number) => new Date(Date.parse(NOW) - minAgo * 60_000).toISOString();
const ev = (type: OrderEvent['type'], minAgo: number, reason?: string): OrderEvent => ({
  type,
  at: at(minAgo),
  reason,
});

const delivered: OrderEvent[] = [
  ev('received', 60),
  ev('prep_started', 58),
  ev('prep_completed', 40),
  ev('pack_started', 39),
  ev('pack_completed', 36),
  ev('ready_for_pickup', 35),
  ev('picked_up', 25),
  ev('out_for_delivery', 24),
  ev('delivered', 5),
];

describe('order lifecycle', () => {
  it('replays a valid delivery timeline', () => {
    expect(replay(delivered, NOW)).toBe('delivered');
  });
  it('requires "received" first and rejects skipped steps', () => {
    expect(() => applyEvent(null, [], ev('prep_started', 5), NOW)).toThrow(/first event/);
    expect(() => applyEvent('received', [ev('received', 10)], ev('picked_up', 5), NOW)).toThrow(
      OrderTransitionError,
    );
    expect(() => applyEvent('delivered', delivered, ev('prep_started', 1), NOW)).toThrow(/not allowed/);
  });
  it('rejects timestamps that go backwards or are in the future', () => {
    expect(() => applyEvent('received', [ev('received', 10)], ev('prep_started', 20), NOW)).toThrow(
      /earlier/,
    );
    expect(() => applyEvent('received', [ev('received', 10)], ev('prep_started', -30), NOW)).toThrow(
      /future/,
    );
  });
  it('allows rider assignment once without changing status', () => {
    const h = [ev('received', 10)];
    expect(applyEvent('received', h, ev('rider_assigned', 9), NOW)).toBe('received');
    expect(() =>
      applyEvent('received', [...h, ev('rider_assigned', 9)], ev('rider_assigned', 8), NOW),
    ).toThrow(/already/);
    expect(allowedEvents('received', [...h, ev('rider_assigned', 9)])).not.toContain('rider_assigned');
  });
  it('calculates durations from recorded timestamps only', () => {
    const d = durations(delivered, 'delivered', NOW);
    expect(d).toMatchObject({
      prepMin: 18,
      packMin: 3,
      readyWaitMin: 10,
      readyWaitOngoing: false,
      deliveryMin: 20,
      totalMin: 55,
      holdMin: 35,
    });
    const partial = durations([ev('received', 30), ev('prep_started', 25)], 'preparing', NOW);
    expect(partial.prepMin).toBeNull(); // not invented
    expect(partial.totalMin).toBe(30);
    expect(partial.totalOngoing).toBe(true);
  });
  it('measures an ongoing pickup wait up to now', () => {
    const waiting = [
      ev('received', 50),
      ev('prep_started', 48),
      ev('prep_completed', 30),
      ev('ready_for_pickup', 22),
    ];
    expect(durations(waiting, 'ready_for_pickup', NOW)).toMatchObject({
      readyWaitMin: 22,
      readyWaitOngoing: true,
      holdMin: 30,
    });
  });
  it('classifies cancellation stages', () => {
    expect(orderStage([ev('received', 10), ev('cancelled', 5)], 'cancelled')).toBe('cancelled_before_prep');
    expect(orderStage([ev('received', 10), ev('prep_started', 8), ev('cancelled', 5)], 'cancelled')).toBe(
      'cancelled_during_prep',
    );
    const packed = [
      ev('received', 50),
      ev('prep_started', 48),
      ev('prep_completed', 30),
      ev('pack_started', 29),
      ev('pack_completed', 27),
      ev('ready_for_pickup', 26),
      ev('marked_uncollected', 2),
    ];
    expect(orderStage(packed, 'uncollected')).toBe('packed_not_collected');
    expect(preparedButUndelivered(packed, 'uncollected')).toBe(true);
    expect(preparedButUndelivered([ev('received', 10), ev('cancelled', 5)], 'cancelled')).toBe(false);
    expect(orderStage([...delivered, ev('returned', 1)], 'returned')).toBe('returned');
  });
});

const settings = { prepWarnMin: 25, readyWaitWarnMin: 10, readyWaitHighMin: 20, deliveryTargetMin: 45 };
const hot = {
  name: 'Chicken Biryani',
  handlingClass: 'hot' as const,
  maxHoldMin: 60,
  handlingVerified: true,
};
const base = (p: Partial<RiskInput>): RiskInput => ({
  status: 'ready_for_pickup',
  events: [],
  items: [hot],
  estTravelMin: 15,
  packaging: 'Sealed foil container',
  delayReason: null,
  settings,
  nowIso: NOW,
  ...p,
});

describe('delivery risk', () => {
  it('is low when recorded times are within thresholds', () => {
    const r = assessDeliveryRisk(
      base({
        events: [
          ev('received', 20),
          ev('prep_started', 19),
          ev('prep_completed', 8),
          ev('ready_for_pickup', 5),
        ],
      }),
    );
    expect(r.level).toBe('low');
    expect(r.projectedHoldMin).toBe(23); // 8 min held + 15 min travel
  });
  it('is moderate when the pickup wait passes the warning threshold', () => {
    const r = assessDeliveryRisk(
      base({
        events: [
          ev('received', 40),
          ev('prep_started', 38),
          ev('prep_completed', 25),
          ev('ready_for_pickup', 12),
        ],
      }),
    );
    expect(r.level).toBe('moderate');
    expect(r.factors.find((f) => f.factor.startsWith('Waiting'))?.effect).toBe('raises');
  });
  it('is high when projected hold time exceeds the verified handling limit', () => {
    const r = assessDeliveryRisk(
      base({
        estTravelMin: 30,
        events: [
          ev('received', 60),
          ev('prep_started', 58),
          ev('prep_completed', 40),
          ev('ready_for_pickup', 15),
        ],
      }),
    );
    expect(r.level).toBe('high');
    expect(r.limitMin).toBe(60);
    expect(r.projectedHoldMin).toBe(70);
  });
  it('reports missing information instead of assuming', () => {
    const r = assessDeliveryRisk(
      base({
        items: [{ ...hot, handlingVerified: false }],
        estTravelMin: null,
        packaging: null,
        events: [
          ev('received', 20),
          ev('prep_started', 19),
          ev('prep_completed', 8),
          ev('ready_for_pickup', 5),
        ],
      }),
    );
    expect(r.limitMin).toBeNull();
    expect(r.missing.join(' ')).toMatch(/Verified handling limit/);
    expect(r.missing.join(' ')).toMatch(/Estimated travel time/);
    expect(r.missing.join(' ')).toMatch(/Packaging/);
  });
  it('returns insufficient information when there are no usable timestamps', () => {
    expect(assessDeliveryRisk(base({ events: [] })).level).toBe('insufficient');
    expect(
      assessDeliveryRisk(base({ status: 'received', events: [ev('received', 2)], items: [] })).level,
    ).toBe('insufficient');
  });
});

describe('engine: delivery and order recommendations', () => {
  const order = (p: Partial<OrderSnap>): OrderSnap => ({
    id: 1,
    ref: 'T-1',
    channel: 'aggregator',
    status: 'ready_for_pickup',
    placedAt: at(60),
    estTravelMin: 15,
    packaging: 'foil',
    delayReason: null,
    disposition: null,
    items: [{ menuItemId: 10, qty: 2 }],
    events: [],
    ...p,
  });
  const snap = (orders: OrderSnap[]) =>
    snapshot({
      nowIso: NOW,
      ingredients: [
        ingredient({ id: 1, name: 'Rice', batches: [batch({ qtyRemaining: 50000, unitCostPaise: 9 })] }),
      ],
      menuItems: [
        menuItem({
          id: 10,
          name: 'Veg Biryani',
          handlingClass: 'hot',
          handlingMaxHoldMin: 45,
          handlingVerified: true,
          lines: [{ ingredientId: 1, qty: 200, unit: 'g', lossPct: 0 }],
        }),
      ],
      sales: dailySales(10, '2026-10-10', 28, 30),
      orders,
    });

  it('flags a long pickup wait and escalates to tier 1 when the verified limit is exceeded', () => {
    const waiting = order({
      events: [
        ev('received', 60),
        ev('prep_started', 58),
        ev('prep_completed', 40),
        ev('ready_for_pickup', 25),
      ],
    });
    const res = runEngine(snap([waiting]));
    const r = res.recommendations.find((x) => x.kind === 'pickup_delay')!;
    expect(r.severityTier).toBe(1);
    expect(r.options[0].key).toBe('C');
    expect(r.options.flatMap((o) => o.lines).every((l) => l.type === 'order_action')).toBe(true);
    expect(res.orderRisks[0]).toMatchObject({ orderId: 1, level: 'high' });
  });

  it('offers disposal (never resale) for an uncollected prepared order, and hold only within the verified limit', () => {
    const uncollected = order({
      status: 'uncollected',
      events: [
        ev('received', 50),
        ev('prep_started', 48),
        ev('prep_completed', 30),
        ev('ready_for_pickup', 29),
        ev('marked_uncollected', 1),
      ],
    });
    const r = runEngine(snap([uncollected])).recommendations.find((x) => x.kind === 'order_disposition')!;
    expect(r.options.map((o) => o.key)).toEqual(['A', 'B']);
    expect(r.options[0].lines[0]).toMatchObject({ type: 'dispose_order', qty: 2 });
    expect(r.estimatedImpactPaise).toBe(2 * 200 * 9); // 2 portions × 200 g × 9 paise
    expect(r.options[1].feasible).toBe(true); // 30 min held < 45 min verified limit
    const stale = order({
      status: 'uncollected',
      events: [
        ev('received', 90),
        ev('prep_started', 88),
        ev('prep_completed', 70),
        ev('ready_for_pickup', 69),
        ev('marked_uncollected', 1),
      ],
    });
    const r2 = runEngine(snap([stale])).recommendations.find((x) => x.kind === 'order_disposition')!;
    expect(r2.options[1].feasible).toBe(false);
    expect(r2.options[1].infeasibleReason).toMatch(/already passed/);
  });

  it('never offers to hold or re-serve customer-returned food', () => {
    const returned = order({ status: 'returned', events: [...delivered, ev('returned', 2)] });
    const r = runEngine(snap([returned])).recommendations.find((x) => x.kind === 'order_disposition')!;
    expect(r.options.map((o) => o.key)).toEqual(['A']);
    expect(r.safetyChecks.join(' ')).toMatch(/never offered to another customer/);
  });

  it('does not ask for a disposition when food was never prepared or one is already recorded', () => {
    const early = order({ status: 'cancelled', events: [ev('received', 10), ev('cancelled', 5)] });
    const done = order({
      id: 2,
      ref: 'T-2',
      status: 'uncollected',
      disposition: 'disposed',
      events: [
        ev('received', 50),
        ev('prep_started', 48),
        ev('prep_completed', 30),
        ev('ready_for_pickup', 29),
        ev('marked_uncollected', 1),
      ],
    });
    expect(runEngine(snap([early, done])).recommendations.some((x) => x.kind === 'order_disposition')).toBe(
      false,
    );
  });

  it('requires a storage check before an expiring batch is used', () => {
    const s = snapshot({
      ingredients: [
        ingredient({
          id: 1,
          name: 'Paneer',
          batches: [
            batch({
              qtyRemaining: 2000,
              unitCostPaise: 40,
              lotCode: 'P1',
              dateType: 'use_by',
              dateValue: '2026-10-11',
            }),
          ],
        }),
      ],
      menuItems: [
        menuItem({
          id: 10,
          name: 'Paneer tikka',
          lines: [{ ingredientId: 1, qty: 100, unit: 'g', lossPct: 0 }],
        }),
      ],
      sales: dailySales(10, '2026-10-10', 28, (i) => (i % 2 ? 6 : 4)),
    });
    const r = runEngine(s).recommendations.find((x) => x.kind === 'expiry_waste_risk')!;
    expect(r.options[0].lines[0]).toMatchObject({ type: 'verify', subjectType: 'batch' });
    expect(r.missingInfo.join(' ')).toMatch(/Storage check/);
  });
});
