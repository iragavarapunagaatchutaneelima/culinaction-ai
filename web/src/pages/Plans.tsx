import { useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { del, post, put } from '../api';
import { formatDate, formatDateTime, formatINR, qtyLabel } from '../fmt';
import { useQuery } from '../hooks';
import { Icon } from '../icons';
import { useOutlet } from '../session';
import {
  Alert,
  Badge,
  Button,
  Card,
  Dialog,
  Empty,
  ErrorState,
  Loading,
  PageHead,
  Prov,
  TextArea,
  useToast,
} from '../ui';

type Status = 'draft' | 'awaiting_approval' | 'approved' | 'rejected' | 'completed' | 'cancelled';
const STATUS: Record<Status, [string, 'outline' | 'warn' | 'info' | 'danger' | 'ok']> = {
  draft: ['Draft', 'outline'],
  awaiting_approval: ['Awaiting approval', 'warn'],
  approved: ['Approved', 'info'],
  rejected: ['Rejected', 'danger'],
  completed: ['Completed', 'ok'],
  cancelled: ['Cancelled', 'outline'],
};
export function PlanStatus({ status }: { status: Status }) {
  const [l, k] = STATUS[status];
  return <Badge kind={k}>{l}</Badge>;
}

const LINE_TYPE: Record<string, string> = {
  prep: 'Prepare',
  purchase: 'Buy',
  reduce_purchase: 'Reduce next order',
  discard: 'Remove & record waste',
  verify: 'Check',
  count: 'Count stock',
  order_action: 'Order follow-up',
  dispose_order: 'Dispose & record order food',
};

interface PlanLine {
  id: number;
  recItemId: number | null;
  recTitle: string | null;
  optionKey: string | null;
  optionLabel: string | null;
  type: string;
  subjectType: string;
  subjectName: string;
  proposedQty: number | null;
  approvedQty: number | null;
  originalQty: number | null;
  unit: string | null;
  note: string | null;
  estimatedCostPaise: number | null;
  estimatedImpactPaise: number | null;
}
interface Plan {
  id: number;
  runId: number | null;
  title: string;
  planDate: string;
  status: Status;
  createdBy: string | null;
  createdAt: string;
  submittedAt: string | null;
  decidedBy: string | null;
  decidedAt: string | null;
  rejectionReason: string | null;
  cancelReason: string | null;
  completedAt: string | null;
  lines: PlanLine[];
  tasks: {
    id: number;
    lineId: number;
    title: string;
    status: string;
    dueDate: string;
    targetQty: number | null;
    unit: string | null;
    actualQty: number | null;
    notes: string | null;
    completedBy: string | null;
    completedAt: string | null;
  }[];
  history: {
    id: number;
    action: string;
    fromStatus: string;
    toStatus: string;
    reason: string | null;
    changes: Record<string, unknown> | null;
    createdAt: string;
    userName: string | null;
  }[];
}

export function Plans() {
  const { api, base } = useOutlet();
  const [params, setParams] = useSearchParams();
  const status = params.get('status') ?? '';
  const { data, error, loading, reload } = useQuery<
    {
      id: number;
      title: string;
      planDate: string;
      status: Status;
      createdAt: string;
      lineCount: number;
      openTasks: number;
    }[]
  >(`${api}/plans${status ? `?status=${status}` : ''}`);
  return (
    <div className="stack">
      <PageHead
        title="Action plans"
        sub="Recommendation → approved plan → tasks → recorded outcome. Nothing is ordered or published automatically."
      />
      <div className="seg" role="group" aria-label="Filter by status">
        {[
          ['', 'All'],
          ['draft', 'Draft'],
          ['awaiting_approval', 'Awaiting'],
          ['approved', 'Approved'],
          ['completed', 'Completed'],
          ['rejected', 'Rejected'],
          ['cancelled', 'Cancelled'],
        ].map(([v, l]) => (
          <button
            key={v}
            aria-pressed={status === v}
            onClick={() => setParams(v ? { status: v } : {}, { replace: true })}
          >
            {l}
          </button>
        ))}
      </div>
      {error ? (
        <ErrorState error={error} onRetry={reload} />
      ) : loading && !data ? (
        <Loading />
      ) : !data?.length ? (
        <Card>
          <Empty
            icon={<Icon.Plan />}
            title="No plans here"
            action={
              <Link className="btn" to={`${base}/recommendations`}>
                Go to recommendations
              </Link>
            }
          >
            Plans are created by choosing options on the Recommendations page.
          </Empty>
        </Card>
      ) : (
        <Card>
          <ul className="list">
            {data.map((p) => (
              <li key={p.id}>
                <Link className="list-item" to={`${base}/plans/${p.id}`}>
                  <div className="grow">
                    <div className="title">{p.title}</div>
                    <div className="meta">
                      #{p.id} · for {formatDate(p.planDate)} · {p.lineCount} action(s)
                      {p.openTasks ? ` · ${p.openTasks} open task(s)` : ''}
                    </div>
                  </div>
                  <PlanStatus status={p.status} />
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

export function PlanDetail() {
  const { pid } = useParams();
  const { api, base, outlet, canEdit } = useOutlet();
  const toast = useToast();
  const { data: p, error, loading, reload, setData } = useQuery<Plan>(`${api}/plans/${pid}`);
  const [edits, setEdits] = useState<Record<number, string>>({});
  const [reasonFor, setReasonFor] = useState<'reject' | 'cancel' | null>(null);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState<string | null>(null);

  if (error) return <ErrorState error={error} onRetry={reload} />;
  if (loading && !p) return <Loading />;
  if (!p) return null;

  const isApprover = outlet.role === 'owner' || (outlet.role === 'manager' && outlet.managersCanApprove);
  const editable = (p.status === 'draft' && canEdit) || (p.status === 'awaiting_approval' && isApprover);

  const act = async (action: string, body: object = {}) => {
    setBusy(action);
    try {
      // Save any pending quantity edits first (approve sends them with the request).
      const lineEdits = Object.entries(edits)
        .filter(([, v]) => v !== '')
        .map(([lineId, qty]) => ({ lineId: Number(lineId), qty: Number(qty) }));
      if (action !== 'approve')
        for (const e of lineEdits) await put(`${api}/plans/${p.id}/lines/${e.lineId}`, { qty: e.qty });
      setData(
        await post<Plan>(
          `${api}/plans/${p.id}/${action}`,
          action === 'approve' ? { ...body, lineEdits } : body,
        ),
      );
      setEdits({});
      setReasonFor(null);
      setReason('');
      toast(
        `Plan ${action === 'submit' ? 'submitted for approval' : action === 'approve' ? 'approved — tasks created' : action + 'ed'}`,
      );
    } catch (e) {
      toast((e as Error).message, 'error');
    } finally {
      setBusy(null);
    }
  };

  const saveLine = async (lineId: number) => {
    const v = edits[lineId];
    if (v === undefined || v === '') return;
    try {
      setData(await put<Plan>(`${api}/plans/${p.id}/lines/${lineId}`, { qty: Number(v) }));
      setEdits((e) => {
        const n = { ...e };
        delete n[lineId];
        return n;
      });
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  };

  const removeLine = async (lineId: number) => {
    try {
      setData(await del<Plan>(`${api}/plans/${p.id}/lines/${lineId}`));
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  };

  const totalCost = p.lines.reduce<number | null>(
    (a, l) =>
      l.type === 'purchase'
        ? a === null || l.estimatedCostPaise === null
          ? null
          : a + l.estimatedCostPaise
        : a,
    0,
  );

  return (
    <div className="stack">
      <PageHead
        title={p.title}
        crumb={{ to: `${base}/plans`, label: 'Plans' }}
        sub={
          <span className="row" style={{ gap: 6 }}>
            <PlanStatus status={p.status} /> #{p.id} · for {formatDate(p.planDate)} · created by{' '}
            {p.createdBy ?? '—'}
          </span>
        }
      />

      {p.status === 'rejected' && (
        <Alert kind="danger">
          Rejected by {p.decidedBy} on {formatDateTime(p.decidedAt)}: “{p.rejectionReason}”
        </Alert>
      )}
      {p.status === 'cancelled' && <Alert kind="warn">Cancelled: “{p.cancelReason}”</Alert>}
      {p.status === 'approved' && (
        <Alert kind="info">
          Approved by {p.decidedBy} on {formatDateTime(p.decidedAt)}. Tasks are listed below and in Prep &amp;
          tasks.
        </Alert>
      )}
      {p.status === 'awaiting_approval' && !isApprover && (
        <Alert kind="info">
          Waiting for {outlet.managersCanApprove ? 'the owner or a manager' : 'the owner'} to approve.
        </Alert>
      )}

      <Card title="Actions in this plan" foot={purchaseNote(totalCost, p)}>
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Action</th>
                <th className="num">Quantity</th>
                <th>From recommendation</th>
                {editable && <th />}
              </tr>
            </thead>
            <tbody>
              {p.lines.map((l) => {
                const qty = l.approvedQty ?? l.proposedQty;
                const changed = l.originalQty !== null && qty !== null && qty !== l.originalQty;
                return (
                  <tr key={l.id}>
                    <td>
                      <strong>{LINE_TYPE[l.type] ?? l.type}</strong> — {l.subjectName}
                      {l.note && <div className="tiny muted">{l.note}</div>}
                    </td>
                    <td className="num">
                      {editable && l.proposedQty !== null && l.type !== 'discard' ? (
                        <div className="row" style={{ justifyContent: 'flex-end', flexWrap: 'nowrap' }}>
                          <input
                            className="input"
                            style={{ width: 96, minHeight: 36, textAlign: 'right' }}
                            inputMode="decimal"
                            aria-label={`Quantity for ${l.subjectName}`}
                            value={edits[l.id] ?? String(l.proposedQty)}
                            onChange={(e) => setEdits((x) => ({ ...x, [l.id]: e.target.value }))}
                            onBlur={() => p.status === 'draft' && void saveLine(l.id)}
                          />
                          <span className="small muted">{l.unit === 'portions' ? 'portions' : l.unit}</span>
                        </div>
                      ) : (
                        qtyLabel(qty, l.unit)
                      )}
                      {changed && (
                        <div className="tiny muted">proposed {qtyLabel(l.originalQty, l.unit)}</div>
                      )}
                    </td>
                    <td className="small">
                      {l.recItemId ? (
                        <Link to={`${base}/recommendations/${l.recItemId}`}>{l.recTitle}</Link>
                      ) : (
                        l.recTitle
                      )}
                      {l.optionKey && (
                        <div className="tiny muted">
                          Option {l.optionKey}: {l.optionLabel}
                        </div>
                      )}
                    </td>
                    {editable && (
                      <td>
                        {p.status === 'draft' && (
                          <button
                            className="btn sm ghost"
                            onClick={() => void removeLine(l.id)}
                            aria-label={`Remove ${l.subjectName}`}
                          >
                            Remove
                          </button>
                        )}
                      </td>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Card>

      {canEdit && (
        <div className="row">
          {p.status === 'draft' && (
            <Button className="primary" busy={busy === 'submit'} onClick={() => act('submit')}>
              Submit for approval
            </Button>
          )}
          {p.status === 'awaiting_approval' && isApprover && (
            <>
              <Button className="primary" busy={busy === 'approve'} onClick={() => act('approve')}>
                <Icon.Check size={18} /> Approve{Object.keys(edits).length ? ' with edits' : ''}
              </Button>
              <button className="btn" onClick={() => setReasonFor('reject')}>
                Reject
              </button>
            </>
          )}
          {(p.status === 'draft' ||
            p.status === 'awaiting_approval' ||
            (p.status === 'approved' && isApprover)) && (
            <button className="btn ghost" onClick={() => setReasonFor('cancel')}>
              Cancel plan
            </button>
          )}
          {p.status === 'approved' && p.tasks.every((t) => t.status !== 'open') && (
            <Button busy={busy === 'complete'} onClick={() => act('complete')}>
              Mark completed
            </Button>
          )}
        </div>
      )}

      {p.tasks.length > 0 && (
        <Card
          title="Tasks"
          actions={
            <Link className="btn sm" to={`${base}/tasks`}>
              Open checklist
            </Link>
          }
        >
          <ul className="list">
            {p.tasks.map((t) => (
              <li key={t.id} className="list-item">
                <span className={`dot ${t.status === 'done' ? 'done' : ''}`}>
                  {t.status === 'done' && <Icon.Check size={12} />}
                </span>
                <div className="grow">
                  <div className="title small">{t.title}</div>
                  <div className="meta">
                    {t.status === 'open'
                      ? `Due ${formatDate(t.dueDate)}`
                      : `${t.status} ${t.completedBy ? `by ${t.completedBy}` : ''} ${formatDateTime(t.completedAt)}`}
                    {t.actualQty !== null && ` · actual ${qtyLabel(t.actualQty, t.unit)}`}
                    {t.notes && ` · ${t.notes}`}
                  </div>
                </div>
              </li>
            ))}
          </ul>
        </Card>
      )}

      <Card title="Approval history">
        <div className="card-body">
          <ol className="timeline">
            {p.history.map((h) => (
              <li key={h.id}>
                <div>
                  <strong>{h.action.replace('_', ' ')}</strong>
                  {h.fromStatus !== h.toStatus &&
                    ` (${h.fromStatus.replace('_', ' ')} → ${h.toStatus.replace('_', ' ')})`}{' '}
                  by {h.userName ?? '—'}
                  <div className="tiny muted">{formatDateTime(h.createdAt)}</div>
                  {h.reason && <div className="small">“{h.reason}”</div>}
                  {h.action === 'edit_line' && h.changes && (
                    <div className="small muted">
                      {String(h.changes.subject)}: {String(h.changes.from)} → {String(h.changes.to)}
                    </div>
                  )}
                </div>
              </li>
            ))}
          </ol>
        </div>
      </Card>

      {reasonFor && (
        <Dialog
          title={reasonFor === 'reject' ? 'Reject plan' : 'Cancel plan'}
          onClose={() => setReasonFor(null)}
          footer={
            <>
              <button className="btn ghost" onClick={() => setReasonFor(null)}>
                Back
              </button>
              <Button
                className="danger"
                busy={busy === reasonFor}
                disabled={!reason.trim()}
                onClick={() => act(reasonFor, { reason })}
              >
                {reasonFor === 'reject' ? 'Reject plan' : 'Cancel plan'}
              </Button>
            </>
          }
        >
          <TextArea label="Reason (required, recorded in history)" value={reason} onChange={setReason} />
          {reasonFor === 'cancel' && p.status === 'approved' && (
            <p className="small muted" style={{ marginTop: 8 }}>
              Open tasks will be cancelled. Completed tasks and their stock changes stay recorded.
            </p>
          )}
        </Dialog>
      )}
    </div>
  );
}

function purchaseNote(total: number | null, p: Plan) {
  const purchases = p.lines.filter((l) => l.type === 'purchase');
  if (!purchases.length)
    return (
      <span className="small muted">
        Approving creates tasks. It does not change stock, place orders or contact anyone.
      </span>
    );
  return (
    <span className="small">
      Estimated purchase cost: <strong>{total === null ? 'Unknown (cost missing)' : formatINR(total)}</strong>{' '}
      <Prov kind="estimate" /> — no order is placed automatically.
    </span>
  );
}
