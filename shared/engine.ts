// Deterministic decision engine. Pure function of a Snapshot — no I/O, no randomness,
// no clock reads (dates come from the snapshot). See docs/ARCHITECTURE.md.

import { addDays, formatDate, formatDateTime } from './dates';
import { assessDeliveryRisk, RISK_LABELS, type RiskResult } from './deliveryRisk';
import { EVENT_LABELS, durations, isOpen, orderStage, preparedButUndelivered, STAGE_LABELS } from './orders';
import {
  buildSalesIndex,
  dateRange,
  forecastItem,
  METHOD_LABELS,
  type Forecast,
  type SalesIndex,
} from './forecast';
import { costOf, formatINR } from './money';
import { batchSafety, fifoCompare, type BatchSafety } from './safety';
import type {
  BatchSnap,
  Confidence,
  EvidenceBatch,
  EvidenceRecipe,
  EvidenceSales,
  IngredientSnap,
  MenuItemSnap,
  OrderSnap,
  OutcomeSnap,
  PlanLineDraft,
  RecOption,
  Recommendation,
  Snapshot,
} from './types';
import {
  formatQty,
  IncompatibleUnitError,
  roundQty,
  roundUpPurchase,
  toBase,
  UnknownUnitError,
} from './units';

export const ENGINE_VERSION = '1.0.0';
const EPS = 1e-9;

export interface IngredientState {
  ingredient: IngredientSnap;
  usableQty: number;
  excludedQty: number;
  unitCostPaise: number | null; // weighted average over usable batches with known cost
  costComplete: boolean; // every usable batch has a cost
  batches: { batch: BatchSnap; safety: BatchSafety }[];
}

export interface EngineResult {
  engineVersion: string;
  planDate: string;
  today: string;
  recommendations: Recommendation[];
  forecasts: Forecast[];
  stock: {
    ingredientId: number;
    name: string;
    baseUnit: string;
    usableQty: number;
    excludedQty: number;
    unitCostPaise: number | null;
  }[];
  orderRisks: {
    orderId: number;
    level: RiskResult['level'];
    factors: RiskResult['factors'];
    missing: string[];
  }[];
  summary: {
    byTier: Record<string, number>;
    excludedBatches: number;
    verifiedItems: number;
    itemsWithForecast: number;
  };
}

// ---------------------------------------------------------------------------
// Stock state
// ---------------------------------------------------------------------------

export function ingredientState(ing: IngredientSnap, today: string, warnDays: number): IngredientState {
  const batches = ing.batches
    .filter((b) => b.qtyRemaining > EPS)
    .map((batch) => ({ batch, safety: batchSafety(batch, today, warnDays) }))
    .sort((a, b) => fifoCompare(a.batch, b.batch));
  let usable = 0;
  let excluded = 0;
  let costQty = 0;
  let costSum = 0;
  let costComplete = true;
  for (const { batch, safety } of batches) {
    if (safety.usable) {
      usable += batch.qtyRemaining;
      if (batch.unitCostPaise === null) costComplete = false;
      else {
        costQty += batch.qtyRemaining;
        costSum += batch.qtyRemaining * batch.unitCostPaise;
      }
    } else excluded += batch.qtyRemaining;
  }
  let unitCostPaise = costQty > EPS ? costSum / costQty : null;
  if (unitCostPaise === null) {
    // fall back to the most recently received batch with a known cost (still an actual record)
    const withCost = [...ing.batches]
      .filter((b) => b.unitCostPaise !== null)
      .sort((a, b) => (a.receivedOn < b.receivedOn ? 1 : -1));
    unitCostPaise = withCost[0]?.unitCostPaise ?? null;
    if (usable <= EPS) costComplete = unitCostPaise !== null;
  }
  return {
    ingredient: ing,
    usableQty: roundQty(usable),
    excludedQty: roundQty(excluded),
    unitCostPaise,
    costComplete,
    batches,
  };
}

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------

interface InvalidLine {
  item: MenuItemSnap;
  ingredientName: string;
  reason: string;
}

class Ctx {
  readonly ingById = new Map<number, IngredientSnap>();
  readonly state = new Map<number, IngredientState>();
  readonly verifiedItems: MenuItemSnap[] = [];
  /** item → ingredient → gross base qty per serving (loss applied) */
  readonly perServing = new Map<number, Map<number, number>>();
  readonly invalidLines: InvalidLine[] = [];
  readonly salesIndex: SalesIndex;
  private fcCache = new Map<string, Forecast>();

  constructor(readonly snap: Snapshot) {
    for (const ing of snap.ingredients) {
      this.ingById.set(ing.id, ing);
      this.state.set(ing.id, ingredientState(ing, snap.today, snap.settings.expiryWarnDays));
    }
    for (const item of snap.menuItems) {
      if (!item.active) continue;
      const per = new Map<number, number>();
      let valid = item.lines.length > 0;
      for (const line of item.lines) {
        const ing = this.ingById.get(line.ingredientId);
        if (!ing) {
          valid = false;
          this.invalidLines.push({
            item,
            ingredientName: `#${line.ingredientId}`,
            reason: 'ingredient no longer exists',
          });
          continue;
        }
        try {
          if (!(line.qty > 0)) throw new Error('quantity must be greater than zero');
          if (line.lossPct < 0 || line.lossPct >= 100) throw new Error('loss % must be between 0 and 99');
          const net = toBase(line.qty, line.unit, ing.baseUnit);
          const gross = net / (1 - line.lossPct / 100);
          per.set(ing.id, roundQty((per.get(ing.id) ?? 0) + gross));
        } catch (e) {
          valid = false;
          const reason =
            e instanceof IncompatibleUnitError || e instanceof UnknownUnitError
              ? `recipe unit "${line.unit}" cannot be converted to the stock unit "${ing.baseUnit}"`
              : (e as Error).message;
          this.invalidLines.push({ item, ingredientName: ing.name, reason });
        }
      }
      if (valid && item.recipeVerified) {
        this.verifiedItems.push(item);
        this.perServing.set(item.id, per);
      }
    }
    this.verifiedItems.sort((a, b) => a.name.localeCompare(b.name));
    this.salesIndex = buildSalesIndex(snap.sales);
  }

  fc(itemId: number, date: string): Forecast {
    const k = `${itemId}|${date}`;
    let f = this.fcCache.get(k);
    if (!f) this.fcCache.set(k, (f = forecastItem(this.salesIndex, itemId, date)));
    return f;
  }

  usersOf(ingId: number): MenuItemSnap[] {
    return this.verifiedItems.filter((m) => this.perServing.get(m.id)!.has(ingId));
  }

  per(itemId: number, ingId: number): number {
    return this.perServing.get(itemId)?.get(ingId) ?? 0;
  }

  /** Ingredient cost of one portion, or null when any ingredient cost is unknown. */
  costPerPortion(itemId: number): number | null {
    const per = this.perServing.get(itemId);
    if (!per) return null;
    let sum = 0;
    for (const [ingId, q] of per) {
      const c = this.state.get(ingId)?.unitCostPaise;
      if (c === null || c === undefined) return null;
      sum += q * c;
    }
    return sum;
  }

  st(ingId: number): IngredientState {
    return this.state.get(ingId)!;
  }

  // ---- evidence helpers ----
  evBatch(ingId: number, batch: BatchSnap, safety: BatchSafety): EvidenceBatch {
    const ing = this.ingById.get(ingId)!;
    return {
      batchId: batch.id,
      ingredient: ing.name,
      lot: batch.lotCode,
      qtyRemaining: formatQty(batch.qtyRemaining, ing.baseUnit),
      dateType: batch.dateType,
      dateValue: batch.dateValue,
      status: `${safety.status} — ${safety.reason}`,
      unitCost:
        batch.unitCostPaise === null
          ? 'Not recorded'
          : `${formatINR(batch.unitCostPaise * unitScale(ing.baseUnit))} per ${unitScaleLabel(ing.baseUnit)}`,
    };
  }
  evRecipe(item: MenuItemSnap, ingId: number): EvidenceRecipe {
    const ing = this.ingById.get(ingId)!;
    const line = item.lines.find((l) => l.ingredientId === ingId);
    return {
      menuItem: item.name,
      ingredient: ing.name,
      qtyPerServing: line ? `${line.qty} ${line.unit}` : formatQty(this.per(item.id, ingId), ing.baseUnit),
      lossPct: line?.lossPct ?? 0,
      verified: item.recipeVerified,
    };
  }
  evSales(item: MenuItemSnap, f: Forecast): EvidenceSales {
    return {
      menuItem: item.name,
      method: METHOD_LABELS[f.method],
      from: f.from,
      to: f.to,
      daysUsed: f.daysUsed,
      values: f.values,
      mean: f.mean,
      min: f.min,
      max: f.max,
    };
  }
}

/** Costs are stored per g/ml/pc; show them per kg/L/pc for readability. */
function unitScale(base: string) {
  return base === 'pc' ? 1 : 1000;
}
function unitScaleLabel(base: string) {
  return base === 'g' ? 'kg' : base === 'ml' ? 'L' : 'pc';
}

function confidenceOf(fcs: Forecast[], costsKnown: boolean): Confidence {
  if (fcs.length === 0 || fcs.some((f) => f.method === 'insufficient')) return 'low';
  if (fcs.every((f) => f.method === 'same_weekday' && f.daysUsed >= 3) && costsKnown) return 'high';
  return 'medium';
}

