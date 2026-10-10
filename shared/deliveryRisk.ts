// Transparent, rule-based delivery quality-risk assessment. No AI, no invented data.
// It does NOT know actual food temperature: it compares recorded elapsed times with
// thresholds the outlet configured and handling limits the outlet verified for each dish.
// See docs/FOOD_SAFETY_AND_RISK_RULES.md.

import { durations, isOpen, type OrderEvent, type OrderStatus } from './orders';

export type RiskLevel = 'low' | 'moderate' | 'high' | 'insufficient';

export interface RiskItem {
  name: string;
  handlingClass: 'hot' | 'cold' | 'ambient' | 'frozen' | null;
  maxHoldMin: number | null;
  handlingVerified: boolean;
}

export interface RiskSettings {
  prepWarnMin: number;
  readyWaitWarnMin: number;
  readyWaitHighMin: number;
  deliveryTargetMin: number;
}

export interface RiskInput {
  status: OrderStatus;
  events: OrderEvent[];
  items: RiskItem[];
  estTravelMin: number | null;
  packaging: string | null;
  delayReason: string | null;
  settings: RiskSettings;
  nowIso: string;
}

export interface RiskFactor {
  factor: string;
  value: string;
  effect: 'raises' | 'neutral' | 'missing';
  note: string;
}

export interface RiskResult {
  level: RiskLevel;
  summary: string;
  factors: RiskFactor[];
  missing: string[];
  holdMin: number | null;
  projectedHoldMin: number | null;
  limitMin: number | null;
  readyWaitMin: number | null;
}

const RANK: Record<RiskLevel, number> = { insufficient: -1, low: 0, moderate: 1, high: 2 };
const max = (a: RiskLevel, b: RiskLevel) => (RANK[b] > RANK[a] ? b : a);

