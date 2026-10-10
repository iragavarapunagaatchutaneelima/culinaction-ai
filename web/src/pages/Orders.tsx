import { useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { post, put } from '../api';
import { formatDateTime, formatINR, nowISTLocal, WASTE_REASON_LABELS } from '../fmt';
import { useForm, useQuery } from '../hooks';
import { Icon } from '../icons';
import { useOutlet } from '../session';
import {
  Alert,
  Badge,
  Button,
  Card,
  Dialog,
  downloadUrl,
  Empty,
  ErrorState,
  FormError,
  Loading,
  PageHead,
  Prov,
  SelectField,
  TextField,
  useToast,
} from '../ui';

type Level = 'low' | 'moderate' | 'high' | 'insufficient';
const RISK: Record<Level, [string, 'ok' | 'warn' | 'danger' | 'outline']> = {
  low: ['Low apparent risk', 'ok'],
  moderate: ['Moderate risk', 'warn'],
  high: ['High risk', 'danger'],
  insufficient: ['Insufficient information', 'outline'],
};
export function RiskBadge({ level }: { level: Level }) {
  const [l, k] = RISK[level];
  return <Badge kind={k}>{l}</Badge>;
}
const STATUS_LABEL: Record<string, string> = {
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
const CHANNELS = [
  { value: 'aggregator', label: 'Delivery platform' },
  { value: 'own_delivery', label: 'Own delivery' },
  { value: 'takeaway', label: 'Takeaway' },
  { value: 'dine_in', label: 'Dine-in' },
  { value: 'other', label: 'Other' },
];
const mins = (v: number | null | undefined, ongoing?: boolean) =>
  v === null || v === undefined ? '—' : `${v} min${ongoing ? ' (ongoing)' : ''}`;

interface Durations {
  prepMin: number | null;
  packMin: number | null;
  readyWaitMin: number | null;
  readyWaitOngoing: boolean;
  deliveryMin: number | null;
  totalMin: number | null;
  totalOngoing: boolean;
  holdMin: number | null;
  holdOngoing: boolean;
}
interface OrderRow {
  id: number;
  ref: string;
  channelLabel: string;
  status: string;
  placedAt: string;
  items: string;
  lastEvent: { label: string; at: string } | null;
  durations: Durations;
  risk: { level: Level; summary: string };
  needsDisposition: boolean;
  delayReason: string | null;
}
interface Summary {
  orders: number;
  medians: {
    prepMin: number | null;
    packMin: number | null;
    readyWaitMin: number | null;
    deliveryMin: number | null;
    totalMin: number | null;
  };
  samples: { prep: number; readyWait: number; delivery: number };
  waitedOverWarning: number;
  openByRisk: Partial<Record<Level, number>>;
  delayReasons: { reason: string; count: number }[];
  thresholds: {
    prepWarnMin: number;
    readyWaitWarnMin: number;
    readyWaitHighMin: number;
    deliveryTargetMin: number;
  };
}

export function Orders() {
  const { api, base, canEdit } = useOutlet();
  const [params, setParams] = useSearchParams();
  const view = params.get('view') ?? 'open';
  const list = useQuery<OrderRow[]>(`${api}/orders?view=${view}`);
  const sum = useQuery<Summary>(`${api}/delivery/summary`);
  const [adding, setAdding] = useState(false);
  const nav = useNavigate();

  return (
    <div className="stack">
      <PageHead
        title="Orders & delivery risk"
        sub="Timelines and waits are calculated only from recorded events. No live traffic, GPS or platform data is used."
        actions={
          <>
            <a className="btn sm" href={downloadUrl(`${api}/export/orders.csv`)}>
              <Icon.Download size={16} /> Export
            </a>
            {canEdit && (
              <>
                <Link className="btn sm" to={`${base}/orders/import`}>
                  <Icon.Upload size={16} /> Import CSV
                </Link>
                <button className="btn primary" onClick={() => setAdding(true)}>
                  <Icon.Plus size={18} /> New order
                </button>
              </>
            )}
          </>
        }
      />

      {sum.data && (
        <div className="grid-3 grid-4">
          <div className="card stat">
            <div className="label">Open orders by risk</div>
            <div className="row" style={{ marginTop: 6, gap: 6 }}>
              {(['high', 'moderate', 'low', 'insufficient'] as Level[]).map((l) =>
                sum.data!.openByRisk[l] ? (
                  <span key={l} className="nowrap">
                    <RiskBadge level={l} /> <strong>{sum.data!.openByRisk[l]}</strong>
                  </span>
                ) : null,
              )}
              {!Object.keys(sum.data.openByRisk).length && (
                <span className="muted small">No open orders</span>
              )}
            </div>
          </div>
          <div className="card stat">
            <div className="label">
              Median preparation <Prov kind="actual" />
            </div>
            <div className={`value ${sum.data.medians.prepMin === null ? 'unavailable' : ''}`}>
              {sum.data.medians.prepMin === null ? 'No data' : `${sum.data.medians.prepMin} min`}
            </div>
            <div className="foot">
              {sum.data.samples.prep} orders · guideline {sum.data.thresholds.prepWarnMin} min
            </div>
          </div>
          <div className="card stat">
            <div className="label">
              Median wait for pickup <Prov kind="actual" />
            </div>
            <div className={`value ${sum.data.medians.readyWaitMin === null ? 'unavailable' : ''}`}>
              {sum.data.medians.readyWaitMin === null ? 'No data' : `${sum.data.medians.readyWaitMin} min`}
            </div>
            <div className="foot">
              {sum.data.waitedOverWarning} waited ≥ {sum.data.thresholds.readyWaitWarnMin} min (7 days)
            </div>
          </div>
          <div className="card stat">
            <div className="label">
              Median order to delivery <Prov kind="actual" />
            </div>
            <div className={`value ${sum.data.medians.totalMin === null ? 'unavailable' : ''}`}>
              {sum.data.medians.totalMin === null ? 'No data' : `${sum.data.medians.totalMin} min`}
            </div>
            <div className="foot">
              target {sum.data.thresholds.deliveryTargetMin} min · {sum.data.orders} orders in 7 days
            </div>
          </div>
        </div>
      )}

      <div className="seg" role="group" aria-label="Which orders">
        {[
          ['open', 'Open & needing action'],
          ['recent', 'Last 2 days'],
          ['all', 'Last 14 days'],
        ].map(([v, l]) => (
          <button key={v} aria-pressed={view === v} onClick={() => setParams({ view: v }, { replace: true })}>
            {l}
          </button>
        ))}
      </div>

      {list.error ? (
        <ErrorState error={list.error} onRetry={list.reload} />
      ) : list.loading && !list.data ? (
        <Loading />
      ) : !list.data?.length ? (
        <Card>
          <Empty
            icon={<Icon.Delivery />}
            title={view === 'open' ? 'No open orders' : 'No orders in this period'}
            action={
              canEdit && (
                <button className="btn primary" onClick={() => setAdding(true)}>
                  Record an order
                </button>
              )
            }
          >
            Record orders as they arrive, or import order events from your billing or delivery system as CSV.
            Each status change becomes a timeline event.
          </Empty>
        </Card>
      ) : (
        <Card>
          <ul className="list">
            {list.data.map((o) => (
              <li key={o.id}>
                <Link className="list-item" to={`${base}/orders/${o.id}`}>
                  <div className="grow">
                    <div className="title">
                      {o.ref} <span className="muted small">· {o.channelLabel}</span>
                    </div>
                    <div className="meta">
                      {o.items} · {STATUS_LABEL[o.status] ?? o.status}
                      {o.lastEvent && ` · ${o.lastEvent.label} ${formatDateTime(o.lastEvent.at)}`}
                    </div>
                    <div className="meta">
                      {o.durations.readyWaitMin !== null &&
                        `Wait ${mins(o.durations.readyWaitMin, o.durations.readyWaitOngoing)} · `}
                      Elapsed {mins(o.durations.totalMin, o.durations.totalOngoing)}
                      {o.delayReason && ` · ${o.delayReason}`}
                    </div>
                  </div>
                  <div className="right stack-sm" style={{ justifyItems: 'end' }}>
                    <RiskBadge level={o.risk.level} />
                    {o.needsDisposition && <Badge kind="warn">Needs disposition</Badge>}
                  </div>
                  <Icon.Chevron className="chev" />
                </Link>
              </li>
            ))}
          </ul>
        </Card>
      )}

      {sum.data && sum.data.delayReasons.length > 0 && (
        <Card title="Recorded delay reasons (7 days)">
          <ul className="list">
            {sum.data.delayReasons.map((d) => (
              <li key={d.reason} className="list-item" style={{ minHeight: 0 }}>
                <span className="grow small">{d.reason}</span>
                <strong>{d.count}</strong>
              </li>
            ))}
          </ul>
        </Card>
      )}

      {adding && (
        <NewOrderDialog onClose={() => setAdding(false)} onCreated={(id) => nav(`${base}/orders/${id}`)} />
      )}
    </div>
  );
}

function NewOrderDialog({ onClose, onCreated }: { onClose: () => void; onCreated: (id: number) => void }) {
  const { api } = useOutlet();
  const toast = useToast();
  const menu = useQuery<{ id: number; name: string; active: boolean }[]>(`${api}/menu-items`);
  const f = useForm({
    orderRef: '',
    channel: 'aggregator',
    placedAt: nowISTLocal(),
    estTravelMin: '',
    packaging: '',
    notes: '',
    lines: [{ menuItemId: '', qty: '1' }] as { menuItemId: string; qty: string }[],
  });
  const v = f.values;
  const submit = () =>
    void f.submit(
      async (x) => {
        const o = await post<{ id: number; ref: string }>(`${api}/orders`, {
          orderRef: x.orderRef,
          channel: x.channel,
          placedAt: x.placedAt,
          estTravelMin: x.estTravelMin || null,
          packaging: x.packaging,
          notes: x.notes,
          items: x.lines
            .filter((l) => l.menuItemId)
            .map((l) => ({ menuItemId: Number(l.menuItemId), qty: l.qty })),
        });
        toast(`Order ${o.ref} recorded`);
        onCreated(o.id);
      },
      (x) => {
        const e: Record<string, string> = {};
        if (!x.lines.some((l) => l.menuItemId)) e.items = 'Add at least one item';
        if (x.estTravelMin && !/^\d+$/.test(x.estTravelMin)) e.estTravelMin = 'Whole minutes';
        return e;
      },
    );
  return (
    <Dialog
      title="Record an order"
      onClose={onClose}
      footer={
        <>
          <button className="btn ghost" onClick={onClose}>
            Cancel
          </button>
          <Button className="primary" busy={f.submitting} onClick={submit}>
            Save order
          </Button>
        </>
      }
    >
      <div className="form">
        <FormError message={f.formError} />
        <div className="form-grid">
          <TextField
            label="Order reference (optional)"
            value={v.orderRef}
            onChange={(x) => f.set('orderRef', x)}
            error={f.errors.orderRef}
            placeholder="Auto if blank"
          />
          <SelectField
            label="Channel"
            value={v.channel}
            onChange={(x) => f.set('channel', x)}
            options={CHANNELS}
          />
          <TextField
            label="Order received at"
            type="datetime-local"
            value={v.placedAt}
            onChange={(x) => f.set('placedAt', x)}
            error={f.errors.placedAt}
            hint="India time"
          />
          <TextField
            label="Estimated travel (min, optional)"
            inputMode="numeric"
            value={v.estTravelMin}
            onChange={(x) => f.set('estTravelMin', x)}
            error={f.errors.estTravelMin}
            hint="Your estimate; not live traffic"
          />
          <TextField
            className="span-2"
            label="Packaging (optional)"
            value={v.packaging}
            onChange={(x) => f.set('packaging', x)}
            placeholder="e.g. Sealed foil container in insulated bag"
          />
        </div>
        <div className="stack-sm">
          <div className="strong small">Items</div>
          {f.errors.items && <div className="error small">{f.errors.items}</div>}
          {v.lines.map((l, i) => (
            <div key={i} className="qty-input" style={{ gridTemplateColumns: 'minmax(0,1fr) 80px auto' }}>
              <select
                className="input"
                aria-label={`Item ${i + 1}`}
                value={l.menuItemId}
                onChange={(e) =>
                  f.set(
                    'lines',
                    v.lines.map((x, j) => (j === i ? { ...x, menuItemId: e.target.value } : x)),
                  )
                }
              >
                <option value="">Choose a menu item…</option>
                {menu.data
                  ?.filter((m) => m.active)
                  .map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.name}
                    </option>
                  ))}
              </select>
              <input
                className="input"
                aria-label={`Quantity ${i + 1}`}
                inputMode="numeric"
                value={l.qty}
                onChange={(e) =>
                  f.set(
                    'lines',
                    v.lines.map((x, j) => (j === i ? { ...x, qty: e.target.value } : x)),
                  )
                }
              />
              <button
                type="button"
                className="btn ghost sm"
                aria-label="Remove item"
                onClick={() =>
                  f.set(
                    'lines',
                    v.lines.filter((_, j) => j !== i),
                  )
                }
                disabled={v.lines.length === 1}
              >
                <Icon.Close size={16} />
              </button>
            </div>
          ))}
          <div>
            <button
              type="button"
              className="btn sm"
              onClick={() => f.set('lines', [...v.lines, { menuItemId: '', qty: '1' }])}
            >
              <Icon.Plus size={16} /> Add item
            </button>
          </div>
        </div>
      </div>
    </Dialog>
  );
}