const n2 = (x: number) => Math.round(x * 100) / 100;

function baseSafetyChecks(ctx: Ctx): string[] {
  let unsafe = 0;
  let verify = 0;
  for (const s of ctx.state.values())
    for (const b of s.batches) {
      if (b.safety.status === 'unsafe') unsafe++;
      if (b.safety.status === 'verify') verify++;
    }
  return [
    `Batches past their use-by/expiry date or marked unsafe are excluded from usable stock (${unsafe} batch(es) excluded).`,
    `Batches past best-before are excluded until an operator records a quality check today (${verify} batch(es) excluded).`,
    'No option proposes using an excluded batch.',
    'Only recipes the operator marked as verified are used in calculations.',
    'This engine does not judge food safety or allergens; it applies the dates and flags you recorded. Follow your FSSAI-compliant procedures.',
  ];
}

function allergenNote(item: MenuItemSnap): string {
  if (item.allergens && item.allergensVerified) return `Verified allergens: ${item.allergens}`;
  if (item.allergens) return `Allergens (not verified): ${item.allergens}`;
  return 'Allergen information not recorded';
}

// ---------------------------------------------------------------------------
// Generators
// ---------------------------------------------------------------------------

function unsafeStock(ctx: Ctx, out: Recommendation[]) {
  for (const s of ctx.state.values()) {
    const ing = s.ingredient;
    for (const { batch, safety } of s.batches) {
      if (safety.status !== 'unsafe') continue;
      const cost = batch.unitCostPaise === null ? null : costOf(batch.qtyRemaining, batch.unitCostPaise);
      const qtyTxt = formatQty(batch.qtyRemaining, ing.baseUnit);
      const line: PlanLineDraft = {
        type: 'discard',
        subjectType: 'batch',
        subjectId: batch.id,
        subjectName: `${ing.name}${batch.lotCode ? ` (lot ${batch.lotCode})` : ''}`,
        qty: batch.qtyRemaining,
        unit: ing.baseUnit,
        note: `${safety.reason}. Remove from use and record as waste (reason: expired).`,
        estimatedCostPaise: cost,
      };
      out.push({
        key: `unsafe_stock:${batch.id}`,
        kind: 'unsafe_stock',
        severityTier: 1,
        title: `Remove ${ing.name}${batch.lotCode ? ` lot ${batch.lotCode}` : ''} from use`,
        problem: `${qtyTxt} of ${ing.name} is recorded in stock but ${safety.reason.toLowerCase()}${batch.dateValue ? ` (${formatDate(batch.dateValue)})` : ''}. It must not be used.`,
        subjectName: ing.name,
        evidence: { batches: [ctx.evBatch(ing.id, batch, safety)], recipes: [], sales: [], other: [] },
        calculation: [
          `Today (${formatDate(ctx.snap.today)}) is after the ${batch.dateType?.replace('_', '-') ?? 'safety'} date ${formatDate(batch.dateValue)}` +
            (batch.quarantined ? ' / batch is flagged unsafe by an operator' : ''),
          cost === null
            ? 'Batch cost not recorded — loss value cannot be calculated.'
            : `Recorded value of the batch: ${qtyTxt} × unit cost = ${formatINR(cost)} (already spent)`,
        ],
        assumptions: [
          'The recorded date and remaining quantity are accurate. Verify physically before discarding.',
        ],
        options: [
          {
            key: 'A',
            label: 'Remove from use and record as waste',
            description:
              'Physically remove the batch, then complete the task to deduct it from stock with reason "expired".',
            feasible: true,
            effects: [
              { label: 'Stock removed', value: qtyTxt },
              {
                label: 'Recorded loss (already incurred)',
                value: cost === null ? 'Unknown — cost not recorded' : formatINR(cost),
              },
            ],
            estimatedCostPaise: cost,
            lines: [line],
          },
        ],
        confidence: 'high',
        missingInfo: batch.unitCostPaise === null ? ['Purchase cost for this batch'] : [],
        safetyChecks: [
          'This batch is already excluded from usable stock in every other calculation.',
          'Using this batch is never offered as an option.',
        ],
        nextStep:
          'Add to a plan and get it approved; completing the task records the waste and removes the stock.',
        estimatedImpactPaise: cost,
        impactLabel: 'Recorded value of unusable stock',
        sortKey: `unsafe_stock:${ing.name}:${batch.id}`,
      });
    }
  }
}

function verifyBestBefore(ctx: Ctx, out: Recommendation[]) {
  for (const s of ctx.state.values()) {
    const ing = s.ingredient;
    for (const { batch, safety } of s.batches) {
      if (safety.status !== 'verify') continue;
      const cost = batch.unitCostPaise === null ? null : costOf(batch.qtyRemaining, batch.unitCostPaise);
      const name = `${ing.name}${batch.lotCode ? ` (lot ${batch.lotCode})` : ''}`;
      out.push({
        key: `verify_best_before:${batch.id}`,
        kind: 'verify_best_before',
        severityTier: 1,
        title: `Check quality of ${name}`,
        problem: `${formatQty(batch.qtyRemaining, ing.baseUnit)} of ${ing.name} is past its best-before date (${formatDate(batch.dateValue)}). It is excluded from usable stock until someone checks it.`,
        subjectName: ing.name,
        evidence: { batches: [ctx.evBatch(ing.id, batch, safety)], recipes: [], sales: [], other: [] },
        calculation: [
          `Best-before ${formatDate(batch.dateValue)} < today ${formatDate(ctx.snap.today)}; no quality check recorded today.`,
        ],
        assumptions: [
          'Best-before is a quality date, not a safety date — but CulinAction will not decide quality for you.',
        ],
        options: [
          {
            key: 'A',
            label: 'Check quality today',
            description:
              'Inspect storage and condition per your procedures. If acceptable, completing the task records the check and makes the batch usable for today only.',
            feasible: true,
            effects: [
              {
                label: 'If acceptable',
                value: `${formatQty(batch.qtyRemaining, ing.baseUnit)} becomes usable today`,
              },
            ],
            estimatedCostPaise: null,
            lines: [
              {
                type: 'verify',
                subjectType: 'batch',
                subjectId: batch.id,
                subjectName: name,
                qty: null,
                unit: null,
                note: 'Quality check after best-before date',
                estimatedCostPaise: null,
              },
            ],
          },
          {
            key: 'B',
            label: 'Discard',
            description: 'Remove from use and record as waste.',
            feasible: true,
            effects: [{ label: 'Recorded loss', value: cost === null ? 'Unknown' : formatINR(cost) }],
            estimatedCostPaise: cost,
            lines: [
              {
                type: 'discard',
                subjectType: 'batch',
                subjectId: batch.id,
                subjectName: name,
                qty: batch.qtyRemaining,
                unit: ing.baseUnit,
                note: 'Past best-before; discarded after review',
                estimatedCostPaise: cost,
              },
            ],
          },
        ],
        confidence: 'high',
        missingInfo: [],
        safetyChecks: ['Batch excluded from usable stock until checked.'],
        nextStep: 'Choose check or discard and add it to a plan.',
        estimatedImpactPaise: cost,
        impactLabel: 'Recorded value of the batch',
        sortKey: `verify_best_before:${ing.name}:${batch.id}`,
      });
    }
  }
}

