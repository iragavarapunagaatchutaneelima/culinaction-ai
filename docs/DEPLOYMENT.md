# Deployment

## Architecture options

| Target                                                                                | Database                                     | Status                                                                                                                    |
| ------------------------------------------------------------------------------------- | -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| **Vercel** (static site + one Node.js function for `/api`)                            | **Turso / libSQL** (remote SQLite over HTTP) | Packaging built and tested locally against the bundled output; **live deployment requires the account owner** (see below) |
| Any Node.js host with a persistent disk (Render paid instance, Railway volume, a VPS) | Local SQLite file via `node:sqlite`          | `npm run build && npm start` — tested locally                                                                             |

Vercel functions have no persistent disk, so a local SQLite file **cannot** be used there: it would lose data between requests and deployments. The server therefore uses Turso when `TURSO_DATABASE_URL` is set, and refuses to start on Vercel without it (503 with a clear message rather than silently using a throwaway file).

Both drivers implement the same async interface (`server/db/database.ts`) and run the same SQL and migrations. The full integration suite runs against both (`npm run test:integration` and `npm run test:integration:libsql`, the latter through the libSQL engine on a local file). The HTTP transport to Turso itself is only exercised after deployment.

## Vercel + Turso — step by step

These steps need the account owner's own logins (they cannot be done on someone's behalf).

1. **Create the database (free tier)**
   - Either in the Vercel dashboard → _Storage_ → _Marketplace_ → **Turso** (it creates the database and sets the environment variables for you), or
   - at <https://turso.tech>: sign up, create a database (region nearest Hyderabad: **Mumbai / aws-ap-south-1**), copy the **database URL** (`libsql://…`) and create an **auth token**.
2. **Import the project**: <https://vercel.com/new> → _Continue with GitHub_ → import `iragavarapunagaatchutaneelima/culinaction-ai`. Leave framework _Other_; `vercel.json` already sets `installCommand: npm ci` and `buildCommand: npm run build:vercel`.
3. **Environment variables** (Project → Settings → Environment Variables):
   - `TURSO_DATABASE_URL` = `libsql://…` (set automatically by the Turso integration)
   - `TURSO_AUTH_TOKEN` = token (set automatically by the integration)
   - optional `ANTHROPIC_API_KEY` (enables AI explanations; leave unset to use rule-based summaries only)
   - optional `AI_MODEL` (default `claude-opus-5-5`)
4. **Deploy.** The build writes `.vercel/output` (Build Output API v3): static files plus `functions/api.func` (Node.js 22). On the first request the function runs the migrations on Turso.
5. **Verify the live site** (this is the step that proves it works):
   - `https://<project>.vercel.app/api/health` → `{"ok":true}`
   - Open the landing page → _Explore interactive demo_ → the four demo outlets appear (this writes to Turso)
   - Reload the page → the same demo session and data are still there (persistence across requests)
   - _Use real application_ → create the owner account → create an outlet → redeploy → sign in again → the outlet is still there (persistence across deployments)

Every push to `main` triggers a new deployment.

## How the Vercel bundle works

- `scripts/build-vercel.mjs` copies `dist/web` to `.vercel/output/static` and bundles `server/vercel.ts` with esbuild into one ESM file (the libSQL HTTP client is pure JavaScript; `node:sqlite` is never loaded on Vercel).
- Routing (`.vercel/output/config.json`): `/api/(.*)` → the function as `/api?__p=$1` (the handler restores the original URL for Express); hashed assets are cached for a year; everything else falls back to `index.html`.
- The same bundle is tested locally by `npm run test:e2e:vercel`, which serves `.vercel/output` with the same routing rules (`scripts/vercel-local.mjs`) and runs the whole browser suite against it (using a local SQLite file instead of Turso).

## Self-hosting with a persistent disk

```bash
npm ci && npm run build
DATABASE_PATH=/var/data/culinaction.db COOKIE_SECURE=1 npm start
```

Back up the database file regularly; there is no built-in backup.

## Known deployment limitations

- The in-memory sign-in throttle and demo-sandbox cap are per function instance on Vercel.
- Region latency: put the Vercel function and the Turso database in nearby regions.
- Free tiers have usage limits (Vercel function execution, Turso rows read/written).
