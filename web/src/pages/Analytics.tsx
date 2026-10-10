import { useState } from 'react';
import { BarChart } from '../BarChart';
import { addDays, formatDate, formatINR, todayIST, WASTE_REASON_LABELS } from '../fmt';
import { useQuery } from '../hooks';
import { useOutlet } from '../session';
import { Alert, Card, ErrorState, Loading, PageHead, Prov } from '../ui';

interface AnalyticsDto {
  from: string;
  to: string;
  waste: {
    entries: number;
    recordedCostPaise: number;
    estimatedCostPaise: number;
    entriesWithoutCost: number;
    discardedPortions: number;
    byDay: { date: string; recorded: number; estimated: number }[];
    byReason: { reason: string; count: number }[];
  };
  sales: { portionsSold: number; days: number; byDay: { date: string; portions: number }[] };
  wastePer100Portions: { value: number | null; discardedPortions: number; portionsSold: number };
  forecastError: {
    pairs: number;
    mae: number | null;
    wape: number | null;
    recent: { date: string; name: string; forecast: number; actual: number }[];
  };
  actions: { plans: Record<string, number>; tasks: Record<string, number> };
  estimatedImpactOfApprovedRecommendations: {
    totalPaise: number | null;
    recommendations: number;
    withoutEstimate: number;
  };
  prepComparisons: {
    taskId: number;
    name: string;
    date: string;
    result: null | {
      planned: number;
      prepared: number;
      sold: number;
      discarded: number;
      baselineDays: number;
      baselineDiscardedAvg: number | null;
      observedDiscardDiff: number | null;
      observedDiffCostPaise: number | null;
      note: string;
    };
  }[];
}

const RANGES = [7, 14, 28, 90];

/** Fill missing dates so the time axis is continuous. */
function days(from: string, to: string) {
  const out: string[] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) out.push(d);
  return out;
}

function Stat({
  label,
  value,
  prov,
  foot,
}: {
  label: string;
  value: string | null;
  prov: 'actual' | 'estimate' | 'forecast';
  foot?: string;
}) {
  return (
    <div className="card stat">
      <div className="label">
        {label} {value === null ? <Prov kind="unavailable" /> : <Prov kind={prov} />}
      </div>
      <div className={`value ${value === null ? 'unavailable' : ''}`}>{value ?? 'Not enough data'}</div>
      {foot && <div className="foot">{foot}</div>}
    </div>
  );
}