function stockoutRisk(ctx: Ctx, out: Recommendation[]) {
  const date = ctx.snap.planDate;
  for (const s of ctx.state.values()) {
    const ing = s.ingredient;
    const users = ctx.usersOf(ing.id);
    if (!users.length) continue;
    const withFc = users
      .map((m) => ({ m, f: ctx.fc(m.id, date) }))
      .filter((x) => x.f.method !== 'insufficient');
    const noFc = users.filter((m) => !withFc.some((x) => x.m.id === m.id));
    if (!withFc.length) continue;
    const demand = roundQty(withFc.reduce((a, { m, f }) => a + f.mean! * ctx.per(m.id, ing.id), 0));
    const demandHigh = roundQty(withFc.reduce((a, { m, f }) => a + f.max! * ctx.per(m.id, ing.id), 0));
    if (demand <= s.usableQty + EPS || demand <= EPS) continue;

    const shortfall = roundQty(demand - s.usableQty);
    const buffer = ctx.snap.settings.purchaseBufferPct;
    const buyQty = roundUpPurchase(shortfall * (1 + buffer / 100), ing.baseUnit);
    const buyCost = s.unitCostPaise === null ? null : costOf(buyQty, s.unitCostPaise);
    const B = ing.baseUnit;

    // Option B: cap preparation, allocating usable stock by forecast demand (highest first).
    let remaining = s.usableQty;
    const alloc = [...withFc]
      .sort((a, b) => b.f.mean! - a.f.mean! || a.m.name.localeCompare(b.m.name))
      .map(({ m, f }) => {
        const want = Math.ceil(f.mean! - EPS);
        const per = ctx.per(m.id, ing.id);
        const can = Math.max(0, Math.min(want, Math.floor((remaining + EPS) / per)));
        remaining = roundQty(remaining - can * per);
        return { m, want, can, unmet: want - can };
      });
    let revenueAtRisk: number | null = 0;
    for (const a of alloc) {
      if (a.unmet <= 0) continue;
      if (a.m.pricePaise === null) revenueAtRisk = null;
      else if (revenueAtRisk !== null) revenueAtRisk += a.unmet * a.m.pricePaise;
    }

    const fcs = withFc.map((x) => x.f);
    const missing: string[] = [];
    if (s.unitCostPaise === null) missing.push(`Purchase cost of ${ing.name}`);
    for (const m of noFc)
      missing.push(`Sales history for ${m.name} (uses ${ing.name}; its demand is not included)`);
    for (const a of alloc)
      if (a.unmet > 0 && a.m.pricePaise === null) missing.push(`Selling price of ${a.m.name}`);

    out.push({
      key: `stockout_risk:${ing.id}`,
      kind: 'stockout_risk',
      severityTier: 2,
      title: `${ing.name} may run short on ${formatDate(date)}`,
      problem: `Forecast demand needs about ${formatQty(demand, B)} of ${ing.name}, but only ${formatQty(s.usableQty, B)} is usable. Shortfall ≈ ${formatQty(shortfall, B)}.`,
      subjectName: ing.name,
      evidence: {
        batches: s.batches.map((b) => ctx.evBatch(ing.id, b.batch, b.safety)),
        recipes: users.map((m) => ctx.evRecipe(m, ing.id)),
        sales: withFc.map(({ m, f }) => ctx.evSales(m, f)),
        other: [],
      },
      calculation: [
        ...withFc.map(
          ({ m, f }) =>
            `${m.name}: forecast ${n2(f.mean!)} portions × ${formatQty(ctx.per(m.id, ing.id), B)} per portion (incl. prep loss) = ${formatQty(f.mean! * ctx.per(m.id, ing.id), B)}`,
        ),
        `Total forecast need = ${formatQty(demand, B)}; on the highest comparable day it would be ${formatQty(demandHigh, B)}`,
        `Usable stock = ${formatQty(s.usableQty, B)}${s.excludedQty > 0 ? ` (${formatQty(s.excludedQty, B)} excluded as unsafe / unchecked)` : ''}`,
        `Shortfall = ${formatQty(demand, B)} − ${formatQty(s.usableQty, B)} = ${formatQty(shortfall, B)}`,
        `Purchase suggestion = shortfall × (1 + ${buffer}% buffer), rounded up = ${formatQty(buyQty, B)}`,
      ],
      assumptions: [
        'Demand on the plan date resembles the comparable days used in the forecast.',
        'Only usable stock on hand is counted; deliveries not yet recorded are not included.',
        'Each ingredient is checked separately; another ingredient may also limit the same dish.',
      ],
      options: [
        {
          key: 'A',
          label: `Buy ${formatQty(buyQty, B)} of ${ing.name}`,
          description:
            'Raise a purchase task. Nothing is ordered automatically — record the receipt in Inventory when it arrives.',
          feasible: true,
          effects: [
            { label: 'Covers average forecast', value: 'Yes' },
            {
              label: 'Covers highest comparable day',
              value:
                s.usableQty + buyQty + EPS >= demandHigh ? 'Yes' : `No (needs ${formatQty(demandHigh, B)})`,
            },
            {
              label: 'Estimated purchase cost',
              value: buyCost === null ? 'Unknown — no cost recorded' : formatINR(buyCost),
            },
          ],
          estimatedCostPaise: buyCost,
          lines: [
            {
              type: 'purchase',
              subjectType: 'ingredient',
              subjectId: ing.id,
              subjectName: ing.name,
              qty: buyQty,
              unit: B,
              note: `Covers forecast shortfall of ${formatQty(shortfall, B)} + ${buffer}% buffer`,
              estimatedCostPaise: buyCost,
            },
          ],
        },
        {
          key: 'B',
          label: 'Cap preparation to usable stock',
          description:
            'Prepare only what usable stock supports, giving priority to the dishes with the highest forecast demand.',
          feasible: alloc.some((a) => a.can > 0),
          infeasibleReason: alloc.some((a) => a.can > 0)
            ? undefined
            : `No usable ${ing.name} — no portions can be prepared.`,
          effects: [
            ...alloc.map((a) => ({
              label: a.m.name,
              value: `${a.can} of ${a.want} forecast portions${a.unmet ? ` (${a.unmet} short)` : ''}`,
            })),
            {
              label: 'Forecast sales value at risk',
              value: revenueAtRisk === null ? 'Unknown — selling price missing' : formatINR(revenueAtRisk),
            },
          ],
          estimatedCostPaise: null,
          lines: alloc.map((a) => ({
            type: 'prep' as const,
            subjectType: 'menu_item' as const,
            subjectId: a.m.id,
            subjectName: a.m.name,
            qty: a.can,
            unit: 'portions',
            note: `Capped by usable ${ing.name} (${formatQty(s.usableQty, B)})`,
            estimatedCostPaise: null,
          })),
        },
      ],
      confidence: confidenceOf(fcs, s.unitCostPaise !== null),
      missingInfo: missing,
      safetyChecks: baseSafetyChecks(ctx),
      nextStep:
        'Compare buying the shortfall against capping preparation, then add one option to a plan for approval.',
      estimatedImpactPaise: revenueAtRisk,
      impactLabel: 'Forecast sales value at risk if nothing changes (estimate)',
      sortKey: `stockout_risk:${ing.name}`,
    });
  }
}

