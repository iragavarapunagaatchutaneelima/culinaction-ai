import { useState } from 'react';
import { Link } from 'react-router-dom';
import { post } from '../api';
import { formatDate, formatDateTime, qtyLabel, todayIST } from '../fmt';
import { useQuery } from '../hooks';
import { Icon } from '../icons';
import { useOutlet } from '../session';
import {
  Alert,
  Badge,
  Button,
  Card,
  Check,
  Dialog,
  Empty,
  ErrorState,
  Loading,
  PageHead,
  TextField,
  useToast,
} from '../ui';

interface Task {
  id: number;
  title: string;
  status: string;
  dueDate: string;
  targetQty: number | null;
  unit: string | null;
  actualQty: number | null;
  notes: string | null;
  completedAt: string | null;
  completedBy: string | null;
  planId: number;
  planTitle: string;
  type: string;
  subjectType: string;
  subjectId: number;
  subjectName: string;
  lineNote: string | null;
  outcomeId: number | null;
}

export function Tasks() {
  const { api, base } = useOutlet();
  const [tab, setTab] = useState<'open' | 'done' | 'all'>('open');
  const { data, error, loading, reload } = useQuery<Task[]>(`${api}/tasks?status=${tab}`);
  const [active, setActive] = useState<{ task: Task; mode: 'complete' | 'skip' } | null>(null);
  const today = todayIST();

  const groups = new Map<string, Task[]>();
  for (const t of data ?? []) groups.set(t.dueDate, [...(groups.get(t.dueDate) ?? []), t]);

  return (
    <div className="stack">
      <PageHead
        title="Prep & tasks"
        sub="Created only from approved plans. Record the actual quantity when done."
      />
      <div className="seg" role="group" aria-label="Show">
        <button aria-pressed={tab === 'open'} onClick={() => setTab('open')}>
          Open
        </button>
        <button aria-pressed={tab === 'done'} onClick={() => setTab('done')}>
          Done
        </button>
        <button aria-pressed={tab === 'all'} onClick={() => setTab('all')}>
          All
        </button>
      </div>
      {error ? (
        <ErrorState error={error} onRetry={reload} />
      ) : loading && !data ? (
        <Loading />
      ) : !data?.length ? (
        <Card>
          <Empty
            icon={<Icon.Tasks />}
            title={tab === 'open' ? 'No open tasks' : 'Nothing here yet'}
            action={
              <Link className="btn" to={`${base}/plans`}>
                View plans
              </Link>
            }
          >
            Tasks appear after an action plan is approved.
          </Empty>
        </Card>
      ) : (
        [...groups.entries()].map(([date, tasks]) => (
          <Card
            key={date}
            title={
              <h2>
                {date === today ? 'Today' : formatDate(date)}
                {date < today && tab === 'open' && (
                  <>
                    {' '}
                    <Badge kind="danger">Overdue</Badge>
                  </>
                )}
              </h2>
            }
          >
            <ul className="list">
              {tasks.map((t) => (
                <li key={t.id} className="list-item" style={{ alignItems: 'flex-start' }}>
                  <span className={`dot ${t.status === 'done' ? 'done' : ''}`} style={{ marginTop: 2 }}>
                    {t.status === 'done' && <Icon.Check size={12} />}
                  </span>
                  <div className="grow">
                    <div className="title">{t.title}</div>
                    <div className="meta">
                      <Link to={`${base}/plans/${t.planId}`}>{t.planTitle}</Link>
                      {t.lineNote && ` · ${t.lineNote}`}
                    </div>
                    {t.status !== 'open' && (
                      <div className="meta">
                        {t.status} {t.completedBy && `by ${t.completedBy}`} {formatDateTime(t.completedAt)}
                        {t.actualQty !== null && ` · actual ${qtyLabel(t.actualQty, t.unit)}`}
                        {t.notes && ` · ${t.notes}`}
                      </div>
                    )}
                    {t.status === 'done' && t.type === 'prep' && !t.outcomeId && (
                      <Link
                        className="btn sm"
                        style={{ marginTop: 8 }}
                        to={`${base}/outcomes?taskId=${t.id}&menuItemId=${t.subjectId}&prepared=${t.actualQty ?? ''}`}
                      >
                        Record service outcome
                      </Link>
                    )}
                    {t.outcomeId && <Badge kind="ok">Outcome recorded</Badge>}
                  </div>
                  {t.status === 'open' && (
                    <div className="row" style={{ flex: 'none' }}>
                      <button
                        className="btn sm primary"
                        aria-label={`Mark done: ${t.title}`}
                        onClick={() => setActive({ task: t, mode: 'complete' })}
                      >
                        Mark done
                      </button>
                      <button
                        className="btn sm ghost"
                        aria-label={`Skip: ${t.title}`}
                        onClick={() => setActive({ task: t, mode: 'skip' })}
                      >
                        Skip
                      </button>
                    </div>
                  )}
                </li>
              ))}
            </ul>
          </Card>
        ))
      )}
      {active && (
        <TaskDialog
          {...active}
          onClose={() => setActive(null)}
          onDone={() => {
            setActive(null);
            void reload();
          }}
        />
      )}
    </div>
  );
}

