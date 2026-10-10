import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import type { Role } from '../shared/types';
import type { Db } from './db/database';
import { forbidden, HttpError, notFound } from './http';

export const SESSION_COOKIE = 'ca_session';
/** Demo sessions use their own cookie so a visitor can explore the demo without touching a real session. */
export const DEMO_COOKIE = 'ca_demo';
export type Mode = 'real' | 'demo';
const SESSION_DAYS = 14;

export interface AuthUser {
  id: number;
  username: string;
  displayName: string;
  isDemo: boolean;
}

export interface OutletRow {
  id: number;
  name: string;
  outlet_type: string;
  city: string;
  locality: string | null;
  timezone: string;
  currency: string;
  preferred_mass_unit: string;
  preferred_volume_unit: string;
  service_periods: string;
  operating_hours: string | null;
  notes: string | null;
  expiry_warn_days: number;
  excess_cover_days: number;
  stale_count_days: number;
  purchase_buffer_pct: number;
  managers_can_approve: number;
  is_illustrative: number;
  prep_warn_min: number;
  ready_wait_warn_min: number;
  ready_wait_high_min: number;
  delivery_target_min: number;
  created_at: string;
  updated_at: string;
}

declare module 'express-serve-static-core' {
  interface Request {
    user?: AuthUser;
    mode?: Mode;
    outlet?: OutletRow;
    role?: Role;
  }
}

export function hashPassword(pw: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(pw, salt, 64, { N: 16384, r: 8, p: 1 });
  return `scrypt$${salt.toString('base64')}$${hash.toString('base64')}`;
}

export function verifyPassword(pw: string, stored: string): boolean {
  const [alg, saltB64, hashB64] = stored.split('$');
  if (alg !== 'scrypt' || !saltB64 || !hashB64) return false;
  const expected = Buffer.from(hashB64, 'base64');
  const actual = scryptSync(pw, Buffer.from(saltB64, 'base64'), expected.length, { N: 16384, r: 8, p: 1 });
  return timingSafeEqual(expected, actual);
}

const sha = (s: string) => createHash('sha256').update(s).digest('hex');

export async function createSession(
  db: Db,
  userId: number,
  now: Date,
): Promise<{ token: string; expires: Date }> {
  const token = randomBytes(32).toString('base64url');
  const expires = new Date(now.getTime() + SESSION_DAYS * 86400000);
  await db.run('INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)', [
    sha(token),
    userId,
    now.toISOString(),
    expires.toISOString(),
  ]);
  return { token, expires };
}

export async function destroySession(db: Db, token: string) {
  await db.run('DELETE FROM sessions WHERE token_hash = ?', [sha(token)]);
}

export function readCookie(req: Request, name: string): string | null {
  const header = req.headers.cookie;
  if (!header) return null;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return null;
}

export function sessionCookie(
  token: string,
  expires: Date,
  secure: boolean,
  name: string = SESSION_COOKIE,
): string {
  return `${name}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Strict; Expires=${expires.toUTCString()}${secure ? '; Secure' : ''}`;
}
export function clearCookie(name: string = SESSION_COOKIE): string {
  return `${name}=; Path=/; HttpOnly; SameSite=Strict; Expires=Thu, 01 Jan 1970 00:00:00 GMT`;
}

/**
 * Which session a request uses. The SPA sends `X-CulinAction-Mode: demo` from Demo Mode pages;
 * plain GET links (CSV downloads) may pass `?mode=demo`. Anything else is Real Mode.
 */
export function requestMode(req: Request): Mode {
  if (req.get('X-CulinAction-Mode') === 'demo') return 'demo';
  if ((req.method === 'GET' || req.method === 'HEAD') && req.query.mode === 'demo') return 'demo';
  return 'real';
}

export function loadUser(db: Db, now: () => Date) {
  return async (req: Request, _res: Response, next: NextFunction) => {
    req.mode = requestMode(req);
    const token = readCookie(req, req.mode === 'demo' ? DEMO_COOKIE : SESSION_COOKIE);
    if (token) {
      const row = await db.get<{
        id: number;
        username: string;
        display_name: string;
        is_demo: number;
        expires_at: string;
      }>(
        `SELECT u.id, u.username, u.display_name, u.is_demo, s.expires_at FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?`,
        [sha(token)],
      );
      // A demo cookie only ever resolves to a demo user, and a real cookie only to a real user.
      if (row && row.expires_at > now().toISOString() && !!row.is_demo === (req.mode === 'demo'))
        req.user = {
          id: row.id,
          username: row.username,
          displayName: row.display_name,
          isDemo: !!row.is_demo,
        };
    }
    next();
  };
}

/** Blocks actions that only make sense for real accounts (creating real outlets, team management…). */
export function requireRealUser(req: Request, _res: Response, next: NextFunction) {
  if (!req.user) return next(new HttpError(401, 'Please sign in.', 'unauthenticated'));
  if (req.user.isDemo) return next(forbidden('This action is not available in Demo Mode.'));
  next();
}

/** Mutating requests must carry a custom header. Cross-site forms cannot set it and CORS is not enabled. */
export function csrfGuard(req: Request, _res: Response, next: NextFunction) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  if (req.get('X-CulinAction') !== '1')
    return next(new HttpError(403, 'Missing request header. Reload the app and try again.', 'csrf'));
  next();
}

export function requireAuth(req: Request, _res: Response, next: NextFunction) {
  if (!req.user) return next(new HttpError(401, 'Please sign in.', 'unauthenticated'));
  next();
}

/** Loads the outlet in :oid and the caller's role. Non-members get 404 (no information leak). */
export function outletAccess(db: Db) {
  return async (req: Request, _res: Response, next: NextFunction) => {
    const oid = Number(req.params.oid);
    if (!req.user) return next(new HttpError(401, 'Please sign in.', 'unauthenticated'));
    if (!Number.isInteger(oid) || oid <= 0) return next(notFound('Outlet'));
    const row = await db.get<OutletRow & { role: Role }>(
      `SELECT o.*, m.role FROM outlets o JOIN outlet_members m ON m.outlet_id = o.id WHERE o.id = ? AND m.user_id = ?`,
      [oid, req.user.id],
    );
    if (!row) return next(notFound('Outlet'));
    const { role, ...outlet } = row;
    req.outlet = outlet;
    req.role = role;
    next();
  };
}

export function requireRole(...roles: Role[]) {
  return (req: Request, _res: Response, next: NextFunction) => {
    if (!req.role || !roles.includes(req.role))
      return next(forbidden(`This action requires the ${roles.join(' or ')} role.`));
    next();
  };
}

/** Very small in-memory login throttle: 5 failures per username per 5 minutes. */
const failures = new Map<string, { count: number; until: number }>();
export function loginThrottle(username: string, nowMs: number): void {
  const f = failures.get(username.toLowerCase());
  if (f && f.count >= 5 && f.until > nowMs)
    throw new HttpError(429, 'Too many failed sign-in attempts. Try again in a few minutes.', 'rate_limited');
}
export function recordLoginFailure(username: string, nowMs: number) {
  const k = username.toLowerCase();
  const f = failures.get(k);
  if (!f || f.until < nowMs) failures.set(k, { count: 1, until: nowMs + 5 * 60000 });
  else f.count++;
}
export function clearLoginFailures(username: string) {
  failures.delete(username.toLowerCase());
}