function expiryWasteRisk(ctx: Ctx, out: Recommendation[]) {
  const planDate = ctx.snap.planDate;
  for (const s of ctx.state.values()) {
    const ing = s.ingredient;
    const B = ing.baseUnit;
    const usableFifo = s.batches.filter((b) => b.safety.usable);
    const users = ctx.usersOf(ing.id);
    let prior = 0;
    for (const { batch, safety } of usableFifo) {
      const thisPrior = prior;
      prior += batch.qtyRemaining;
      if (safety.status !== 'expiring' || !batch.dateValue) continue;

      const days = batch.dateValue >= planDate ? dateRange(planDate, batch.dateValue) : [];
      const fcsByDay = days.map((d) => users.map((m) => ({ m, f: ctx.fc(m.id, d) })));
      const flat = fcsByDay.flat();
      const known = flat.filter((x) => x.f.method !== 'insufficient');
      const unknownItems = [
        ...new Set(flat.filter((x) => x.f.method === 'insufficient').map((x) => x.m.name)),
      ];
      const expectedUse = roundQty(known.reduce((a, { m, f }) => a + f.mean! * ctx.per(m.id, ing.id), 0));
      const upside = roundQty(
        known.reduce((a, { m, f }) => a + (f.max! - f.mean!) * ctx.per(m.id, ing.id), 0),
      );
      const availableForThis = Math.max(0, expectedUse - thisPrior);
      const atRisk = roundQty(Math.max(0, batch.qtyRemaining - availableForThis));
      if (atRisk <= EPS) continue;

      const unitCost = batch.unitCostPaise ?? s.unitCostPaise;
      const costAtRisk = unitCost === null ? null : costOf(atRisk, unitCost);
      const extraUse = roundQty(Math.min(atRisk, upside));
      const afterA = roundQty(atRisk - extraUse);
      const lotName = `${ing.name}${batch.lotCode ? ` (lot ${batch.lotCode})` : ''}`;
      const reduceQty = Math.floor(atRisk / (B === 'pc' ? 1 : 10)) * (B === 'pc' ? 1 : 10);

      const fcsPlan = users
        .map((m) => ({ m, f: ctx.fc(m.id, planDate) }))
        .filter((x) => x.f.method !== 'insufficient');
      const prepLines: PlanLineDraft[] = fcsPlan.map(({ m, f }) => ({
        type: 'prep',
        subjectType: 'menu_item',
        subjectId: m.id,
        subjectName: m.name,
        qty: Math.ceil(f.max! - EPS),
        unit: 'portions',
        note: `Use ${lotName} first. Up to the highest comparable-day demand (${f.max}).`,
        estimatedCostPaise: null,
      }));

      // Using a dated batch requires the operator to confirm it has been stored as required.
      if (!batch.storageVerifiedOn && prepLines.length) {
        prepLines.unshift({
          type: 'verify',
          subjectType: 'batch',
          subjectId: batch.id,
          subjectName: lotName,
          qty: null,
          unit: null,
          note: 'Confirm this lot has been stored as required (temperature, cover, handling) before using it. If not, discard it.',
          estimatedCostPaise: null,
        });
      }
      const missing: string[] = [];
      if (!batch.storageVerifiedOn)
        missing.push(`Storage check for ${lotName} (not yet confirmed by an operator)`);
      if (!users.length)
        missing.push(`No verified recipe uses ${ing.name}, so expected use cannot be calculated.`);
      for (const n of unknownItems) missing.push(`Sales history for ${n} (uses ${ing.name})`);
      if (unitCost === null) missing.push(`Purchase cost of ${ing.name}`);

      const optA: RecOption = {
        key: 'A',
        label: 'Prioritise existing dishes that use it',
        description:
          'Use this lot first and prepare dishes that use it up to the highest demand seen on comparable days. Does not invent new recipes.',
        feasible: users.length > 0 && extraUse > EPS,
        infeasibleReason: !users.length
          ? 'No verified menu item uses this ingredient.'
          : extraUse <= EPS
            ? 'Recorded demand gives no evidence that more of these dishes would sell.'
            : undefined,
        effects: [
          { label: 'Additional use if demand reaches recorded highs', value: formatQty(extraUse, B) },
          { label: 'Still at risk after that', value: formatQty(afterA, B) },
          {
            label: 'Estimated value still at risk',
            value: unitCost === null ? 'Unknown' : formatINR(costOf(afterA, unitCost)),
          },
          ...users.map((m) => ({ label: m.name, value: allergenNote(m) })),
        ],
        estimatedCostPaise: unitCost === null ? null : costOf(afterA, unitCost),
        lines: prepLines,
      };
      const optB: RecOption = {
        key: 'B',
        label: `Reduce next purchase of ${ing.name}`,
        description:
          'Order less next time so the same surplus does not recur. Does not save the current lot.',
        feasible: reduceQty > 0,
        infeasibleReason: reduceQty > 0 ? undefined : 'Quantity at risk is too small to change an order.',
        effects: [
          { label: 'Reduce next order by', value: formatQty(reduceQty, B) },
          {
            label: 'Estimated future spend avoided',
            value: unitCost === null ? 'Unknown' : formatINR(costOf(reduceQty, unitCost)),
          },
        ],
        estimatedCostPaise: unitCost === null ? null : costOf(reduceQty, unitCost),
        lines: [
          {
            type: 'reduce_purchase',
            subjectType: 'ingredient',
            subjectId: ing.id,
            subjectName: ing.name,
            qty: reduceQty,
            unit: B,
            note: `Surplus of ${formatQty(atRisk, B)} expected on ${lotName}`,
            estimatedCostPaise: unitCost === null ? null : costOf(reduceQty, unitCost),
          },
        ],
      };
      const optC: RecOption = {
        key: 'C',
        label: 'No change — re-check on the date',
        description: `Continue as planned and re-check the lot on ${formatDate(batch.dateValue)}. Record any unused quantity as waste.`,
        feasible: true,
        effects: [
          {
            label: 'Estimated value at risk',
            value: costAtRisk === null ? 'Unknown' : formatINR(costAtRisk),
          },
        ],
        estimatedCostPaise: costAtRisk,
        lines: [
          {
            type: 'verify',
            subjectType: 'batch',
            subjectId: batch.id,
            subjectName: lotName,
            qty: null,
            unit: null,
            note: `Re-check on ${formatDate(batch.dateValue)}; record unused quantity as waste`,
            estimatedCostPaise: null,
          },
        ],
      };

      out.push({
        key: `expiry_waste_risk:${batch.id}`,
        kind: 'expiry_waste_risk',
        severityTier: 2,
        title: `${formatQty(atRisk, B)} of ${ing.name} may go unused before ${formatDate(batch.dateValue)}`,
        problem: `${lotName} has ${formatQty(batch.qtyRemaining, B)} left and its ${batch.dateType === 'use_by' ? 'use-by' : 'expiry'} date is ${formatDate(batch.dateValue)}. Forecast use before then covers only part of it.`,
        subjectName: ing.name,
        evidence: {
          batches: s.batches.map((b) => ctx.evBatch(ing.id, b.batch, b.safety)),
          recipes: users.map((m) => ctx.evRecipe(m, ing.id)),
          sales: users.map((m) => ctx.evSales(m, ctx.fc(m.id, planDate))),
          other: [],
        },
        calculation: [
          `Window: ${formatDate(planDate)} to ${formatDate(batch.dateValue)} (${days.length} day(s))`,
          `Expected use in window = Σ daily forecast × recipe quantity = ${formatQty(expectedUse, B)}${unknownItems.length ? ' (excludes dishes without sales history)' : ''}`,
          `Earlier-dated usable stock used first (FIFO): ${formatQty(thisPrior, B)}`,
          `Expected use from this lot = max(0, ${formatQty(expectedUse, B)} − ${formatQty(thisPrior, B)}) = ${formatQty(availableForThis, B)}`,
          `At risk = ${formatQty(batch.qtyRemaining, B)} − ${formatQty(availableForThis, B)} = ${formatQty(atRisk, B)}`,
          costAtRisk === null
            ? 'Value at risk: unknown (no cost recorded)'
            : `Value at risk = ${formatQty(atRisk, B)} × unit cost = ${formatINR(costAtRisk)}`,
        ],
        assumptions: [
          'Demand in the window resembles the comparable days used in each forecast.',
          'Stock is used earliest-date-first.',
          'The lot remains safe until its recorded date only if stored as required — verify storage conditions.',
        ],
        options: [optA, optB, optC],
        confidence: confidenceOf(
          known.map((k) => k.f),
          unitCost !== null,
        ),
        missingInfo: missing,
        safetyChecks: [
          ...baseSafetyChecks(ctx),
          `Option A only applies up to ${formatDate(batch.dateValue)}; after that date the lot becomes unusable automatically.`,
        ],
        nextStep: 'Pick the option that fits your kitchen and add it to a plan.',
        estimatedImpactPaise: costAtRisk,
        impactLabel: 'Estimated value of stock at risk of waste',
        sortKey: `expiry_waste_risk:${ing.name}:${batch.id}`,
      });
    }
  }
}

function prepAdjustment(ctx: Ctx, out: Recommendation[]) {
  const planDate = ctx.snap.planDate;
  const from = addDays(planDate, -28);
  for (const m of ctx.verifiedItems) {
    const f = ctx.fc(m.id, planDate);
    if (f.method === 'insufficient') continue;
    // Forecasts are per day, so service-period outcomes are summed per day before comparing.
    const byDate = new Map<string, OutcomeSnap>();
    for (const o of ctx.snap.outcomes) {
      if (o.menuItemId !== m.id || o.date < from || o.date >= planDate) continue;
      const d = byDate.get(o.date);
      byDate.set(
        o.date,
        d
          ? {
              ...d,
              prepared: d.prepared + o.prepared,
              sold: d.sold + o.sold,
              remaining: d.remaining + o.remaining,
              discarded: d.discarded + o.discarded,
            }
          : { ...o },
      );
    }
    const outs = [...byDate.values()].sort((a, b) => (a.date < b.date ? 1 : -1)).slice(0, 7);
    if (outs.length < 3) continue;
    const n = outs.length;
    const avgPrep = n2(outs.reduce((a, o) => a + o.prepared, 0) / n);
    const avgSold = n2(outs.reduce((a, o) => a + o.sold, 0) / n);
    const avgLeft = n2(outs.reduce((a, o) => a + o.remaining + o.discarded, 0) / n);
    const avgDisc = n2(outs.reduce((a, o) => a + o.discarded, 0) / n);
    const soldOut = outs.filter((o) => o.remaining + o.discarded === 0).length;
    const current = Math.round(avgPrep);
    const optMean = Math.ceil(f.mean! - EPS);
    const optHigh = Math.ceil(f.max! - EPS);
    const reduce = avgLeft >= 1 && current - optMean >= Math.max(1, 0.1 * current);
    const increase = soldOut >= Math.ceil(n / 2) && optHigh > current;
    if (!reduce && !increase) continue;

    const cpp = ctx.costPerPortion(m.id);
    const per = ctx.perServing.get(m.id)!;
    const feas = (portions: number) => {
      for (const [ingId, q] of per) {
        const st = ctx.st(ingId);
        if (portions * q > st.usableQty + EPS)
          return `Needs ${formatQty(portions * q, st.ingredient.baseUnit)} of ${st.ingredient.name}; only ${formatQty(st.usableQty, st.ingredient.baseUnit)} usable.`;
      }
      return undefined;
    };
    const mkOpt = (key: string, label: string, portions: number, description: string): RecOption => {
      const diff = current - portions;
      const reason = feas(portions);
      return {
        key,
        label,
        description,
        feasible: !reason,
        infeasibleReason: reason,
        effects: [
          { label: 'Portions to prepare', value: String(portions) },
          {
            label: 'Change vs recent average prep',
            value: `${diff > 0 ? '−' : diff < 0 ? '+' : '±'}${Math.abs(diff)} portions`,
          },
          {
            label: 'Estimated ingredient cost change',
            value:
              cpp === null
                ? 'Unknown — ingredient cost missing'
                : `${diff > 0 ? '−' : '+'}${formatINR(Math.abs(diff) * cpp)}`,
          },
          {
            label: 'Comparable days where demand exceeded this',
            value: `${f.values.filter((v) => v.qty > portions).length} of ${f.values.length}`,
          },
        ],
        estimatedCostPaise: cpp === null ? null : Math.round((portions - current) * cpp),
        lines: [
          {
            type: 'prep',
            subjectType: 'menu_item',
            subjectId: m.id,
            subjectName: m.name,
            qty: portions,
            unit: 'portions',
            note: label,
            estimatedCostPaise: cpp === null ? null : Math.round(portions * cpp),
          },
        ],
      };
    };
    const impact = reduce
      ? cpp === null
        ? null
        : Math.round((current - optMean) * cpp)
      : m.pricePaise === null
        ? null
        : (optHigh - current) * m.pricePaise;
    const missing: string[] = [];
    if (cpp === null) missing.push(`Ingredient cost for one or more ingredients of ${m.name}`);
    if (increase && m.pricePaise === null) missing.push(`Selling price of ${m.name}`);

    out.push({
      key: `prep_adjustment:${m.id}`,
      kind: 'prep_adjustment',
      severityTier: reduce ? 3 : 2,
      title: reduce
        ? `Prepare fewer ${m.name} (recent avg ${current}, forecast ${optMean})`
        : `${m.name} often sells out — consider preparing more`,
      problem: reduce
        ? `In the last ${n} recorded services ${m.name} averaged ${avgPrep} prepared, ${avgSold} sold and ${avgLeft} left over (${avgDisc} discarded).`
        : `${m.name} sold out in ${soldOut} of the last ${n} recorded services (average prepared ${avgPrep}). Recorded demand reached ${f.max}.`,
      subjectName: m.name,
      evidence: {
        batches: [],
        recipes: [...per.keys()].map((ingId) => ctx.evRecipe(m, ingId)),
        sales: [ctx.evSales(m, f)],
        other: outs.map(
          (o) =>
            `${formatDate(o.date)}: prepared ${o.prepared}, sold ${o.sold}, kept or transferred ${o.remaining}, discarded ${o.discarded}`,
        ),
      },
      calculation: [
        `Recent average prepared = ${avgPrep} over ${n} services → ${current}`,
        `Forecast for ${formatDate(planDate)} = ${f.mean} (range ${f.min}–${f.max}, ${METHOD_LABELS[f.method].toLowerCase()}, ${f.daysUsed} days)`,
        cpp === null
          ? 'Ingredient cost per portion: unknown'
          : `Ingredient cost per portion = Σ recipe qty × unit cost = ${formatINR(cpp)}`,
        reduce && cpp !== null
          ? `Preparing ${optMean} instead of ${current} changes ingredient spend by about ${formatINR((current - optMean) * cpp)}`
          : '',
      ].filter(Boolean),
      assumptions: [
        'Recorded outcomes reflect normal service.',
        'Outcomes for a day are summed across service periods and compared with the whole-day forecast.',
        'Leftovers are not reliably sold on later days.',
      ],
      options: [
        mkOpt(
          'A',
          `Prepare ${optMean} (average forecast)`,
          optMean,
          'Matches typical demand; may run short on busier days.',
        ),
        mkOpt(
          'B',
          `Prepare ${optHigh} (highest comparable day)`,
          optHigh,
          'Protects against the busiest recorded day; more risk of leftovers.',
        ),
        mkOpt('C', `Keep preparing ${current}`, current, 'No change to current practice.'),
      ],
      confidence: confidenceOf([f], cpp !== null),
      missingInfo: missing,
      safetyChecks: baseSafetyChecks(ctx),
      nextStep:
        'Choose a quantity, add it to a plan, then record the actual outcome after service to measure the result.',
      estimatedImpactPaise: impact,
      impactLabel: reduce
        ? 'Estimated ingredient cost of over-preparation per service'
        : 'Estimated sales value missed per service',
      sortKey: `prep_adjustment:${m.name}`,
    });
  }
}

