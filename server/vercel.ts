// Vercel serverless entry point. Bundled by scripts/build-vercel.mjs into
// .vercel/output/functions/api.func/index.mjs (Build Output API v3).
// The database must be remote (Turso / libSQL) because serverless functions have no persistent disk.
import type { IncomingMessage, ServerResponse } from 'node:http';
import { providerFromEnv } from './ai/provider';
import { createApp } from './app';
import { dbConfigFromEnv, openDb } from './db/database';

let appPromise: Promise<ReturnType<typeof createApp>> | null = null;

function getApp() {
  if (!appPromise) {
    const config = dbConfigFromEnv();
    if (!config.url) {
      return Promise.reject(
        new Error('TURSO_DATABASE_URL is not set. A remote libSQL/Turso database is required on Vercel.'),
      );
    }
    appPromise = openDb(config)
      .then((db) => createApp({ db, ai: providerFromEnv(), staticDir: null, secureCookies: true }))
      .catch((e) => {
        appPromise = null; // retry on the next request
        throw e;
      });
  }
  return appPromise;
}

/** Routes rewrite /api/<path> to /api?__p=<path>; restore the original URL for Express. */
export function restoreUrl(url: string): string {
  const u = new URL(url, 'http://local');
  const p = u.searchParams.get('__p');
  if (p === null) return url;
  u.searchParams.delete('__p');
  return `/api/${p.replace(/^\/+/, '')}${u.search}`;
}

export default async function handler(req: IncomingMessage, res: ServerResponse) {
  req.url = restoreUrl(req.url ?? '/');
  try {
    const app = await getApp();
    app(req as never, res as never);
  } catch (e) {
    console.error('[startup]', e instanceof Error ? e.message : e);
    res.statusCode = 503;
    res.setHeader('Content-Type', 'application/json');
    res.end(
      JSON.stringify({
        error: {
          code: 'unavailable',
          message: 'The server could not connect to its database. Check the deployment configuration.',
        },
      }),
    );
  }
}
