import { Link } from 'react-router-dom';
import { formatDate, formatDateTime, formatINR, WASTE_REASON_LABELS } from '../fmt';
import { useQuery } from '../hooks';
import { Icon } from '../icons';
import { useOutlet } from '../session';
import { Alert, Badge, Card, ErrorState, Loading, PageHead, Prov, Tier } from '../ui';

interface StockRef {
  id: number;
  name: string;
  usableLabel: string;
  nearestDate: { type: string; value: string; status: string } | null;
}
interface Dashboard {
  today: string;
  checklist: { key: string; label: string; done: boolean; detail?: string; to: string }[];
  stock: {
    ingredientCount: number;
    unsafe: StockRef[];
    verify: StockRef[];
    expiring: StockRef[];
    outOfStockInRecipes: StockRef[];
    costMissing: StockRef[];
  };
  run: null | {
    id: number;
    planDate: string;
    createdAt: string;
    changesSinceRun: number;
    summary: { byTier: Record<string, number> };
    top: { id: number; title: string; tier: number; impactPaise: number | null; impactLabel: string }[];
    stockouts: { id: number; title: string }[];
    gaps: { id: number; title: string }[];
  };
  approvals: { id: number; title: string; planDate: string }[];
  drafts: number;
  tasks: { open: number; dueToday: number; overdue: number };
  lastService: null | {
    date: string;
    items: number;
    prepared: number;
    sold: number;
    remaining: number;
    discarded: number;
  };
  salesHistory: { days: number; last: string | null };
  delivery: {
    open: number;
    waitingForPickup: number;
    needsDisposition: number;
    elevated: {
      id: number;
      ref: string;
      level: 'high' | 'moderate';
      status: string;
      items: string;
      readyWaitMin: number | null;
    }[];
  };
  waste7d: { reason: string; entries: number; recordedPaise: number | null; estimatedPaise: number | null }[];
  recentOutcomes: {
    id: number;
    date: string;
    servicePeriod: string;
    name: string;
    prepared: number;
    sold: number;
    transferred: number;
    discarded: number;
    taskId: number | null;
  }[];
}