function excessStock(ctx: Ctx, out: Recommendation[]) {
  const planDate = ctx.snap.planDate;
  const coverDays = ctx.snap.settings.excessCoverDays;
  for (const s of ctx.state.values()) {
    const ing = s.ingredient;
    const B = ing.baseUnit;
    if (s.usableQty <= EPS) continue;
    const users = ctx.usersOf(ing.id);
    if (!users.length) continue;
    const fcs = users.map((m) => ({ m, f: ctx.fc(m.id, planDate) }));
    const known = fcs.filter((x) => x.f.method !== 'insufficient');
    if (!known.length || known.length < fcs.length) continue; // incomplete demand picture → reported as data gap
    const daily = roundQty(known.reduce((a, { m, f }) => a + f.mean! * ctx.per(m.id, ing.id), 0));
    const cover = daily > EPS ? s.usableQty / daily : Infinity;
    if (cover <= coverDays) continue;
    const excess = roundQty(s.usableQty - daily * coverDays);
    const step = B === 'pc' ? 1 : 10;
    const reduceQty = Math.floor(excess / step) * step;
    if (reduceQty <= 0) continue;
    const value = s.unitCostPaise === null ? null : costOf(excess, s.unitCostPaise);
    out.push({
      key: `excess_stock:${ing.id}`,
      kind: 'excess_stock',
      severityTier: 3,
      title: `${ing.name}: about ${Number.isFinite(cover) ? Math.round(cover) : 'unlimited'} days of stock on hand`,
      problem: `Usable stock of ${formatQty(s.usableQty, B)} covers ${Number.isFinite(cover) ? `${n2(cover)} days` : 'an indefinite period'} at forecast use of ${formatQty(daily, B)}/day. Your target cover is ${coverDays} days.`,
      subjectName: ing.name,
      evidence: {
        batches: s.batches.map((b) => ctx.evBatch(ing.id, b.batch, b.safety)),
        recipes: users.map((m) => ctx.evRecipe(m, ing.id)),
        sales: known.map(({ m, f }) => ctx.evSales(m, f)),
        other: [],
      },
      calculation: [
        `Forecast daily use = ${known.map(({ m, f }) => `${m.name} ${n2(f.mean!)} × ${formatQty(ctx.per(m.id, ing.id), B)}`).join(' + ')} = ${formatQty(daily, B)}`,
        `Days of cover = ${formatQty(s.usableQty, B)} ÷ ${formatQty(daily, B)} = ${Number.isFinite(cover) ? n2(cover) : '∞'}`,
        `Stock beyond ${coverDays} days = ${formatQty(s.usableQty, B)} − ${coverDays} × ${formatQty(daily, B)} = ${formatQty(excess, B)}`,
        value === null
          ? 'Value: unknown (no cost)'
          : `Value of stock beyond target cover ≈ ${formatINR(value)}`,
      ],
      assumptions: [
        'Future daily demand resembles the plan-date forecast.',
        'Ingredient is not needed for dishes without a verified recipe.',
      ],
      options: [
        {
          key: 'A',
          label: `Reduce next purchase by ${formatQty(reduceQty, B)}`,
          description: 'Order less until stock returns to the target cover.',
          feasible: true,
          effects: [
            {
              label: 'Estimated future spend deferred',
              value: s.unitCostPaise === null ? 'Unknown' : formatINR(costOf(reduceQty, s.unitCostPaise)),
            },
          ],
          estimatedCostPaise: s.unitCostPaise === null ? null : costOf(reduceQty, s.unitCostPaise),
          lines: [
            {
              type: 'reduce_purchase',
              subjectType: 'ingredient',
              subjectId: ing.id,
              subjectName: ing.name,
              qty: reduceQty,
              unit: B,
              note: `Stock covers ${Number.isFinite(cover) ? n2(cover) : '∞'} days vs target ${coverDays}`,
              estimatedCostPaise: null,
            },
          ],
        },
        {
          key: 'B',
          label: 'Keep current purchasing',
          description: 'Appropriate if you expect higher demand or supply is irregular.',
          feasible: true,
          effects: [{ label: 'Stock beyond target cover', value: formatQty(excess, B) }],
          estimatedCostPaise: null,
          lines: [],
        },
      ],
      confidence: confidenceOf(
        known.map((k) => k.f),
        s.unitCostPaise !== null,
      ),
      missingInfo: s.unitCostPaise === null ? [`Purchase cost of ${ing.name}`] : [],
      safetyChecks: baseSafetyChecks(ctx),
      nextStep: 'Review dated batches for this ingredient, then decide on the next order.',
      estimatedImpactPaise: value,
      impactLabel: 'Value of stock beyond target cover (estimate)',
      sortKey: `excess_stock:${ing.name}`,
    });
  }
}

function forecastDeviation(ctx: Ctx, out: Recommendation[]) {
  const devs: { date: string; item: MenuItemSnap; mean: number; actual: number }[] = [];
  const byId = new Map(ctx.snap.menuItems.map((m) => [m.id, m]));
  for (const p of ctx.snap.pastForecasts) {
    if (p.date >= ctx.snap.today || !ctx.salesIndex.tradingDays.has(p.date)) continue;
    const item = byId.get(p.menuItemId);
    if (!item) continue;
    const actual = ctx.salesIndex.byItemDay.get(p.menuItemId)?.get(p.date) ?? 0;
    if (Math.abs(actual - p.mean) >= Math.max(5, 0.5 * p.mean))
      devs.push({ date: p.date, item, mean: p.mean, actual });
  }
  if (!devs.length) return;
  devs.sort(
    (a, b) =>
      Math.abs(b.actual - b.mean) - Math.abs(a.actual - a.mean) || a.item.name.localeCompare(b.item.name),
  );
  const top = devs.slice(0, 10);
  out.push({
    key: 'forecast_deviation',
    kind: 'forecast_deviation',
    severityTier: 4,
    title: `${devs.length} forecast(s) differed sharply from actual sales`,
    problem:
      'Large differences can mean an unusual day (festival, event, rain), a missing sales record, or a data-entry error.',
    subjectName: 'Forecasts',
    evidence: {
      batches: [],
      recipes: [],
      sales: [],
      other: top.map((d) => `${formatDate(d.date)} ${d.item.name}: forecast ${d.mean}, actual ${d.actual}`),
    },
    calculation: ['Flagged when |actual − forecast| ≥ max(5 portions, 50% of forecast).'],
    assumptions: ['Forecasts compared are those stored by earlier recommendation runs.'],
    options: [
      {
        key: 'A',
        label: 'Review the sales records',
        description: 'Check the listed days for missing or mistyped entries.',
        feasible: true,
        effects: [],
        estimatedCostPaise: null,
        lines: [...new Map(top.map((d) => [d.item.id, d.item])).values()].map((item) => ({
          type: 'verify' as const,
          subjectType: 'menu_item' as const,
          subjectId: item.id,
          subjectName: item.name,
          qty: null,
          unit: null,
          note: 'Review sales records on flagged dates',
          estimatedCostPaise: null,
        })),
      },
    ],
    confidence: 'medium',
    missingInfo: [],
    safetyChecks: [],
    nextStep: 'Review the flagged days in Sales.',
    estimatedImpactPaise: null,
    impactLabel: '',
    sortKey: 'forecast_deviation',
  });
}

