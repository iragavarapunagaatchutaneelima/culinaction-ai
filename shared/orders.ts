// Order lifecycle: allowed events, status transitions, stage classification and durations.
// Pure functions; timestamps are ISO-8601 UTC strings. Missing timestamps are never invented.

export const ORDER_STATUSES = [
  'received',
  'preparing',
  'prepared',
  'packing',
  'packed',
  'ready_for_pickup',
  'picked_up',
  'in_transit',
  'delivered',
  'cancelled',
  'uncollected',
  'returned',
  'closed',
] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];

export const ORDER_EVENTS = [
  'received',
  'prep_started',
  'prep_completed',
  'pack_started',
  'pack_completed',
  'rider_assigned',
  'ready_for_pickup',
  'picked_up',
  'out_for_delivery',
  'delivered',
  'cancelled',
  'marked_uncollected',
  'returned',
  'closed',
] as const;
export type OrderEventType = (typeof ORDER_EVENTS)[number];

export const ORDER_CHANNELS = ['dine_in', 'takeaway', 'own_delivery', 'aggregator', 'other'] as const;
export type OrderChannel = (typeof ORDER_CHANNELS)[number];

export const STATUS_LABELS: Record<OrderStatus, string> = {
  received: 'Received',
  preparing: 'Preparing',
  prepared: 'Prepared',
  packing: 'Packing',
  packed: 'Packed',
  ready_for_pickup: 'Ready for pickup',
  picked_up: 'Picked up',
  in_transit: 'Out for delivery',
  delivered: 'Delivered',
  cancelled: 'Cancelled',
  uncollected: 'Not collected',
  returned: 'Returned',
  closed: 'Closed',
};

export const EVENT_LABELS: Record<OrderEventType, string> = {
  received: 'Order received',
  prep_started: 'Preparation started',
  prep_completed: 'Preparation completed',
  pack_started: 'Packing started',
  pack_completed: 'Packing completed',
  rider_assigned: 'Rider assigned',
  ready_for_pickup: 'Ready for pickup',
  picked_up: 'Picked up',
  out_for_delivery: 'Delivery in progress',
  delivered: 'Delivered',
  cancelled: 'Cancelled',
  marked_uncollected: 'Marked not collected',
  returned: 'Returned',
  closed: 'Closed',
};

export const CHANNEL_LABELS: Record<OrderChannel, string> = {
  dine_in: 'Dine-in',
  takeaway: 'Takeaway',
  own_delivery: 'Own delivery',
  aggregator: 'Delivery platform',
  other: 'Other',
};

/** event → (allowed current statuses, resulting status). `null` result = status unchanged. */
const TRANSITIONS: Record<OrderEventType, { from: OrderStatus[]; to: OrderStatus | null }> = {
  received: { from: [], to: 'received' }, // only as the first event
  prep_started: { from: ['received'], to: 'preparing' },
  prep_completed: { from: ['preparing'], to: 'prepared' },
  pack_started: { from: ['prepared'], to: 'packing' },
  pack_completed: { from: ['packing'], to: 'packed' },
  rider_assigned: {
    from: ['received', 'preparing', 'prepared', 'packing', 'packed', 'ready_for_pickup'],
    to: null,
  },
  ready_for_pickup: { from: ['prepared', 'packed'], to: 'ready_for_pickup' },
  picked_up: { from: ['ready_for_pickup'], to: 'picked_up' },
  out_for_delivery: { from: ['picked_up'], to: 'in_transit' },
  delivered: { from: ['picked_up', 'in_transit'], to: 'delivered' },
  cancelled: {
    from: ['received', 'preparing', 'prepared', 'packing', 'packed', 'ready_for_pickup'],
    to: 'cancelled',
  },
  marked_uncollected: { from: ['ready_for_pickup', 'packed', 'prepared'], to: 'uncollected' },
  returned: { from: ['picked_up', 'in_transit', 'delivered'], to: 'returned' },
  closed: { from: ['picked_up', 'delivered', 'cancelled', 'uncollected', 'returned'], to: 'closed' },
};

export const TERMINAL_STATUSES: OrderStatus[] = [
  'delivered',
  'cancelled',
  'uncollected',
  'returned',
  'closed',
];
export const isOpen = (s: OrderStatus) => !TERMINAL_STATUSES.includes(s);

export interface OrderEvent {
  type: OrderEventType;
  at: string; // ISO timestamp
  reason?: string | null;
}

export class OrderTransitionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OrderTransitionError';
  }
}

/** Events allowed next for an order in `status` (for UI menus). */
export function allowedEvents(status: OrderStatus | null, events: OrderEvent[] = []): OrderEventType[] {
  if (status === null) return ['received'];
  return (Object.keys(TRANSITIONS) as OrderEventType[]).filter((e) => {
    if (e === 'received') return false;
    if (e === 'rider_assigned' && events.some((x) => x.type === 'rider_assigned')) return false;
    return TRANSITIONS[e].from.includes(status);
  });
}

/**
 * Validate that `event` may be applied after `history` (sorted by time) and return the new status.
 * Rules: the first event must be `received`; each event must be allowed from the current status;
 * timestamps must not go backwards and must not be in the future (with tolerance).
 */
