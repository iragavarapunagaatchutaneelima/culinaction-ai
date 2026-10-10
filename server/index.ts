import { providerFromEnv } from './ai/provider';
import { createApp } from './app';
import { dbConfigFromEnv, openDb } from './db/database';

// API_PORT wins over PORT so tools that set PORT for the web dev server do not collide with the API.
const port = Number(process.env.API_PORT || process.env.PORT) || 8787;
const production = process.env.NODE_ENV === 'production';
const dbConfig = dbConfigFromEnv();

const db = await openDb(dbConfig);
const ai = providerFromEnv();
const app = createApp({
  db,
  ai,
  staticDir: production ? 'dist/web' : null,
  secureCookies: process.env.COOKIE_SECURE === '1',
});

const server = app.listen(port, () => {
  const s = ai.status();
  console.log(
    `CulinAction AI API listening on http://localhost:${port} (${production ? 'production' : 'development'})`,
  );
  console.log(`Database: ${db.driver === 'libsql' ? 'remote libSQL/Turso' : dbConfig.path} (${db.driver})`);
  console.log(
    `AI explanation: ${s.configured ? `configured (${s.provider}, ${s.model}) — not verified until a request succeeds` : 'not configured'}`,
  );
});

function shutdown() {
  server.close(() => {
    void db.close().then(() => process.exit(0));
  });
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