function TaskDialog({
  task,
  mode,
  onClose,
  onDone,
}: {
  task: Task;
  mode: 'complete' | 'skip';
  onClose: () => void;
  onDone: () => void;
}) {
  const { api, base } = useOutlet();
  const toast = useToast();
  const needsQty = mode === 'complete' && (task.type === 'prep' || task.type === 'count');
  const [qty, setQty] = useState(
    task.type === 'discard' && task.targetQty !== null ? String(task.targetQty) : '',
  );
  const [notes, setNotes] = useState('');
  const [qualityOk, setQualityOk] = useState(false);
  const [delayReason, setDelayReason] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [effects, setEffects] = useState<string[] | null>(null);

  const submit = async () => {
    setErr(null);
    if (needsQty && (qty.trim() === '' || Number.isNaN(Number(qty)) || Number(qty) < 0))
      return setErr('Enter the actual quantity.');
    if (mode === 'skip' && !notes.trim()) return setErr('Give a reason for skipping.');
    setBusy(true);
    try {
      const r = await post<{ effects: string[] }>(`${api}/tasks/${task.id}/${mode}`, {
        actualQty: qty.trim() === '' ? null : Number(qty),
        notes,
        qualityOk,
        delayReason: delayReason || null,
      });
      toast(mode === 'skip' ? 'Task skipped' : 'Task completed');
      if (r.effects.length || task.type === 'prep') setEffects(r.effects);
      else onDone();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (effects)
    return (
      <Dialog
        title="Task completed"
        onClose={onDone}
        footer={
          <>
            {task.type === 'prep' && (
              <Link
                className="btn"
                to={`${base}/outcomes?taskId=${task.id}&menuItemId=${task.subjectId}&prepared=${qty}`}
              >
                Record outcome now
              </Link>
            )}
            <button className="btn primary" onClick={onDone}>
              Close
            </button>
          </>
        }
      >
        <div className="stack-sm">
          {effects.map((e, i) => (
            <Alert key={i} kind="ok">
              {e}
            </Alert>
          ))}
          {task.type === 'prep' && (
            <p className="small">
              After service, record how many were sold, left over and discarded so the result can be measured.
            </p>
          )}
        </div>
      </Dialog>
    );

  const unitLabel = task.unit === 'portions' ? 'portions' : (task.unit ?? '');
  return (
    <Dialog
      title={mode === 'skip' ? 'Skip task' : 'Complete task'}
      onClose={onClose}
      footer={
        <>
          <button className="btn ghost" onClick={onClose}>
            Cancel
          </button>
          <Button className={mode === 'skip' ? 'danger' : 'primary'} busy={busy} onClick={submit}>
            {mode === 'skip' ? 'Skip task' : 'Mark done'}
          </Button>
        </>
      }
    >
      <div className="form">
        <p className="strong">{task.title}</p>
        {err && <Alert kind="danger">{err}</Alert>}
        {mode === 'complete' && task.type === 'discard' && (
          <Alert kind="warn">
            Completing this removes the quantity from stock and records it as waste (reason: expired) at the
            batch’s recorded cost.
          </Alert>
        )}
        {mode === 'complete' && task.type === 'purchase' && (
          <Alert kind="info">
            Marking this done does not add stock. Record a receipt in Inventory when the delivery arrives.
          </Alert>
        )}
        {mode === 'complete' &&
          (task.type === 'prep' ||
            task.type === 'count' ||
            task.type === 'discard' ||
            task.type === 'purchase') && (
            <TextField
              label={
                task.type === 'prep'
                  ? `Portions actually prepared (planned ${task.targetQty})`
                  : task.type === 'count'
                    ? `Counted quantity (${unitLabel})`
                    : task.type === 'discard'
                      ? `Quantity removed (${unitLabel})`
                      : `Quantity bought (${unitLabel}, optional)`
              }
              inputMode="decimal"
              value={qty}
              onChange={setQty}
              required={needsQty}
              hint={
                task.type === 'count'
                  ? `Recorded: ${qtyLabel(task.targetQty, task.unit)}. Enter what you physically count, in ${unitLabel}.`
                  : undefined
              }
            />
          )}
        {mode === 'complete' && task.type === 'verify' && task.subjectType === 'batch' && (
          <Check
            label="Checked today and acceptable (storage / quality)"
            checked={qualityOk}
            onChange={setQualityOk}
            hint="Only tick after inspecting storage and condition per your procedures. If not acceptable, record it as waste instead."
          />
        )}
        {mode === 'complete' && (task.type === 'order_action' || task.type === 'dispose_order') && (
          <TextField
            label="Delay reason to record on the order (optional)"
            value={delayReason}
            onChange={setDelayReason}
            placeholder="e.g. Rider arrived late"
          />
        )}
        {mode === 'complete' && task.type === 'dispose_order' && (
          <Alert kind="warn">
            Completing this records the order’s food as waste (cancelled / uncollected / returned) at the
            recipe cost estimate and closes the order.
          </Alert>
        )}
        <TextField
          label={mode === 'skip' ? 'Reason' : 'Notes (optional)'}
          value={notes}
          onChange={setNotes}
          required={mode === 'skip'}
        />
      </div>
    </Dialog>
  );
}