export function Today() {
  const { api, base, outlet, canEdit } = useOutlet();
  const { data: d, error, loading, reload } = useQuery<Dashboard>(`${api}/dashboard`);
  if (error) return <ErrorState error={error} onRetry={reload} />;
  if (loading || !d) return <Loading />;

  const pending = d.checklist.filter((c) => !c.done);
  const safety = d.stock.unsafe.length + d.stock.verify.length;

  return (
    <div className="stack">
      <PageHead
        title="Today"
        sub={`${formatDate(d.today)} · ${outlet.city}`}
        actions={
          canEdit && (
            <Link className="btn primary" to={`${base}/recommendations`}>
              <Icon.Decide size={18} /> Review recommendations
            </Link>
          )
        }
      />

      {pending.length > 0 && (
        <Card
          title={
            <div>
              <h2>Getting started</h2>
              <div className="muted small">
                {d.checklist.length - pending.length} of {d.checklist.length} done
              </div>
            </div>
          }
        >
          <ul className="list checklist">
            {d.checklist.map((c) => (
              <li key={c.key}>
                <span className={`dot ${c.done ? 'done' : ''}`}>{c.done && <Icon.Check size={12} />}</span>
                <span className={`grow ${c.done ? 'done' : ''}`} style={{ flex: 1 }}>
                  {c.label} {c.detail && <span className="muted small">({c.detail})</span>}
                </span>
                {!c.done && (
                  <Link className="btn sm" to={`${base}/${c.to}`}>
                    Go
                  </Link>
                )}
              </li>
            ))}
          </ul>
        </Card>
      )}

      {safety > 0 && (
        <Card tone="danger" title={<h2>Food-safety checks needed</h2>}>
          <div className="card-body stack-sm">
            {d.stock.unsafe.map((i) => (
              <Link
                key={`u${i.id}`}
                to={`${base}/inventory/${i.id}`}
                className="spread"
                style={{ color: 'inherit', textDecoration: 'none' }}
              >
                <span>
                  <strong>{i.name}</strong> — has stock past its use-by/expiry date or marked unsafe
                </span>
                <Badge kind="danger">Do not use</Badge>
              </Link>
            ))}
            {d.stock.verify.map((i) => (
              <Link
                key={`v${i.id}`}
                to={`${base}/inventory/${i.id}`}
                className="spread"
                style={{ color: 'inherit', textDecoration: 'none' }}
              >
                <span>
                  <strong>{i.name}</strong> — past best-before; check quality before use
                </span>
                <Badge kind="warn">Check</Badge>
              </Link>
            ))}
            <p className="muted small">
              These batches are automatically excluded from usable stock in every calculation.
            </p>
          </div>
        </Card>
      )}

      <div className="grid-3 grid-4">
        <Link to={`${base}/orders`} className="card stat">
          <div className="label">Orders waiting for pickup</div>
          <div className="value">{d.delivery.waitingForPickup}</div>
          <div className="foot">
            {d.delivery.open} open order(s)
            {d.delivery.needsDisposition ? ` · ${d.delivery.needsDisposition} need a disposition` : ''}
          </div>
        </Link>
        <Link to={`${base}/tasks`} className="card stat">
          <div className="label">Open tasks</div>
          <div className="value">{d.tasks.open}</div>
          <div className="foot">
            {d.tasks.dueToday} due today{d.tasks.overdue ? ` · ${d.tasks.overdue} overdue` : ''}
          </div>
        </Link>
        <Link to={`${base}/approvals`} className="card stat">
          <div className="label">Awaiting approval</div>
          <div className="value">{d.approvals.length}</div>
          <div className="foot">{d.drafts} draft plan(s)</div>
        </Link>
        <Link to={`${base}/inventory?status=expiring`} className="card stat">
          <div className="label">Use soon</div>
          <div className="value">{d.stock.expiring.length}</div>
          <div className="foot">ingredients near use-by/expiry</div>
        </Link>
      </div>

      {d.delivery.elevated.length > 0 && (
        <Card
          title="Orders with elevated delivery risk"
          tone={d.delivery.elevated.some((e) => e.level === 'high') ? 'danger' : 'warn'}
          actions={
            <Link className="btn sm" to={`${base}/orders`}>
              All orders
            </Link>
          }
        >
          <ul className="list">
            {d.delivery.elevated.map((e) => (
              <li key={e.id}>
                <Link className="list-item" to={`${base}/orders/${e.id}`}>
                  <div className="grow">
                    <div className="title small">
                      Order {e.ref} · {e.items}
                    </div>
                    <div className="meta">
                      {e.readyWaitMin !== null
                        ? `Waiting ${e.readyWaitMin} min for pickup`
                        : e.status.replace(/_/g, ' ')}
                    </div>
                  </div>
                  <Badge kind={e.level === 'high' ? 'danger' : 'warn'}>
                    {e.level === 'high' ? 'High risk' : 'Moderate risk'}
                  </Badge>
                  <Icon.Chevron className="chev" />
                </Link>
              </li>
            ))}
          </ul>
        </Card>
      )}

      <div className="grid-2">
        <Card
          title={<h2>Recorded waste, last 7 days</h2>}
          actions={
            <Link className="btn sm" to={`${base}/waste`}>
              Waste & surplus
            </Link>
          }
        >
          {d.waste7d.length === 0 ? (
            <div className="card-body small muted">No waste recorded in the last 7 days.</div>
          ) : (
            <ul className="list">
              {d.waste7d.map((w) => (
                <li key={w.reason} className="list-item" style={{ minHeight: 0 }}>
                  <div className="grow small">
                    {WASTE_REASON_LABELS[w.reason] ?? w.reason}{' '}
                    <span className="muted">
                      · {w.entries} entr{w.entries === 1 ? 'y' : 'ies'}
                    </span>
                  </div>
                  <div className="right small nowrap">
                    {w.recordedPaise ? (
                      <div>
                        {formatINR(w.recordedPaise)} <Prov kind="actual" />
                      </div>
                    ) : null}
                    {w.estimatedPaise ? (
                      <div>
                        {formatINR(w.estimatedPaise)} <Prov kind="estimate" />
                      </div>
                    ) : null}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Card>
        <Card
          title="Recent recorded outcomes"
          actions={
            <Link className="btn sm" to={`${base}/verify`}>
              Verify outcomes
            </Link>
          }
        >
          {d.recentOutcomes.length === 0 ? (
            <div className="card-body small muted">No service outcomes recorded yet.</div>
          ) : (
            <ul className="list">
              {d.recentOutcomes.map((o) => (
                <li key={o.id} className="list-item" style={{ minHeight: 0 }}>
                  <div className="grow small">
                    <strong>{o.name}</strong>{' '}
                    <span className="muted">
                      · {formatDate(o.date)} {o.servicePeriod}
                    </span>
                    {o.taskId && <Badge kind="info">from plan</Badge>}
                  </div>
                  <div className="small nowrap">
                    {o.prepared} prep · {o.sold} sold · {o.discarded} disc.
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>

      <div className="grid-2">
        <Card
          title="Latest decision run"
          actions={
            d.run && (
              <Link className="btn sm" to={`${base}/recommendations`}>
                Open
              </Link>
            )
          }
        >
          {!d.run ? (
            <div className="card-body stack-sm">
              <p className="muted small">The decision engine has not been run yet.</p>
              {canEdit && (
                <Link className="btn sm" to={`${base}/recommendations`}>
                  Run it now
                </Link>
              )}
            </div>
          ) : (
            <div className="card-body stack-sm">
              <div className="small muted">
                For {formatDate(d.run.planDate)} · calculated {formatDateTime(d.run.createdAt)}
              </div>
              {d.run.changesSinceRun > 0 && (
                <Alert kind="info">
                  {d.run.changesSinceRun} record change(s) since this run. Re-run to refresh the results.
                </Alert>
              )}
              {d.run.top.length === 0 && (
                <p className="small">No safety, stock or cost risks were found from the current records.</p>
              )}
              <ul className="list">
                {d.run.top.map((t) => (
                  <li key={t.id}>
                    <Link
                      className="list-item"
                      to={`${base}/recommendations/${t.id}`}
                      style={{ padding: '10px 0' }}
                    >
                      <Tier tier={t.tier} />
                      <div className="grow">
                        <div className="title small">{t.title}</div>
                        {t.impactPaise !== null && (
                          <div className="meta">
                            {formatINR(t.impactPaise)} <Prov kind="estimate" title={t.impactLabel} />
                          </div>
                        )}
                      </div>
                    </Link>
                  </li>
                ))}
              </ul>
              {d.run.gaps.length > 0 && (
                <p className="small muted">{d.run.gaps.length} data gap(s) reduce what can be calculated.</p>
              )}
            </div>
          )}
        </Card>

        <Card title="Latest recorded service">
          {!d.lastService ? (
            <div className="card-body stack-sm">
              <p className="muted small">
                No service outcomes recorded yet. After service, record what was prepared, sold and discarded.
              </p>
              <Link className="btn sm" to={`${base}/outcomes`}>
                Record an outcome
              </Link>
            </div>
          ) : (
            <div className="card-body stack-sm">
              <div className="spread">
                <span className="small muted">
                  {formatDate(d.lastService.date)} · {d.lastService.items} item(s)
                </span>
                <Prov kind="actual" />
              </div>
              <div className="grid-3" style={{ gridTemplateColumns: 'repeat(3, 1fr)' }}>
                <div>
                  <div className="muted tiny">Prepared</div>
                  <div className="strong">{d.lastService.prepared}</div>
                </div>
                <div>
                  <div className="muted tiny">Sold</div>
                  <div className="strong">{d.lastService.sold}</div>
                </div>
                <div>
                  <div className="muted tiny">Discarded</div>
                  <div className="strong">{d.lastService.discarded}</div>
                </div>
              </div>
              <Link className="small" to={`${base}/outcomes`}>
                All outcomes
              </Link>
            </div>
          )}
        </Card>
      </div>

      {(d.approvals.length > 0 ||
        d.stock.outOfStockInRecipes.length > 0 ||
        d.stock.costMissing.length > 0) && (
        <div className="grid-2">
          {d.approvals.length > 0 && (
            <Card title="Plans awaiting approval">
              <ul className="list">
                {d.approvals.map((p) => (
                  <li key={p.id}>
                    <Link className="list-item" to={`${base}/plans/${p.id}`}>
                      <div className="grow">
                        <div className="title">{p.title}</div>
                        <div className="meta">For {formatDate(p.planDate)}</div>
                      </div>
                      <Icon.Chevron className="chev" />
                    </Link>
                  </li>
                ))}
              </ul>
            </Card>
          )}
          {(d.stock.outOfStockInRecipes.length > 0 || d.stock.costMissing.length > 0) && (
            <Card title="Missing or insufficient information">
              <div className="card-body stack-sm small">
                {d.stock.outOfStockInRecipes.length > 0 && (
                  <p>
                    <strong>No usable stock</strong> recorded for ingredients used in recipes:{' '}
                    {d.stock.outOfStockInRecipes.map((i) => i.name).join(', ')}.
                  </p>
                )}
                {d.stock.costMissing.length > 0 && (
                  <p>
                    <strong>No purchase cost</strong> for: {d.stock.costMissing.map((i) => i.name).join(', ')}
                    . Cost estimates are incomplete.
                  </p>
                )}
              </div>
            </Card>
          )}
        </div>
      )}

      <p className="muted tiny">
        Sales history: {d.salesHistory.days} day(s) recorded
        {d.salesHistory.last ? `, latest ${formatDate(d.salesHistory.last)}` : ''}. Numbers on this page come
        from your records; estimates are labelled.
      </p>
    </div>
  );
}
