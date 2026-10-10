import { useState } from 'react';
import { Link } from 'react-router-dom';
import { del, post, put } from '../api';
import { addDays, formatDate, formatDateTime, formatINR, num, todayIST } from '../fmt';
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

interface SaleRow {
  id: number;
  date: string;
  menuItemId: number;
  menuItemName: string;
  servicePeriod: string;
  qty: number;
  unitPricePaise: number | null;
  source: string;
}
interface MenuOpt {
  id: number;
  name: string;
  active: boolean;
}
interface ForecastRow {
  menuItemId: number;
  name: string;
  method: 'same_weekday' | 'recent_days' | 'insufficient';
  methodLabel: string;
  from: string | null;
  to: string | null;
  daysUsed: number;
  mean: number | null;
  min: number | null;
  max: number | null;
  explanation: string;
}

const SOURCE_LABEL: Record<string, string> = {
  manual: 'Manual',
  csv_import: 'CSV import',
  service_outcome: 'From outcome',
  illustrative: 'Illustrative',
};

export function Sales() {
  const { api, base, canEdit, outlet } = useOutlet();
  const today = todayIST();
  const [from, setFrom] = useState(addDays(today, -13));
  const [to, setTo] = useState(today);
  const { data, error, loading, reload } = useQuery<{
    rows: SaleRow[];
    history: { days: number; first: string | null; last: string | null; n: number };
  }>(`${api}/sales?from=${from}&to=${to}`);
  const menu = useQuery<MenuOpt[]>(`${api}/menu-items`);
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<SaleRow | null>(null);

  const byDay = new Map<string, SaleRow[]>();
  for (const r of data?.rows ?? []) byDay.set(r.date, [...(byDay.get(r.date) ?? []), r]);

  return (
    <div className="stack">
      <PageHead
        title="Sales history"
        sub={
          data?.history.days
            ? `${data.history.days} trading day(s) recorded, ${formatDate(data.history.first)} – ${formatDate(data.history.last)}`
            : 'Actual portions sold per day. Used for forecasts.'
        }
        actions={
          <>
            <a className="btn sm" href={downloadUrl(`${api}/export/sales.csv`)}>
              <Icon.Download size={16} /> Export
            </a>
            {canEdit && (
              <>
                <Link className="btn sm" to={`${base}/sales/import`}>
                  <Icon.Upload size={16} /> Import CSV
                </Link>
                <button className="btn primary" onClick={() => setAdding(true)} disabled={!menu.data?.length}>
                  <Icon.Plus size={18} /> Add sales
                </button>
              </>
            )}
          </>
        }
      />
      {menu.data && menu.data.length === 0 && (
        <Alert kind="info">Add menu items first — sales are recorded per menu item.</Alert>
      )}

      <ForecastPanel api={api} />

      <Card
        title={
          <h2>
            Recorded sales <Prov kind="actual" />
          </h2>
        }
        actions={
          <div className="row">
            <input
              className="input"
              type="date"
              value={from}
              max={to}
              onChange={(e) => setFrom(e.target.value)}
              aria-label="From date"
              style={{ width: 160 }}
            />
            <span className="muted">to</span>
            <input
              className="input"
              type="date"
              value={to}
              min={from}
              onChange={(e) => setTo(e.target.value)}
              aria-label="To date"
              style={{ width: 160 }}
            />
          </div>
        }
      >
        {error ? (
          <div className="card-body">
            <ErrorState error={error} onRetry={reload} />
          </div>
        ) : loading && !data ? (
          <Loading />
        ) : !data?.rows.length ? (
          <Empty icon={<Icon.Sales />} title="No sales in this period">
            Record each day’s portions sold per menu item, or import them from a CSV exported from your
            billing system.
          </Empty>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Menu item</th>
                  <th>Period</th>
                  <th className="num">Qty sold</th>
                  <th className="num">Price</th>
                  <th>Source</th>
                  {canEdit && <th />}
                </tr>
              </thead>
              <tbody>
                {[...byDay.entries()].map(([d, rows]) =>
                  rows.map((r, i) => (
                    <tr key={r.id}>
                      <td className="nowrap">{i === 0 ? <strong>{formatDate(d)}</strong> : ''}</td>
                      <td>{r.menuItemName}</td>
                      <td className="small">{r.servicePeriod || '—'}</td>
                      <td className="num">{r.qty}</td>
                      <td className="num small">
                        {r.unitPricePaise === null ? '—' : formatINR(r.unitPricePaise)}
                      </td>
                      <td className="small">{SOURCE_LABEL[r.source] ?? r.source}</td>
                      {canEdit && (
                        <td>
                          <button className="btn sm ghost" onClick={() => setEditing(r)}>
                            Edit
                          </button>
                        </td>
                      )}
                    </tr>
                  )),
                )}
              </tbody>
            </table>
          </div>
        )}
      </Card>
      {adding && menu.data && (
        <SaleDialog
          menu={menu.data.filter((m) => m.active)}
          periods={outlet.servicePeriods}
          onClose={() => setAdding(false)}
          onSaved={() => {
            setAdding(false);
            void reload();
          }}
        />
      )}
      {editing && (
        <EditSaleDialog
          row={editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            void reload();
          }}
        />
      )}
    </div>
  );
}

