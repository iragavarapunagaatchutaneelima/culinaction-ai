import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { post } from '../api';
import { OUTLET_TYPE_LABELS } from '../fmt';
import { Icon, Logo } from '../icons';
import { useOutlet, useSession } from '../session';
import { ThemeToggle } from '../theme';
import { Alert, Button, Card, Loading, PageHead, useToast } from '../ui';

/** /demo — starts (or resumes) this visitor's demo sandbox, then lets them pick an outlet. */
export function DemoEntry() {
  const s = useSession();
  const nav = useNavigate();
  const [err, setErr] = useState<string | null>(null);
  const started = useRef(false);

  useEffect(() => {
    if (s.status !== 'signed_out' || started.current) return;
    started.current = true;
    post('/demo/start')
      .then(() => s.refresh())
      .catch((e) => setErr((e as Error).message));
  }, [s]);

  if (err)
    return (
      <div className="main" style={{ maxWidth: 640 }}>
        <Alert kind="danger">Could not start the demo: {err}</Alert>
        <p style={{ marginTop: 12 }}>
          <Link to="/">Back to the home page</Link>
        </p>
      </div>
    );
  if (s.status !== 'signed_in') return <Loading label="Preparing four fictional demo outlets…" />;

  return (
    <div className="main" style={{ maxWidth: 820, paddingBottom: 48 }}>
      <div className="spread" style={{ marginBottom: 16 }}>
        <Link to="/" className="brandmark" style={{ color: 'var(--ink)', fontSize: '1.1rem' }}>
          <Logo /> CulinAction AI
        </Link>
        <ThemeToggle compact />
      </div>
      <div className="demo-bar" style={{ borderRadius: 10, marginBottom: 16 }} role="note">
        <span className="demo-pill">DEMO MODE</span>
        <span className="demo-text">
          Fictional outlets with generated sample data. Nothing here is a real restaurant, a live integration
          or a real result.
        </span>
      </div>
      <PageHead
        title="Choose a demo outlet"
        sub="Each outlet has its own stock, recipes, 4 weeks of sales, delivery orders and waste history. Start with the guided scenarios."
      />
      <div className="grid-2">
        {s.outlets.map((o) => (
          <Card key={o.id}>
            <div className="card-body stack-sm">
              <div
                className="tiny muted strong"
                style={{ textTransform: 'uppercase', letterSpacing: '0.06em' }}
              >
                {OUTLET_TYPE_LABELS[o.outletType] ?? o.outletType}
              </div>
              <h2>{o.name}</h2>
              <div className="row">
                <button className="btn primary sm" onClick={() => nav(`/demo/o/${o.id}/scenarios`)}>
                  <Icon.Spark size={16} /> Guided scenarios
                </button>
                <button className="btn sm" onClick={() => nav(`/demo/o/${o.id}/today`)}>
                  Open dashboard
                </button>
              </div>
            </div>
          </Card>
        ))}
      </div>
      <p className="muted small" style={{ marginTop: 16 }}>
        Your demo is private to this browser and expires after 24 hours. Use “Reset demo” in the orange bar to
        start over at any time. <Link to="/app">Use the real application instead</Link>.
      </p>
    </div>
  );
}

interface Scenario {
  n: number;
  title: string;
  shows: string;
  expect: string;
  outletType: string | null; // preferred outlet, null = current
}