interface OrderDetailDto {
  id: number;
  ref: string;
  channelLabel: string;
  status: string;
  placedAt: string;
  estTravelMin: number | null;
  packaging: string | null;
  deliveryArea: string | null;
  delayReason: string | null;
  disposition: string | null;
  notes: string | null;
  source: string;
  items: {
    menuItemId: number;
    name: string;
    qty: number;
    handlingClass: string | null;
    maxHoldMin: number | null;
    handlingVerified: boolean;
  }[];
  events: {
    id: number;
    type: string;
    label: string;
    at: string;
    reason: string | null;
    note: string | null;
    source: string;
    userName: string | null;
  }[];
  durations: Durations;
  stage: { key: string; label: string };
  allowedEvents: { type: string; label: string }[];
  risk: {
    level: Level;
    summary: string;
    factors: { factor: string; value: string; effect: string; note: string }[];
    missing: string[];
    limitMin: number | null;
    holdMin: number | null;
    projectedHoldMin: number | null;
  };
  thresholds: {
    prepWarnMin: number;
    readyWaitWarnMin: number;
    readyWaitHighMin: number;
    deliveryTargetMin: number;
  };
  waste: { id: number; qty: number; reason: string; costPaise: number | null; costBasis: string | null }[];
  latestRecommendationId: number | null;
}