export function assessDeliveryRisk(input: RiskInput): RiskResult {
  const { status, events, items, settings, nowIso } = input;
  const d = durations(events, status, nowIso);
  const factors: RiskFactor[] = [];
  const missing: string[] = [];
  let level: RiskLevel = 'low';

  if (!events.length) {
    return {
      level: 'insufficient',
      summary: 'No timeline events recorded.',
      factors,
      missing: ['Order timeline events'],
      holdMin: null,
      projectedHoldMin: null,
      limitMin: null,
      readyWaitMin: null,
    };
  }
  const prepDone = events.some((e) => e.type === 'prep_completed');
  const beyondPrep = !['received', 'preparing'].includes(status) && !(status === 'cancelled' && !prepDone);
  if (beyondPrep && !prepDone) {
    missing.push('Preparation completed time');
  }

  // Verified handling limits (the strictest verified limit among items)
  const verified = items.filter((i) => i.handlingVerified && i.maxHoldMin);
  const unverified = items.filter((i) => !i.handlingVerified || !i.maxHoldMin);
  const limitMin = verified.length ? Math.min(...verified.map((i) => i.maxHoldMin!)) : null;
  if (unverified.length)
    missing.push(`Verified handling limit for: ${unverified.map((i) => i.name).join(', ')}`);

  // Preparation duration
  if (d.prepMin !== null) {
    const slow = d.prepMin > settings.prepWarnMin;
    factors.push({
      factor: 'Preparation time',
      value: `${d.prepMin} min`,
      effect: slow ? 'raises' : 'neutral',
      note: slow
        ? `Longer than the outlet's ${settings.prepWarnMin}-minute guideline.`
        : `Within the ${settings.prepWarnMin}-minute guideline.`,
    });
    if (slow) level = max(level, 'moderate');
  }

  // Waiting for pickup
  if (d.readyWaitMin !== null) {
    const v = d.readyWaitMin;
    const eff = v >= settings.readyWaitWarnMin ? 'raises' : 'neutral';
    factors.push({
      factor: d.readyWaitOngoing ? 'Waiting for pickup (still waiting)' : 'Waited for pickup',
      value: `${v} min`,
      effect: eff,
      note:
        v >= settings.readyWaitHighMin
          ? `At or above the high threshold (${settings.readyWaitHighMin} min).`
          : v >= settings.readyWaitWarnMin
            ? `At or above the warning threshold (${settings.readyWaitWarnMin} min).`
            : `Below the ${settings.readyWaitWarnMin}-minute warning threshold.`,
    });
    if (v >= settings.readyWaitHighMin) level = max(level, 'high');
    else if (v >= settings.readyWaitWarnMin) level = max(level, 'moderate');
  }

  // Time cooked food has been held, projected to delivery when travel time is known
  let projected: number | null = null;
  if (d.holdMin !== null) {
    const pickedAt = events.find((e) => e.type === 'picked_up')?.at;
    const delivered = events.some((e) => e.type === 'delivered');
    if (isOpen(status) && !delivered) {
      if (input.estTravelMin !== null) {
        const travelled = pickedAt ? (Date.parse(nowIso) - Date.parse(pickedAt)) / 60_000 : 0;
        projected = Math.round((d.holdMin + Math.max(0, input.estTravelMin - travelled)) * 10) / 10;
      } else if (
        ['packed', 'ready_for_pickup', 'picked_up', 'in_transit', 'prepared', 'packing'].includes(status)
      ) {
        missing.push('Estimated travel time');
      }
    }
    const compare = projected ?? d.holdMin;
    factors.push({
      factor: d.holdOngoing ? 'Time since food was prepared' : 'Time from preparation to delivery',
      value: `${d.holdMin} min${projected !== null ? ` (≈ ${projected} min at delivery, using the recorded travel estimate)` : ''}`,
      effect:
        limitMin === null
          ? 'missing'
          : compare > limitMin
            ? 'raises'
            : compare >= 0.8 * limitMin
              ? 'raises'
              : 'neutral',
      note:
        limitMin === null
          ? 'No verified handling limit to compare against.'
          : compare > limitMin
            ? `Exceeds the verified handling limit (${limitMin} min).`
            : compare >= 0.8 * limitMin
              ? `Within 80% of the verified handling limit (${limitMin} min).`
              : `Within the verified handling limit (${limitMin} min).`,
    });
    if (limitMin !== null) {
      if (compare > limitMin) level = max(level, 'high');
      else if (compare >= 0.8 * limitMin) level = max(level, 'moderate');
    }
  }

  // Overall elapsed time vs delivery target (delivery channels only)
  if (
    d.totalMin !== null &&
    events.some((e) => ['picked_up', 'rider_assigned', 'ready_for_pickup'].includes(e.type))
  ) {
    const over = d.totalMin > settings.deliveryTargetMin;
    factors.push({
      factor: d.totalOngoing ? 'Elapsed since order received' : 'Total order time',
      value: `${d.totalMin} min`,
      effect: over ? 'raises' : 'neutral',
      note: over
        ? `Longer than the ${settings.deliveryTargetMin}-minute target.`
        : `Within the ${settings.deliveryTargetMin}-minute target.`,
    });
    if (over) level = max(level, 'moderate');
  }

  if (input.delayReason)
    factors.push({
      factor: 'Recorded delay reason',
      value: input.delayReason,
      effect: 'neutral',
      note: 'As recorded by staff.',
    });
  if (input.packaging)
    factors.push({
      factor: 'Packaging',
      value: input.packaging,
      effect: 'neutral',
      note: 'Recorded packaging; not used to change the level unless a verified rule exists.',
    });
  else if (items.some((i) => i.handlingClass === 'hot' || i.handlingClass === 'cold'))
    missing.push('Packaging information');

  // Not enough data to say anything about time-based risk
  const timeFactors = factors.filter(
    (f) => f.effect !== 'missing' && !['Recorded delay reason', 'Packaging'].includes(f.factor),
  );
  if (!timeFactors.length) level = 'insufficient';

  const summary =
    level === 'insufficient'
      ? 'Not enough recorded timestamps to assess this order.'
      : level === 'high'
        ? 'High risk: recorded times exceed a verified handling limit or the high waiting threshold.'
        : level === 'moderate'
          ? 'Moderate risk: one or more recorded times are near or above the outlet’s thresholds.'
          : 'Low apparent risk: recorded times are within the outlet’s thresholds.';

  return {
    level,
    summary,
    factors,
    missing,
    holdMin: d.holdMin,
    projectedHoldMin: projected,
    limitMin,
    readyWaitMin: d.readyWaitMin,
  };
}

export const RISK_LABELS: Record<RiskLevel, string> = {
  low: 'Low apparent risk',
  moderate: 'Moderate risk',
  high: 'High risk',
  insufficient: 'Insufficient information',
};
