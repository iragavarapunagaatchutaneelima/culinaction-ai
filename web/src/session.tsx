import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { get, post } from './api';

export interface User {
  id: number;
  username: string;
  displayName: string;
}
export interface OutletSummary {
  id: number;
  name: string;
  outletType: string;
  city: string;
  isIllustrative: boolean;
  role: 'owner' | 'manager' | 'staff';
}
export interface Outlet {
  id: number;
  name: string;
  outletType: string;
  city: string;
  locality: string | null;
  timezone: string;
  currency: string;
  preferredMassUnit: string;
  preferredVolumeUnit: string;
  servicePeriods: string[];
  operatingHours: string | null;
  notes: string | null;
  expiryWarnDays: number;
  excessCoverDays: number;
  staleCountDays: number;
  purchaseBufferPct: number;
  managersCanApprove: boolean;
  isIllustrative: boolean;
  role: 'owner' | 'manager' | 'staff';
}

interface SessionState {
  status: 'loading' | 'needs_setup' | 'signed_out' | 'signed_in' | 'offline';
  user: User | null;
  outlets: OutletSummary[];
  refresh: () => Promise<void>;
  logout: () => Promise<void>;
}

const SessionCtx = createContext<SessionState>({
  status: 'loading',
  user: null,
  outlets: [],
  refresh: async () => {},
  logout: async () => {},
});
export const useSession = () => useContext(SessionCtx);

export function SessionProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<Omit<SessionState, 'refresh' | 'logout'>>({
    status: 'loading',
    user: null,
    outlets: [],
  });

  const refresh = useCallback(async () => {
    try {
      const s = await get<{ needsSetup: boolean; user: User | null }>('/auth/state');
      if (s.needsSetup) return setState({ status: 'needs_setup', user: null, outlets: [] });
      if (!s.user) return setState({ status: 'signed_out', user: null, outlets: [] });
      const me = await get<{ user: User; outlets: OutletSummary[] }>('/auth/me');
      setState({ status: 'signed_in', user: me.user, outlets: me.outlets });
    } catch {
      setState({ status: 'offline', user: null, outlets: [] });
    }
  }, []);

  const logout = useCallback(async () => {
    await post('/auth/logout').catch(() => {});
    setState({ status: 'signed_out', user: null, outlets: [] });
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return <SessionCtx.Provider value={{ ...state, refresh, logout }}>{children}</SessionCtx.Provider>;
}

// ---- Current outlet ----
interface OutletState {
  outlet: Outlet;
  base: string; // e.g. /o/3
  api: string; // e.g. /outlets/3
  canEdit: boolean; // owner or manager
  isOwner: boolean;
  reloadOutlet: () => Promise<void>;
}
const OutletCtx = createContext<OutletState | null>(null);
export const OutletProvider = OutletCtx.Provider;
export function useOutlet(): OutletState {
  const v = useContext(OutletCtx);
  if (!v) throw new Error('useOutlet outside outlet');
  return v;
}