function dataGaps(ctx: Ctx, out: Recommendation[]) {
  const snap = ctx.snap;
  const push = (
    sub: string,
    title: string,
    problem: string,
    items: string[],
    lines: PlanLineDraft[],
    nextStep: string,
  ) =>
    out.push({
      key: `data_gap:${sub}`,
      kind: 'data_gap',
      severityTier: 4,
      title,
      problem,
      subjectName: title,
      evidence: { batches: [], recipes: [], sales: [], other: items },
      calculation: [],
      assumptions: [],
      options: [
        {
          key: 'A',
          label: 'Create verification tasks',
          description: 'Adds a task for each item so someone can supply the missing information.',
          feasible: lines.length > 0,
          infeasibleReason: lines.length ? undefined : 'Nothing to assign',
          effects: [],
          estimatedCostPaise: null,
          lines,
        },
      ],
      confidence: 'high',
      missingInfo: items,
      safetyChecks: [],
      nextStep,
      estimatedImpactPaise: null,
      impactLabel: '',
      sortKey: `data_gap:${sub}`,
    });
  const verifyItem = (m: MenuItemSnap, note: string): PlanLineDraft => ({
    type: 'verify',
    subjectType: 'menu_item',
    subjectId: m.id,
    subjectName: m.name,
    qty: null,
    unit: null,
    note,
    estimatedCostPaise: null,
  });
  const active = snap.menuItems.filter((m) => m.active);

  const noRecipe = active.filter((m) => m.lines.length === 0);
  if (noRecipe.length)
    push(
      'no_recipe',
      `${noRecipe.length} menu item(s) have no recipe`,
      'Without ingredient quantities, CulinAction cannot check stock or cost for these dishes.',
      noRecipe.map((m) => m.name),
      noRecipe.map((m) => verifyItem(m, 'Enter recipe quantities from the kitchen')),
      'Open Menu → Recipe and enter the quantities your kitchen actually uses.',
    );

  const invalidIds = new Set(ctx.invalidLines.map((l) => l.item.id));
  const unverified = active.filter((m) => m.lines.length > 0 && !m.recipeVerified && !invalidIds.has(m.id));
  if (unverified.length)
    push(
      'unverified_recipe',
      `${unverified.length} recipe(s) not yet verified`,
      'Unverified recipes are excluded from stock and demand calculations.',
      unverified.map((m) => m.name),
      unverified.map((m) => verifyItem(m, 'Confirm recipe quantities with the kitchen')),
      'Ask the kitchen to confirm quantities, then tick "verified" in the recipe editor.',
    );

  if (ctx.invalidLines.length)
    push(
      'invalid_recipe_lines',
      `${ctx.invalidLines.length} recipe line(s) cannot be calculated`,
      'These lines use a unit that cannot be converted to the ingredient’s stock unit, or are otherwise invalid. The dish is excluded until fixed.',
      ctx.invalidLines.map((l) => `${l.item.name} → ${l.ingredientName}: ${l.reason}`),
      [...new Map(ctx.invalidLines.map((l) => [l.item.id, l.item])).values()].map((m) =>
        verifyItem(m, 'Fix recipe units'),
      ),
      'Edit the recipe so each line uses g/kg, ml/L or pc matching the ingredient.',
    );

  const noCost = [...ctx.state.values()].filter((s) => s.usableQty > EPS && !s.costComplete);
  if (noCost.length)
    push(
      'missing_cost',
      `${noCost.length} ingredient(s) have stock without a purchase cost`,
      'Cost-based estimates for dishes using these ingredients are incomplete.',
      noCost.map((s) => s.ingredient.name),
      noCost.map((s) => ({
        type: 'verify' as const,
        subjectType: 'ingredient' as const,
        subjectId: s.ingredient.id,
        subjectName: s.ingredient.name,
        qty: null,
        unit: null,
        note: 'Record purchase cost from the supplier bill',
        estimatedCostPaise: null,
      })),
      'Add the cost from the supplier bill when recording receipts.',
    );

  if (ctx.salesIndex.tradingDays.size === 0) {
    push(
      'no_sales',
      'No sales history recorded',
      'Forecasts, stockout and waste-risk checks need at least a few days of actual sales.',
      ['Sales records'],
      [],
      'Enter sales manually or import a CSV in Sales.',
    );
  } else {
    const insufficient = ctx.verifiedItems.filter(
      (m) => ctx.fc(m.id, snap.planDate).method === 'insufficient',
    );
    if (insufficient.length)
      push(
        'insufficient_history',
        `${insufficient.length} dish(es) lack enough sales history`,
        'These dishes are excluded from demand-based calculations until more days are recorded.',
        insufficient.map((m) => m.name),
        [],
        'Keep recording daily sales; forecasts appear automatically once enough days exist.',
      );
  }

  const staleCut = new Date(Date.parse(snap.nowIso) - snap.settings.staleCountDays * 86400000).toISOString();
  const stale = [...ctx.state.values()].filter(
    (s) => s.usableQty > EPS && (!s.ingredient.lastCountedAt || s.ingredient.lastCountedAt < staleCut),
  );
  if (stale.length)
    push(
      'stale_count',
      `${stale.length} ingredient(s) not counted in the last ${snap.settings.staleCountDays} days`,
      'Calculations use recorded stock. If physical stock differs, recommendations will be wrong.',
      stale.map(
        (s) =>
          `${s.ingredient.name} (last count/receipt: ${s.ingredient.lastCountedAt ? formatDate(s.ingredient.lastCountedAt.slice(0, 10)) : 'never'})`,
      ),
      stale.map((s) => ({
        type: 'count' as const,
        subjectType: 'ingredient' as const,
        subjectId: s.ingredient.id,
        subjectName: s.ingredient.name,
        qty: s.usableQty,
        unit: s.ingredient.baseUnit,
        note: 'Physically count and record actual quantity',
        estimatedCostPaise: null,
      })),
      'Count these items and record the actual quantities.',
    );
}

// ---------------------------------------------------------------------------
// Delivery and order generators
// ---------------------------------------------------------------------------

function orderItemsInfo(ctx: Ctx, o: OrderSnap) {
  const byId = new Map(ctx.snap.menuItems.map((m) => [m.id, m]));
  return o.items.map((it) => {
    const m = byId.get(it.menuItemId);
    return {
      qty: it.qty,
      menuItemId: it.menuItemId,
      name: m?.name ?? `#${it.menuItemId}`,
      handlingClass: m?.handlingClass ?? null,
      maxHoldMin: m?.handlingMaxHoldMin ?? null,
      handlingVerified: !!m?.handlingVerified,
      cpp: ctx.costPerPortion(it.menuItemId),
    };
  });
}

function riskSettings(ctx: Ctx) {
  const st = ctx.snap.settings;
  return {
    prepWarnMin: st.prepWarnMin ?? 25,
    readyWaitWarnMin: st.readyWaitWarnMin ?? 10,
    readyWaitHighMin: st.readyWaitHighMin ?? 20,
    deliveryTargetMin: st.deliveryTargetMin ?? 45,
  };
}

function assessOrder(ctx: Ctx, o: OrderSnap): RiskResult {
  const items = orderItemsInfo(ctx, o);
  return assessDeliveryRisk({
    status: o.status,
    events: o.events,
    items: items.map((i) => ({
      name: i.name,
      handlingClass: i.handlingClass,
      maxHoldMin: i.maxHoldMin,
      handlingVerified: i.handlingVerified,
    })),
    estTravelMin: o.estTravelMin,
    packaging: o.packaging,
    delayReason: o.delayReason,
    settings: riskSettings(ctx),
    nowIso: ctx.snap.nowIso,
  });
}

function timeline(o: OrderSnap): string[] {
  return o.events.map(
    (e) => `${formatDateTime(e.at)} — ${EVENT_LABELS[e.type]}${e.reason ? ` (${e.reason})` : ''}`,
  );
}

