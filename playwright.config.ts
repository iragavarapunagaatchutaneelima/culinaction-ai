import { defineConfig, devices } from '@playwright/test';

// Uses the locally installed Google Chrome (no browser download).
export default defineConfig({
  testDir: 'tests/e2e',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 60_000,
  reporter: [['list']],
  use: { baseURL: 'http://localhost:8799', channel: 'chrome', trace: 'retain-on-failure' },
  projects: [
    {
      name: 'desktop',
      use: { ...devices['Desktop Chrome'], channel: 'chrome', viewport: { width: 1280, height: 860 } },
    },
  ],
  webServer: {
    // E2E_TARGET=vercel tests the bundled Vercel output (scripts/vercel-local.mjs) instead of the Node server.
    command:
      process.env.E2E_TARGET === 'vercel'
        ? 'npm run build:vercel && node scripts/vercel-local.mjs'
        : 'npm run build && node scripts/e2e-server.mjs',
    url: 'http://localhost:8799/api/health',
    timeout: 180_000,
    reuseExistingServer: false,
  },
});