function ForecastPanel({ api }: { api: string }) {
  const [date, setDate] = useState(todayIST());
  const { data, loading, error } = useQuery<{ date: string; items: ForecastRow[] }>(
    `${api}/sales/forecast?date=${date}`,
  );
  return (
    <Card
      title={
        <h2>
          Demand baseline <Prov kind="forecast" />
        </h2>
      }
      actions={
        <input
          className="input"
          type="date"
          value={date}
          min={todayIST()}
          max={addDays(todayIST(), 7)}
          onChange={(e) => setDate(e.target.value)}
          aria-label="Forecast date"
          style={{ width: 160 }}
        />
      }
    >
      <div className="card-body stack-sm">
        <p className="muted small">
          Simple averages of your recorded sales — not machine learning. Same-weekday average when at least 2
          matching days exist in the last 28 days; otherwise the average of the last 14 days (needs 3+ days).
        </p>
        {error && <Alert kind="danger">{error.message}</Alert>}
        {loading && !data ? (
          <Loading />
        ) : !data?.items.length ? (
          <p className="small muted">No active menu items.</p>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Menu item</th>
                  <th className="num">Forecast</th>
                  <th className="num">Range seen</th>
                  <th>Method</th>
                  <th>Based on</th>
                </tr>
              </thead>
              <tbody>
                {data.items.map((f) => (
                  <tr key={f.menuItemId}>
                    <td>{f.name}</td>
                    <td className="num strong">
                      {f.mean === null ? <span className="muted">—</span> : f.mean}
                    </td>
                    <td className="num">{f.min === null ? '—' : `${f.min}–${f.max}`}</td>
                    <td>
                      {f.method === 'insufficient' ? (
                        <Badge kind="warn">Insufficient data</Badge>
                      ) : (
                        <span className="small">{f.methodLabel}</span>
                      )}
                    </td>
                    <td className="small muted">
                      {f.method === 'insufficient'
                        ? `${f.daysUsed} recent day(s) recorded`
                        : `${f.daysUsed} days, ${formatDate(f.from)}–${formatDate(f.to)}`}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </Card>
  );
}

function SaleDialog({
  menu,
  periods,
  onClose,
  onSaved,
}: {
  menu: MenuOpt[];
  periods: string[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const { api } = useOutlet();
  const toast = useToast();
  const f = useForm({
    date: todayIST(),
    menuItemId: '',
    servicePeriod: periods[0] ?? '',
    qty: '',
    unitPriceInr: '',
  });
  const submit = (keepOpen: boolean) =>
    void f.submit(
      async (v) => {
        await post(`${api}/sales`, { ...v, menuItemId: Number(v.menuItemId) });
        toast('Sales recorded');
        if (keepOpen) f.setValues((s) => ({ ...s, menuItemId: '', qty: '' }));
        else onSaved();
      },
      (v) => {
        const e: Record<string, string> = {};
        if (!v.menuItemId) e.menuItemId = 'Choose a menu item';
        const q = num(v.qty);
        if (q === null || Number.isNaN(q) || q < 0) e.qty = 'Enter the quantity sold';
        if (v.date > todayIST()) e.date = 'Cannot be in the future';
        return e;
      },
    );
  return (
    <Dialog
      title="Record sales"
      onClose={onClose}
      footer={
        <>
          <button className="btn ghost" onClick={onClose}>
            Close
          </button>
          <Button busy={f.submitting} onClick={() => submit(true)}>
            Save & add another
          </Button>
          <Button className="primary" busy={f.submitting} onClick={() => submit(false)}>
            Save
          </Button>
        </>
      }
    >
      <form className="form" onSubmit={(e) => (e.preventDefault(), submit(false))} noValidate>
        <FormError message={f.formError} />
        <TextField
          label="Date"
          type="date"
          value={f.values.date}
          onChange={(v) => f.set('date', v)}
          error={f.errors.date}
          required
        />
        <SelectField
          label="Menu item"
          value={f.values.menuItemId}
          onChange={(v) => f.set('menuItemId', v)}
          error={f.errors.menuItemId}
          required
          placeholder="Choose…"
          options={menu.map((m) => ({ value: String(m.id), label: m.name }))}
        />
        {periods.length > 0 && (
          <SelectField
            label="Service period"
            value={f.values.servicePeriod}
            onChange={(v) => f.set('servicePeriod', v)}
            error={f.errors.servicePeriod}
            placeholder="Whole day"
            options={periods.map((p) => ({ value: p, label: p }))}
          />
        )}
        <TextField
          label="Quantity sold (portions)"
          inputMode="decimal"
          value={f.values.qty}
          onChange={(v) => f.set('qty', v)}
          error={f.errors.qty}
          required
        />
        <TextField
          label="Unit price (₹, optional)"
          inputMode="decimal"
          value={f.values.unitPriceInr}
          onChange={(v) => f.set('unitPriceInr', v)}
          error={f.errors.unitPriceInr}
        />
      </form>
    </Dialog>
  );
}

function EditSaleDialog({
  row,
  onClose,
  onSaved,
}: {
  row: SaleRow;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { api } = useOutlet();
  const toast = useToast();
  const f = useForm({
    qty: String(row.qty),
    unitPriceInr: row.unitPricePaise === null ? '' : String(row.unitPricePaise / 100),
  });
  const [deleting, setDeleting] = useState(false);
  return (
    <Dialog
      title={`${row.menuItemName} · ${formatDate(row.date)}`}
      onClose={onClose}
      footer={
        <>
          <Button
            className="danger"
            busy={deleting}
            onClick={async () => {
              if (!window.confirm('Delete this sales record? This is recorded in the audit log.')) return;
              setDeleting(true);
              try {
                await del(`${api}/sales/${row.id}`);
                toast('Sales record deleted');
                onSaved();
              } catch (e) {
                toast((e as Error).message, 'error');
                setDeleting(false);
              }
            }}
          >
            Delete
          </Button>
          <span style={{ flex: 1 }} />
          <button className="btn ghost" onClick={onClose}>
            Cancel
          </button>
          <Button
            className="primary"
            busy={f.submitting}
            onClick={() =>
              void f.submit(async (v) => {
                await put(`${api}/sales/${row.id}`, v);
                toast('Sales record updated');
                onSaved();
              })
            }
          >
            Save
          </Button>
        </>
      }
    >
      <div className="form">
        <FormError message={f.formError} />
        <TextField
          label="Quantity sold"
          inputMode="decimal"
          value={f.values.qty}
          onChange={(v) => f.set('qty', v)}
          error={f.errors.qty}
        />
        <TextField
          label="Unit price (₹)"
          inputMode="decimal"
          value={f.values.unitPriceInr}
          onChange={(v) => f.set('unitPriceInr', v)}
          error={f.errors.unitPriceInr}
        />
      </div>
    </Dialog>
  );
}

// ---------------- CSV import ----------------

interface ImportRow {
  line: number;
  raw: Record<string, string>;
  date: string | null;
  menuItemName: string;
  qty: number | null;
  servicePeriod: string;
  unitPricePaise: number | null;
  status: 'valid' | 'invalid' | 'duplicate_in_file' | 'duplicate_existing';
  errors: string[];
}
interface Preview {
  importId: number;
  summary: {
    total: number;
    valid: number;
    invalid: number;
    duplicateInFile: number;
    duplicateExisting: number;
  };
  rows: ImportRow[];
}

const STATUS_BADGE: Record<ImportRow['status'], [string, 'ok' | 'danger' | 'warn']> = {
  valid: ['Will import', 'ok'],
  invalid: ['Invalid', 'danger'],
  duplicate_in_file: ['Duplicate in file', 'warn'],
  duplicate_existing: ['Already recorded', 'warn'],
};

export function SalesImport() {
  const { api, base } = useOutlet();
  const toast = useToast();
  const [fileName, setFileName] = useState<string | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [result, setResult] = useState<{
    imported: number;
    skippedAsDuplicate: number;
    notImported: number;
  } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [show, setShow] = useState<'all' | 'problems'>('problems');
  const history = useQuery<
    {
      id: number;
      filename: string | null;
      status: string;
      totalRows: number;
      importedRows: number | null;
      createdAt: string;
      userName: string | null;
    }[]
  >(`${api}/sales/imports`);

  const onFile = async (file: File | undefined) => {
    setErr(null);
    setPreview(null);
    setResult(null);
    if (!file) return;
    if (!/\.csv$/i.test(file.name) && file.type !== 'text/csv') return setErr('Please choose a .csv file.');
    if (file.size > 1_000_000) return setErr('File is larger than 1 MB. Split it into smaller files.');
    setFileName(file.name);
    setBusy(true);
    try {
      const text = await file.text();
      const p = await post<Preview>(`${api}/sales/import/preview`, { filename: file.name, csvText: text });
      setPreview(p);
      setShow(p.summary.valid === p.summary.total ? 'all' : 'problems');
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const commit = async () => {
    if (!preview) return;
    setBusy(true);
    try {
      const r = await post<{ imported: number; skippedAsDuplicate: number; notImported: number }>(
        `${api}/sales/import/${preview.importId}/commit`,
      );
      setResult(r);
      setPreview(null);
      toast(`${r.imported} sales record(s) imported`);
      void history.reload();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const rows = preview
    ? show === 'all'
      ? preview.rows
      : preview.rows.filter((r) => r.status !== 'valid')
    : [];

  return (
    <div className="stack">
      <PageHead
        title="Import sales from CSV"
        crumb={{ to: `${base}/sales`, label: 'Sales' }}
        sub="Nothing is saved until you review the check and confirm."
      />
      <Card title="1. Prepare your file">
        <div className="card-body stack-sm small">
          <p>
            Columns: <code>date</code>, <code>menu_item</code>, <code>quantity</code> (required) and{' '}
            <code>service_period</code>, <code>unit_price_inr</code> (optional). Dates as YYYY-MM-DD or
            DD/MM/YYYY. Menu item names must match your menu exactly (case is ignored). One row per item, date
            and service period.
          </p>
          <div>
            <a className="btn sm" href={downloadUrl(`${api}/sales/template.csv`)}>
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
            onChange={(e) => void onFile(e.target.files?.[0])}
            aria-label="CSV file"
            className="input"
          />
          {busy && <Loading label="Checking file…" />}
          {err && <Alert kind="danger">{err}</Alert>}
        </div>
      </Card>
      {preview && (
        <Card title={`3. Review ${fileName ?? ''}`}>
          <div className="card-body stack">
            <div className="grid-3" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))' }}>
              <div>
                <div className="muted tiny">Rows</div>
                <div className="strong">{preview.summary.total}</div>
              </div>
              <div>
                <div className="muted tiny">Will import</div>
                <div className="strong" style={{ color: 'var(--ok)' }}>
                  {preview.summary.valid}
                </div>
              </div>
              <div>
                <div className="muted tiny">Invalid</div>
                <div
                  className="strong"
                  style={{ color: preview.summary.invalid ? 'var(--danger)' : undefined }}
                >
                  {preview.summary.invalid}
                </div>
              </div>
              <div>
                <div className="muted tiny">Duplicates</div>
                <div className="strong">
                  {preview.summary.duplicateInFile + preview.summary.duplicateExisting}
                </div>
              </div>
            </div>
            {preview.summary.valid < preview.summary.total && (
              <Alert kind="warn">
                Rows that are invalid or duplicated will not be imported. Fix them in the file and import
                again if needed.
              </Alert>
            )}
            <div className="seg" role="group" aria-label="Rows to show">
              <button aria-pressed={show === 'problems'} onClick={() => setShow('problems')}>
                Problems only
              </button>
              <button aria-pressed={show === 'all'} onClick={() => setShow('all')}>
                All rows
              </button>
            </div>
            {rows.length === 0 ? (
              <p className="small muted">No problems found.</p>
            ) : (
              <div className="table-wrap">
                <table className="table">
                  <thead>
                    <tr>
                      <th>Row</th>
                      <th>Status</th>
                      <th>Date</th>
                      <th>Menu item</th>
                      <th className="num">Qty</th>
                      <th>Problem</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.slice(0, 300).map((r) => (
                      <tr
                        key={r.line}
                        className={r.status === 'invalid' ? 'row-bad' : r.status !== 'valid' ? 'row-dup' : ''}
                      >
                        <td>{r.line}</td>
                        <td>
                          <Badge kind={STATUS_BADGE[r.status][1]}>{STATUS_BADGE[r.status][0]}</Badge>
                        </td>
                        <td className="nowrap">{r.date ? formatDate(r.date) : r.raw.date}</td>
                        <td>{r.menuItemName}</td>
                        <td className="num">{r.qty ?? r.raw.quantity}</td>
                        <td className="small">{r.errors.join(' ')}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <div className="row">
              <Button className="primary" busy={busy} disabled={preview.summary.valid === 0} onClick={commit}>
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
          Imported {result.imported} row(s). {result.notImported} row(s) were not imported because they were
          invalid or duplicated.
          {result.skippedAsDuplicate > 0 &&
            ` ${result.skippedAsDuplicate} row(s) were skipped because matching records were added meanwhile.`}{' '}
          <Link to={`${base}/sales`}>View sales</Link>
        </Alert>
      )}
      {!!history.data?.length && (
        <Card title="Recent imports">
          <ul className="list">
            {history.data.map((h) => (
              <li key={h.id} className="list-item">
                <div className="grow">
                  <div className="title small">{h.filename ?? 'Unnamed file'}</div>
                  <div className="meta">
                    {formatDateTime(h.createdAt)}
                    {h.userName ? ` · ${h.userName}` : ''}
                  </div>
                </div>
                <span className="small">
                  {h.status === 'committed'
                    ? `${h.importedRows} of ${h.totalRows} imported`
                    : 'Previewed, not saved'}
                </span>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </div>
  );
}
