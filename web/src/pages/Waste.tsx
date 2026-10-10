import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { post } from '../api';
import {
  addDays,
  defaultUnit,
  formatDate,
  formatDateTime,
  formatINR,
  nowISTLocal,
  num,
  qtyLabel,
  todayIST,
  unitsForBase,
  WASTE_REASON_LABELS,
  type BaseUnit,
} from '../fmt';
import { useForm, useQuery } from '../hooks';
import { Icon } from '../icons';
import { useOutlet } from '../session';
import {
  Alert,
  Button,
  Card,
  Check,
  downloadUrl,
  Empty,
  ErrorState,
  FormError,
  Loading,
  PageHead,
  Prov,
  QtyField,
  SelectField,
  TextField,
  useToast,
} from '../ui';
import type { IngredientDetailDto, IngredientSummary } from './Inventory';

interface WasteRow {
  id: number;
  subjectType: 'ingredient' | 'menu_item';
  name: string;
  qty: number;
  unit: string;
  qtyBase: number;
  baseUnit: BaseUnit | null;
  occurredAt: string;
  date: string;
  reason: string;
  notes: string | null;
  servicePeriod: string | null;
  costPaise: number | null;
  costBasis: 'batch_cost' | 'recipe_estimate' | null;
  source: string;
  userName: string | null;
}

const reasonOptions = Object.entries(WASTE_REASON_LABELS).map(([value, label]) => ({ value, label }));

