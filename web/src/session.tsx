import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { get, post } from './api';

export interface User {
  id: number;
  username: string;
  displayName: string;
  isDemo?: boolean;
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
  prepWarnMin: number;
  readyWaitWarnMin: number;
  readyWaitHighMin: number;
  deliveryTargetMin: number;
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

export type AppMode = 'real' | 'demo';
const ModeCtx = createContext<AppMode>('real');
/** 'real' or 'demo' for the current part of the app. */
export const useMode = () => useContext(ModeCtx);
/** Route prefix for the current mode: '/app' (Real Mode) or '/demo' (Demo Mode). */
export const useModeRoot = () => (useMode() === 'demo' ? '/demo' : '/app');

export function SessionProvider({ children, mode = 'real' }: { children: ReactNode; mode?: AppMode }) {
  const [state, setState] = useState<Omit<SessionState, 'refresh' | 'logout'>>({
    status: 'loading',
    user: null,
    outlets: [],
  });

  const refresh = useCallback(async () => {
    try {
      if (mode === 'demo') {
        // Demo Mode: there is either an active demo session (demo cookie) or none yet.
        try {
          const me = await get<{ user: User; outlets: OutletSummary[] }>('/auth/me');
          return setState({ status: 'signed_in', user: me.user, outlets: me.outlets });
        } catch (e) {
          if ((e as { status?: number }).status === 401)
            return setState({ status: 'signed_out', user: null, outlets: [] });
          throw e;
        }
      }
      const s = await get<{ needsSetup: boolean; user: User | null }>('/auth/state');
      if (s.needsSetup) return setState({ status: 'needs_setup', user: null, outlets: [] });
      if (!s.user) return setState({ status: 'signed_out', user: null, outlets: [] });
      const me = await get<{ user: User; outlets: OutletSummary[] }>('/auth/me');
      setState({ status: 'signed_in', user: me.user, outlets: me.outlets });
    } catch {
      setState({ status: 'offline', user: null, outlets: [] });
    }
  }, [mode]);

  const logout = useCallback(async () => {
    await post(mode === 'demo' ? '/demo/end' : '/auth/logout').catch(() => {});
    setState({ status: 'signed_out', user: null, outlets: [] });
  }, [mode]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return (
    <ModeCtx.Provider value={mode}>
      <SessionCtx.Provider value={{ ...state, refresh, logout }}>{children}</SessionCtx.Provider>
    </ModeCtx.Provider>
  );
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
