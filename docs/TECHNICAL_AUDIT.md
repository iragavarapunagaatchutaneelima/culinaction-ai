# Technical Audit

## Part 1 — Baseline before the v2 upgrade (commit `c86131d`, 10/10/2026)

Verified by inspecting the files and running the commands; nothing below comes only from the README.

### Stack (verified)

- React 19 + React Router 7 + Vite 8 (`web/`), hand-written CSS with a light theme only.
- Express 5 API (`server/`), Zod validation, cookie sessions (scrypt passwords, SHA-256-hashed session tokens), CSRF header guard, role + outlet-membership authorisation.
- Async data layer with two drivers: `node:sqlite` (local file) and libSQL/Turso over HTTP (`server/db/database.ts`). One migration (v1, 17 tables).
- Deterministic decision engine in `shared/engine.ts`. Optional Anthropic explanation layer (`server/ai/provider.ts`) — **no API key available, never called live**.
- Vercel Build Output API packaging (`scripts/build-vercel.mjs`, `vercel.json`). **No Vercel project or deployment existed.**

### Baseline test results (executed)

| Command                                          | Result                 |
| ------------------------------------------------ | ---------------------- |
| `npm test`                                       | 6 files, **78 passed** |
| `npm run build`                                  | passed                 |
| `npm run test:e2e` (previous run, same commit)   | **11 passed**          |
| `npm run test:integration:libsql` (previous run) | **21 passed**          |

### 1. Existed and worked

Owner/manager/staff auth; outlets; ingredients + dated batches; receipts/use/count/adjust/stock movements; menu + verified recipes + cost per portion; manual sales + CSV import with review; forecast baseline; waste log; service outcomes; decision engine (unsafe stock, best-before check, stockout, expiry waste, prep adjustment, excess stock, forecast deviation, data gaps); plans with approval history; tasks with real effects; analytics; exports; audit log; illustrative workspace (one outlet); mobile layout; PWA manifest.

### 2. Existed but incomplete

- Illustrative data: a single outlet, created inside a real user's account (not a separate mode).
- AI layer: when not configured, no explanation at all (no deterministic fallback text).
- Waste reasons: 6 generic categories; no distinction for cancelled/uncollected orders or unsold cooked food.
- Service outcomes: no "transferred" quantity.
- Expiry-risk options did not ask for storage verification of the batch.

### 3. Missing

Public landing page; login-free interactive demo mode; separation of demo and real data; delivery orders, order timelines, lifecycle validation, delay and quality-risk engine; cancelled/uncollected order handling; what-if simulator; approval queue and outcome-verification screens; dark/system themes; demo scenarios and reset.

### 4. Security / data-integrity risks

- An illustrative workspace could be created inside a real account (mixing sample and real records in one account).
- Login throttle is in-memory (per server instance) — weaker on serverless.
- No rate limit on account setup beyond "first user only".

### 5. Deployment blockers

- Vercel requires a remote database (Turso) — needs the account owner to create a Turso database and set `TURSO_DATABASE_URL` / `TURSO_AUTH_TOKEN`.
- Vercel deployment requires the account owner to sign in to Vercel and import the GitHub repository.

## Part 2 — v2 upgrade (10/10/2026)

### Preserved

All v1 functionality, its tests and its data. Migration 2 was tested on a populated v1 database: rows were preserved with no foreign-key violations. The old single-outlet "illustrative workspace" endpoint was **replaced** by Demo Mode, which covers the same purpose with proper isolation. Its integration and E2E tests were replaced accordingly.

### Changed

- Routing: `/` is now a public landing page, Real Mode is under `/app` (old `/o/:id` links redirect), and Demo Mode is under `/demo`.
- Sessions: a separate demo cookie selected by a mode header; demo/real user checks on every request; `requireRealUser` added for real-only actions.
- Waste categories expanded from 6 to 9 (table rebuilt); outcomes gained `qty_transferred`.
- Engine: preparation surplus sums service periods per day; expiry options require a storage check; engine run storage moved to `createRun` with multi-row inserts.
- AI: structured output must name its recommended option; responses are rejected for safety conflicts or unsupported numbers/options; deterministic rule-based summary always available.
- UI: complete theme system (light/dark/system, tokens for every colour, no first-paint flash), new navigation (Operate / Decide / Records / Review), demo bar, skip link.

### Added

Landing page; Demo Mode (4 fictional outlets, 6 scenarios, reset, 24 h expiry, capacity cap); orders with validated lifecycle, manual events and CSV import; delivery durations and rule-based quality risk; risk assessments stored per run; engine rules for pickup delay, order disposition and kitchen bottlenecks; what-if simulator (preparation and purchasing); approval queue; outcome verification; waste-and-surplus view; dashboard delivery and waste panels; delivery analytics; handling limits per dish; storage checks per batch; docs (API, SECURITY, DEPLOYMENT, DEMO_GUIDE, FOOD_SAFETY_AND_RISK_RULES, this audit).

### Tested

See [TEST_REPORT.md](TEST_REPORT.md): 81 unit, 35 integration on each database driver, 21 E2E against the production server and 21 against the bundled Vercel output — all executed and passing.

### Remaining incomplete / external

| Item                                                              | Status                                                                                                                              |
| ----------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| Live Vercel deployment + Turso database                           | **Blocked on account-owner sign-in** to Vercel and Turso (cannot be done on their behalf). Steps in [DEPLOYMENT.md](DEPLOYMENT.md). |
| Live AI explanations                                              | Requires `ANTHROPIC_API_KEY`; app is fully functional without it.                                                                   |
| Platform/POS/supplier integrations, temperature probes, Telugu UI | Not built (out of scope; not simulated outside labelled demo scenarios).                                                            |
| Android install, screen-reader audit, load testing                | Not performed.                                                                                                                      |
