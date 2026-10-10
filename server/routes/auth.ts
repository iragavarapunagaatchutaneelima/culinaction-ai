import { Router } from 'express';
import { z } from 'zod';
import {
  clearCookie,
  clearLoginFailures,
  createSession,
  destroySession,
  hashPassword,
  loginThrottle,
  readCookie,
  recordLoginFailure,
  requireAuth,
  SESSION_COOKIE,
  sessionCookie,
  verifyPassword,
} from '../auth';
import { conflict, HttpError, parse } from '../http';
import { audit, type Deps } from '../services';
import { reqText } from '../validation';

const username = z
  .string()
  .trim()
  .min(3, 'Username must be at least 3 characters')
  .max(40)
  .regex(/^[a-zA-Z0-9._-]+$/, 'Use letters, numbers, dot, dash or underscore');
export const passwordField = z.string().min(8, 'Password must be at least 8 characters').max(200);

export function authRoutes({ db, now }: Deps, secureCookies: boolean) {
  const r = Router();

  r.get('/state', async (req, res) => {
    const users = (await db.get<{ n: number }>('SELECT COUNT(*) AS n FROM users'))!.n;
    res.json({ needsSetup: users === 0, user: req.user ?? null });
  });

  // First-run only: creates the first account. Further users are added by an outlet owner.
  r.post('/setup', async (req, res) => {
    const body = parse(
      z.object({ username, displayName: reqText(80, 'Name'), password: passwordField }),
      req.body,
    );
    const id = await db.tx(async () => {
      if ((await db.get<{ n: number }>('SELECT COUNT(*) AS n FROM users'))!.n > 0)
        throw conflict('Setup has already been completed. Please sign in.');
      const { lastId } = await db.run(
        'INSERT INTO users (username, display_name, password_hash, created_at) VALUES (?,?,?,?)',
        [body.username, body.displayName, hashPassword(body.password), now().toISOString()],
      );
      await audit(
        db,
        { outletId: null, userId: lastId, entityType: 'user', entityId: lastId, action: 'setup' },
        now(),
      );
      return lastId;
    });
    const s = await createSession(db, id, now());
    res.setHeader('Set-Cookie', sessionCookie(s.token, s.expires, secureCookies));
    res.status(201).json({ user: { id, username: body.username, displayName: body.displayName } });
  });

  r.post('/login', async (req, res) => {
    const body = parse(
      z.object({ username: z.string().trim().min(1, 'Required'), password: z.string().min(1, 'Required') }),
      req.body,
    );
    loginThrottle(body.username, now().getTime());
    const u = await db.get<{ id: number; username: string; display_name: string; password_hash: string }>(
      'SELECT * FROM users WHERE username = ?',
      [body.username],
    );
    if (!u || !verifyPassword(body.password, u.password_hash)) {
      recordLoginFailure(body.username, now().getTime());
      throw new HttpError(401, 'Username or password is incorrect.', 'bad_credentials');
    }
    clearLoginFailures(body.username);
    const s = await createSession(db, u.id, now());
    res.setHeader('Set-Cookie', sessionCookie(s.token, s.expires, secureCookies));
    res.json({ user: { id: u.id, username: u.username, displayName: u.display_name } });
  });

  r.post('/logout', async (req, res) => {
    const token = readCookie(req, SESSION_COOKIE);
    if (token) await destroySession(db, token);
    res.setHeader('Set-Cookie', clearCookie());
    res.json({ ok: true });
  });

  r.get('/me', requireAuth, async (req, res) => {
    const outlets = await db.all(
      `SELECT o.id, o.name, o.outlet_type AS outletType, o.city, o.is_illustrative AS isIllustrative, m.role
       FROM outlets o JOIN outlet_members m ON m.outlet_id = o.id WHERE m.user_id = ? ORDER BY o.is_illustrative, o.name`,
      [req.user!.id],
    );
    res.json({ user: req.user, outlets: outlets.map((o) => ({ ...o, isIllustrative: !!o.isIllustrative })) });
  });

  return r;
}
