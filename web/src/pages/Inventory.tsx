import { useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { post, put } from '../api';
import {
  DATE_TYPE_LABEL,
  defaultUnit,
  formatDate,
  formatDateTime,
  formatINR,
  formatQty,
  num,
  todayIST,
  unitCostLabel,
  unitsForBase,
  type BaseUnit,
} from '../fmt';
import { useForm, useQuery } from '../hooks';
import { Icon } from '../icons';
import { useOutlet } from '../session';
import {
  Alert,
  BatchStatus,
  Button,
  Card,
  Check,
  Dialog,
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

interface IngredientSummary {
  id: number;
  name: string;
  category: string;
  baseUnit: BaseUnit;
  usableQty: number;
  excludedQty: number;
  usableLabel: string;
  unitCostPaise: number | null;
  costMissing: boolean;
  batchCount: number;
  nearestDate: { type: string; value: string; status: string } | null;
  undatedQty: number;
  flags: { unsafe: boolean; verify: boolean; expiring: boolean; outOfStock: boolean };
  storageNotes: string | null;
  supplierName: string | null;
  source: string;
  lastCountedAt: string | null;
  updatedAt: string;
  usedInMenuItems: number;
}
interface Batch {
  id: number;
  lotCode: string | null;
  qtyReceived: number;
  qtyRemaining: number;
  unitCostPaise: number | null;
  totalCostPaise: number | null;
  receivedOn: string;
  dateType: string | null;
  dateValue: string | null;
  quarantined: boolean;
  qualityCheckedOn: string | null;
  storageVerifiedOn: string | null;
  source: string;
  status: string;
  statusReason: string;
}
interface Movement {
  id: number;
  type: string;
  qtyDelta: number;
  reason: string;
  batchId: number | null;
  createdAt: string;
  userName: string | null;
  ingredientId?: number;
  ingredientName?: string;
  baseUnit?: BaseUnit;
}
interface IngredientDetailDto extends IngredientSummary {
  batches: Batch[];
  usedIn: { id: number; name: string; qty: number; unit: string; lossPct: number; verified: boolean }[];
  movements: Movement[];
}

const STATUS_FILTERS = [
  { value: '', label: 'All' },
  { value: 'unsafe', label: 'Do not use' },
  { value: 'verify', label: 'Check quality' },
  { value: 'expiring', label: 'Use soon' },
  { value: 'outOfStock', label: 'No usable stock' },
  { value: 'costMissing', label: 'Cost missing' },
];

export function Inventory() {
  const { api, base, canEdit } = useOutlet();
  const [params, setParams] = useSearchParams();
  const q = params.get('q') ?? '';
  const status = params.get('status') ?? '';
  const category = params.get('category') ?? '';
  const sort = params.get('sort') ?? 'name';
  const qs = new URLSearchParams({ q, status, category, sort }).toString();
  const { data, error, loading, reload } = useQuery<{ items: IngredientSummary[]; categories: string[] }>(
    `${api}/ingredients?${qs}`,
  );
  const setParam = (k: string, v: string) => {
    const n = new URLSearchParams(params);
    if (v) n.set(k, v);
    else n.delete(k);
    setParams(n, { replace: true });
  };

  return (
    <div className="stack">
      <PageHead
        title="Inventory"
        sub="Usable stock excludes anything past its use-by/expiry date, marked unsafe, or past best-before without a check."
        actions={
          <>
            <a className="btn sm" href={downloadUrl(`${api}/export/inventory.csv`)}>
              <Icon.Download size={16} /> Export CSV
            </a>
            {canEdit && (
              <Link className="btn primary" to={`${base}/inventory/new`}>
                <Icon.Plus size={18} /> Add ingredient
              </Link>
            )}
          </>
        }
      />
      <div className="toolbar" role="search">
        <input
          className="input"
          placeholder="Search ingredient or supplier"
          value={q}
          onChange={(e) => setParam('q', e.target.value)}
          aria-label="Search ingredients"
        />
        <select
          className="input"
          value={status}
          onChange={(e) => setParam('status', e.target.value)}
          aria-label="Filter by status"
        >
          {STATUS_FILTERS.map((s) => (
            <option key={s.value} value={s.value}>
              {s.label}
            </option>
          ))}
        </select>
        <select
          className="input"
          value={category}
          onChange={(e) => setParam('category', e.target.value)}
          aria-label="Filter by category"
        >
          <option value="">All categories</option>
          {data?.categories.map((c) => (
            <option key={c}>{c}</option>
          ))}
        </select>
        <select
          className="input"
          value={sort}
          onChange={(e) => setParam('sort', e.target.value)}
          aria-label="Sort"
        >
          <option value="name">Sort: name</option>
          <option value="qty">Sort: lowest stock</option>
          <option value="date">Sort: nearest date</option>
          <option value="category">Sort: category</option>
          <option value="updated">Sort: recently updated</option>
        </select>
      </div>
      {error ? (
        <ErrorState error={error} onRetry={reload} />
      ) : loading && !data ? (
        <Loading />
      ) : !data?.items.length ? (
        <Card>
          {q || status || category ? (
            <Empty title="No ingredients match">Try clearing the search or filters.</Empty>
          ) : (
            <Empty
              icon={<Icon.Stock />}
              title="No ingredients yet"
              action={
                canEdit && (
                  <Link className="btn primary" to={`${base}/inventory/new`}>
                    Add your first ingredient
                  </Link>
                )
              }
            >
              Add the ingredients you actually hold, with the quantity on hand, the bill cost and any use-by
              date printed on the pack.
            </Empty>
          )}
        </Card>
      ) : (
        <Card>
          <ul className="list">
            {data.items.map((i) => (
              <li key={i.id}>
                <Link className="list-item" to={`${base}/inventory/${i.id}`}>
                  <div className="grow">
                    <div className="title">{i.name}</div>
                    <div className="meta">
                      {i.category}
                      {i.nearestDate &&
                        ` · ${DATE_TYPE_LABEL[i.nearestDate.type]} ${formatDate(i.nearestDate.value)}`}
                      {!i.nearestDate && i.batchCount > 0 && ' · no date supplied'}
                      {i.supplierName && ` · ${i.supplierName}`}
                    </div>
                  </div>
                  <div className="right">
                    <div className="strong nowrap">{i.usableLabel}</div>
                    <div className="row" style={{ justifyContent: 'flex-end', gap: 4, marginTop: 2 }}>
                      {i.flags.unsafe && <BatchStatus status="unsafe" />}
                      {i.flags.verify && <BatchStatus status="verify" />}
                      {i.flags.expiring && <BatchStatus status="expiring" />}
                      {i.flags.outOfStock && !i.flags.unsafe && (
                        <span className="badge outline">None usable</span>
                      )}
                      {i.costMissing && <span className="badge outline">No cost</span>}
                    </div>
                  </div>
                  <Icon.Chevron className="chev" />
                </Link>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </div>
  );
}

// ---------------- Add / edit ----------------

export function IngredientForm() {
  const { id } = useParams();
  const editing = !!id;
  const { api, base, outlet } = useOutlet();
  const nav = useNavigate();
  const toast = useToast();
  const existing = useQuery<IngredientDetailDto>(editing ? `${api}/ingredients/${id}` : null);
  if (editing && existing.error) return <ErrorState error={existing.error} />;
  if (editing && !existing.data) return <Loading />;
  return (
    <IngredientFormInner
      key={id ?? 'new'}
      existing={existing.data}
      api={api}
      base={base}
      outlet={outlet}
      nav={nav}
      toast={toast}
    />
  );
}

function IngredientFormInner({
  existing,
  api,
  base,
  outlet,
  nav,
  toast,
}: {
  existing: IngredientDetailDto | null;
  api: string;
  base: string;
  outlet: { preferredMassUnit: string; preferredVolumeUnit: string };
  nav: ReturnType<typeof useNavigate>;
  toast: ReturnType<typeof useToast>;
}) {
  const f = useForm({
    name: existing?.name ?? '',
    category: existing?.category ?? '',
    baseUnit: (existing?.baseUnit ?? 'g') as string,
    supplierName: existing?.supplierName ?? '',
    storageNotes: existing?.storageNotes ?? '',
    withStock: !existing,
    qty: '',
    unit: defaultUnit('g', outlet.preferredMassUnit, outlet.preferredVolumeUnit),
    totalCostInr: '',
    receivedOn: todayIST(),
    lotCode: '',
    dateType: '',
    dateValue: '',
  });
  const v = f.values;
  const locked = !!existing && (existing.batches.length > 0 || existing.usedIn.length > 0);

  const save = (e: React.FormEvent) => {
    e.preventDefault();
    void f.submit(
      async (x) => {
        const body = {
          name: x.name,
          category: x.category,
          baseUnit: x.baseUnit,
          supplierName: x.supplierName,
          storageNotes: x.storageNotes,
          ...(!existing && x.withStock
            ? {
                initialStock: {
                  qty: x.qty,
                  unit: x.unit,
                  totalCostInr: x.totalCostInr,
                  receivedOn: x.receivedOn,
                  lotCode: x.lotCode,
                  dateType: x.dateType || null,
                  dateValue: x.dateValue || null,
                },
              }
            : {}),
        };
        const r = existing
          ? await put<IngredientDetailDto>(`${api}/ingredients/${existing.id}`, body)
          : await post<IngredientDetailDto>(`${api}/ingredients`, body);
        toast(existing ? 'Ingredient updated' : 'Ingredient added');
        nav(`${base}/inventory/${r.id}`);
      },
      (x) => {
        const e: Record<string, string> = {};
        if (!x.name.trim()) e.name = 'Required';
        if (!x.category.trim()) e.category = 'Required';
        if (!existing && x.withStock) {
          const n = num(x.qty);
          if (n === null || Number.isNaN(n) || n <= 0)
            e['initialStock.qty'] = 'Enter a quantity greater than zero';
          if (x.totalCostInr && !/^\d+(\.\d{1,2})?$/.test(x.totalCostInr.replace(/,/g, '')))
            e['initialStock.totalCostInr'] = 'Enter rupees, e.g. 450 or 450.50';
          if (!!x.dateType !== !!x.dateValue)
            e['initialStock.dateValue'] = 'Choose a date type and a date together, or leave both blank';
        }
        return e;
      },
    );
  };

  const units = unitsForBase(v.baseUnit as BaseUnit);
  return (
    <form onSubmit={save} noValidate className="stack">
      <PageHead
        title={existing ? `Edit ${existing.name}` : 'Add ingredient'}
        crumb={{
          to: existing ? `${base}/inventory/${existing.id}` : `${base}/inventory`,
          label: existing ? existing.name : 'Inventory',
        }}
      />
      <FormError message={f.formError} />
      <Card title="Ingredient">
        <div className="card-body form-grid">
          <TextField
            className="span-2"
            label="Name"
            value={v.name}
            onChange={(x) => f.set('name', x)}
            error={f.errors.name}
            required
            placeholder="e.g. Toor dal"
          />
          <TextField
            label="Category"
            value={v.category}
            onChange={(x) => f.set('category', x)}
            error={f.errors.category}
            required
            placeholder="e.g. Pulses, Dairy, Produce"
          />
          <SelectField
            label="Measured by"
            value={v.baseUnit}
            onChange={(x) => {
              f.set('baseUnit', x);
              f.set('unit', defaultUnit(x as BaseUnit, outlet.preferredMassUnit, outlet.preferredVolumeUnit));
            }}
            error={f.errors.baseUnit}
            options={[
              { value: 'g', label: 'Weight (g / kg)' },
              { value: 'ml', label: 'Volume (ml / L)' },
              { value: 'pc', label: 'Count (pieces)' },
            ]}
            hint={
              locked
                ? 'Locked because stock or recipes already use this ingredient.'
                : 'Recipes must use a unit of the same kind.'
            }
          />
          <TextField
            label="Supplier (optional)"
            value={v.supplierName}
            onChange={(x) => f.set('supplierName', x)}
          />
          <TextField
            label="Storage notes (optional)"
            value={v.storageNotes}
            onChange={(x) => f.set('storageNotes', x)}
            placeholder="e.g. Chiller 2, below 5 °C"
          />
        </div>
      </Card>
      {!existing && (
        <Card title="Opening stock">
          <div className="card-body stack">
            <Check
              label="Record the quantity I have now"
              checked={v.withStock}
              onChange={(x) => f.set('withStock', x)}
              hint="Count what is physically on the shelf. You can add more receipts later."
            />
            {v.withStock && (
              <div className="form-grid">
                <QtyField
                  label="Quantity on hand"
                  qty={v.qty}
                  unit={v.unit}
                  units={units}
                  onQty={(x) => f.set('qty', x)}
                  onUnit={(x) => f.set('unit', x)}
                  error={f.errors['initialStock.qty'] ?? f.errors['initialStock.unit']}
                  required
                />
                <TextField
                  label="Total bill cost (₹, optional)"
                  inputMode="decimal"
                  value={v.totalCostInr}
                  onChange={(x) => f.set('totalCostInr', x)}
                  error={f.errors['initialStock.totalCostInr']}
                  hint="What you paid for this quantity. Leave blank if unknown."
                />
                <TextField
                  label="Received on"
                  type="date"
                  value={v.receivedOn}
                  onChange={(x) => f.set('receivedOn', x)}
                  error={f.errors['initialStock.receivedOn']}
                />
                <TextField
                  label="Batch / lot (optional)"
                  value={v.lotCode}
                  onChange={(x) => f.set('lotCode', x)}
                />
                <SelectField
                  label="Date printed on pack"
                  value={v.dateType}
                  onChange={(x) => f.set('dateType', x)}
                  placeholder="No date supplied"
                  options={[
                    { value: 'use_by', label: 'Use-by' },
                    { value: 'expiry', label: 'Expiry' },
                    { value: 'best_before', label: 'Best-before' },
                  ]}
                  hint="Leave blank if there is no date. CulinAction never guesses dates."
                />
                <TextField
                  label="Date"
                  type="date"
                  value={v.dateValue}
                  onChange={(x) => f.set('dateValue', x)}
                  error={f.errors['initialStock.dateValue']}
                />
              </div>
            )}
          </div>
        </Card>
      )}
      <div className="row">
        <Button className="primary" type="submit" busy={f.submitting}>
          {existing ? 'Save changes' : 'Add ingredient'}
        </Button>
        <Link className="btn ghost" to={existing ? `${base}/inventory/${existing.id}` : `${base}/inventory`}>
          Cancel
        </Link>
      </div>
    </form>
  );
}

// ---------------- Detail ----------------

type ActionMode = 'receive' | 'consume' | 'count' | { adjust: Batch } | null;

export function IngredientDetail() {
  const { id } = useParams();
  const { api, base, canEdit, outlet } = useOutlet();
  const toast = useToast();
  const {
    data: d,
    error,
    loading,
    reload,
    setData,
  } = useQuery<IngredientDetailDto>(`${api}/ingredients/${id}`);
  const [mode, setMode] = useState<ActionMode>(null);
  if (error) return <ErrorState error={error} onRetry={reload} />;
  if (loading && !d) return <Loading />;
  if (!d) return null;

  const flag = async (b: Batch, body: object, msg: string) => {
    try {
      setData(await post<IngredientDetailDto>(`${api}/batches/${b.id}/flags`, body));
      toast(msg);
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  };

  const live = d.batches.filter((b) => b.status !== 'empty');
  return (
    <div className="stack">
      <PageHead
        title={d.name}
        sub={`${d.category}${d.supplierName ? ` · ${d.supplierName}` : ''}${d.storageNotes ? ` · ${d.storageNotes}` : ''}`}
        crumb={{ to: `${base}/inventory`, label: 'Inventory' }}
        actions={
          canEdit && (
            <Link className="btn sm" to={`${base}/inventory/${d.id}/edit`}>
              Edit details
            </Link>
          )
        }
      />
      <div className="grid-3">
        <div className="card stat">
          <div className="label">
            Usable stock <Prov kind="actual" />
          </div>
          <div className="value">{d.usableLabel}</div>
          <div className="foot">
            {d.lastCountedAt ? `Last count/receipt ${formatDateTime(d.lastCountedAt)}` : 'Never counted'}
          </div>
        </div>
        <div className="card stat">
          <div className="label">Excluded (unsafe / unchecked)</div>
          <div className="value">{formatQty(d.excludedQty, d.baseUnit)}</div>
          <div className="foot">Never counted as usable</div>
        </div>
        <div className="card stat">
          <div className="label">Average cost</div>
          <div
            className={`value ${d.unitCostPaise === null ? 'unavailable' : ''}`}
            style={{ fontSize: d.unitCostPaise === null ? undefined : '1.15rem' }}
          >
            {unitCostLabel(d.unitCostPaise, d.baseUnit)}
          </div>
          <div className="foot">
            {d.costMissing ? 'Some usable stock has no cost' : 'Weighted over usable batches'}
          </div>
        </div>
      </div>

      <div className="row">
        {canEdit && (
          <button className="btn primary" onClick={() => setMode('receive')}>
            <Icon.Plus size={18} /> Record receipt
          </button>
        )}
        <button className="btn" onClick={() => setMode('consume')}>
          Record use
        </button>
        {canEdit && (
          <button className="btn" onClick={() => setMode('count')}>
            Physical count
          </button>
        )}
        <Link className="btn" to={`${base}/waste?ingredient=${d.id}`}>
          Record waste
        </Link>
      </div>

      <Card title={`Batches (${live.length} with stock)`}>
        {d.batches.length === 0 ? (
          <Empty title="No stock recorded">Record a receipt to add stock.</Empty>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Status</th>
                  <th>Lot</th>
                  <th className="num">Remaining</th>
                  <th>Date</th>
                  <th>Received</th>
                  <th className="num">Cost</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {d.batches.map((b) => (
                  <tr key={b.id} style={b.status === 'empty' ? { opacity: 0.55 } : undefined}>
                    <td>
                      <BatchStatus status={b.status} reason={b.statusReason} />
                      {b.status !== 'empty' && (
                        <div className="tiny muted" style={{ marginTop: 4, maxWidth: 180 }}>
                          {b.statusReason}
                        </div>
                      )}
                    </td>
                    <td className="small">
                      {b.lotCode ?? '—'}
                      {b.source === 'illustrative' && (
                        <div>
                          <Prov kind="illustrative" />
                        </div>
                      )}
                    </td>
                    <td className="num">
                      {formatQty(b.qtyRemaining, d.baseUnit)}
                      <div className="tiny muted">of {formatQty(b.qtyReceived, d.baseUnit)}</div>
                    </td>
                    <td className="small nowrap">
                      {b.dateType ? (
                        `${DATE_TYPE_LABEL[b.dateType]} ${formatDate(b.dateValue)}`
                      ) : (
                        <span className="muted">No date supplied</span>
                      )}
                    </td>
                    <td className="small nowrap">{formatDate(b.receivedOn)}</td>
                    <td className="num small">
                      {b.totalCostPaise === null ? (
                        <span className="muted">Not recorded</span>
                      ) : (
                        formatINR(b.totalCostPaise)
                      )}
                    </td>
                    <td>
                      {b.status !== 'empty' && (
                        <div className="row" style={{ gap: 4 }}>
                          {canEdit && (
                            <button className="btn sm" onClick={() => setMode({ adjust: b })}>
                              Adjust
                            </button>
                          )}
                          {b.dateType &&
                            b.status !== 'verify' &&
                            b.status !== 'unsafe' &&
                            b.storageVerifiedOn !== todayIST() && (
                              <button
                                className="btn sm"
                                onClick={() =>
                                  flag(b, { storageVerified: true }, 'Storage check recorded for today')
                                }
                              >
                                Storage OK today
                              </button>
                            )}
                          {b.storageVerifiedOn && (
                            <span className="tiny muted">
                              Storage checked {formatDate(b.storageVerifiedOn)}
                            </span>
                          )}
                          {b.status === 'verify' && (
                            <button
                              className="btn sm"
                              onClick={() =>
                                flag(b, { qualityChecked: true }, 'Quality check recorded for today')
                              }
                            >
                              Quality OK today
                            </button>
                          )}
                          {!b.quarantined ? (
                            <button
                              className="btn sm"
                              onClick={() =>
                                window.confirm(
                                  'Mark this batch unsafe? It will be excluded from usable stock.',
                                ) && flag(b, { quarantined: true }, 'Batch marked unsafe')
                              }
                            >
                              Mark unsafe
                            </button>
                          ) : (
                            canEdit && (
                              <button
                                className="btn sm"
                                onClick={() => flag(b, { quarantined: false }, 'Unsafe flag cleared')}
                              >
                                Clear unsafe flag
                              </button>
                            )
                          )}
                        </div>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <div className="grid-2">
        <Card title="Used in menu items">
          {d.usedIn.length === 0 ? (
            <div className="card-body muted small">Not used in any recipe yet.</div>
          ) : (
            <ul className="list">
              {d.usedIn.map((u) => (
                <li key={u.id}>
                  <Link className="list-item" to={`${base}/menu/${u.id}`}>
                    <div className="grow">
                      <div className="title">{u.name}</div>
                      <div className="meta">
                        {u.qty} {u.unit} per serving{u.lossPct ? ` + ${u.lossPct}% prep loss` : ''}
                      </div>
                    </div>
                    {!u.verified && <span className="badge warn">Recipe not verified</span>}
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </Card>
        <Card
          title="Recent stock movements"
          actions={
            <Link className="btn sm" to={`${base}/movements?ingredientId=${d.id}`}>
              All
            </Link>
          }
        >
          <MovementList movements={d.movements.slice(0, 8)} baseUnit={d.baseUnit} />
        </Card>
      </div>

      {mode && (
        <StockDialog
          mode={mode}
          d={d}
          api={api}
          outlet={outlet}
          onClose={() => setMode(null)}
          onDone={(n, msg) => {
            setData(n);
            setMode(null);
            toast(msg);
          }}
        />
      )}
    </div>
  );
}

function StockDialog({
  mode,
  d,
  api,
  outlet,
  onClose,
  onDone,
}: {
  mode: Exclude<ActionMode, null>;
  d: IngredientDetailDto;
  api: string;
  outlet: { preferredMassUnit: string; preferredVolumeUnit: string };
  onClose: () => void;
  onDone: (d: IngredientDetailDto, msg: string) => void;
}) {
  const units = unitsForBase(d.baseUnit);
  const adjust = typeof mode === 'object' ? mode.adjust : null;
  const f = useForm({
    qty: adjust ? String(adjust.qtyRemaining) : '',
    unit: adjust
      ? d.baseUnit
      : (defaultUnit(d.baseUnit, outlet.preferredMassUnit, outlet.preferredVolumeUnit) as string),
    totalCostInr: '',
    receivedOn: todayIST(),
    lotCode: '',
    dateType: '',
    dateValue: '',
    reason: '',
  });
  const v = f.values;
  const title = adjust
    ? `Adjust batch ${adjust.lotCode ?? ''}`
    : mode === 'receive'
      ? 'Record stock receipt'
      : mode === 'consume'
        ? 'Record use'
        : 'Physical count';

  const submit = () =>
    void f.submit(
      async (x) => {
        if (mode === 'receive') {
          const r = await post<{ ingredient: IngredientDetailDto }>(`${api}/ingredients/${d.id}/receipts`, {
            qty: x.qty,
            unit: x.unit,
            totalCostInr: x.totalCostInr,
            receivedOn: x.receivedOn,
            lotCode: x.lotCode,
            dateType: x.dateType || null,
            dateValue: x.dateValue || null,
          });
          onDone(r.ingredient, 'Receipt recorded');
        } else if (mode === 'consume') {
          onDone(
            await post<IngredientDetailDto>(`${api}/ingredients/${d.id}/consumption`, {
              qty: x.qty,
              unit: x.unit,
              reason: x.reason,
            }),
            'Use recorded',
          );
        } else if (mode === 'count') {
          const r = await post<{ ingredient: IngredientDetailDto; result: { diff: number } }>(
            `${api}/ingredients/${d.id}/count`,
            { qty: x.qty, unit: x.unit, reason: x.reason },
          );
          onDone(
            r.ingredient,
            r.result.diff === 0
              ? 'Count matches records'
              : `Stock adjusted by ${formatQty(r.result.diff, d.baseUnit)}`,
          );
        } else if (adjust) {
          onDone(
            await post<IngredientDetailDto>(`${api}/batches/${adjust.id}/adjust`, {
              qty: x.qty,
              unit: x.unit,
              reason: x.reason,
            }),
            'Batch adjusted',
          );
        }
      },
      (x) => {
        const e: Record<string, string> = {};
        const n = num(x.qty);
        if (n === null || Number.isNaN(n) || n < 0 || (mode !== 'count' && !adjust && n === 0))
          e.qty = 'Enter a valid quantity';
        if ((mode === 'consume' || adjust) && !x.reason.trim()) e.reason = 'A reason is required';
        if (mode === 'receive' && !!x.dateType !== !!x.dateValue)
          e.dateValue = 'Choose a date type and a date together';
        return e;
      },
    );

  return (
    <Dialog
      title={title}
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
      <form className="form" onSubmit={(e) => (e.preventDefault(), submit())} noValidate>
        <FormError message={f.formError} />
        {mode === 'count' && (
          <Alert kind="info">
            Enter the total you can physically see for {d.name}, including any unsafe stock not yet removed.
            Recorded stock is currently {formatQty(d.usableQty + d.excludedQty, d.baseUnit)}.
          </Alert>
        )}
        {mode === 'consume' && (
          <p className="muted small">
            Taken from usable batches, earliest date first. Unsafe or unchecked batches are never used.
          </p>
        )}
        <QtyField
          label={adjust ? 'Correct remaining quantity' : mode === 'count' ? 'Counted quantity' : 'Quantity'}
          qty={v.qty}
          unit={v.unit}
          units={units}
          onQty={(x) => f.set('qty', x)}
          onUnit={(x) => f.set('unit', x)}
          error={f.errors.qty ?? f.errors.unit}
          required
        />
        {mode === 'receive' && (
          <div className="form-grid">
            <TextField
              label="Total bill cost (₹)"
              inputMode="decimal"
              value={v.totalCostInr}
              onChange={(x) => f.set('totalCostInr', x)}
              error={f.errors.totalCostInr}
              hint="Optional, but needed for cost estimates"
            />
            <TextField
              label="Received on"
              type="date"
              value={v.receivedOn}
              onChange={(x) => f.set('receivedOn', x)}
              error={f.errors.receivedOn}
            />
            <TextField label="Batch / lot" value={v.lotCode} onChange={(x) => f.set('lotCode', x)} />
            <SelectField
              label="Date on pack"
              value={v.dateType}
              onChange={(x) => f.set('dateType', x)}
              placeholder="No date supplied"
              options={[
                { value: 'use_by', label: 'Use-by' },
                { value: 'expiry', label: 'Expiry' },
                { value: 'best_before', label: 'Best-before' },
              ]}
            />
            <TextField
              className="span-2"
              label="Date"
              type="date"
              value={v.dateValue}
              onChange={(x) => f.set('dateValue', x)}
              error={f.errors.dateValue}
            />
          </div>
        )}
        {mode !== 'receive' && (
          <TextField
            label={mode === 'count' ? 'Note (optional)' : 'Reason'}
            value={v.reason}
            onChange={(x) => f.set('reason', x)}
            error={f.errors.reason}
            required={mode !== 'count'}
            placeholder={
              mode === 'consume'
                ? 'e.g. Staff meal, transferred to branch'
                : adjust
                  ? 'e.g. Weighed and corrected'
                  : 'e.g. Morning count'
            }
          />
        )}
      </form>
    </Dialog>
  );
}

const MOVE_LABEL: Record<string, string> = {
  receipt: 'Receipt',
  adjustment: 'Adjustment',
  consumption: 'Used',
  waste: 'Waste',
  count: 'Count',
};

function MovementList({ movements, baseUnit }: { movements: Movement[]; baseUnit?: BaseUnit }) {
  if (!movements.length) return <div className="card-body muted small">No movements yet.</div>;
  return (
    <ul className="list">
      {movements.map((m) => {
        const bu = (m.baseUnit ?? baseUnit)!;
        return (
          <li key={m.id} className="list-item" style={{ minHeight: 0 }}>
            <div className="grow">
              <div className="small">
                <strong>{MOVE_LABEL[m.type] ?? m.type}</strong>
                {m.ingredientName && <> · {m.ingredientName}</>} —{' '}
                <span className="wrap-anywhere">{m.reason}</span>
              </div>
              <div className="meta">
                {formatDateTime(m.createdAt)}
                {m.userName && ` · ${m.userName}`}
              </div>
            </div>
            <div
              className={`strong nowrap small`}
              style={{
                color: m.qtyDelta < 0 ? 'var(--danger)' : m.qtyDelta > 0 ? 'var(--ok)' : 'var(--ink-3)',
              }}
            >
              {m.qtyDelta > 0 ? '+' : m.qtyDelta < 0 ? '−' : '±'}
              {formatQty(Math.abs(m.qtyDelta), bu)}
            </div>
          </li>
        );
      })}
    </ul>
  );
}

export function Movements() {
  const { api } = useOutlet();
  const [params, setParams] = useSearchParams();
  const ingredientId = params.get('ingredientId') ?? '';
  const type = params.get('type') ?? '';
  const ings = useQuery<{ items: IngredientSummary[] }>(`${api}/ingredients`);
  const { data, error, loading, reload } = useQuery<Movement[]>(
    `${api}/movements?${new URLSearchParams({ ingredientId, type })}`,
  );
  const set = (k: string, v: string) => {
    const n = new URLSearchParams(params);
    if (v) n.set(k, v);
    else n.delete(k);
    setParams(n, { replace: true });
  };
  return (
    <div className="stack">
      <PageHead
        title="Stock movement history"
        sub="Every change to recorded stock, with the reason and who made it."
      />
      <div className="toolbar">
        <select
          className="input"
          value={ingredientId}
          onChange={(e) => set('ingredientId', e.target.value)}
          aria-label="Ingredient"
        >
          <option value="">All ingredients</option>
          {ings.data?.items.map((i) => (
            <option key={i.id} value={i.id}>
              {i.name}
            </option>
          ))}
        </select>
        <select
          className="input"
          value={type}
          onChange={(e) => set('type', e.target.value)}
          aria-label="Movement type"
        >
          <option value="">All types</option>
          {Object.entries(MOVE_LABEL).map(([k, l]) => (
            <option key={k} value={k}>
              {l}
            </option>
          ))}
        </select>
      </div>
      {error ? (
        <ErrorState error={error} onRetry={reload} />
      ) : loading && !data ? (
        <Loading />
      ) : (
        <Card>
          {data?.length ? (
            <MovementList movements={data} />
          ) : (
            <Empty title="No movements">
              Stock changes appear here once you record receipts, use, counts or waste.
            </Empty>
          )}
        </Card>
      )}
    </div>
  );
}

export type { IngredientSummary, IngredientDetailDto };