const NEEDS_REASON = ['cancelled', 'marked_uncollected', 'returned'];

export function OrderDetail() {
  const { id } = useParams();
  const { api, base, canEdit, outlet } = useOutlet();
  const toast = useToast();
  const nav = useNavigate();
  const { data: o, error, loading, reload, setData } = useQuery<OrderDetailDto>(`${api}/orders/${id}`);
  const [editing, setEditing] = useState(false);
  const [running, setRunning] = useState(false);
  const ev = useForm({ type: '', at: nowISTLocal(), reason: '', note: '' });

  if (error) return <ErrorState error={error} onRetry={reload} />;
  if (loading && !o) return <Loading />;
  if (!o) return null;

  const addEvent = (e: React.FormEvent) => {
    e.preventDefault();
    void ev.submit(
      async (x) => {
        setData(await post<OrderDetailDto>(`${api}/orders/${o.id}/events`, x));
        toast('Event recorded');
        ev.setValues({ type: '', at: nowISTLocal(), reason: '', note: '' });
      },
      (x) => {
        const er: Record<string, string> = {};
        if (!x.type) er.type = 'Choose an event';
        if (NEEDS_REASON.includes(x.type) && !x.reason.trim())
          er.reason = 'A reason is required for this event';
        return er;
      },
    );
  };

  const review = async () => {
    setRunning(true);
    try {
      const run = await post<{ items: { id: number; key: string }[] }>(`${api}/recommendations/run`, {});
      const rec = run.items.find(
        (i) => i.key === `pickup_delay:${o.id}` || i.key === `order_disposition:${o.id}`,
      );
      if (rec) nav(`${base}/recommendations/${rec.id}`);
      else toast('No action is recommended for this order right now.');
    } catch (e) {
      toast((e as Error).message, 'error');
    } finally {
      setRunning(false);
    }
  };

  const d = o.durations;
  const segs = [
    { label: 'Preparation', v: d.prepMin, cls: 'seg-prep' },
    { label: 'Packing', v: d.packMin, cls: 'seg-pack' },
    { label: 'Waiting for pickup', v: d.readyWaitMin, cls: 'seg-wait' },
    { label: 'Delivery', v: d.deliveryMin, cls: 'seg-deliv' },
  ].filter((s) => s.v !== null && s.v! > 0);
  const segTotal = segs.reduce((a, s) => a + (s.v ?? 0), 0);

  return (
    <div className="stack">
      <PageHead
        title={`Order ${o.ref}`}
        crumb={{ to: `${base}/orders`, label: 'Orders' }}
        sub={
          <span className="row" style={{ gap: 6 }}>
            {o.channelLabel} · {STATUS_LABEL[o.status] ?? o.status} · <RiskBadge level={o.risk.level} />
            {o.source === 'illustrative' && <Prov kind="illustrative" title="Demo data — simulated order" />}
          </span>
        }
        actions={
          canEdit && (
            <Button className="primary sm" busy={running} onClick={review}>
              <Icon.Decide size={16} /> Review recommended actions
            </Button>
          )
        }
      />

      <Card title="Timeline" actions={<span className="small muted">Stage: {o.stage.label}</span>}>
        <div className="card-body stack">
          {segs.length > 0 && (
            <div>
              <div
                className="timebar"
                role="img"
                aria-label={segs.map((s) => `${s.label} ${s.v} minutes`).join(', ')}
              >
                {segs.map((s) => (
                  <span
                    key={s.label}
                    className={s.cls}
                    style={{ flexGrow: s.v! / segTotal }}
                    title={`${s.label}: ${s.v} min`}
                  />
                ))}
              </div>
              <div className="legend" style={{ marginTop: 8 }}>
                {segs.map((s) => (
                  <span key={s.label}>
                    <i className={s.cls} />
                    {s.label}: {s.v} min
                    {s.label === 'Waiting for pickup' && d.readyWaitOngoing ? ' (ongoing)' : ''}
                  </span>
                ))}
              </div>
            </div>
          )}
          <ol className="events">
            {o.events.map((e, i) => {
              const prev = o.events[i - 1];
              const gap = prev ? Math.round((Date.parse(e.at) - Date.parse(prev.at)) / 6000) / 10 : null;
              return (
                <li key={e.id}>
                  <span className="ev-dot" />
                  <div>
                    <div className="strong small">{e.label}</div>
                    <div className="tiny muted">
                      {formatDateTime(e.at)}
                      {gap !== null && ` · +${gap} min`}
                      {e.userName && ` · ${e.userName}`}
                      {e.source === 'illustrative' && ' · simulated'}
                    </div>
                    {e.reason && <div className="small">Reason: {e.reason}</div>}
                    {e.note && <div className="small muted">{e.note}</div>}
                  </div>
                </li>
              );
            })}
          </ol>
          {o.allowedEvents.length > 0 ? (
            <form className="form" onSubmit={addEvent} noValidate>
              <h3>Record the next event</h3>
              <FormError message={ev.formError} />
              <div className="form-grid">
                <SelectField
                  label="Event"
                  value={ev.values.type}
                  onChange={(x) => ev.set('type', x)}
                  error={ev.errors.type}
                  placeholder="Choose…"
                  options={o.allowedEvents.map((a) => ({ value: a.type, label: a.label }))}
                />
                <TextField
                  label="When"
                  type="datetime-local"
                  value={ev.values.at}
                  onChange={(x) => ev.set('at', x)}
                  error={ev.errors.at}
                  hint="India time; must not be earlier than the last event"
                />
                <TextField
                  label={
                    NEEDS_REASON.includes(ev.values.type)
                      ? 'Reason (required)'
                      : 'Reason / delay cause (optional)'
                  }
                  value={ev.values.reason}
                  onChange={(x) => ev.set('reason', x)}
                  error={ev.errors.reason}
                />
                <TextField
                  label="Note (optional)"
                  value={ev.values.note}
                  onChange={(x) => ev.set('note', x)}
                />
              </div>
              <div>
                <Button className="primary sm" type="submit" busy={ev.submitting}>
                  Record event
                </Button>
              </div>
            </form>
          ) : (
            <p className="small muted">This order is closed; no further events can be recorded.</p>
          )}
        </div>
      </Card>

      <div className="grid-2">
        <Card
          title={<h2>Quality-risk assessment</h2>}
          tone={o.risk.level === 'high' ? 'danger' : o.risk.level === 'moderate' ? 'warn' : 'muted'}
        >
          <div className="card-body stack-sm">
            <p className="small">{o.risk.summary}</p>
            <ul className="factor-list">
              {o.risk.factors.map((f, i) => (
                <li key={i} className={`factor ${f.effect}`}>
                  <div className="spread">
                    <strong className="small">{f.factor}</strong>
                    <span className="small factor-value">{f.value}</span>
                  </div>
                  <div className="tiny muted">{f.note}</div>
                </li>
              ))}
            </ul>
            {o.risk.missing.length > 0 && (
              <Alert kind="info">
                <strong>Missing information:</strong> {o.risk.missing.join('; ')}.
              </Alert>
            )}
            <p className="tiny muted">
              Rule-based: compares recorded times with this outlet’s thresholds (warning{' '}
              {o.thresholds.readyWaitWarnMin} min, high {o.thresholds.readyWaitHighMin} min wait) and verified
              handling limits. It does not measure temperature.{' '}
              <Link to={`${base}/settings`}>Thresholds</Link>
            </p>
          </div>
        </Card>
        <Card
          title="Order details"
          actions={
            <button className="btn sm" onClick={() => setEditing(true)}>
              Edit
            </button>
          }
        >
          <div className="card-body stack-sm small">
            <div>
              <strong>Items:</strong>
              <ul style={{ margin: '4px 0 0', paddingLeft: 18 }}>
                {o.items.map((i) => (
                  <li key={i.menuItemId}>
                    {i.qty} × {i.name}{' '}
                    <span className="muted">
                      {i.handlingVerified && i.maxHoldMin
                        ? `— ${i.handlingClass}, verified limit ${i.maxHoldMin} min`
                        : '— handling limit not verified'}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
            <div>
              <strong>Received:</strong> {formatDateTime(o.placedAt)}
            </div>
            <div>
              <strong>Estimated travel:</strong>{' '}
              {o.estTravelMin === null ? 'Not recorded' : `${o.estTravelMin} min (estimate)`}
            </div>
            <div>
              <strong>Packaging:</strong> {o.packaging ?? 'Not recorded'}
            </div>
            <div>
              <strong>Delay reason:</strong> {o.delayReason ?? '—'}
            </div>
            {o.disposition && (
              <div>
                <strong>Disposition:</strong> {o.disposition}
              </div>
            )}
            {o.waste.map((w) => (
              <div key={w.id}>
                <Badge kind="warn">Waste recorded</Badge> {w.qty} portion(s) ·{' '}
                {WASTE_REASON_LABELS[w.reason] ?? w.reason}
                {w.costPaise !== null && ` · ${formatINR(w.costPaise)}`}{' '}
                {w.costBasis === 'recipe_estimate' && <Prov kind="estimate" />}
              </div>
            ))}
            {o.latestRecommendationId && (
              <Link to={`${base}/recommendations/${o.latestRecommendationId}`}>
                Latest recommendation for this order
              </Link>
            )}
          </div>
        </Card>
      </div>
      {editing && (
        <EditOrderDialog
          o={o}
          api={api}
          outletName={outlet.name}
          onClose={() => setEditing(false)}
          onSaved={(n) => (setData(n), setEditing(false))}
        />
      )}
    </div>
  );
}

function EditOrderDialog({
  o,
  api,
  onClose,
  onSaved,
}: {
  o: OrderDetailDto;
  api: string;
  outletName: string;
  onClose: () => void;
  onSaved: (o: OrderDetailDto) => void;
}) {
  const toast = useToast();
  const f = useForm({
    estTravelMin: o.estTravelMin === null ? '' : String(o.estTravelMin),
    packaging: o.packaging ?? '',
    deliveryArea: o.deliveryArea ?? '',
    delayReason: o.delayReason ?? '',
    notes: o.notes ?? '',
  });
  const submit = () =>
    void f.submit(async (x) => {
      const n = await put<OrderDetailDto>(`${api}/orders/${o.id}`, {
        ...x,
        estTravelMin: x.estTravelMin || null,
      });
      toast('Order updated');
      onSaved(n);
    });
  return (
    <Dialog
      title={`Edit order ${o.ref}`}
      onClose={onClose}
      footer={
        <>
          <button className="btn ghost" onClick={onClose}>
            Cancel
          </button>
          <Button className="primary" busy={f.submitting} onClick={submit}>
            Save
          </Button>
        </>
      }
    >
      <div className="form">
        <FormError message={f.formError} />
        <TextField
          label="Estimated travel (min)"
          inputMode="numeric"
          value={f.values.estTravelMin}
          onChange={(x) => f.set('estTravelMin', x)}
          error={f.errors.estTravelMin}
        />
        <TextField label="Packaging" value={f.values.packaging} onChange={(x) => f.set('packaging', x)} />
        <TextField
          label="Delivery area"
          value={f.values.deliveryArea}
          onChange={(x) => f.set('deliveryArea', x)}
        />
        <TextField
          label="Delay reason"
          value={f.values.delayReason}
          onChange={(x) => f.set('delayReason', x)}
          placeholder="e.g. Rider arrived late"
        />
        <TextField label="Notes" value={f.values.notes} onChange={(x) => f.set('notes', x)} />
      </div>
    </Dialog>
  );
}

interface ImportRow {
  line: number;
  ref: string;
  event: string;
  at: string | null;
  status: 'valid' | 'invalid';
  errors: string[];
  creates: boolean;
}

export function OrderImport() {
  const { api, base } = useOutlet();
  const toast = useToast();
  const [text, setText] = useState<string | null>(null);
  const [name, setName] = useState<string | null>(null);
  const [preview, setPreview] = useState<{
    rows: ImportRow[];
    summary: { total: number; valid: number; invalid: number };
  } | null>(null);
  const [result, setResult] = useState<{ imported: number; notImported: number } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const onFile = async (file?: File) => {
    setErr(null);
    setPreview(null);
    setResult(null);
    if (!file) return;
    if (!/\.csv$/i.test(file.name)) return setErr('Please choose a .csv file.');
    if (file.size > 1_000_000) return setErr('File is larger than 1 MB.');
    const t = await file.text();
    setText(t);
    setName(file.name);
    setBusy(true);
    try {
      setPreview(await post(`${api}/orders/import/preview`, { csvText: t }));
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const commit = async () => {
    if (!text) return;
    setBusy(true);
    try {
      const r = await post<{ imported: number; notImported: number }>(`${api}/orders/import/commit`, {
        csvText: text,
      });
      setResult(r);
      setPreview(null);
      toast(`${r.imported} event(s) imported`);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="stack">
      <PageHead
        title="Import order events"
        crumb={{ to: `${base}/orders`, label: 'Orders' }}
        sub="A dry-run check runs first. Only valid rows are saved, and the check is repeated when you confirm."
      />
      <Card title="1. Prepare the file">
        <div className="card-body stack-sm small">
          <p>
            One row per event, in time order: <code>order_ref, event, occurred_at</code> (required) and{' '}
            <code>channel, items, est_travel_min, packaging, reason</code>. The first row of a new order must
            be <code>received</code> with a channel and items such as{' '}
            <code>Masala Dosa x2; Filter Coffee x1</code>. Times are India time, <code>YYYY-MM-DD HH:mm</code>
            .
          </p>
          <div>
            <a className="btn sm" href={downloadUrl(`${api}/orders/import/template.csv`)}>
              <Icon.Download size={16} /> Download template
            </a>
          </div>
        </div>
      </Card>
      <Card title="2. Choose the file">
        <div className="card-body stack-sm">
          <input
            type="file"
            accept=".csv,text/csv"
            className="input"
            aria-label="Order events CSV file"
            onChange={(e) => void onFile(e.target.files?.[0])}
          />
          {busy && <Loading label="Checking…" />}
          {err && <Alert kind="danger">{err}</Alert>}
        </div>
      </Card>
      {preview && (
        <Card title={`3. Review ${name ?? ''}`}>
          <div className="card-body stack">
            <p className="small">
              {preview.summary.total} rows ·{' '}
              <strong style={{ color: 'var(--ok)' }}>{preview.summary.valid} valid</strong> ·{' '}
              <strong style={{ color: preview.summary.invalid ? 'var(--danger)' : undefined }}>
                {preview.summary.invalid} invalid
              </strong>
            </p>
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>Row</th>
                    <th>Order</th>
                    <th>Event</th>
                    <th>Time</th>
                    <th>Result</th>
                  </tr>
                </thead>
                <tbody>
                  {preview.rows.slice(0, 300).map((r) => (
                    <tr key={r.line} className={r.status === 'invalid' ? 'row-bad' : ''}>
                      <td>{r.line}</td>
                      <td>{r.ref}</td>
                      <td>{r.event}</td>
                      <td className="nowrap small">{r.at ? formatDateTime(r.at) : '—'}</td>
                      <td className="small">
                        {r.status === 'valid' ? (r.creates ? 'Creates order' : 'OK') : r.errors.join(' ')}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="row">
              <Button className="primary" busy={busy} disabled={!preview.summary.valid} onClick={commit}>
                Import {preview.summary.valid} valid row(s)
              </Button>
              <button className="btn ghost" onClick={() => setPreview(null)}>
                Discard
              </button>
            </div>
          </div>
        </Card>
      )}
      {result && (
        <Alert kind="ok">
          Imported {result.imported} event(s); {result.notImported} row(s) were not imported.{' '}
          <Link to={`${base}/orders?view=all`}>View orders</Link>
        </Alert>
      )}
    </div>
  );
}