const SCENARIOS: Scenario[] = [
  {
    n: 1,
    title: 'Excess biryani preparation',
    shows:
      'Recorded outcomes show more Chicken Dum Biryani prepared than sold. The engine compares preparation quantities against the sales history and recipe cost.',
    expect:
      'A “Prepare fewer” recommendation with three options, the outcome history as evidence and the ingredient cost of over-preparation (estimate).',
    outletType: 'biryani',
  },
  {
    n: 2,
    title: 'Ingredient approaching its use-by date',
    shows:
      'Fresh cream at the bakery has a recorded use-by date tomorrow and its storage has not been confirmed.',
    expect:
      'Affected recipes, the quantity at risk (FIFO), options to prioritise, reduce purchasing or re-check — and a mandatory storage check before use.',
    outletType: 'bakery',
  },
  {
    n: 3,
    title: 'Cancelled / uncollected order',
    shows:
      'A simulated packed order is marked not collected. The app inspects its timeline and the verified handling limit.',
    expect:
      'A disposition decision: record disposal, or hold only until the verified limit. Resale or donation is never suggested.',
    outletType: null,
  },
  {
    n: 4,
    title: 'Delivery pickup delay',
    shows: 'A simulated order has been ready for 26 minutes without pickup.',
    expect:
      'The order timeline, measured waits, the risk level with each contributing factor, and actions to approve (alert staff, record reason, manager review).',
    outletType: null,
  },
  {
    n: 5,
    title: 'What-if preparation simulator',
    shows:
      'Compare preparation quantities for a dish against usable stock and the comparable days in its sales history.',
    expect:
      'Ingredient use, remaining stock, shortfalls and how often each quantity would have run short or left a surplus.',
    outletType: 'biryani',
  },
  {
    n: 6,
    title: 'Outcome verification',
    shows: 'A completed plan from the demo history (Upma at the tiffin outlet) and any plans you approve.',
    expect:
      'Planned vs prepared vs sold vs discarded, compared with earlier services — labelled as an observation, not proven savings.',
    outletType: 'tiffin',
  },
];

export function Scenarios() {
  const { outlet } = useOutlet();
  const s = useSession();
  const nav = useNavigate();
  const toast = useToast();
  const [busy, setBusy] = useState<number | null>(null);

  const start = async (sc: Scenario) => {
    const target =
      (sc.outletType && s.outlets.find((o) => o.outletType === sc.outletType)) ||
      s.outlets.find((o) => o.id === outlet.id)!;
    setBusy(sc.n);
    try {
      const r = await post<{ navigate: string; message: string }>(
        `/outlets/${target.id}/demo/scenarios/${sc.n}`,
      );
      toast(r.message);
      nav(`/demo/o/${target.id}/${r.navigate}`);
    } catch (e) {
      toast((e as Error).message, 'error');
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="stack">
      <PageHead
        title="Guided demo scenarios"
        sub="Each scenario uses the fictional demo data. Triggered events (new orders, delays) are simulated and labelled — they are not live data."
      />
      <div className="scenario-grid">
        {SCENARIOS.map((sc) => {
          const target = sc.outletType ? s.outlets.find((o) => o.outletType === sc.outletType) : null;
          return (
            <Card key={sc.n} className="scenario">
              <div className="card-body stack-sm">
                <div className="row" style={{ gap: 10, flexWrap: 'nowrap', alignItems: 'flex-start' }}>
                  <span className="scenario-n">{sc.n}</span>
                  <div style={{ minWidth: 0 }}>
                    <h2>{sc.title}</h2>
                    <div className="tiny muted">
                      {target ? `Opens in ${target.name}` : `Runs in ${outlet.name}`}
                    </div>
                  </div>
                </div>
                <p className="small">{sc.shows}</p>
                <p className="small muted">
                  <strong>Expected:</strong> {sc.expect}
                </p>
                <div>
                  <Button className="primary sm" busy={busy === sc.n} onClick={() => void start(sc)}>
                    Start scenario {sc.n}
                  </Button>
                </div>
              </div>
            </Card>
          );
        })}
      </div>
      <Card title="Suggested end-to-end walkthrough">
        <ol className="card-body small walkthrough">
          <li>
            Start scenario 1 → choose option A → <em>Create draft plan</em> → <em>Submit</em> →{' '}
            <em>Approve</em>.
          </li>
          <li>
            Open <em>Kitchen tasks</em> → mark the preparation task done with the actual quantity.
          </li>
          <li>
            Choose <em>Record outcome now</em> → enter sold / transferred / discarded portions → save.
          </li>
          <li>
            Open <em>Outcome verification</em> and <em>Analytics</em> to see the recorded result next to
            earlier services.
          </li>
          <li>
            Start scenario 4 → review the timeline and risk factors → add an action plan → record the pickup
            event.
          </li>
        </ol>
      </Card>
    </div>
  );
}