export function Analytics() {
  const { api } = useOutlet();
  const [range, setRange] = useState(28);
  const to = todayIST();
  const from = addDays(to, -(range - 1));
  const {
    data: a,
    error,
    loading,
    reload,
  } = useQuery<AnalyticsDto>(`${api}/analytics?from=${from}&to=${to}`);

  return (
    <div className="stack">
      <PageHead
        title="Analytics & outcomes"
        sub="Only what your records support. Estimates and forecasts are labelled; unavailable metrics say why."
      />
      <div className="seg" role="group" aria-label="Date range">
        {RANGES.map((r) => (
          <button key={r} aria-pressed={range === r} onClick={() => setRange(r)}>
            Last {r} days
          </button>
        ))}
      </div>
      {error ? (
        <ErrorState error={error} onRetry={reload} />
      ) : loading && !a ? (
        <Loading />
      ) : !a ? null : (
        <>
          <div className="grid-3">
            <Stat
              label="Portions sold"
              value={a.sales.days ? a.sales.portionsSold.toLocaleString('en-IN') : null}
              prov="actual"
              foot={`${a.sales.days} trading day(s) recorded`}
            />
            <Stat
              label="Waste at batch cost"
              value={a.waste.entries ? formatINR(a.waste.recordedCostPaise) : null}
              prov="actual"
              foot="Raw ingredients, from bill costs"
            />
            <Stat
              label="Wasted dishes (recipe cost)"
              value={a.waste.entries ? formatINR(a.waste.estimatedCostPaise) : null}
              prov="estimate"
              foot={`${a.waste.discardedPortions} portion(s) discarded${a.waste.entriesWithoutCost ? ` · ${a.waste.entriesWithoutCost} without cost` : ''}`}
            />
            <Stat
              label="Discarded per 100 portions sold"
              value={a.wastePer100Portions.value === null ? null : String(a.wastePer100Portions.value)}
              prov="actual"
              foot={
                a.wastePer100Portions.value === null
                  ? 'Needs recorded sales in this period'
                  : `${a.wastePer100Portions.discardedPortions} ÷ ${a.wastePer100Portions.portionsSold} × 100`
              }
            />
            <Stat
              label="Forecast error (avg. portions)"
              value={a.forecastError.mae === null ? null : String(a.forecastError.mae)}
              prov="actual"
              foot={
                a.forecastError.pairs
                  ? `${a.forecastError.pairs} forecast(s) vs actual${a.forecastError.wape !== null ? ` · ${a.forecastError.wape}% weighted error` : ''}`
                  : 'Needs past forecasts and actual sales for the same days'
              }
            />
            <Stat
              label="Impact of approved recommendations"
              value={
                a.estimatedImpactOfApprovedRecommendations.recommendations
                  ? formatINR(a.estimatedImpactOfApprovedRecommendations.totalPaise ?? 0)
                  : null
              }
              prov="estimate"
              foot={
                a.estimatedImpactOfApprovedRecommendations.recommendations
                  ? `${a.estimatedImpactOfApprovedRecommendations.recommendations} recommendation(s) · calculated before acting, not realised savings`
                  : 'No approved plans in this period'
              }
            />
          </div>

          <div className="grid-2">
            <Card
              title={
                <h2>
                  Portions sold per day <Prov kind="actual" />
                </h2>
              }
            >
              <div className="card-body">
                {a.sales.days === 0 ? (
                  <p className="small muted">No sales recorded in this period.</p>
                ) : (
                  <BarChart
                    title="Portions sold per day"
                    series={[{ name: 'Portions sold', color: 'var(--chart-a)' }]}
                    data={days(a.from, a.to).map((d) => ({
                      label: formatDate(d).slice(0, 5),
                      values: [a.sales.byDay.find((x) => x.date === d)?.portions ?? 0],
                    }))}
                    format={(n) => Math.round(n).toLocaleString('en-IN')}
                  />
                )}
              </div>
            </Card>
            <Card title="Waste cost per day">
              <div className="card-body">
                {a.waste.entries === 0 ? (
                  <p className="small muted">
                    No waste recorded in this period. If waste occurred, record it so it can be measured.
                  </p>
                ) : (
                  <BarChart
                    title="Waste cost per day"
                    series={[
                      { name: 'Recorded (batch cost)', color: 'var(--chart-a)' },
                      { name: 'Estimated (recipe cost)', color: 'var(--chart-b)' },
                    ]}
                    data={days(a.from, a.to).map((d) => {
                      const x = a.waste.byDay.find((w) => w.date === d);
                      return {
                        label: formatDate(d).slice(0, 5),
                        values: [x?.recorded ?? 0, x?.estimated ?? 0],
                      };
                    })}
                    format={(n) => formatINR(n).replace('.00', '')}
                  />
                )}
              </div>
            </Card>
          </div>

          <Card title="Outcomes of completed preparation tasks">
            <div className="card-body stack-sm">
              <p className="small muted">
                Each approved preparation task is compared with the same dish’s previous recorded services. A
                single day is an observation, not proof of a lasting saving.
              </p>
              {a.prepComparisons.length === 0 ? (
                <p className="small">No completed preparation tasks in this period.</p>
              ) : (
                <div className="table-wrap">
                  <table className="table">
                    <thead>
                      <tr>
                        <th>Dish / date</th>
                        <th className="num">Planned</th>
                        <th className="num">Prepared</th>
                        <th className="num">Sold</th>
                        <th className="num">Discarded</th>
                        <th className="num">Earlier avg discarded</th>
                        <th>Observed difference</th>
                      </tr>
                    </thead>
                    <tbody>
                      {a.prepComparisons.map((c) => (
                        <tr key={c.taskId}>
                          <td>
                            {c.name}
                            <div className="tiny muted">{formatDate(c.date)}</div>
                          </td>
                          {!c.result ? (
                            <td colSpan={6} className="small muted">
                              No service outcome recorded for this day yet.
                            </td>
                          ) : (
                            <>
                              <td className="num">{c.result.planned}</td>
                              <td className="num">{c.result.prepared}</td>
                              <td className="num">{c.result.sold}</td>
                              <td className="num">{c.result.discarded}</td>
                              <td className="num">{c.result.baselineDiscardedAvg ?? '—'}</td>
                              <td className="small">
                                {c.result.observedDiscardDiff === null ? (
                                  <span className="muted">{c.result.note}</span>
                                ) : (
                                  <>
                                    {c.result.observedDiscardDiff >= 0
                                      ? `${c.result.observedDiscardDiff} fewer`
                                      : `${-c.result.observedDiscardDiff} more`}{' '}
                                    portion(s) discarded
                                    {c.result.observedDiffCostPaise !== null && (
                                      <>
                                        {' '}
                                        (≈ {formatINR(Math.abs(c.result.observedDiffCostPaise))}{' '}
                                        <Prov kind="estimate" />)
                                      </>
                                    )}
                                    <div className="tiny muted">{c.result.note}</div>
                                  </>
                                )}
                              </td>
                            </>
                          )}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </Card>

          <div className="grid-2">
            <Card title="Forecast vs actual (recent)">
              <div className="card-body">
                {a.forecastError.recent.length === 0 ? (
                  <p className="small muted">
                    Forecasts are stored each time the decision engine runs. Once actual sales are recorded
                    for those days, the comparison appears here.
                  </p>
                ) : (
                  <div className="table-wrap">
                    <table className="table">
                      <thead>
                        <tr>
                          <th>Date</th>
                          <th>Dish</th>
                          <th className="num">Forecast</th>
                          <th className="num">Actual</th>
                        </tr>
                      </thead>
                      <tbody>
                        {a.forecastError.recent.map((r, i) => (
                          <tr key={i}>
                            <td className="small">{formatDate(r.date)}</td>
                            <td>{r.name}</td>
                            <td className="num">{r.forecast}</td>
                            <td className="num">{r.actual}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            </Card>
            <Card title="Actions and waste reasons">
              <div className="card-body stack-sm small">
                <div>
                  <strong>Plans:</strong>{' '}
                  {Object.keys(a.actions.plans).length
                    ? Object.entries(a.actions.plans)
                        .map(([k, v]) => `${v} ${k.replace('_', ' ')}`)
                        .join(' · ')
                    : 'none in this period'}
                </div>
                <div>
                  <strong>Tasks:</strong>{' '}
                  {Object.keys(a.actions.tasks).length
                    ? Object.entries(a.actions.tasks)
                        .map(([k, v]) => `${v} ${k}`)
                        .join(' · ')
                    : 'none in this period'}
                </div>
                <div>
                  <strong>Waste entries by reason:</strong>{' '}
                  {a.waste.byReason.length
                    ? a.waste.byReason
                        .map((r) => `${WASTE_REASON_LABELS[r.reason] ?? r.reason} (${r.count})`)
                        .join(' · ')
                    : 'none'}
                </div>
              </div>
            </Card>
          </div>
          <Alert kind="info">
            “Savings” are not claimed here. Estimated impact is calculated before acting; observed differences
            compare recorded outcomes with earlier records and can be affected by many other factors.
          </Alert>
        </>
      )}
    </div>
  );
}
