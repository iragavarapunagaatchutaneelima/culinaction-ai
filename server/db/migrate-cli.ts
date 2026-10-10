import { dbConfigFromEnv, openDb } from './database';

const config = dbConfigFromEnv();
const db = await openDb(config);
const all = await db.all<{ version: number; name: string; applied_at: string }>(
  'SELECT * FROM schema_migrations ORDER BY version',
);
await db.close();
console.log(`Database: ${config.url ? config.url.replace(/\?.*$/, '') : config.path} (${db.driver})`);
console.log('Schema is up to date. Applied migrations:');
for (const m of all) console.log(`  v${m.version} ${m.name} (${m.applied_at})`);
