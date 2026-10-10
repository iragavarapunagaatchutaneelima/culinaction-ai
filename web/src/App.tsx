import { Navigate, Route, Routes, useParams } from 'react-router-dom';
import { setApiMode } from './api';
import { OutletLayout } from './Layout';
import { Analytics } from './pages/Analytics';
import { Approvals, Verify } from './pages/Approvals';
import { AuthPage } from './pages/Auth';
import { DemoEntry, Scenarios } from './pages/Demo';
import { IngredientDetail, IngredientForm, Inventory, Movements } from './pages/Inventory';
import { Landing } from './pages/Landing';
import { MenuItemPage, MenuList } from './pages/Menu';
import { OrderDetail, OrderImport, Orders } from './pages/Orders';
import { OutletPicker } from './pages/Outlets';
import { PlanDetail, Plans } from './pages/Plans';
import { RecommendationDetail, Recommendations } from './pages/Recommendations';
import { Sales, SalesImport } from './pages/Sales';
import { Settings } from './pages/Settings';
import { Tasks } from './pages/Tasks';
import { Today } from './pages/Today';
import { Outcomes, Waste } from './pages/Waste';
import { WhatIf } from './pages/WhatIf';
import { SessionProvider, useSession, type AppMode } from './session';
import { Loading } from './ui';

/** Routes shared by Real Mode and Demo Mode inside one outlet. */
function outletRoutes(mode: AppMode) {
  return (
    <Route path="o/:oid" element={<OutletLayout />}>
      <Route index element={<Navigate to={mode === 'demo' ? 'scenarios' : 'today'} replace />} />
      {mode === 'demo' && <Route path="scenarios" element={<Scenarios />} />}
      <Route path="today" element={<Today />} />
      <Route path="inventory" element={<Inventory />} />
      <Route path="inventory/new" element={<IngredientForm />} />
      <Route path="inventory/:id" element={<IngredientDetail />} />
      <Route path="inventory/:id/edit" element={<IngredientForm />} />
      <Route path="movements" element={<Movements />} />
      <Route path="menu" element={<MenuList />} />
      <Route path="menu/:id" element={<MenuItemPage />} />
      <Route path="sales" element={<Sales />} />
      <Route path="sales/import" element={<SalesImport />} />
      <Route path="orders" element={<Orders />} />
      <Route path="orders/import" element={<OrderImport />} />
      <Route path="orders/:id" element={<OrderDetail />} />
      <Route path="waste" element={<Waste />} />
      <Route path="outcomes" element={<Outcomes />} />
      <Route path="recommendations" element={<Recommendations />} />
      <Route path="recommendations/:iid" element={<RecommendationDetail />} />
      <Route path="whatif" element={<WhatIf />} />
      <Route path="approvals" element={<Approvals />} />
      <Route path="plans" element={<Plans />} />
      <Route path="plans/:pid" element={<PlanDetail />} />
      <Route path="tasks" element={<Tasks />} />
      <Route path="verify" element={<Verify />} />
      <Route path="analytics" element={<Analytics />} />
      <Route path="settings" element={<Settings />} />
      <Route path="*" element={<NotFound />} />
    </Route>
  );
}

function RealApp() {
  setApiMode('real');
  return (
    <SessionProvider mode="real">
      <RealGate />
    </SessionProvider>
  );
}

function RealGate() {
  const s = useSession();
  if (s.status === 'loading') return <Loading label="Starting CulinAction…" />;
  if (s.status === 'offline') return <Offline retry={() => void s.refresh()} />;
  if (s.status === 'needs_setup' || s.status === 'signed_out')
    return <AuthPage mode={s.status === 'needs_setup' ? 'setup' : 'login'} />;
  return (
    <Routes>
      <Route index element={<OutletPicker />} />
      {outletRoutes('real')}
      <Route path="*" element={<NotFound standalone />} />
    </Routes>
  );
}

function DemoApp() {
  setApiMode('demo');
  return (
    <SessionProvider mode="demo">
      <DemoGate />
    </SessionProvider>
  );
}

function DemoGate() {
  const s = useSession();
  if (s.status === 'loading') return <Loading label="Opening Demo Mode…" />;
  if (s.status === 'offline') return <Offline retry={() => void s.refresh()} />;
  return (
    <Routes>
      <Route index element={<DemoEntry />} />
      {s.status === 'signed_in' ? outletRoutes('demo') : <Route path="o/*" element={<DemoEntry />} />}
      <Route path="*" element={<NotFound standalone />} />
    </Routes>
  );
}

function LegacyOutletRedirect() {
  const p = useParams();
  return <Navigate to={`/app/o/${p.oid}/${p['*'] ?? ''}`} replace />;
}

export function App() {
  return (
    <Routes>
      <Route path="/" element={<Landing />} />
      <Route path="/app/*" element={<RealApp />} />
      <Route path="/demo/*" element={<DemoApp />} />
      <Route path="/outlets" element={<Navigate to="/app" replace />} />
      <Route path="/o/:oid/*" element={<LegacyOutletRedirect />} />
      <Route path="*" element={<NotFound standalone />} />
    </Routes>
  );
}

function Offline({ retry }: { retry: () => void }) {
  return (
    <div className="auth-wrap">
      <div className="card card-pad auth-card stack-sm">
        <h1>Cannot reach the server</h1>
        <p className="muted">
          The CulinAction server is not responding. Check your connection and try again.
        </p>
        <button className="btn primary" onClick={retry}>
          Retry
        </button>
      </div>
    </div>
  );
}

function NotFound({ standalone }: { standalone?: boolean }) {
  const body = (
    <div className="card card-pad stack-sm">
      <h1>Page not found</h1>
      <p className="muted">This address does not match any page in CulinAction.</p>
      <div className="row">
        <a className="btn" href="/">
          Home
        </a>
      </div>
    </div>
  );
  return standalone ? <div className="main">{body}</div> : body;
}
