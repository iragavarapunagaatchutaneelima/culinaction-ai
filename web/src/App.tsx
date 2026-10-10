import { Navigate, Route, Routes } from 'react-router-dom';
import { OutletLayout } from './Layout';
import { AuthPage } from './pages/Auth';
import { Analytics } from './pages/Analytics';
import { IngredientDetail, IngredientForm, Inventory, Movements } from './pages/Inventory';
import { MenuItemPage, MenuList } from './pages/Menu';
import { OutletPicker } from './pages/Outlets';
import { PlanDetail, Plans } from './pages/Plans';
import { RecommendationDetail, Recommendations } from './pages/Recommendations';
import { Sales, SalesImport } from './pages/Sales';
import { Settings } from './pages/Settings';
import { Tasks } from './pages/Tasks';
import { Today } from './pages/Today';
import { Outcomes, Waste } from './pages/Waste';
import { useSession } from './session';
import { Loading } from './ui';

export function App() {
  const s = useSession();
  if (s.status === 'loading') return <Loading label="Starting CulinAction…" />;
  if (s.status === 'offline')
    return (
      <div className="auth-wrap">
        <div className="card card-pad auth-card stack-sm">
          <h1>Cannot reach the server</h1>
          <p className="muted">
            The CulinAction server is not responding. Make sure it is running (npm run dev) and reload.
          </p>
          <button className="btn primary" onClick={() => void s.refresh()}>
            Retry
          </button>
        </div>
      </div>
    );
  if (s.status === 'needs_setup' || s.status === 'signed_out')
    return <AuthPage mode={s.status === 'needs_setup' ? 'setup' : 'login'} />;

  return (
    <Routes>
      <Route path="/" element={<OutletPicker />} />
      <Route path="/outlets" element={<OutletPicker />} />
      <Route path="/o/:oid" element={<OutletLayout />}>
        <Route index element={<Navigate to="today" replace />} />
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
        <Route path="waste" element={<Waste />} />
        <Route path="outcomes" element={<Outcomes />} />
        <Route path="recommendations" element={<Recommendations />} />
        <Route path="recommendations/:iid" element={<RecommendationDetail />} />
        <Route path="plans" element={<Plans />} />
        <Route path="plans/:pid" element={<PlanDetail />} />
        <Route path="tasks" element={<Tasks />} />
        <Route path="analytics" element={<Analytics />} />
        <Route path="settings" element={<Settings />} />
        <Route path="*" element={<NotFound />} />
      </Route>
      <Route path="*" element={<NotFound standalone />} />
    </Routes>
  );
}

function NotFound({ standalone }: { standalone?: boolean }) {
  const body = (
    <div className="card card-pad stack-sm">
      <h1>Page not found</h1>
      <p className="muted">This address does not match any page in CulinAction.</p>
      <div>
        <a className="btn" href="/">
          Go to my outlets
        </a>
      </div>
    </div>
  );
  return standalone ? <div className="main">{body}</div> : body;
}
