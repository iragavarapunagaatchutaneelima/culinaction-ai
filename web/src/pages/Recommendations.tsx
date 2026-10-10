import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { ApiError, post } from '../api';
import { addDays, DATE_TYPE_LABEL, formatDate, formatDateTime, formatINR, todayIST } from '../fmt';
import { useQuery } from '../hooks';
import { Icon } from '../icons';
import { useOutlet } from '../session';
import {
  Alert,
  Badge,
  Button,
  Card,
  Confidence,
  Empty,
  ErrorState,
  Loading,
  PageHead,
  Prov,
  Tier,
  useToast,
} from '../ui';

interface Option {
  key: string;
  label: string;
  description: string;
  feasible: boolean;
  infeasibleReason?: string;
  effects: { label: string; value: string }[];
  estimatedCostPaise: number | null;
  lines: { type: string; subjectName: string; qty: number | null; unit: string | null; note: string }[];
}
interface Rec {
  id: number;
  runId: number;
  key: string;
  kind: string;
  severityTier: number;
  title: string;
  problem: string;
  subjectName: string;
  evidence: {
    batches: {
      batchId: number;
      ingredient: string;
      lot: string | null;
      qtyRemaining: string;
      dateType: string | null;
      dateValue: string | null;
      status: string;
      unitCost: string;
    }[];
    recipes: {
      menuItem: string;
      ingredient: string;
      qtyPerServing: string;
      lossPct: number;
      verified: boolean;
    }[];
    sales: {
      menuItem: string;
      method: string;
      from: string | null;
      to: string | null;
      daysUsed: number;
      values: { date: string; qty: number }[];
      mean: number | null;
      min: number | null;
      max: number | null;
    }[];
    other: string[];
  };
  calculation: string[];
  assumptions: string[];
  options: Option[];
  confidence: 'high' | 'medium' | 'low';
  missingInfo: string[];
  safetyChecks: string[];
  nextStep: string;
  estimatedImpactPaise: number | null;
  impactLabel: string;
  ai: null | {
    status: string;
    explanation: null | {
      summary: string;
      why: string[];
      tradeoffs: { option: string; pros: string[]; cons: string[] }[];
      uncertainty: string[];
      information_to_collect: string[];
      suggested_next_step: string;
      unmatchedNumbers?: string[];
    };
    error: string | null;
    model: string | null;
    generatedAt: string | null;
  };
  plans?: { id: number; status: string; title?: string }[];
}
interface Run {
  id: number;
  planDate: string;
  today: string;
  createdAt: string;
  createdBy: string | null;
  changesSinceRun: number;
  summary: {
    byTier: Record<string, number>;
    excludedBatches: number;
    verifiedItems: number;
    itemsWithForecast: number;
  };
  forecasts: {
    menuItemId: number;
    name: string;
    method: string;
    mean: number | null;
    min: number | null;
    max: number | null;
    daysUsed: number;
  }[];
  items: Rec[];
}

const TIER_NAME: Record<number, string> = {
  1: 'Food safety',
  2: 'Service risks',
  3: 'Cost opportunities',
  4: 'Data quality',
};
const KIND_LABEL: Record<string, string> = {
  unsafe_stock: 'Unsafe stock',
  verify_best_before: 'Quality check',
  stockout_risk: 'Stockout risk',
  expiry_waste_risk: 'Expiry waste risk',
  prep_adjustment: 'Preparation quantity',
  excess_stock: 'Excess stock',
  forecast_deviation: 'Forecast vs actual',
  data_gap: 'Missing information',
};