export function applyEvent(
  current: OrderStatus | null,
  history: OrderEvent[],
  event: OrderEvent,
  nowIso: string,
  toleranceMs = 5 * 60_000,
): OrderStatus {
  if (Number.isNaN(Date.parse(event.at)))
    throw new OrderTransitionError('Event time is not a valid date/time.');
  if (Date.parse(event.at) > Date.parse(nowIso) + toleranceMs)
    throw new OrderTransitionError('Event time cannot be in the future.');
  if (current === null) {
    if (event.type !== 'received')
      throw new OrderTransitionError('The first event of an order must be "Order received".');
    return 'received';
  }
  const t = TRANSITIONS[event.type];
  if (event.type === 'received') throw new OrderTransitionError('This order has already been received.');
  if (!t.from.includes(current)) {
    throw new OrderTransitionError(
      `"${EVENT_LABELS[event.type]}" is not allowed when the order is ${STATUS_LABELS[current].toLowerCase()}.`,
    );
  }
  if (event.type === 'rider_assigned' && history.some((e) => e.type === 'rider_assigned')) {
    throw new OrderTransitionError('A rider is already assigned.');
  }
  const last = history[history.length - 1];
  if (last && Date.parse(event.at) < Date.parse(last.at)) {
    throw new OrderTransitionError(
      `Event time is earlier than the previous event (${EVENT_LABELS[last.type]}).`,
    );
  }
  return t.to ?? current;
}

/** Replays a full event list; throws on the first invalid event. */
export function replay(events: OrderEvent[], nowIso: string): OrderStatus {
  let status: OrderStatus | null = null;
  const seen: OrderEvent[] = [];
  for (const e of events) {
    status = applyEvent(status, seen, e, nowIso);
    seen.push(e);
  }
  if (status === null) throw new OrderTransitionError('Order has no events.');
  return status;
}

const first = (events: OrderEvent[], type: OrderEventType) => events.find((e) => e.type === type)?.at ?? null;
const minutes = (a: string | null, b: string | null) =>
  a && b ? Math.round(((Date.parse(b) - Date.parse(a)) / 60_000) * 10) / 10 : null;

export interface OrderDurations {
  prepMin: number | null;
  packMin: number | null;
  /** ready → picked up; for an order still waiting, measured to `now` and flagged ongoing */
  readyWaitMin: number | null;
  readyWaitOngoing: boolean;
  deliveryMin: number | null; // picked up → delivered
  totalMin: number | null; // received → delivered (or now while open)
  totalOngoing: boolean;
  /** prep completed → delivered/picked-up-and-ongoing/now: how long cooked food has been held */
  holdMin: number | null;
  holdOngoing: boolean;
}

export function durations(events: OrderEvent[], status: OrderStatus, nowIso: string): OrderDurations {
  const received = first(events, 'received');
  const prepStart = first(events, 'prep_started');
  const prepDone = first(events, 'prep_completed');
  const packStart = first(events, 'pack_started');
  const packDone = first(events, 'pack_completed');
  const ready = first(events, 'ready_for_pickup');
  const picked = first(events, 'picked_up');
  const delivered = first(events, 'delivered');
  const terminalAt =
    first(events, 'delivered') ??
    first(events, 'cancelled') ??
    first(events, 'marked_uncollected') ??
    first(events, 'returned') ??
    first(events, 'closed');
  const open = isOpen(status);
  const waiting = status === 'ready_for_pickup';
  return {
    prepMin: minutes(prepStart, prepDone),
    packMin: minutes(packStart, packDone),
    readyWaitMin: ready ? minutes(ready, picked ?? (waiting ? nowIso : terminalAt)) : null,
    readyWaitOngoing: waiting && !picked,
    deliveryMin: minutes(picked, delivered),
    totalMin: received ? minutes(received, delivered ?? (open ? nowIso : terminalAt)) : null,
    totalOngoing: open,
    holdMin: prepDone ? minutes(prepDone, delivered ?? (open ? nowIso : terminalAt)) : null,
    holdOngoing: open && !!prepDone,
  };
}

/** Where in the lifecycle an order ended (or is), for cancelled/uncollected handling. */
export type OrderStage =
  | 'cancelled_before_prep'
  | 'cancelled_during_prep'
  | 'prepared_not_packed'
  | 'packed_not_collected'
  | 'dispatched_not_delivered'
  | 'delivered'
  | 'returned'
  | 'in_progress';

export const STAGE_LABELS: Record<OrderStage, string> = {
  cancelled_before_prep: 'Cancelled before preparation',
  cancelled_during_prep: 'Cancelled during preparation',
  prepared_not_packed: 'Prepared but not packed',
  packed_not_collected: 'Packed but not collected',
  dispatched_not_delivered: 'Dispatched but not delivered',
  delivered: 'Delivered',
  returned: 'Returned',
  in_progress: 'In progress',
};

export function orderStage(events: OrderEvent[], status: OrderStatus): OrderStage {
  const has = (t: OrderEventType) => events.some((e) => e.type === t);
  if (has('returned')) return 'returned';
  if (has('delivered')) return 'delivered';
  if (has('picked_up') && (status === 'cancelled' || status === 'closed')) return 'dispatched_not_delivered';
  if (status === 'cancelled' || status === 'uncollected' || status === 'closed') {
    if (!has('prep_started')) return 'cancelled_before_prep';
    if (!has('prep_completed')) return 'cancelled_during_prep';
    if (has('pack_completed')) return 'packed_not_collected';
    return 'prepared_not_packed';
  }
  return 'in_progress';
}

/** True when food for this order was actually prepared and the order did not reach the customer. */
export function preparedButUndelivered(events: OrderEvent[], status: OrderStatus): boolean {
  const stage = orderStage(events, status);
  return (
    stage === 'prepared_not_packed' ||
    stage === 'packed_not_collected' ||
    stage === 'dispatched_not_delivered' ||
    stage === 'returned'
  );
}
