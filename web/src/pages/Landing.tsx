import { Link } from 'react-router-dom';
import { Icon, Logo } from '../icons';
import { ThemeToggle } from '../theme';

const STEPS = [
  { t: 'Your records', d: 'Stock batches, verified recipes, sales, order timelines' },
  { t: 'Risk detected', d: 'Surplus, expiry, shortage, pickup delay, uncollected food' },
  { t: 'Evidence & options', d: 'The calculation, the records used and 2–3 feasible choices' },
  { t: 'Human approval', d: 'An owner or manager approves, edits or rejects' },
  { t: 'Kitchen action', d: 'Approved plans become tasks; nothing is sent automatically' },
  { t: 'Outcome verified', d: 'What actually happened is recorded and compared' },
];

const FEATURES: [keyof typeof Icon, string, string][] = [
  [
    'Stock',
    'Batch-level inventory',
    'Use-by, expiry and best-before stored as printed. Unsafe or unchecked stock is never counted as usable.',
  ],
  [
    'Menu',
    'Recipe-aware maths',
    'Shared ingredients, preparation loss and cost per portion from your own verified recipes.',
  ],
  [
    'Delivery',
    'Delivery timelines',
    'Prep → pack → ready → pickup → delivered, with waits measured only from recorded times.',
  ],
  [
    'Alert',
    'Quality-risk rules',
    'Recorded holding times compared with handling limits you verified. No guessed temperatures.',
  ],
  [
    'Sliders',
    'What-if simulator',
    'Try preparation and purchase quantities against your own sales history before committing.',
  ],
  [
    'Outcome',
    'Outcome verification',
    'Approved actions are compared with what was recorded afterwards — estimates stay labelled.',
  ],
];

export function Landing() {
  return (
    <div className="landing">
      <header className="lp-header">
        <Link to="/" className="lp-brand" aria-label="CulinAction AI home">
          <Logo size={30} /> <span>CulinAction AI</span>
        </Link>
        <nav className="lp-nav" aria-label="Page sections">
          <a href="#how">How it works</a>
          <a href="#modes">Demo vs real</a>
          <a href="#features">Features</a>
          <a href="#trust">Data integrity</a>
        </nav>
        <div className="lp-header-actions">
          <ThemeToggle compact />
          <Link className="btn sm" to="/app">
            Sign in
          </Link>
        </div>
      </header>

      <main id="main">
        <section className="lp-hero">
          <div className="lp-hero-copy">
            <p className="lp-kicker">Restaurant operations intelligence · Hyderabad-first</p>
            <h1 className="lp-title">Smarter kitchen decisions. Less avoidable waste.</h1>
            <p className="lp-lead">
              CulinAction connects two problems most kitchens track separately —{' '}
              <strong>food that gets wasted</strong> and{' '}
              <strong>food that waits too long before it reaches the customer</strong>. It reads your own
              records, shows the evidence and the options, lets a person decide, and then checks what actually
              happened.
            </p>
            <div className="lp-cta">
              <Link className="btn primary lg" to="/demo">
                <Icon.Spark size={18} /> Explore interactive demo
              </Link>
              <Link className="btn lg" to="/app">
                Use real application
              </Link>
            </div>
            <p className="lp-small">
              The demo needs no account and uses clearly labelled fictional outlets. The real application
              requires sign-in.
            </p>
          </div>
          <div className="lp-hero-art" aria-hidden="true">
            <HeroDiagram />
          </div>
        </section>

        <section id="how" className="lp-section">
          <h2 className="lp-h2">One loop for waste and delivery quality</h2>
          <p className="lp-sub">
            Every recommendation follows the same path, and every number on the way can be traced back to a
            record.
          </p>
          <ol className="lp-steps">
            {STEPS.map((s, i) => (
              <li key={s.t}>
                <span className="lp-step-n">{i + 1}</span>
                <div>
                  <h3>{s.t}</h3>
                  <p>{s.d}</p>
                </div>
              </li>
            ))}
          </ol>
        </section>

        <section id="modes" className="lp-section">
          <h2 className="lp-h2">Two separate modes</h2>
          <div className="lp-modes">
            <div className="lp-mode card">
              <div className="lp-mode-tag demo">Demo Mode</div>
              <h3>Explore with fictional outlets</h3>
              <ul>
                <li>No account needed — opens instantly</li>
                <li>Four fictional Hyderabad outlets: biryani, tiffin, café, bakery</li>
                <li>
                  Six guided scenarios: surplus, expiry, uncollected order, pickup delay, what-if, outcome
                  verification
                </li>
                <li>Every record is generated sample data and labelled as such; reset any time</li>
                <li>Kept apart from real data by the server, not just the screen</li>
              </ul>
              <Link className="btn primary" to="/demo">
                Open the demo
              </Link>
            </div>
            <div className="lp-mode card">
              <div className="lp-mode-tag real">Real Mode</div>
              <h3>Run your own kitchen</h3>
              <ul>
                <li>Secure sign-in; roles for owner, manager and staff</li>
                <li>Starts empty — you add your own stock, recipes, sales and orders</li>
                <li>Every change stored in the database with an audit trail</li>
                <li>Server-side permission checks for every outlet</li>
                <li>Export your data at any time</li>
              </ul>
              <Link className="btn" to="/app">
                Sign in or create the owner account
              </Link>
            </div>
          </div>
        </section>

        <section id="features" className="lp-section">
          <h2 className="lp-h2">What it does</h2>
          <div className="lp-features">
            {FEATURES.map(([icon, t, d]) => {
              const I = Icon[icon];
              return (
                <div key={t} className="lp-feature">
                  <span className="lp-feature-icon">
                    <I size={22} />
                  </span>
                  <h3>{t}</h3>
                  <p>{d}</p>
                </div>
              );
            })}
          </div>
        </section>

        <section id="trust" className="lp-section lp-trust card">
          <h2 className="lp-h2">Privacy and data integrity</h2>
          <div className="lp-trust-grid">
            <div>
              <h3>Your numbers, not ours</h3>
              <p>
                Calculations use only the records you enter or import. Missing data is reported as missing —
                never filled in with guesses.
              </p>
            </div>
            <div>
              <h3>Safety is a rule, not a score</h3>
              <p>
                Expired, unsafe or unchecked stock is never proposed for use. Customer-returned food is never
                offered to another customer.
              </p>
            </div>
            <div>
              <h3>AI explains, it doesn’t decide</h3>
              <p>
                An optional AI model can rewrite a calculation in plain words. Its output is checked; numbers
                always come from the deterministic engine.
              </p>
            </div>
            <div>
              <h3>No hidden integrations</h3>
              <p>
                No orders are placed, no messages sent and no platform is contacted. Approved actions become
                tasks for your team.
              </p>
            </div>
          </div>
        </section>
      </main>

      <footer className="lp-footer">
        <span>
          CulinAction AI — decision support for restaurants and cafés. Not a substitute for your
          FSSAI-compliant food-safety procedures.
        </span>
        <span>
          <Link to="/demo">Demo</Link> · <Link to="/app">Real application</Link>
        </span>
      </footer>
    </div>
  );
}

