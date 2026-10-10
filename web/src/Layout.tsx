import { useCallback, useEffect, useState } from 'react';
import { Link, NavLink, Outlet as RouterOutlet, useLocation, useParams } from 'react-router-dom';
import { get } from './api';
import { Icon, Logo } from './icons';
import { OutletProvider, useSession, type Outlet } from './session';
import { ErrorState, Loading } from './ui';

const NAV = [
  {
    group: 'Daily',
    items: [
      { to: 'today', label: 'Today', icon: Icon.Today },
      { to: 'tasks', label: 'Prep & tasks', icon: Icon.Tasks },
      { to: 'recommendations', label: 'Recommendations', icon: Icon.Decide },
      { to: 'plans', label: 'Action plans', icon: Icon.Plan },
    ],
  },
  {
    group: 'Records',
    items: [
      { to: 'inventory', label: 'Inventory', icon: Icon.Stock },
      { to: 'menu', label: 'Menu & recipes', icon: Icon.Menu },
      { to: 'sales', label: 'Sales', icon: Icon.Sales },
      { to: 'outcomes', label: 'Service outcomes', icon: Icon.Outcome },
      { to: 'waste', label: 'Waste log', icon: Icon.Waste },
      { to: 'movements', label: 'Stock movements', icon: Icon.History },
    ],
  },
  {
    group: 'Review',
    items: [
      { to: 'analytics', label: 'Analytics', icon: Icon.Chart },
      { to: 'settings', label: 'Settings & export', icon: Icon.Settings },
    ],
  },
];

const BOTTOM = [
  { to: 'today', label: 'Today', icon: Icon.Today },
  { to: 'inventory', label: 'Stock', icon: Icon.Stock },
  { to: 'recommendations', label: 'Decide', icon: Icon.Decide },
  { to: 'tasks', label: 'Tasks', icon: Icon.Tasks },
];

export function OutletLayout() {
  const { oid } = useParams();
  const { user, logout } = useSession();
  const [outlet, setOutlet] = useState<Outlet | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [more, setMore] = useState(false);
  const loc = useLocation();

  const load = useCallback(async () => {
    try {
      setError(null);
      setOutlet(await get<Outlet>(`/outlets/${oid}`));
    } catch (e) {
      setError(e as Error);
    }
  }, [oid]);
  useEffect(() => {
    void load();
  }, [load]);
  useEffect(() => setMore(false), [loc.pathname]);

  if (error)
    return (
      <div className="main">
        <ErrorState error={error} onRetry={load} />
        <p style={{ marginTop: 12 }}>
          <Link to="/">Back to my outlets</Link>
        </p>
      </div>
    );
  if (!outlet) return <Loading />;

  const base = `/o/${outlet.id}`;
  const navList = (
    <ul className="navlist">
      {NAV.map((g) => (
        <li key={g.group}>
          <div className="group-label">{g.group}</div>
          <ul className="navlist">
            {g.items.map((i) => (
              <li key={i.to}>
                <NavLink to={`${base}/${i.to}`}>
                  <i.icon /> {i.label}
                </NavLink>
              </li>
            ))}
          </ul>
        </li>
      ))}
      <li>
        <div className="group-label">Account</div>
        <Link
          to="/"
          className=""
          style={{
            display: 'flex',
            gap: 12,
            padding: '12px 14px',
            color: 'var(--ink-2)',
            textDecoration: 'none',
            fontWeight: 500,
          }}
        >
          <Icon.Store /> Switch outlet
        </Link>
        <button
          onClick={() => void logout()}
          style={{
            display: 'flex',
            gap: 12,
            padding: '12px 14px',
            width: '100%',
            background: 'none',
            border: 0,
            color: 'var(--ink-2)',
            font: '500 0.95rem var(--font)',
            cursor: 'pointer',
          }}
        >
          <Icon.Logout /> Sign out ({user?.displayName})
        </button>
      </li>
    </ul>
  );

  return (
    <OutletProvider
      value={{
        outlet,
        base,
        api: `/outlets/${outlet.id}`,
        canEdit: outlet.role !== 'staff',
        isOwner: outlet.role === 'owner',
        reloadOutlet: load,
      }}
    >
      <div className="shell">
        <nav className="sidebar" aria-label="Main">
          <Link to={`${base}/today`} className="brandmark">
            <Logo /> CulinAction AI
          </Link>
          {navList}
        </nav>
        <div style={{ minWidth: 0 }}>
          <header className="topbar">
            <Link to={`${base}/today`} className="brandmark" aria-label="CulinAction home">
              <Logo size={24} />
            </Link>
            <div className="outlet-name" title={outlet.name}>
              {outlet.name}
              <span className="tiny" style={{ opacity: 0.75, fontWeight: 400, marginLeft: 8 }}>
                {outlet.role}
              </span>
            </div>
            <Link to="/" className="btn ghost sm" style={{ minHeight: 36 }}>
              Switch
            </Link>
          </header>
          {outlet.isIllustrative && (
            <div className="illustrative-banner" role="note">
              Illustrative workspace — every record here is synthetic sample data created for demonstration.
              It is not a real restaurant and no result here is a real-world outcome.
            </div>
          )}
          <main className="main" id="main">
            <RouterOutlet />
          </main>
        </div>
        <nav className="bottomnav" aria-label="Main">
          {BOTTOM.map((i) => (
            <NavLink key={i.to} to={`${base}/${i.to}`}>
              <i.icon size={22} />
              {i.label}
            </NavLink>
          ))}
          <button onClick={() => setMore(true)} aria-haspopup="dialog" aria-expanded={more}>
            <Icon.More size={22} />
            More
          </button>
        </nav>
        {more && (
          <>
            <div className="sheet-backdrop" onClick={() => setMore(false)} />
            <div className="sheet" role="dialog" aria-modal="true" aria-label="All sections">
              <div className="sheet-grip" />
              {navList}
            </div>
          </>
        )}
      </div>
    </OutletProvider>
  );
}