function pickupDelay(ctx: Ctx, out: Recommendation[], risks: Map<number, RiskResult>) {
  for (const o of ctx.snap.orders ?? []) {
    if (!['prepared', 'packing', 'packed', 'ready_for_pickup', 'picked_up', 'in_transit'].includes(o.status))
      continue;
    const r = risks.get(o.id)!;
    if (r.level !== 'moderate' && r.level !== 'high') continue;
    const exceedsLimit = r.limitMin !== null && (r.projectedHoldMin ?? r.holdMin ?? 0) > r.limitMin;
    const waiting = o.status === 'ready_for_pickup' || o.status === 'packed';
    const line = (note: string): PlanLineDraft => ({
      type: 'order_action',
      subjectType: 'order',
      subjectId: o.id,
      subjectName: `Order ${o.ref}`,
      qty: null,
      unit: null,
      note,
      estimatedCostPaise: null,
    });
    const options: RecOption[] = [
      {
        key: 'A',
        label: waiting ? 'Alert staff and chase the pickup' : 'Contact the rider for an update',
        description: waiting
          ? 'Tell the counter team, contact the rider or delivery platform through your usual channel, and record what happened. Nothing is sent automatically.'
          : 'Ask the rider for an arrival estimate through your usual channel and record it. Nothing is sent automatically.',
        feasible: true,
        effects: [{ label: 'Current level', value: RISK_LABELS[r.level] }],
        estimatedCostPaise: null,
        lines: [
          line(
            waiting
              ? 'Alert staff; contact rider/platform; record pickup time'
              : 'Contact rider; record expected arrival',
          ),
        ],
      },
      {
        key: 'B',
        label: 'Record the delay reason',
        description: 'Capture why this order is delayed so recurring causes can be analysed later.',
        feasible: true,
        effects: [{ label: 'Delay reason on file', value: o.delayReason ?? 'Not yet recorded' }],
        estimatedCostPaise: null,
        lines: [line('Record the delay reason on the order')],
      },
    ];
    if (exceedsLimit) {
      options.unshift({
        key: 'C',
        label: 'Manager review before hand-over',
        description: `Recorded times exceed the verified handling limit (${r.limitMin} min). A manager decides per your food-safety procedure whether the order can still be handed over or must be remade. CulinAction does not make this decision.`,
        feasible: true,
        effects: [
          {
            label: 'Time since preparation',
            value: `${r.holdMin} min${r.projectedHoldMin !== null ? ` (≈ ${r.projectedHoldMin} at delivery)` : ''}`,
          },
        ],
        estimatedCostPaise: null,
        lines: [
          line(`Manager review: handling limit ${r.limitMin} min exceeded — follow food-safety procedure`),
        ],
      });
    }
    out.push({
      key: `pickup_delay:${o.id}`,
      kind: 'pickup_delay',
      severityTier: exceedsLimit ? 1 : 2,
      title: `Order ${o.ref}: ${RISK_LABELS[r.level].toLowerCase()} — ${
        o.status === 'ready_for_pickup'
          ? `waiting ${r.readyWaitMin} min for pickup`
          : `${o.status.replace(/_/g, ' ')}`
      }`,
      problem: r.summary,
      subjectName: `Order ${o.ref}`,
      evidence: {
        batches: [],
        recipes: [],
        sales: [],
        other: [...timeline(o), ...r.factors.map((f) => `${f.factor}: ${f.value} — ${f.note}`)],
      },
      calculation: r.factors.map((f) => `${f.factor}: ${f.value}. ${f.note}`),
      assumptions: [
        'Times are taken from the recorded order events; missing events are not estimated.',
        'Travel time is the recorded estimate, not live traffic or GPS data.',
      ],
      options,
      confidence: r.missing.length ? 'medium' : 'high',
      missingInfo: r.missing,
      safetyChecks: [
        'CulinAction does not measure food temperature; it compares recorded times with limits your outlet verified.',
        'No order is dispatched, cancelled or changed automatically.',
      ],
      nextStep: exceedsLimit
        ? 'Get a manager decision before this order is handed over.'
        : 'Chase the pickup now and record what happened.',
      estimatedImpactPaise: null,
      impactLabel: '',
      sortKey: `pickup_delay:${o.placedAt}:${o.ref}`,
    });
  }
}

function orderDisposition(ctx: Ctx, out: Recommendation[]) {
  const nowMs = Date.parse(ctx.snap.nowIso);
  for (const o of ctx.snap.orders ?? []) {
    if (!['cancelled', 'uncollected', 'returned'].includes(o.status) || o.disposition) continue;
    if (!preparedButUndelivered(o.events, o.status)) continue;
    const stage = orderStage(o.events, o.status);
    const items = orderItemsInfo(ctx, o);
    const costKnown = items.length > 0 && items.every((i) => i.cpp !== null);
    const cost = costKnown ? Math.round(items.reduce((a, i) => a + i.qty * i.cpp!, 0)) : null;
    const prepDone = o.events.find((e) => e.type === 'prep_completed')?.at ?? null;
    const reason =
      o.status === 'returned'
        ? 'returned'
        : o.status === 'uncollected'
          ? 'uncollected order'
          : 'cancelled order';
    const allVerified = items.length > 0 && items.every((i) => i.handlingVerified && i.maxHoldMin);
    const limit = allVerified ? Math.min(...items.map((i) => i.maxHoldMin!)) : null;
    const holdUntil = prepDone && limit !== null ? new Date(Date.parse(prepDone) + limit * 60_000) : null;
    const holdOk = o.status !== 'returned' && holdUntil !== null && holdUntil.getTime() > nowMs;
    const holdReason =
      o.status === 'returned'
        ? 'Customer-returned food is never served to another customer.'
        : !allVerified
          ? 'Verified handling limits are not recorded for every item.'
          : !prepDone
            ? 'Preparation completed time is not recorded.'
            : 'The verified handling limit has already passed.';
    const totalPortions = items.reduce((a, i) => a + i.qty, 0);
    const options: RecOption[] = [
      {
        key: 'A',
        label: 'Record disposal as waste',
        description:
          'Dispose of the prepared food per your procedure and record it, so the cost appears in waste analytics. Closes the order.',
        feasible: true,
        effects: [
          {
            label: 'Estimated ingredient cost of the food',
            value: cost === null ? 'Unknown — ingredient cost missing' : formatINR(cost),
          },
        ],
        estimatedCostPaise: cost,
        lines: [
          {
            type: 'dispose_order',
            subjectType: 'order',
            subjectId: o.id,
            subjectName: `Order ${o.ref}`,
            qty: totalPortions,
            unit: 'portions',
            note: `Record disposal (reason: ${reason})`,
            estimatedCostPaise: cost,
          },
        ],
      },
    ];
    if (o.status !== 'returned') {
      options.push({
        key: 'B',
        label: holdUntil
          ? `Hold for re-collection until ${formatDateTime(holdUntil.toISOString())}`
          : 'Hold for re-collection',
        description:
          'Keep the order only within the verified handling limit in case the customer or rider returns; if not collected by then, record disposal. Resale or donation is not suggested.',
        feasible: holdOk,
        infeasibleReason: holdOk ? undefined : holdReason,
        effects: [
          {
            label: 'Verified handling limit',
            value: limit === null ? 'Not verified' : `${limit} min after preparation`,
          },
        ],
        estimatedCostPaise: null,
        lines: [
          {
            type: 'order_action',
            subjectType: 'order',
            subjectId: o.id,
            subjectName: `Order ${o.ref}`,
            qty: null,
            unit: null,
            note: `Hold per verified rule until ${holdUntil ? formatDateTime(holdUntil.toISOString()) : '—'}; then record disposal if not collected`,
            estimatedCostPaise: null,
          },
        ],
      });
    }
    out.push({
      key: `order_disposition:${o.id}`,
      kind: 'order_disposition',
      severityTier: 2,
      title: `Order ${o.ref}: ${STAGE_LABELS[stage].toLowerCase()} — record what happens to the food`,
      problem: `Order ${o.ref} (${items.map((i) => `${i.qty} × ${i.name}`).join(', ')}) was prepared but did not reach the customer (${STAGE_LABELS[stage].toLowerCase()}). The food needs a recorded disposition.`,
      subjectName: `Order ${o.ref}`,
      evidence: { batches: [], recipes: [], sales: [], other: timeline(o) },
      calculation: [
        cost === null
          ? 'Ingredient cost of the prepared food: unknown (a recipe or cost is missing).'
          : `Ingredient cost = Σ portions × recipe cost per portion = ${formatINR(cost)} (estimate)`,
        ...(holdUntil
          ? [`Hold limit = preparation completed + ${limit} min = ${formatDateTime(holdUntil.toISOString())}`]
          : []),
      ],
      assumptions: ['The food has not been handed to anyone since the last recorded event.'],
      options,
      confidence: costKnown ? 'high' : 'medium',
      missingInfo: [
        ...(costKnown ? [] : ['Recipe cost for one or more items']),
        ...(allVerified ? [] : ['Verified handling limit for every item']),
      ],
      safetyChecks: [
        'CulinAction never assumes cancelled or uncollected food can be resold, reused or donated.',
        'Customer-returned food is never offered to another customer.',
      ],
      nextStep: 'Choose a disposition and add it to a plan; completing the task records the result.',
      estimatedImpactPaise: cost,
      impactLabel: 'Estimated ingredient cost of the prepared food',
      sortKey: `order_disposition:${o.placedAt}:${o.ref}`,
    });
  }
}

function median(xs: number[]): number | null {
  const a = [...xs].sort((x, y) => x - y);
  if (!a.length) return null;
  return a.length % 2 ? a[(a.length - 1) / 2] : (a[a.length / 2 - 1] + a[a.length / 2]) / 2;
}

