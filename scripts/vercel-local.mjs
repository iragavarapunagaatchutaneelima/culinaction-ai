// Local emulation of the Vercel deployment produced by scripts/build-vercel.mjs.
// Serves .vercel/output/static, rewrites /api/* to the bundled function exactly like config.json
// (/api/<path> → /api?__p=<path>), and falls back to index.html. Used to E2E-test the real bundle.
// NOTE: uses a local SQLite file (DATABASE_URL=file:…) — the Turso HTTP transport itself is not exercised.
import { createServer } from 'node:http';
import { existsSync, readFileSync, rmSync, statSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { pathToFileURL } from 'node:url';

const port = Number(process.env.API_PORT || 8799);
const db = process.env.E2E_DB || 'data/e2e-test.db';
for (const f of [db, `${db}-wal`, `${db}-shm`]) rmSync(f, { force: true });
process.env.DATABASE_URL = `file:${db}`;
process.env.DATABASE_PATH = db;
process.env.ANTHROPIC_API_KEY = '';

const { default: handler } = await import(pathToFileURL('.vercel/output/functions/api.func/index.mjs').href);
const STATIC = '.vercel/output/static';
const TYPES = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webmanifest': 'application/manifest+json',
  '.json': 'application/json',
};

createServer((req, res) => {
  const u = new URL(req.url, 'http://local');
  const m = /^\/api\/(.*)$/.exec(u.pathname);
  if (m) {
    const q = new URLSearchParams(u.search);
    q.set('__p', m[1]);
    req.url = `/api?${q}`;
    // Vercel's Node launcher passes a writable response; Express handles the rest.
    handler(req, res);
    return;
  }
  let file = normalize(join(STATIC, decodeURIComponent(u.pathname)));
  if (!file.startsWith(normalize(STATIC)) || !existsSync(file) || statSync(file).isDirectory())
    file = join(STATIC, 'index.html');
  res.setHeader('Content-Type', TYPES[extname(file)] ?? 'application/octet-stream');
  res.end(readFileSync(file));
}).listen(port, () => console.log(`Vercel emulation on http://localhost:${port}`));
