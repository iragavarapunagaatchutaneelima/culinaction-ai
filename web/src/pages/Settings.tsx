import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { del, post, put } from '../api';
import { formatDateTime } from '../fmt';
import { useForm, useQuery } from '../hooks';
import { Icon } from '../icons';
import { useOutlet, useSession, type Outlet } from '../session';
import {
  Alert,
  Badge,
  Button,
  Card,
  Dialog,
  downloadUrl,
  FormError,
  KV,
  Loading,
  PageHead,
  SelectField,
  TextField,
  useToast,
} from '../ui';
import { formToOutlet, OutletFields, outletToForm, validateOutlet } from './Outlets';

export function Settings() {
  const { api, outlet, isOwner, canEdit, reloadOutlet } = useOutlet();
  const { refresh } = useSession();
  const toast = useToast();
  const f = useForm(outletToForm(outlet));
  const ai = useQuery<{
    configured: boolean;
    provider: string | null;
    model: string | null;
    reason: string;
    last: null | { lastCheckedAt: string; lastResult: string; lastError: string | null };
  }>(`${api}/ai/status`);

  const save = (e: React.FormEvent) => {
    e.preventDefault();
    void f.submit(async (v) => {
      await put<Outlet>(api, formToOutlet(v));
      await reloadOutlet();
      await refresh();
      toast('Settings saved');
    }, validateOutlet);
  };

  return (
    <div className="stack">
      <PageHead
        title="Settings & data"
        sub={`You are ${outlet.role === 'owner' ? 'the owner' : `a ${outlet.role}`} of this outlet.`}
      />

      <form onSubmit={save} noValidate>
        <Card
          title="Outlet profile & decision rules"
          foot={
            isOwner ? (
              <Button className="primary" type="submit" busy={f.submitting}>
                Save settings
              </Button>
            ) : (
              <span className="small muted">Only the owner can change settings.</span>
            )
          }
        >
          <div className="card-body stack">
            <FormError message={f.formError} />
            <fieldset disabled={!isOwner} style={{ border: 0, padding: 0, margin: 0 }}>
              <OutletFields f={f} advanced />
            </fieldset>
            <KV
              items={[
                ['Currency', '₹ INR'],
                ['Timezone', 'Asia/Kolkata'],
                ['Date format', 'DD/MM/YYYY'],
              ]}
            />
          </div>
        </Card>
      </form>

      <Card title="AI explanation provider">
        <div className="card-body stack-sm">
          {ai.loading && !ai.data ? (
            <Loading />
          ) : ai.data?.configured ? (
            <>
              <div className="row">
                <Badge kind="info">
                  Configured — {ai.data.provider}, {ai.data.model}
                </Badge>
              </div>
              <p className="small muted">{ai.data.reason}</p>
            </>
          ) : (
            <Alert kind="info">
              Not configured. {ai.data?.reason} To enable, set <code>ANTHROPIC_API_KEY</code> (and optionally{' '}
              <code>AI_MODEL</code>) in the server’s <code>.env</code> file and restart. The key stays on the
              server.
            </Alert>
          )}
          {ai.data?.last && (
            <p className="small">
              Last request {formatDateTime(ai.data.last.lastCheckedAt)}:{' '}
              {ai.data.last.lastResult === 'ok' ? (
                <Badge kind="ok">Succeeded</Badge>
              ) : (
                <Badge kind="danger">{ai.data.last.lastResult.replace('_', ' ')}</Badge>
              )}
              {ai.data.last.lastError && <span className="muted"> — {ai.data.last.lastError}</span>}
            </p>
          )}
          <p className="tiny muted">
            The decision engine never depends on AI. All quantities, costs and safety checks are calculated by
            fixed rules.
          </p>
        </div>
      </Card>

      {isOwner && <Members />}

      <Card title="Export your data">
        <div className="card-body stack-sm">
          <p className="small muted">
            Download your records at any time. CSV files are protected against spreadsheet formula injection.
          </p>
          <div className="row">
            <a className="btn sm" href={downloadUrl(`${api}/export/inventory.csv`)}>
              <Icon.Download size={16} /> Inventory
            </a>
            <a className="btn sm" href={downloadUrl(`${api}/export/sales.csv`)}>
              <Icon.Download size={16} /> Sales
            </a>
            <a className="btn sm" href={downloadUrl(`${api}/export/waste.csv`)}>
              <Icon.Download size={16} /> Waste
            </a>
            <a className="btn sm" href={downloadUrl(`${api}/export/outcomes.csv`)}>
              <Icon.Download size={16} /> Outcomes
            </a>
            {canEdit && (
              <a className="btn sm" href={downloadUrl(`${api}/export/all.json`)}>
                <Icon.Download size={16} /> Everything (JSON)
              </a>
            )}
          </div>
        </div>
      </Card>

      {canEdit && <AuditLog />}

      {isOwner && <DangerZone />}

      <Card title="About this installation">
        <div className="card-body small stack-sm">
          <p>
            Data is stored in a SQLite database on the server running CulinAction. There is no cloud sync.
            Back up the database file regularly.
          </p>
          <p>
            CulinAction applies the dates and flags you record; it does not certify food safety or regulatory
            compliance. Follow your FSSAI-compliant procedures.
          </p>
        </div>
      </Card>
    </div>
  );
}