function prepBottleneck(ctx: Ctx, out: Recommendation[]) {
  const st = riskSettings(ctx);
  const nowMs = Date.parse(ctx.snap.nowIso);
  const recent = (ctx.snap.orders ?? []).filter((o) => nowMs - Date.parse(o.placedAt) <= 14 * 86400000);
  const ds = recent.map((o) => durations(o.events, o.status, ctx.snap.nowIso));
  const prep = ds.map((d) => d.prepMin).filter((x): x is number => x !== null);
  const wait = ds.filter((d) => d.readyWaitMin !== null && !d.readyWaitOngoing).map((d) => d.readyWaitMin!);
  const mp = prep.length >= 5 ? median(prep) : null;
  const mw = wait.length >= 5 ? median(wait) : null;
  const slowPrep = mp !== null && mp > st.prepWarnMin;
  const slowWait = mw !== null && mw >= st.readyWaitWarnMin;
  if (!slowPrep && !slowWait) return;
  const verifyLine = (note: string): PlanLineDraft => ({
    type: 'verify',
    subjectType: 'outlet',
    subjectId: 0,
    subjectName: 'Kitchen flow',
    qty: null,
    unit: null,
    note,
    estimatedCostPaise: null,
  });
  out.push({
    key: 'prep_bottleneck',
    kind: 'prep_bottleneck',
    severityTier: 3,
    title: slowPrep
      ? `Preparation takes ${mp} min (median) — above the ${st.prepWarnMin}-min guideline`
      : `Orders wait ${mw} min (median) for pickup`,
    problem:
      'Recorded order timelines over the last 14 days show a recurring delay. Recurring delays increase how long food is held before it reaches customers.',
    subjectName: 'Kitchen flow',
    evidence: {
      batches: [],
      recipes: [],
      sales: [],
      other: [
        `${prep.length} orders with preparation start and end recorded`,
        `${wait.length} orders with ready and pickup times recorded`,
      ],
    },
    calculation: [
      mp === null
        ? 'Median preparation time: not enough orders (need 5)'
        : `Median preparation time = ${mp} min over ${prep.length} orders (guideline ${st.prepWarnMin} min)`,
      mw === null
        ? 'Median wait for pickup: not enough orders (need 5)'
        : `Median wait for pickup = ${mw} min over ${wait.length} orders (warning ${st.readyWaitWarnMin} min)`,
    ],
    assumptions: ['Only orders with both timestamps recorded are included.'],
    options: [
      {
        key: 'A',
        label: 'Investigate the bottleneck',
        description:
          'Review the slowest orders and the stations involved; adjust staffing or batch timing. Record findings.',
        feasible: true,
        effects: [],
        estimatedCostPaise: null,
        lines: [verifyLine('Review slow orders and stations; record findings')],
      },
      {
        key: 'B',
        label: 'Record delay reasons for a week',
        description: 'Ask staff to record a reason for every delayed order so the cause can be measured.',
        feasible: true,
        effects: [],
        estimatedCostPaise: null,
        lines: [verifyLine('Record a delay reason on every delayed order for 7 days')],
      },
    ],
    confidence: prep.length >= 20 || wait.length >= 20 ? 'high' : 'medium',
    missingInfo: [],
    safetyChecks: [],
    nextStep: 'Review the slowest orders in the Delivery workspace.',
    estimatedImpactPaise: null,
    impactLabel: '',
    sortKey: 'prep_bottleneck',
  });
}

export { assessOrder };

// ---------------------------------------------------------------------------
// Ranking and entry point
// ---------------------------------------------------------------------------

const CONF_RANK: Record<Confidence, number> = { high: 0, medium: 1, low: 2 };

export function compareRecommendations(a: Recommendation, b: Recommendation): number {
  if (a.severityTier !== b.severityTier) return a.severityTier - b.severityTier;
  const ai = a.estimatedImpactPaise;
  const bi = b.estimatedImpactPaise;
  if (ai !== bi) {
    if (ai === null) return 1;
    if (bi === null) return -1;
    return bi - ai;
  }
  if (a.confidence !== b.confidence) return CONF_RANK[a.confidence] - CONF_RANK[b.confidence];
  return a.sortKey < b.sortKey ? -1 : a.sortKey > b.sortKey ? 1 : 0;
}

export function runEngine(snap: Snapshot): EngineResult {
  const ctx = new Ctx(snap);
  const recs: Recommendation[] = [];
  unsafeStock(ctx, recs);
  verifyBestBefore(ctx, recs);
  stockoutRisk(ctx, recs);
  expiryWasteRisk(ctx, recs);
  prepAdjustment(ctx, recs);
  excessStock(ctx, recs);
  forecastDeviation(ctx, recs);
  dataGaps(ctx, recs);
  const orderRisks = new Map<number, RiskResult>();
  for (const o of snap.orders ?? []) orderRisks.set(o.id, assessOrder(ctx, o));
  pickupDelay(ctx, recs, orderRisks);
  orderDisposition(ctx, recs);
  prepBottleneck(ctx, recs);
  recs.sort(compareRecommendations);

  const forecasts = ctx.verifiedItems.map((m) => ctx.fc(m.id, snap.planDate));
  const byTier: Record<string, number> = { '1': 0, '2': 0, '3': 0, '4': 0 };
  for (const r of recs) byTier[String(r.severityTier)]++;
  let excludedBatches = 0;
  for (const s of ctx.state.values()) excludedBatches += s.batches.filter((b) => !b.safety.usable).length;

  return {
    engineVersion: ENGINE_VERSION,
    planDate: snap.planDate,
    today: snap.today,
    recommendations: recs,
    forecasts,
    stock: [...ctx.state.values()].map((s) => ({
      ingredientId: s.ingredient.id,
      name: s.ingredient.name,
      baseUnit: s.ingredient.baseUnit,
      usableQty: s.usableQty,
      excludedQty: s.excludedQty,
      unitCostPaise: s.unitCostPaise,
    })),
    orderRisks: [...orderRisks.entries()]
      .filter(([id]) => isOpen((snap.orders ?? []).find((o) => o.id === id)!.status))
      .map(([orderId, r]) => ({ orderId, level: r.level, factors: r.factors, missing: r.missing })),
    summary: {
      byTier,
      excludedBatches,
      verifiedItems: ctx.verifiedItems.length,
      itemsWithForecast: forecasts.filter((f) => f.method !== 'insufficient').length,
    },
  };
}

// ---------------------------------------------------------------------------
// Helpers for API views (same logic as the engine, no duplication)
// ---------------------------------------------------------------------------

/** Risk assessment for every order in the snapshot. */
export function assessOrders(snap: Snapshot): Map<number, RiskResult> {
  const ctx = new Ctx(snap);
  const out = new Map<number, RiskResult>();
  for (const o of snap.orders ?? []) out.set(o.id, assessOrder(ctx, o));
  return out;
}

export type PrepInputs =
  | { ok: false; reason: string }
  | {
      ok: true;
      item: MenuItemSnap;
      forecast: Forecast;
      ingredients: import('./whatIf').PrepIngredientInput[];
    };

/** Inputs for the preparation what-if: verified recipe, usable stock, other dishes' forecast demand. */
export function prepInputs(snap: Snapshot, menuItemId: number): PrepInputs {
  const ctx = new Ctx(snap);
  const item = ctx.verifiedItems.find((m) => m.id === menuItemId);
  if (!item) {
    const any = snap.menuItems.find((m) => m.id === menuItemId);
    return {
      ok: false,
      reason: any
        ? `${any.name} has no verified, valid recipe, so its ingredient use cannot be calculated.`
        : 'Menu item not found.',
    };
  }
  const per = ctx.perServing.get(item.id)!;
  const ingredients = [...per.entries()].map(([ingId, perPortion]) => {
    const st = ctx.st(ingId);
    const otherDemand = ctx
      .usersOf(ingId)
      .filter((m) => m.id !== item.id)
      .reduce((a, m) => {
        const f = ctx.fc(m.id, snap.planDate);
        return a + (f.method === 'insufficient' ? 0 : f.mean! * ctx.per(m.id, ingId));
      }, 0);
    return {
      ingredientId: ingId,
      name: st.ingredient.name,
      baseUnit: st.ingredient.baseUnit,
      perPortion,
      usableQty: st.usableQty,
      otherDemand: roundQty(otherDemand),
      unitCostPaise: st.unitCostPaise,
    };
  });
  return { ok: true, item, forecast: ctx.fc(item.id, snap.planDate), ingredients };
}

/** Forecast daily use of an ingredient across verified dishes (null when no dish has enough history). */
export function dailyUseOf(
  snap: Snapshot,
  ingredientId: number,
): {
  dailyUse: number | null;
  usableQty: number;
  unitCostPaise: number | null;
  baseUnit: string;
  name: string;
} | null {
  const ctx = new Ctx(snap);
  const st = ctx.state.get(ingredientId);
  if (!st) return null;
  const users = ctx.usersOf(ingredientId).map((m) => ({ m, f: ctx.fc(m.id, snap.planDate) }));
  const known = users.filter((x) => x.f.method !== 'insufficient');
  const dailyUse = known.length
    ? roundQty(known.reduce((a, { m, f }) => a + f.mean! * ctx.per(m.id, ingredientId), 0))
    : null;
  return {
    dailyUse,
    usableQty: st.usableQty,
    unitCostPaise: st.unitCostPaise,
    baseUnit: st.ingredient.baseUnit,
    name: st.ingredient.name,
  };
}
