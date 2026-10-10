// TEST HARNESS — creates an isolated app + SQLite file per test. Test data here is synthetic.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import { createAnthropicProvider, providerFromEnv, type AiProvider } from '../../server/ai/provider';
import { createApp } from '../../server/app';
import { LibsqlDb, openDb, type Db } from '../../server/db/database';

export const NOW = new Date('2026-10-10T04:00:00.000Z'); // 09:30 IST, Saturday 10/10/2026

export function tempDbPath() {
  const dir = mkdtempSync(join(tmpdir(), 'culinaction-test-'));
  const cleanup = () => {
    // libSQL can release its Windows file lock slightly after close(); a leftover temp dir is harmless.
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    } catch {
      /* ignore */
    }
  };
  return { path: join(dir, 'test.db'), cleanup };
}

export async function makeApp(
  dbPath: string,
  ai: AiProvider = providerFromEnv({}),
  now: () => Date = () => NOW,
) {
  // DB_DRIVER=libsql runs the same suite through the Turso/libSQL driver (local libSQL engine, file URL).
  let db: Db;
  if (process.env.DB_DRIVER === 'libsql') {
    const { createClient } = await import('@libsql/client');
    const url = 'file:' + dbPath.split('\\').join('/');
    db = new LibsqlDb(createClient({ url, intMode: 'number' }) as never);
    await db.migrate();
  } else db = await openDb(dbPath);
  const app = createApp({ db, ai, now });
  return { db, app };
}

/** Agent that keeps the session cookie and always sends the CSRF header. */
/** mode 'demo' sends the Demo Mode header, so the demo session cookie is used. */
export function client(app: ReturnType<typeof createApp>, mode: 'real' | 'demo' = 'real') {
  const agent = request.agent(app);
  const h: Record<string, string> =
    mode === 'demo' ? { 'X-CulinAction': '1', 'X-CulinAction-Mode': 'demo' } : { 'X-CulinAction': '1' };
  return {
    agent,
    get: (url: string) =>
      mode === 'demo' ? agent.get(url).set('X-CulinAction-Mode', 'demo') : agent.get(url),
    post: (url: string, body?: object) =>
      agent
        .post(url)
        .set(h)
        .send(body ?? {}),
    put: (url: string, body?: object) =>
      agent
        .put(url)
        .set(h)
        .send(body ?? {}),
    del: (url: string, body?: object) =>
      agent
        .delete(url)
        .set(h)
        .send(body ?? {}),
  };
}

export async function setupOwner(c: ReturnType<typeof client>, username = 'owner1') {
  const r = await c.post('/api/auth/setup', {
    username,
    displayName: 'Test Owner',
    password: 'test-password-1',
  });
  if (r.status !== 201) throw new Error(`setup failed: ${r.status} ${JSON.stringify(r.body)}`);
  return r.body.user;
}

export async function createOutlet(c: ReturnType<typeof client>, name = 'Test Outlet') {
  const r = await c.post('/api/outlets', {
    name,
    outletType: 'tiffin',
    city: 'Hyderabad',
    servicePeriods: ['Breakfast', 'Lunch'],
  });
  if (r.status !== 201) throw new Error(`outlet failed: ${r.status} ${JSON.stringify(r.body)}`);
  return r.body.id as number;
}

/** A fetch that always returns the given HTTP error — used to test error handling, never to fake success. */
export function failingFetch(
  status: number,
  body = { type: 'error', error: { type: 'api_error', message: 'test failure' } },
): typeof fetch {
  return (async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json', 'retry-after': '0', 'x-should-retry': 'false' },
    })) as typeof fetch;
}

export function erroringProvider(status: number) {
  return createAnthropicProvider({
    apiKey: 'test-key-not-real',
    model: 'claude-opus-5-5',
    timeoutMs: 2000,
    fetch: failingFetch(status),
  });
}