function Members() {
  const { api } = useOutlet();
  const toast = useToast();
  const { data, reload } = useQuery<{ id: number; username: string; displayName: string; role: string }[]>(
    `${api}/members`,
  );
  const [adding, setAdding] = useState(false);
  const f = useForm({ username: '', displayName: '', role: 'staff', password: '' });
  const submit = () =>
    void f.submit(async (v) => {
      await post(`${api}/members`, { ...v, password: v.password || undefined });
      toast('Team member added');
      setAdding(false);
      f.setValues({ username: '', displayName: '', role: 'staff', password: '' });
      void reload();
    });
  return (
    <Card
      title="Team"
      actions={
        <button className="btn sm" onClick={() => setAdding(true)}>
          <Icon.Plus size={16} /> Add member
        </button>
      }
    >
      <ul className="list">
        {data?.map((m) => (
          <li key={m.id} className="list-item">
            <div className="grow">
              <div className="title">{m.displayName}</div>
              <div className="meta">@{m.username}</div>
            </div>
            <Badge kind={m.role === 'owner' ? 'info' : 'outline'}>{m.role}</Badge>
            {m.role !== 'owner' && (
              <button
                className="btn sm ghost"
                onClick={async () => {
                  if (!window.confirm(`Remove ${m.displayName} from this outlet?`)) return;
                  try {
                    await del(`${api}/members/${m.id}`);
                    void reload();
                  } catch (e) {
                    toast((e as Error).message, 'error');
                  }
                }}
              >
                Remove
              </button>
            )}
          </li>
        ))}
      </ul>
      <div className="card-foot small muted">
        Managers can maintain records and plans. Staff can view records, record waste and outcomes, and
        complete tasks. Permissions are enforced by the server.
      </div>
      {adding && (
        <Dialog
          title="Add team member"
          onClose={() => setAdding(false)}
          footer={
            <>
              <button className="btn ghost" onClick={() => setAdding(false)}>
                Cancel
              </button>
              <Button className="primary" busy={f.submitting} onClick={submit}>
                Add
              </Button>
            </>
          }
        >
          <div className="form">
            <FormError message={f.formError} />
            <TextField
              label="Username"
              value={f.values.username}
              onChange={(v) => f.set('username', v)}
              error={f.errors.username}
              required
              autoComplete="off"
            />
            <TextField
              label="Name"
              value={f.values.displayName}
              onChange={(v) => f.set('displayName', v)}
              error={f.errors.displayName}
              required
            />
            <SelectField
              label="Role"
              value={f.values.role}
              onChange={(v) => f.set('role', v)}
              options={[
                { value: 'manager', label: 'Manager' },
                { value: 'staff', label: 'Staff' },
              ]}
            />
            <TextField
              label="Temporary password"
              type="password"
              value={f.values.password}
              onChange={(v) => f.set('password', v)}
              error={f.errors.password}
              autoComplete="new-password"
              hint="At least 8 characters. Not needed if the username already exists on this server."
            />
          </div>
        </Dialog>
      )}
    </Card>
  );
}

function AuditLog() {
  const { api } = useOutlet();
  const [open, setOpen] = useState(false);
  const { data, loading } = useQuery<
    {
      id: number;
      entityType: string;
      entityId: number | null;
      action: string;
      createdAt: string;
      userName: string | null;
    }[]
  >(open ? `${api}/audit` : null);
  return (
    <Card
      title="Audit log"
      actions={
        <button className="btn sm" onClick={() => setOpen((o) => !o)}>
          {open ? 'Hide' : 'Show'}
        </button>
      }
    >
      {open &&
        (loading && !data ? (
          <Loading />
        ) : (
          <div className="table-wrap" style={{ maxHeight: 360, overflowY: 'auto' }}>
            <table className="table">
              <thead>
                <tr>
                  <th>When</th>
                  <th>Who</th>
                  <th>What</th>
                </tr>
              </thead>
              <tbody>
                {data?.map((e) => (
                  <tr key={e.id}>
                    <td className="small nowrap">{formatDateTime(e.createdAt)}</td>
                    <td className="small">{e.userName ?? '—'}</td>
                    <td className="small">
                      {e.action} {e.entityType.replace('_', ' ')}
                      {e.entityId ? ` #${e.entityId}` : ''}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ))}
    </Card>
  );
}

function DangerZone() {
  const { api, outlet } = useOutlet();
  const { refresh } = useSession();
  const nav = useNavigate();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  return (
    <Card title="Delete outlet" tone="danger">
      <div className="card-body stack-sm">
        <p className="small">
          Permanently deletes this outlet and all of its records. Export your data first. This cannot be
          undone.
        </p>
        <div>
          <button className="btn sm" onClick={() => setOpen(true)}>
            Delete this outlet…
          </button>
        </div>
      </div>
      {open && (
        <Dialog
          title="Delete outlet permanently"
          onClose={() => setOpen(false)}
          footer={
            <>
              <button className="btn ghost" onClick={() => setOpen(false)}>
                Cancel
              </button>
              <Button
                className="danger"
                busy={busy}
                disabled={name !== outlet.name}
                onClick={async () => {
                  setBusy(true);
                  try {
                    await del(api, { confirmName: name });
                    await refresh();
                    toast('Outlet deleted');
                    nav('/');
                  } catch (e) {
                    toast((e as Error).message, 'error');
                    setBusy(false);
                  }
                }}
              >
                Delete permanently
              </Button>
            </>
          }
        >
          <TextField
            label={`Type “${outlet.name}” to confirm`}
            value={name}
            onChange={setName}
            autoComplete="off"
          />
        </Dialog>
      )}
    </Card>
  );
}
