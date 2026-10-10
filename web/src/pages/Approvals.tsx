import { Link } from 'react-router-dom';
import { addDays, formatDate, formatDateTime, formatINR, todayIST } from '../fmt';
import { useQuery } from '../hooks';
import { Icon } from '../icons';
import { useOutlet } from '../session';
import { Alert, Badge, Card, Empty, ErrorState, Loading, PageHead, Prov } from '../ui';

interface PlanSummary {
  id: number;
  title: string;
  planDate: string;
  status: string;
  createdAt: string;
  lineCount: number;
  openTasks: number;
}

/** Approval queue: plans waiting for a decision, and drafts not yet submitted. */
export function Approvals() {
  const { api, base, outlet } = useOutlet();
  const awaiting = useQuery<PlanSummary[]>(`${api}/plans?status=awaiting_approval`);
  const drafts = useQuery<PlanSummary[]>(`${api}/plans?status=draft`);
  const approver = outlet.role === 'owner' || (outlet.role === 'manager' && outlet.managersCanApprove);
  if (awaiting.error) return <ErrorState error={awaiting.error} onRetry={awaiting.reload} />;
  return (
    <div className="stack">
      <PageHead
        title="Approval queue"
        sub={
          approver
            ? 'Plans need your decision before they become kitchen tasks.'
            : `Plans wait for ${outlet.managersCanApprove ? 'the owner or a manager' : 'the owner'} to approve.`
        }
      />
      <Card title={`Awaiting approval (${awaiting.data?.length ?? '…'})`}>
        {awaiting.loading && !awaiting.data ? (
          <Loading />
        ) : !awaiting.data?.length ? (
          <Empty icon={<Icon.Check />} title="Nothing waiting for approval">
            Plans appear here after someone chooses options on a recommendation and submits them.
          </Empty>
        ) : (
          <ul className="list">
            {awaiting.data.map((p) => (
              <li key={p.id}>
                <Link className="list-item" to={`${base}/plans/${p.id}`}>
                  <div className="grow">
                    <div className="title">{p.title}</div>
                    <div className="meta">
                      For {formatDate(p.planDate)} · {p.lineCount} action(s) · created{' '}
                      {formatDateTime(p.createdAt)}
                    </div>
                  </div>
                  {approver ? (
                    <span className="btn sm primary">Review</span>
                  ) : (
                    <Badge kind="warn">Waiting</Badge>
                  )}
                </Link>
              </li>
            ))}
          </ul>
        )}
      </Card>
      <Card title={`Drafts not yet submitted (${drafts.data?.length ?? '…'})`}>
        {!drafts.data?.length ? (
          <div className="card-body small muted">No drafts.</div>
        ) : (
          <ul className="list">
            {drafts.data.map((p) => (
              <li key={p.id}>
                <Link className="list-item" to={`${base}/plans/${p.id}`}>
                  <div className="grow">
                    <div className="title">{p.title}</div>
                    <div className="meta">
                      For {formatDate(p.planDate)} · {p.lineCount} action(s)
                    </div>
                  </div>
                  <Badge kind="outline">Draft</Badge>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}

interface Comparison {
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
}

/** Outcome verification: approved actions vs what was recorded afterwards. */
export function Verify() {
  const { api, base } = useOutlet();
  const to = todayIST();
  const a = useQuery<{
    prepComparisons: Comparison[];
    estimatedImpactOfApprovedRecommendations: { totalPaise: number | null; recommendations: number };
  }>(`${api}/analytics?from=${addDays(to, -27)}&to=${to}`);
  const tasks = useQuery<
    {
      id: number;
      title: string;
      type: string;
      status: string;
      dueDate: string;
      subjectId: number;
      actualQty: number | null;
      outcomeId: number | null;
      planId: number;
      planTitle: string;
    }[]
  >(`${api}/tasks?status=done`);
  const plans = useQuery<PlanSummary[]>(`${api}/plans?status=completed`);
  if (a.error) return <ErrorState error={a.error} onRetry={a.reload} />;
  if (a.loading && !a.data) return <Loading />;
  const pending = (tasks.data ?? []).filter((t) => t.type === 'prep' && !t.outcomeId);
  const comps = a.data?.prepComparisons ?? [];

  return (
    <div className="stack">
      <PageHead
        title="Outcome verification"
        sub="Recommendation → approved action → recorded outcome. Estimates made before acting are kept separate from what was measured afterwards."
      />

      {pending.length > 0 && (
        <Card title="Completed tasks still missing an outcome" tone="warn">
          <ul className="list">
            {pending.map((t) => (
              <li key={t.id} className="list-item">
                <div className="grow">
                  <div className="title small">{t.title}</div>
                  <div className="meta">
                    {formatDate(t.dueDate)} · prepared {t.actualQty ?? '—'} · {t.planTitle}
                  </div>
                </div>
                <Link
                  className="btn sm primary"
                  to={`${base}/outcomes?taskId=${t.id}&menuItemId=${t.subjectId}&prepared=${t.actualQty ?? ''}`}
                >
                  Record outcome
                </Link>
              </li>
            ))}
          </ul>
        </Card>
      )}

      <Card
        title={
          <h2>
            Preparation actions vs recorded results <Prov kind="actual" />
          </h2>
        }
      >
        {!comps.length ? (
          <Empty icon={<Icon.Outcome />} title="No completed preparation actions yet">
            Approve a preparation plan, complete its task with the actual quantity, then record the service
            outcome.
          </Empty>
        ) : (
          <div className="stack-sm">
            {comps.map((c) => (
              <div key={c.taskId} className="verify-row">
                <div className="spread">
                  <strong>{c.name}</strong>
                  <span className="small muted">{formatDate(c.date)}</span>
                </div>
                {!c.result ? (
                  <p className="small muted">No service outcome recorded for this day yet.</p>
                ) : (
                  <>
                    <div className="verify-steps">
                      <div>
                        <span className="tiny muted">Approved</span>
                        <strong>{c.result.planned}</strong>
                      </div>
                      <div>
                        <span className="tiny muted">Prepared</span>
                        <strong>{c.result.prepared}</strong>
                      </div>
                      <div>
                        <span className="tiny muted">Sold</span>
                        <strong>{c.result.sold}</strong>
                      </div>
                      <div>
                        <span className="tiny muted">Discarded</span>
                        <strong>{c.result.discarded}</strong>
                      </div>
                      <div>
                        <span className="tiny muted">Earlier avg discarded</span>
                        <strong>{c.result.baselineDiscardedAvg ?? '—'}</strong>
                      </div>
                    </div>
                    {c.result.observedDiscardDiff === null ? (
                      <p className="small muted">{c.result.note}</p>
                    ) : (
                      <p className="small">
                        Observed:{' '}
                        {c.result.observedDiscardDiff >= 0
                          ? `${c.result.observedDiscardDiff} fewer`
                          : `${-c.result.observedDiscardDiff} more`}{' '}
                        portion(s) discarded than the earlier average
                        {c.result.observedDiffCostPaise !== null && (
                          <>
                            {' '}
                            (≈ {formatINR(Math.abs(c.result.observedDiffCostPaise))} <Prov kind="estimate" />)
                          </>
                        )}
                        . <span className="muted">{c.result.note}</span>
                      </p>
                    )}
                  </>
                )}
              </div>
            ))}
          </div>
        )}
      </Card>

      <div className="grid-2">
        <Card title="Completed plans">
          {!plans.data?.length ? (
            <div className="card-body small muted">No completed plans yet.</div>
          ) : (
            <ul className="list">
              {plans.data.map((p) => (
                <li key={p.id}>
                  <Link className="list-item" to={`${base}/plans/${p.id}`}>
                    <div className="grow">
                      <div className="title small">{p.title}</div>
                      <div className="meta">For {formatDate(p.planDate)}</div>
                    </div>
                    <Badge kind="ok">Completed</Badge>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </Card>
        <Card title="Estimated vs measured">
          <div className="card-body small stack-sm">
            <p>
              Estimated impact of approved recommendations (last 28 days):{' '}
              <strong>
                {a.data?.estimatedImpactOfApprovedRecommendations.recommendations
                  ? formatINR(a.data.estimatedImpactOfApprovedRecommendations.totalPaise ?? 0)
                  : '—'}
              </strong>{' '}
              <Prov kind="estimate" />
            </p>
            <Alert kind="info">
              Estimates are calculated before acting. Only the recorded outcomes above are measurements — and
              a few days of records are not proof of lasting savings.
            </Alert>
          </div>
        </Card>
      </div>
    </div>
  );
}
