// Starts the production server on a fresh, throwaway database for end-to-end tests.
import { rmSync } from 'node:fs';
import { spawn } from 'node:child_process';

const db = 'data/e2e-test.db';
for (const f of [db, `${db}-wal`, `${db}-shm`]) rmSync(f, { force: true });
const child = spawn(process.execPath, ['--import', 'tsx', 'server/index.ts'], {
  stdio: 'inherit',
  env: { ...process.env, NODE_ENV: 'production', DATABASE_PATH: db, API_PORT: '8799', ANTHROPIC_API_KEY: '' },
});
const stop = () => child.kill();
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
child.on('exit', (code) => process.exit(code ?? 0));