export function Waste() {
  const { api, outlet } = useOutlet();
  const toast = useToast();
  const [params] = useSearchParams();
  const today = todayIST();
  const [from, setFrom] = useState(addDays(today, -13));
  const list = useQuery<WasteRow[]>(`${api}/waste?from=${from}&to=${today}`);
  const ings = useQuery<{ items: IngredientSummary[] }>(`${api}/ingredients`);
  const menu = useQuery<{ id: number; name: string }[]>(`${api}/menu-items`);
  const pre = params.get('ingredient');
  const f = useForm({
    subjectType: pre ? 'ingredient' : 'menu_item',
    ingredientId: pre ?? '',
    batchId: '',
    menuItemId: '',
    qty: '',
    unit: 'portions',
    occurredAt: nowISTLocal(),
    reason: 'over_preparation',
    notes: '',
    servicePeriod: '',
    deductStock: true,
  });
  const v = f.values;
  const ing = ings.data?.items.find((i) => String(i.id) === v.ingredientId);
  const ingDetail = useQuery<IngredientDetailDto>(
    v.subjectType === 'ingredient' && v.ingredientId ? `${api}/ingredients/${v.ingredientId}` : null,
  );
  const units = v.subjectType === 'menu_item' ? ['portions'] : ing ? unitsForBase(ing.baseUnit) : ['g'];
  const unit = units.includes(v.unit)
    ? v.unit
    : ing
      ? defaultUnit(ing.baseUnit, outlet.preferredMassUnit, outlet.preferredVolumeUnit)
      : units[0];

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    void f.submit(
      async (x) => {
        const body =
          x.subjectType === 'ingredient'
            ? {
                subjectType: 'ingredient',
                ingredientId: Number(x.ingredientId),
                batchId: x.batchId ? Number(x.batchId) : null,
                qty: x.qty,
                unit,
                occurredAt: x.occurredAt,
                reason: x.reason,
                notes: x.notes,
                servicePeriod: x.servicePeriod,
                deductStock: x.deductStock,
              }
            : {
                subjectType: 'menu_item',
                menuItemId: Number(x.menuItemId),
                qty: x.qty,
                unit: 'portions',
                occurredAt: x.occurredAt,
                reason: x.reason,
                notes: x.notes,
                servicePeriod: x.servicePeriod,
              };
        await post(`${api}/waste`, body);
        toast('Waste recorded');
        f.setValues((s) => ({ ...s, qty: '', notes: '', batchId: '' }));
        void list.reload();
        void ingDetail.reload();
      },
      (x) => {
        const e: Record<string, string> = {};
        if (x.subjectType === 'ingredient' && !x.ingredientId) e.ingredientId = 'Choose an ingredient';
        if (x.subjectType === 'menu_item' && !x.menuItemId) e.menuItemId = 'Choose a menu item';
        const q = num(x.qty);
        if (q === null || Number.isNaN(q) || q <= 0) e.qty = 'Enter a quantity greater than zero';
        return e;
      },
    );
  };

  const total = (list.data ?? []).reduce(
    (a, w) => {
      if (w.costPaise === null) a.unknown++;
      else if (w.costBasis === 'batch_cost') a.recorded += w.costPaise;
      else a.estimated += w.costPaise;
      return a;
    },
    { recorded: 0, estimated: 0, unknown: 0 },
  );

  return (
    <div className="stack">
      <PageHead
        title="Waste log"
        sub="Record what was thrown away and why. Ingredient waste is removed from stock."
        actions={
          <a className="btn sm" href={downloadUrl(`${api}/export/waste.csv`)}>
            <Icon.Download size={16} /> Export
          </a>
        }
      />
      <form onSubmit={submit} noValidate>
        <Card
          title="Record waste"
          foot={
            <Button className="primary" type="submit" busy={f.submitting}>
              Record waste
            </Button>
          }
        >
          <div className="card-body stack">
            <FormError message={f.formError} />
            <div className="seg" role="group" aria-label="What was wasted">
              <button
                type="button"
                aria-pressed={v.subjectType === 'menu_item'}
                onClick={() => f.set('subjectType', 'menu_item')}
              >
                Prepared dish
              </button>
              <button
                type="button"
                aria-pressed={v.subjectType === 'ingredient'}
                onClick={() => f.set('subjectType', 'ingredient')}
              >
                Raw ingredient
              </button>
            </div>
            <div className="form-grid">
              {v.subjectType === 'ingredient' ? (
                <>
                  <SelectField
                    label="Ingredient"
                    value={v.ingredientId}
                    onChange={(x) => {
                      f.set('ingredientId', x);
                      f.set('batchId', '');
                    }}
                    error={f.errors.ingredientId}
                    required
                    placeholder="Choose…"
                    options={(ings.data?.items ?? []).map((i) => ({ value: String(i.id), label: i.name }))}
                  />
                  <SelectField
                    label="From batch"
                    value={v.batchId}
                    onChange={(x) => f.set('batchId', x)}
                    placeholder="Earliest-dated first (automatic)"
                    options={(ingDetail.data?.batches ?? [])
                      .filter((b) => b.status !== 'empty')
                      .map((b) => ({
                        value: String(b.id),
                        label: `${b.lotCode ?? `Batch #${b.id}`} — ${qtyLabel(b.qtyRemaining, ingDetail.data!.baseUnit)}${b.dateValue ? `, ${formatDate(b.dateValue)}` : ''}`,
                      }))}
                    error={f.errors.batchId}
                  />
                </>
              ) : (
                <SelectField
                  className="span-2"
                  label="Menu item"
                  value={v.menuItemId}
                  onChange={(x) => f.set('menuItemId', x)}
                  error={f.errors.menuItemId}
                  required
                  placeholder="Choose…"
                  options={(menu.data ?? []).map((m) => ({ value: String(m.id), label: m.name }))}
                />
              )}
              <QtyField
                label="Quantity"
                qty={v.qty}
                unit={unit}
                units={units}
                onQty={(x) => f.set('qty', x)}
                onUnit={(x) => f.set('unit', x)}
                error={f.errors.qty ?? f.errors.unit}
                required
              />
              <SelectField
                label="Reason"
                value={v.reason}
                onChange={(x) => f.set('reason', x)}
                options={reasonOptions}
                error={f.errors.reason}
              />
              <TextField
                label="When"
                type="datetime-local"
                value={v.occurredAt}
                onChange={(x) => f.set('occurredAt', x)}
                error={f.errors.occurredAt}
                hint="India time"
              />
              {outlet.servicePeriods.length > 0 && (
                <SelectField
                  label="Service period"
                  value={v.servicePeriod}
                  onChange={(x) => f.set('servicePeriod', x)}
                  placeholder="Not linked"
                  options={outlet.servicePeriods.map((p) => ({ value: p, label: p }))}
                />
              )}
              <TextField
                className="span-2"
                label="Notes (optional)"
                value={v.notes}
                onChange={(x) => f.set('notes', x)}
              />
            </div>
            {v.subjectType === 'ingredient' && (
              <Check
                label="Deduct this quantity from recorded stock"
                checked={v.deductStock}
                onChange={(x) => f.set('deductStock', x)}
                hint="Untick only if the stock was already adjusted another way."
              />
            )}
            {v.subjectType === 'menu_item' && (
              <p className="muted small">
                Cost of wasted portions is estimated from the verified recipe and current ingredient costs,
                and is labelled as an estimate.
              </p>
            )}
          </div>
        </Card>
      </form>

      <Card
        title={
          <h2>
            Recorded waste <Prov kind="actual" />
          </h2>
        }
        actions={
          <label className="row small">
            Since{' '}
            <input
              className="input"
              type="date"
              value={from}
              max={today}
              onChange={(e) => setFrom(e.target.value)}
              style={{ width: 160 }}
            />
          </label>
        }
      >
        {list.error ? (
          <div className="card-body">
            <ErrorState error={list.error} onRetry={list.reload} />
          </div>
        ) : list.loading && !list.data ? (
          <Loading />
        ) : !list.data?.length ? (
          <Empty icon={<Icon.Waste />} title="No waste recorded in this period">
            Recording waste honestly is what makes before/after comparisons possible.
          </Empty>
        ) : (
          <>
            <div className="card-body small row" style={{ gap: 16 }}>
              <span>
                Recorded at batch cost: <strong>{formatINR(total.recorded)}</strong> <Prov kind="actual" />
              </span>
              <span>
                Estimated from recipes: <strong>{formatINR(total.estimated)}</strong> <Prov kind="estimate" />
              </span>
              {total.unknown > 0 && <span className="muted">{total.unknown} entr(ies) without cost</span>}
            </div>
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>When</th>
                    <th>Item</th>
                    <th className="num">Qty</th>
                    <th>Reason</th>
                    <th className="num">Cost</th>
                  </tr>
                </thead>
                <tbody>
                  {list.data.map((w) => (
                    <tr key={w.id}>
                      <td className="small nowrap">{formatDateTime(w.occurredAt)}</td>
                      <td>
                        {w.name}
                        <div className="tiny muted">
                          {w.subjectType === 'menu_item' ? 'Prepared dish' : 'Ingredient'}
                          {w.notes ? ` · ${w.notes}` : ''}
                          {w.userName ? ` · ${w.userName}` : ''}
                        </div>
                      </td>
                      <td className="num">
                        {w.subjectType === 'ingredient' && w.baseUnit
                          ? qtyLabel(w.qtyBase, w.baseUnit)
                          : `${w.qty} ${w.unit}`}
                      </td>
                      <td className="small">{WASTE_REASON_LABELS[w.reason] ?? w.reason}</td>
                      <td className="num small">
                        {w.costPaise === null ? (
                          <Prov kind="unavailable" />
                        ) : (
                          <>
                            {formatINR(w.costPaise)}{' '}
                            <Prov kind={w.costBasis === 'batch_cost' ? 'actual' : 'estimate'} />
                          </>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </Card>
    </div>
  );
}

// ---------------- Service outcomes ----------------

interface OutcomeRow {
  id: number;
  date: string;
  servicePeriod: string;
  menuItemName: string;
  prepared: number;
  sold: number;
  remaining: number;
  discarded: number;
  taskId: number | null;
  notes: string | null;
  source: string;
  userName: string | null;
}

export function Outcomes() {
  const { api, outlet } = useOutlet();
  const toast = useToast();
  const [params] = useSearchParams();
  const today = todayIST();
  const list = useQuery<OutcomeRow[]>(`${api}/outcomes?from=${addDays(today, -29)}&to=${today}`);
  const menu = useQuery<{ id: number; name: string; active: boolean; recipe: { exists: boolean } }[]>(
    `${api}/menu-items`,
  );
  const [effects, setEffects] = useState<string[] | null>(null);
  const f = useForm({
    date: today,
    servicePeriod: outlet.servicePeriods[0] ?? '',
    menuItemId: params.get('menuItemId') ?? '',
    prepared: params.get('prepared') ?? '',
    sold: '',
    remaining: '0',
    discarded: '0',
    notes: '',
    taskId: params.get('taskId') ?? '',
    recordSales: true,
    deductIngredients: true,
    discardReason: 'over_preparation',
  });
  const v = f.values;
  const n = (s: string) => num(s) ?? 0;
  const accounted = n(v.sold) + n(v.remaining) + n(v.discarded);
  const prepared = n(v.prepared);
  const item = menu.data?.find((m) => String(m.id) === v.menuItemId);

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    setEffects(null);
    void f.submit(
      async (x) => {
        const r = await post<{ effects: string[]; unaccounted: number }>(`${api}/outcomes`, {
          ...x,
          menuItemId: Number(x.menuItemId),
          taskId: x.taskId ? Number(x.taskId) : null,
          deductIngredients: x.deductIngredients && !!item?.recipe.exists,
        });
        toast('Outcome recorded');
        setEffects(r.effects);
        f.setValues((s) => ({
          ...s,
          menuItemId: '',
          prepared: '',
          sold: '',
          remaining: '0',
          discarded: '0',
          notes: '',
          taskId: '',
        }));
        void list.reload();
      },
      (x) => {
        const e: Record<string, string> = {};
        if (!x.menuItemId) e.menuItemId = 'Choose a menu item';
        for (const k of ['prepared', 'sold', 'remaining', 'discarded'] as const) {
          const q = num(x[k]);
          if (q === null || Number.isNaN(q) || q < 0) e[k] = 'Enter 0 or more';
        }
        if (!e.prepared && accounted > prepared) e.prepared = 'Must be at least sold + remaining + discarded';
        if (x.date > today) e.date = 'Cannot be in the future';
        return e;
      },
    );
  };

  return (
    <div className="stack">
      <PageHead
        title="Service outcomes"
        sub="After service, record what was actually prepared, sold, left over and discarded. These records are how results are measured."
        actions={
          <a className="btn sm" href={downloadUrl(`${api}/export/outcomes.csv`)}>
            <Icon.Download size={16} /> Export
          </a>
        }
      />
      <form onSubmit={submit} noValidate>
        <Card
          title="Record an outcome"
          foot={
            <Button className="primary" type="submit" busy={f.submitting}>
              Save outcome
            </Button>
          }
        >
          <div className="card-body stack">
            <FormError message={f.formError} />
            {v.taskId && (
              <Alert kind="info">
                Linked to plan task #{v.taskId}. This outcome will be compared with the approved preparation
                quantity.
              </Alert>
            )}
            <div className="form-grid">
              <TextField
                label="Date"
                type="date"
                value={v.date}
                onChange={(x) => f.set('date', x)}
                error={f.errors.date}
                required
              />
              {outlet.servicePeriods.length > 0 ? (
                <SelectField
                  label="Service period"
                  value={v.servicePeriod}
                  onChange={(x) => f.set('servicePeriod', x)}
                  placeholder="Whole day"
                  options={outlet.servicePeriods.map((p) => ({ value: p, label: p }))}
                />
              ) : (
                <div />
              )}
              <SelectField
                className="span-2"
                label="Menu item"
                value={v.menuItemId}
                onChange={(x) => f.set('menuItemId', x)}
                error={f.errors.menuItemId}
                required
                placeholder="Choose…"
                options={(menu.data ?? [])
                  .filter((m) => m.active)
                  .map((m) => ({ value: String(m.id), label: m.name }))}
              />
              <TextField
                label="Prepared (portions)"
                inputMode="decimal"
                value={v.prepared}
                onChange={(x) => f.set('prepared', x)}
                error={f.errors.prepared}
                required
              />
              <TextField
                label="Sold"
                inputMode="decimal"
                value={v.sold}
                onChange={(x) => f.set('sold', x)}
                error={f.errors.sold}
                required
              />
              <TextField
                label="Remaining (kept for later)"
                inputMode="decimal"
                value={v.remaining}
                onChange={(x) => f.set('remaining', x)}
                error={f.errors.remaining}
              />
              <TextField
                label="Discarded"
                inputMode="decimal"
                value={v.discarded}
                onChange={(x) => f.set('discarded', x)}
                error={f.errors.discarded}
              />
              {n(v.discarded) > 0 && (
                <SelectField
                  label="Discard reason"
                  value={v.discardReason}
                  onChange={(x) => f.set('discardReason', x)}
                  options={reasonOptions}
                />
              )}
              <TextField
                className="span-2"
                label="Notes (optional)"
                value={v.notes}
                onChange={(x) => f.set('notes', x)}
                placeholder="e.g. Rain reduced footfall"
              />
            </div>
            {prepared > 0 && accounted < prepared && (
              <p className="small muted">
                {prepared - accounted} portion(s) not accounted for (e.g. staff meals). That is allowed, but
                will show as unaccounted.
              </p>
            )}
            <Check
              label="Add the sold quantity to sales history"
              checked={v.recordSales}
              onChange={(x) => f.set('recordSales', x)}
              hint="Untick if you already recorded or imported sales for this item and day."
            />
            <Check
              label="Deduct recipe ingredients for the prepared portions from stock"
              checked={v.deductIngredients && !!item?.recipe.exists}
              onChange={(x) => f.set('deductIngredients', x)}
              hint={
                item && !item.recipe.exists
                  ? 'This item has no recipe, so nothing can be deducted.'
                  : 'Uses usable batches only, earliest date first.'
              }
            />
          </div>
        </Card>
      </form>
      {effects && <Alert kind="ok">{effects.length ? effects.join('. ') + '.' : 'Outcome saved.'}</Alert>}
      <Card
        title={
          <h2>
            Recent outcomes <Prov kind="actual" />
          </h2>
        }
      >
        {list.error ? (
          <div className="card-body">
            <ErrorState error={list.error} onRetry={list.reload} />
          </div>
        ) : list.loading && !list.data ? (
          <Loading />
        ) : !list.data?.length ? (
          <Empty icon={<Icon.Outcome />} title="No outcomes recorded">
            Outcomes are compared with plans and forecasts to show what actually happened.
          </Empty>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Item</th>
                  <th className="num">Prepared</th>
                  <th className="num">Sold</th>
                  <th className="num">Remaining</th>
                  <th className="num">Discarded</th>
                </tr>
              </thead>
              <tbody>
                {list.data.map((o) => (
                  <tr key={o.id}>
                    <td className="nowrap small">
                      {formatDate(o.date)}
                      {o.servicePeriod && <div className="tiny muted">{o.servicePeriod}</div>}
                    </td>
                    <td>
                      {o.menuItemName}
                      {o.taskId && <div className="tiny muted">Plan task #{o.taskId}</div>}
                      {o.source === 'illustrative' && (
                        <div>
                          <Prov kind="illustrative" />
                        </div>
                      )}
                    </td>
                    <td className="num">{o.prepared}</td>
                    <td className="num">{o.sold}</td>
                    <td className="num">{o.remaining}</td>
                    <td className="num" style={{ color: o.discarded ? 'var(--danger)' : undefined }}>
                      {o.discarded}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}