export function Recommendations() {
  const { api, base, canEdit } = useOutlet();
  const nav = useNavigate();
  const toast = useToast();
  const latest = useQuery<Run | null>(`${api}/recommendations/latest`);
  const [planDate, setPlanDate] = useState(todayIST());
  const [running, setRunning] = useState(false);
  const [choice, setChoice] = useState<Record<number, string>>({});
  const [creating, setCreating] = useState(false);
  const run = latest.data;

  const doRun = async () => {
    setRunning(true);
    try {
      latest.setData(await post<Run>(`${api}/recommendations/run`, { planDate }));
      setChoice({});
      toast('Recommendations recalculated from current records');
    } catch (e) {
      toast((e as Error).message, 'error');
    } finally {
      setRunning(false);
    }
  };

  const selected = Object.entries(choice).filter(([, k]) => k);
  const createPlan = async () => {
    if (!run) return;
    setCreating(true);
    try {
      const p = await post<{ id: number }>(`${api}/plans`, {
        runId: run.id,
        selections: selected.map(([itemId, optionKey]) => ({ itemId: Number(itemId), optionKey })),
      });
      toast('Draft plan created');
      nav(`${base}/plans/${p.id}`);
    } catch (e) {
      toast((e as Error).message, 'error');
      setCreating(false);
    }
  };

  const tiers = [1, 2, 3, 4]
    .map((t) => ({ t, items: run?.items.filter((i) => i.severityTier === t) ?? [] }))
    .filter((g) => g.items.length);

  return (
    <div className="stack">
      <PageHead
        title="Recommendations"
        sub="Calculated by fixed, documented rules from your own stock, recipe and sales records. You decide what to do."
      />
      <Card>
        <div className="card-body stack-sm">
          <div className="row" style={{ alignItems: 'flex-end' }}>
            <div className="field" style={{ flex: '0 1 200px' }}>
              <label htmlFor="pd">Plan for</label>
              <input
                id="pd"
                className="input"
                type="date"
                value={planDate}
                min={todayIST()}
                max={addDays(todayIST(), 7)}
                onChange={(e) => setPlanDate(e.target.value)}
              />
            </div>
            {canEdit ? (
              <Button className="primary" busy={running} onClick={doRun}>
                <Icon.Decide size={18} /> {run ? 'Recalculate' : 'Run decision engine'}
              </Button>
            ) : (
              <span className="small muted">Only owners and managers can run the engine.</span>
            )}
          </div>
          {run && (
            <p className="small muted">
              Showing run #{run.id} for {formatDate(run.planDate)}, calculated {formatDateTime(run.createdAt)}
              {run.createdBy ? ` by ${run.createdBy}` : ''}. {run.summary.verifiedItems} verified recipe(s),{' '}
              {run.summary.itemsWithForecast} with enough sales history, {run.summary.excludedBatches}{' '}
              batch(es) excluded for safety.
            </p>
          )}
          {run && run.changesSinceRun > 0 && (
            <Alert kind="warn">
              {run.changesSinceRun} record change(s) since this run — recalculate to use the latest data.
            </Alert>
          )}
        </div>
      </Card>

      {latest.error ? (
        <ErrorState error={latest.error} onRetry={latest.reload} />
      ) : latest.loading && !run ? (
        <Loading />
      ) : !run ? (
        <Card>
          <Empty icon={<Icon.Decide />} title="No recommendations yet">
            Run the engine after adding ingredients with stock, verified recipes and some days of sales. It
            will also tell you exactly what information is missing.
          </Empty>
        </Card>
      ) : run.items.length === 0 ? (
        <Alert kind="ok">
          No risks were detected from the current records. This only covers what has been recorded.
        </Alert>
      ) : (
        tiers.map(({ t, items }) => (
          <section key={t} className="stack-sm" aria-labelledby={`tier-${t}`}>
            <h2 id={`tier-${t}`} className="row">
              <Tier tier={t} /> {TIER_NAME[t]} <span className="muted small">({items.length})</span>
            </h2>
            {items.map((r) => (
              <Card key={r.id} tone={t === 1 ? 'danger' : t === 2 ? 'warn' : t === 3 ? 'info' : 'muted'}>
                <div className="card-body stack-sm">
                  <div className="spread" style={{ alignItems: 'flex-start' }}>
                    <div style={{ minWidth: 0, flex: 1 }}>
                      <div
                        className="tiny muted strong"
                        style={{ textTransform: 'uppercase', letterSpacing: '0.05em' }}
                      >
                        {KIND_LABEL[r.kind]}
                      </div>
                      <Link
                        to={`${base}/recommendations/${r.id}`}
                        style={{ color: 'inherit', textDecoration: 'none' }}
                      >
                        <h3 style={{ fontSize: '1rem' }}>{r.title}</h3>
                      </Link>
                      <p className="small" style={{ marginTop: 4, color: 'var(--ink-2)' }}>
                        {r.problem}
                      </p>
                    </div>
                    {r.estimatedImpactPaise !== null && (
                      <div className="right" style={{ flex: 'none' }}>
                        <div className="strong">{formatINR(r.estimatedImpactPaise)}</div>
                        <Prov kind="estimate" title={r.impactLabel} />
                      </div>
                    )}
                  </div>
                  <div className="row small">
                    <Confidence level={r.confidence} />
                    {r.missingInfo.length > 0 && r.kind !== 'data_gap' && (
                      <Badge kind="outline">{r.missingInfo.length} missing input(s)</Badge>
                    )}
                    {r.plans?.map((p) => (
                      <Link key={p.id} to={`${base}/plans/${p.id}`}>
                        <Badge kind="info">
                          In plan #{p.id} · {p.status.replace('_', ' ')}
                        </Badge>
                      </Link>
                    ))}
                  </div>
                  {canEdit && r.options.some((o) => o.lines.length) && (
                    <div className="field">
                      <label htmlFor={`opt-${r.id}`} className="small">
                        Add to plan
                      </label>
                      <select
                        id={`opt-${r.id}`}
                        className="input"
                        value={choice[r.id] ?? ''}
                        onChange={(e) => setChoice((c) => ({ ...c, [r.id]: e.target.value }))}
                      >
                        <option value="">Don’t include</option>
                        {r.options.map((o) => (
                          <option key={o.key} value={o.key} disabled={!o.feasible || o.lines.length === 0}>
                            {o.key}. {o.label}
                            {!o.feasible
                              ? ' (not feasible)'
                              : o.lines.length === 0
                                ? ' (no action needed)'
                                : ''}
                          </option>
                        ))}
                      </select>
                    </div>
                  )}
                  <div>
                    <Link className="btn sm" to={`${base}/recommendations/${r.id}`}>
                      Why this recommendation? <Icon.Chevron size={16} />
                    </Link>
                  </div>
                </div>
              </Card>
            ))}
          </section>
        ))
      )}

      {canEdit && selected.length > 0 && (
        <div
          className="card card-pad spread"
          style={{
            position: 'sticky',
            bottom: 'calc(var(--nav-h) + 8px)',
            zIndex: 10,
            borderColor: 'var(--brand)',
          }}
        >
          <span className="strong">{selected.length} option(s) selected</span>
          <Button className="primary" busy={creating} onClick={createPlan}>
            Create draft plan
          </Button>
        </div>
      )}

      {run && run.forecasts.length > 0 && (
        <details className="card card-pad disclose">
          <summary>
            Forecasts used in this run <Prov kind="forecast" />
          </summary>
          <div className="table-wrap" style={{ marginTop: 8 }}>
            <table className="table">
              <thead>
                <tr>
                  <th>Menu item</th>
                  <th className="num">Forecast</th>
                  <th className="num">Range</th>
                  <th>Method</th>
                  <th className="num">Days</th>
                </tr>
              </thead>
              <tbody>
                {run.forecasts.map((f) => (
                  <tr key={f.menuItemId}>
                    <td>{f.name}</td>
                    <td className="num">{f.mean ?? '—'}</td>
                    <td className="num">{f.min === null ? '—' : `${f.min}–${f.max}`}</td>
                    <td className="small">
                      {f.method === 'insufficient' ? (
                        <Badge kind="warn">Insufficient data</Badge>
                      ) : f.method === 'same_weekday' ? (
                        'Same weekday'
                      ) : (
                        'Recent days'
                      )}
                    </td>
                    <td className="num">{f.daysUsed}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      )}
    </div>
  );
}

export function RecommendationDetail() {
  const { iid } = useParams();
  const { api, base, canEdit } = useOutlet();
  const nav = useNavigate();
  const toast = useToast();
  const { data: r, error, loading, reload, setData } = useQuery<Rec>(`${api}/recommendations/items/${iid}`);
  const [selected, setSelected] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [explaining, setExplaining] = useState(false);
  const ai = useQuery<{ configured: boolean; reason: string; model: string | null }>(`${api}/ai/status`);

  if (error) return <ErrorState error={error} onRetry={reload} />;
  if (loading && !r) return <Loading />;
  if (!r) return null;

  const explain = async () => {
    setExplaining(true);
    try {
      setData(await post<Rec>(`${api}/recommendations/items/${r.id}/explain`));
    } catch (e) {
      // The server returns the updated record (with the error status) even when the provider fails.
      if (
        e instanceof ApiError &&
        e.details &&
        typeof e.details === 'object' &&
        'ai' in (e.details as object)
      )
        setData(e.details as Rec);
      else toast((e as Error).message, 'error');
    } finally {
      setExplaining(false);
    }
  };

  const makePlan = async () => {
    if (!selected) return;
    setBusy(true);
    try {
      const p = await post<{ id: number }>(`${api}/plans`, {
        runId: r.runId,
        selections: [{ itemId: r.id, optionKey: selected }],
      });
      toast('Draft plan created');
      nav(`${base}/plans/${p.id}`);
    } catch (e) {
      toast((e as Error).message, 'error');
      setBusy(false);
    }
  };

  return (
    <div className="stack">
      <PageHead
        title={r.title}
        crumb={{ to: `${base}/recommendations`, label: 'Recommendations' }}
        sub={
          <span className="row" style={{ gap: 6 }}>
            <Tier tier={r.severityTier} /> {KIND_LABEL[r.kind]} · <Confidence level={r.confidence} />
          </span>
        }
      />

      <Card
        title="Problem detected"
        tone={r.severityTier === 1 ? 'danger' : r.severityTier === 2 ? 'warn' : 'info'}
      >
        <div className="card-body stack-sm">
          <p>{r.problem}</p>
          {r.estimatedImpactPaise !== null && (
            <p className="small">
              {r.impactLabel}: <strong>{formatINR(r.estimatedImpactPaise)}</strong> <Prov kind="estimate" />
            </p>
          )}
          <p className="small">
            <strong>Recommended next step:</strong> {r.nextStep}
          </p>
        </div>
      </Card>

      {r.options.length > 0 && (
        <section className="stack-sm" aria-labelledby="opts">
          <h2 id="opts">Compare options</h2>
          <div className="grid-2">
            {r.options.map((o) => (
              <div
                key={o.key}
                className={`option ${selected === o.key ? 'selected' : ''} ${!o.feasible ? 'infeasible' : ''}`}
                role="radio"
                aria-checked={selected === o.key}
                aria-disabled={!o.feasible || !o.lines.length}
                tabIndex={o.feasible && o.lines.length ? 0 : -1}
                onClick={() => o.feasible && o.lines.length && canEdit && setSelected(o.key)}
                onKeyDown={(e) =>
                  (e.key === ' ' || e.key === 'Enter') &&
                  o.feasible &&
                  o.lines.length &&
                  canEdit &&
                  (e.preventDefault(), setSelected(o.key))
                }
              >
                <div className="row" style={{ alignItems: 'flex-start', flexWrap: 'nowrap' }}>
                  <span className="key">{o.key}</span>
                  <div style={{ minWidth: 0 }}>
                    <h3>{o.label}</h3>
                    <p className="small muted">{o.description}</p>
                  </div>
                </div>
                {!o.feasible && <Alert kind="warn">Not feasible: {o.infeasibleReason}</Alert>}
                {o.effects.length > 0 && (
                  <dl className="kv">
                    {o.effects.map((e, i) => (
                      <div key={i} style={{ display: 'contents' }}>
                        <dt>{e.label}</dt>
                        <dd>{e.value}</dd>
                      </div>
                    ))}
                  </dl>
                )}
                {o.lines.length > 0 && (
                  <div className="tiny muted">
                    Would create:{' '}
                    {o.lines
                      .map(
                        (l) =>
                          `${l.type.replace('_', ' ')} — ${l.subjectName}${l.qty !== null ? ` (${l.qty}${l.unit && l.unit !== 'portions' ? ' ' + l.unit : ' portions'})` : ''}`,
                      )
                      .join('; ')}
                  </div>
                )}
              </div>
            ))}
          </div>
          {canEdit && (
            <div className="row">
              <Button className="primary" disabled={!selected} busy={busy} onClick={makePlan}>
                {selected ? `Create draft plan with option ${selected}` : 'Select an option to plan'}
              </Button>
              {r.plans?.map((p) => (
                <Link key={p.id} className="btn sm" to={`${base}/plans/${p.id}`}>
                  Open plan #{p.id} ({p.status.replace('_', ' ')})
                </Link>
              ))}
            </div>
          )}
        </section>
      )}

      <Card title="Why this recommendation? — the calculation">
        <div className="card-body stack">
          {r.calculation.length > 0 ? (
            <ul className="calc">
              {r.calculation.map((c, i) => (
                <li key={i}>{c}</li>
              ))}
            </ul>
          ) : (
            <p className="small muted">No calculation — this item reports missing information.</p>
          )}
          {r.assumptions.length > 0 && (
            <div>
              <h3>Assumptions</h3>
              <ul className="small">
                {r.assumptions.map((a, i) => (
                  <li key={i}>{a}</li>
                ))}
              </ul>
            </div>
          )}
        </div>
      </Card>

      <Card title="What information is missing?">
        <div className="card-body">
          {r.missingInfo.length ? (
            <ul className="small">
              {r.missingInfo.map((m, i) => (
                <li key={i}>{m}</li>
              ))}
            </ul>
          ) : (
            <p className="small muted">Nothing missing for this calculation.</p>
          )}
        </div>
      </Card>

      <Card title="Supporting records">
        <div className="card-body stack">
          {r.evidence.batches.length > 0 && (
            <div className="stack-sm">
              <h3>
                Inventory batches <Prov kind="actual" />
              </h3>
              <div className="table-wrap">
                <table className="table">
                  <thead>
                    <tr>
                      <th>Ingredient / lot</th>
                      <th className="num">Remaining</th>
                      <th>Date</th>
                      <th>Status</th>
                      <th>Unit cost</th>
                    </tr>
                  </thead>
                  <tbody>
                    {r.evidence.batches.map((b) => (
                      <tr key={b.batchId}>
                        <td>
                          {b.ingredient}
                          <div className="tiny muted">{b.lot ?? `Batch #${b.batchId}`}</div>
                        </td>
                        <td className="num">{b.qtyRemaining}</td>
                        <td className="small nowrap">
                          {b.dateType
                            ? `${DATE_TYPE_LABEL[b.dateType]} ${formatDate(b.dateValue)}`
                            : 'No date supplied'}
                        </td>
                        <td className="small">{b.status}</td>
                        <td className="small">{b.unitCost}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
          {r.evidence.recipes.length > 0 && (
            <div className="stack-sm">
              <h3>Recipe quantities (verified by the outlet)</h3>
              <div className="table-wrap">
                <table className="table">
                  <thead>
                    <tr>
                      <th>Menu item</th>
                      <th>Ingredient</th>
                      <th className="num">Per serving</th>
                      <th className="num">Prep loss</th>
                    </tr>
                  </thead>
                  <tbody>
                    {r.evidence.recipes.map((x, i) => (
                      <tr key={i}>
                        <td>{x.menuItem}</td>
                        <td>{x.ingredient}</td>
                        <td className="num">{x.qtyPerServing}</td>
                        <td className="num">{x.lossPct ? `${x.lossPct}%` : '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
          {r.evidence.sales.length > 0 && (
            <div className="stack-sm">
              <h3>
                Sales history used <Prov kind="actual" /> → forecast <Prov kind="forecast" />
              </h3>
              {r.evidence.sales.map((s, i) => (
                <div key={i} className="small">
                  <strong>{s.menuItem}</strong>: {s.method}
                  {s.mean !== null
                    ? ` = ${s.mean} (range ${s.min}–${s.max}) from ${s.daysUsed} day(s), ${formatDate(s.from)}–${formatDate(s.to)}`
                    : ' — not enough history'}
                  {s.values.length > 0 && (
                    <div className="tiny muted mono" style={{ marginTop: 2 }}>
                      {s.values.map((v) => `${formatDate(v.date).slice(0, 5)}: ${v.qty}`).join(' · ')}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
          {r.evidence.other.length > 0 && (
            <ul className="small">
              {r.evidence.other.map((o, i) => (
                <li key={i}>{o}</li>
              ))}
            </ul>
          )}
          {!r.evidence.batches.length &&
            !r.evidence.recipes.length &&
            !r.evidence.sales.length &&
            !r.evidence.other.length && <p className="small muted">No supporting records.</p>}
        </div>
      </Card>

      {r.safetyChecks.length > 0 && (
        <Card title="Safety constraints checked">
          <div className="card-body">
            <ul className="small">
              {r.safetyChecks.map((s, i) => (
                <li key={i}>{s}</li>
              ))}
            </ul>
          </div>
        </Card>
      )}

      <Card
        title={
          <h2>
            Plain-language explanation <Prov kind="ai" />
          </h2>
        }
      >
        <div className="card-body stack-sm">
          <p className="small muted">
            Optional. A configured AI model rewrites the calculation above in simple words. It does not change
            any number, quantity or safety decision — those always come from the deterministic engine above.
          </p>
          {ai.data && !ai.data.configured && (
            <Alert kind="info">AI explanation is not configured on this server. {ai.data.reason}</Alert>
          )}
          {r.ai?.status === 'ok' && r.ai.explanation && (
            <div className="stack-sm">
              {r.ai.explanation.unmatchedNumbers && r.ai.explanation.unmatchedNumbers.length > 0 && (
                <Alert kind="warn">
                  The explanation mentions number(s) not found in the calculation (
                  {r.ai.explanation.unmatchedNumbers.join(', ')}). Rely on the calculation above.
                </Alert>
              )}
              <p>{r.ai.explanation.summary}</p>
              <ul className="small">
                {r.ai.explanation.why.map((w, i) => (
                  <li key={i}>{w}</li>
                ))}
              </ul>
              {r.ai.explanation.tradeoffs.map((t, i) => (
                <div key={i} className="small">
                  <strong>Option {t.option}</strong> — pros: {t.pros.join('; ') || '—'}; cons:{' '}
                  {t.cons.join('; ') || '—'}
                </div>
              ))}
              {r.ai.explanation.uncertainty.length > 0 && (
                <p className="small">
                  <strong>Uncertainty:</strong> {r.ai.explanation.uncertainty.join(' ')}
                </p>
              )}
              {r.ai.explanation.information_to_collect.length > 0 && (
                <p className="small">
                  <strong>Worth collecting:</strong> {r.ai.explanation.information_to_collect.join('; ')}
                </p>
              )}
              <p className="small">
                <strong>Suggested next step:</strong> {r.ai.explanation.suggested_next_step}
              </p>
              <p className="tiny muted">
                Generated {formatDateTime(r.ai.generatedAt)} by {r.ai.model}.
              </p>
            </div>
          )}
          {r.ai && r.ai.status !== 'ok' && (
            <Alert kind="danger">
              Last attempt failed ({r.ai.status.replace('_', ' ')}): {r.ai.error} No explanation was
              generated.
            </Alert>
          )}
          {canEdit && ai.data?.configured && (
            <div>
              <Button busy={explaining} onClick={explain}>
                <Icon.Spark size={16} />{' '}
                {r.ai?.status === 'ok' ? 'Regenerate explanation' : 'Explain in plain language'}
              </Button>
            </div>
          )}
        </div>
      </Card>
    </div>
  );
}