/** Two problem lanes converging into the decision loop (decorative; described in text above). */
function HeroDiagram() {
  return (
    <svg viewBox="0 0 420 360" className="lp-diagram">
      <defs>
        <marker
          id="arr"
          viewBox="0 0 10 10"
          refX="9"
          refY="5"
          markerWidth="7"
          markerHeight="7"
          orient="auto-start-reverse"
        >
          <path d="M0 0L10 5L0 10z" fill="var(--ink-3)" />
        </marker>
      </defs>
      <g className="lp-d-lane">
        <rect
          x="10"
          y="20"
          width="170"
          height="74"
          rx="14"
          fill="var(--accent-soft)"
          stroke="var(--accent)"
        />
        <text x="26" y="48" className="lp-d-h">
          Food waste
        </text>
        <text x="26" y="70" className="lp-d-t">
          surplus · expiry · cancelled
        </text>
        <text x="26" y="86" className="lp-d-t">
          & uncollected orders
        </text>
      </g>
      <g className="lp-d-lane">
        <rect x="240" y="20" width="170" height="74" rx="14" fill="var(--info-bg)" stroke="var(--info)" />
        <text x="256" y="48" className="lp-d-h">
          Delivery quality
        </text>
        <text x="256" y="70" className="lp-d-t">
          prep · pack · pickup wait
        </text>
        <text x="256" y="86" className="lp-d-t">
          & hold time vs limits
        </text>
      </g>
      <path
        d="M95 96 C 95 130, 200 120, 205 150"
        fill="none"
        stroke="var(--ink-3)"
        strokeWidth="1.6"
        markerEnd="url(#arr)"
      />
      <path
        d="M325 96 C 325 130, 220 120, 215 150"
        fill="none"
        stroke="var(--ink-3)"
        strokeWidth="1.6"
        markerEnd="url(#arr)"
      />
      <rect x="110" y="156" width="200" height="60" rx="14" fill="var(--brand)" />
      <text x="210" y="182" textAnchor="middle" className="lp-d-h lp-d-inv">
        Evidence-backed options
      </text>
      <text x="210" y="202" textAnchor="middle" className="lp-d-t lp-d-inv">
        calculation · records · trade-offs
      </text>
      <path d="M210 218 L210 244" stroke="var(--ink-3)" strokeWidth="1.6" markerEnd="url(#arr)" />
      <g>
        {[
          ['Approve', 30],
          ['Act', 160],
          ['Verify', 290],
        ].map(([t, x]) => (
          <g key={t as string}>
            <rect
              x={x as number}
              y="250"
              width="100"
              height="44"
              rx="12"
              fill="var(--surface)"
              stroke="var(--line-strong)"
            />
            <text x={(x as number) + 50} y="277" textAnchor="middle" className="lp-d-h">
              {t}
            </text>
          </g>
        ))}
        <path d="M132 272 L156 272" stroke="var(--ink-3)" strokeWidth="1.6" markerEnd="url(#arr)" />
        <path d="M262 272 L286 272" stroke="var(--ink-3)" strokeWidth="1.6" markerEnd="url(#arr)" />
        <path
          d="M340 296 C 340 340, 80 340, 80 296"
          fill="none"
          stroke="var(--brand-2)"
          strokeWidth="1.6"
          strokeDasharray="4 4"
          markerEnd="url(#arr)"
        />
        <text x="210" y="352" textAnchor="middle" className="lp-d-t">
          recorded outcomes improve the next decision
        </text>
      </g>
    </svg>
  );
}
