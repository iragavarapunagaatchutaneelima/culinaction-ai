import { useCallback, useEffect, useState } from 'react';
import { Link, NavLink, Outlet as RouterOutlet, useLocation, useNavigate, useParams } from 'react-router-dom';
import { get, post } from './api';
import { Icon, Logo } from './icons';
import { OutletProvider, useMode, useModeRoot, useSession, type Outlet } from './session';
import { ThemeToggle } from './theme';
import { Button, Dialog, ErrorState, Loading, useToast } from './ui';

type NavItem = {
  to: string;
  label: string;
  icon: (p: { size?: number }) => React.ReactElement;
  demoOnly?: boolean;
};
const NAV: { group: string; items: NavItem[] }[] = [
  {
    group: 'Operate',
    items: [
      { to: 'scenarios', label: 'Demo scenarios', icon: Icon.Spark, demoOnly: true },
      { to: 'today', label: 'Dashboard', icon: Icon.Today },
      { to: 'orders', label: 'Orders & delivery', icon: Icon.Delivery },
      { to: 'tasks', label: 'Kitchen tasks', icon: Icon.Tasks },
      { to: 'approvals', label: 'Approval queue', icon: Icon.Check },
    ],
  },
  {
    group: 'Decide',
    items: [
      { to: 'recommendations', label: 'Recommendations', icon: Icon.Decide },
      { to: 'whatif', label: 'What-if simulator', icon: Icon.Sliders },
      { to: 'plans', label: 'Action plans', icon: Icon.Plan },
      { to: 'verify', label: 'Outcome verification', icon: Icon.Outcome },
    ],
  },
  {
    group: 'Records',
    items: [
      { to: 'inventory', label: 'Inventory & batches', icon: Icon.Stock },
      { to: 'menu', label: 'Menu & recipes', icon: Icon.Menu },
      { to: 'sales', label: 'Sales', icon: Icon.Sales },
      { to: 'outcomes', label: 'Service outcomes', icon: Icon.Outcome },
      { to: 'waste', label: 'Waste & surplus', icon: Icon.Waste },
      { to: 'movements', label: 'Stock movements', icon: Icon.History },
    ],
  },
  {
    group: 'Review',
    items: [
      { to: 'analytics', label: 'Analytics & reports', icon: Icon.Chart },
      { to: 'settings', label: 'Settings & export', icon: Icon.Settings },
    ],
  },
];

const BOTTOM: NavItem[] = [
  { to: 'today', label: 'Today', icon: Icon.Today },
  { to: 'orders', label: 'Orders', icon: Icon.Delivery },
  { to: 'recommendations', label: 'Decide', icon: Icon.Decide },
  { to: 'tasks', label: 'Tasks', icon: Icon.Tasks },
];

export function OutletLayout() {
  const { oid } = useParams();
  const { user, logout } = useSession();
  const mode = useMode();
  const root = useModeRoot();
  const nav = useNavigate();
  const toast = useToast();
  const [outlet, setOutlet] = useState<Outlet | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [more, setMore] = useState(false);
  const [confirmReset, setConfirmReset] = useState(false);
  const [resetting, setResetting] = useState(false);
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

  const resetDemo = async () => {
    setResetting(true);
    try {
      const r = await post<{ outlets: { id: number }[] }>('/demo/reset');
      setConfirmReset(false);
      toast('Demo reset to its starting data');
      window.location.assign(`/demo/o/${r.outlets[0].id}/scenarios`);
    } catch (e) {
      toast((e as Error).message, 'error');
      setResetting(false);
    }
  };
  const exitDemo = async () => {
    await logout();
    nav('/');
  };

  if (error)
    return (
      <div className="main">
        <ErrorState error={error} onRetry={load} />
        <p style={{ marginTop: 12 }}>
          <Link to={root}>Back to outlets</Link>
        </p>
      </div>
    );
  if (!outlet) return <Loading />;

  const base = `${root}/o/${outlet.id}`;
  const navList = (
    <ul className="navlist">
      {NAV.map((g) => (
        <li key={g.group}>
          <div className="group-label">{g.group}</div>
          <ul className="navlist">
            {g.items
              .filter((i) => !i.demoOnly || mode === 'demo')
              .map((i) => (
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
        <div className="group-label">{mode === 'demo' ? 'Demo' : 'Account'}</div>
        <Link to={root} className="navlink-plain">
          <Icon.Store /> {mode === 'demo' ? 'Switch demo outlet' : 'Switch outlet'}
        </Link>
        {mode === 'demo' ? (
          <button className="navlink-plain" onClick={() => void exitDemo()}>
            <Icon.Logout /> Exit Demo Mode
          </button>
        ) : (
          <button className="navlink-plain" onClick={() => void logout()}>
            <Icon.Logout /> Sign out ({user?.displayName})
          </button>
        )}
      </li>
      <li className="nav-theme">
        <div className="group-label">Theme</div>
        <ThemeToggle />
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
      <a href="#main" className="skip-link">
        Skip to content
      </a>
      {mode === 'demo' && (
        <div className="demo-bar" role="note" aria-label="Demo Mode">
          <span className="demo-pill">DEMO MODE</span>
          <span className="demo-text">
            Fictional outlets · generated sample data · simulated events — nothing here is a real restaurant
            or a real result.
          </span>
          <span className="demo-actions">
            <Link to={`${base}/scenarios`} className="demo-btn">
              Scenarios
            </Link>
            <button className="demo-btn" onClick={() => setConfirmReset(true)}>
              Reset demo
            </button>
            <button className="demo-btn" onClick={() => void exitDemo()}>
              Exit
            </button>
          </span>
        </div>
      )}
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
            <div className="topbar-theme">
              <ThemeToggle compact />
            </div>
            <Link to={root} className="btn ghost sm" style={{ minHeight: 36 }}>
              Switch
            </Link>
          </header>
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
      {confirmReset && (
        <Dialog
          title="Reset the demo?"
          onClose={() => setConfirmReset(false)}
          footer={
            <>
              <button className="btn ghost" onClick={() => setConfirmReset(false)}>
                Cancel
              </button>
              <Button className="primary" busy={resetting} onClick={() => void resetDemo()}>
                Reset demo data
              </Button>
            </>
          }
        >
          <p>
            All changes you made in this demo (plans, tasks, outcomes, orders) are discarded and the four
            fictional outlets are regenerated. Real application data is never affected.
          </p>
        </Dialog>
      )}
    </OutletProvider>
  );
}
