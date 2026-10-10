# CulinAction AI

**Smarter kitchen decisions. Less avoidable waste.**

CulinAction AI is a decision-support and action-planning web app for restaurants, cafés and bakeries, built first for Hyderabad and the rest of Telangana and Andhra Pradesh (₹ INR, Asia/Kolkata time, DD/MM/YYYY, g/kg, ml/L).

The workflow:

1. Record your actual **stock** (with bill costs and any use-by, expiry or best-before date printed on the pack).
2. Enter **recipes** your kitchen has verified.
3. Enter or **import sales**.
4. A **deterministic decision engine** finds food-safety, stockout, expiry-waste, over-preparation, excess-stock and missing-data risks, and compares feasible options with the full calculation shown.
5. An owner or manager **approves, edits or rejects** a plan. Approved plans become **tasks**.
6. After service, staff **record what actually happened**, and analytics compare outcomes with earlier records.

AI is optional. It only rewrites an already-calculated recommendation in plain language. It never sets quantities, costs or safety decisions.

> Nothing in this repository is real restaurant data. The app starts empty. An optional **illustrative workspace** holds synthetic sample records for demonstration. It is kept separate and labelled on every screen.

## Stack

| Layer         | Choice                                                                                      |
| ------------- | ------------------------------------------------------------------------------------------- |
| Server        | Node.js ≥ 22.13 (tested on 24.16), Express 5, Zod, `tsx`                                    |
| Database      | SQLite via Node's built-in `node:sqlite` (no native build); file `data/culinaction.db`      |
| Domain logic  | Pure TypeScript in `shared/` (units, money, forecast, engine, CSV, plan states, metrics)    |
| Web           | React 19, React Router 7, Vite 8, hand-written CSS; mobile-first, with a PWA manifest       |
| AI (optional) | `@anthropic-ai/sdk`, server-side only                                                       |
| Tests         | Vitest (unit + API integration via supertest), Playwright (E2E on locally installed Chrome) |

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the engine rules, ranking, safety model and security design.

## Setup

```bash
npm install
```

```bash
cp .env.example .env
```

Editing `.env` is optional. Everything works without an AI key.

```bash
npm run db:migrate
```

`db:migrate` creates `data/culinaction.db` with the schema. The server also runs migrations on start.

## Run

Development mode runs the API on :8787 and the web app on :5173 with a proxy:

```bash
npm run dev
```

Open http://localhost:5173. The first visit asks you to create the owner account. After that, create an outlet, or choose **Create illustrative workspace** to explore with sample data.

Production mode builds the web app, then serves the app and API from one port (default 8787):

```bash
npm run build
```

```bash
npm start
```

Set `API_PORT` or `PORT` to change the port. Set `COOKIE_SECURE=1` when serving over HTTPS.

## Tests and checks

```bash
npm run lint
```

```bash
npm run typecheck
```

```bash
npm run format:check
```

```bash
npm run test:unit
```

```bash
npm run test:integration
```

```bash
npm run test:e2e
```

`npm test` runs unit and integration tests together. `test:e2e` builds the app, starts it on port 8799 with a throwaway database (`data/e2e-test.db`), and drives the locally installed Google Chrome. If Chrome is not installed, change `channel` in `playwright.config.ts` (e.g. `msedge`). Results from the last run are in [docs/TEST_REPORT.md](docs/TEST_REPORT.md).

## Environment variables

| Variable            | Default               | Purpose                                                                                  |
| ------------------- | --------------------- | ---------------------------------------------------------------------------------------- |
| `API_PORT` / `PORT` | 8787                  | HTTP port (`API_PORT` wins)                                                              |
| `DATABASE_PATH`     | `data/culinaction.db` | SQLite file                                                                              |
| `AI_PROVIDER`       | `anthropic`           | Only `anthropic` is supported                                                            |
| `ANTHROPIC_API_KEY` | _(unset)_             | Enables AI explanations. Server-side only; never sent to the browser or stored in the DB |
| `AI_MODEL`          | `claude-opus-5-5`     | Model used for explanations                                                              |
| `AI_TIMEOUT_MS`     | 20000                 | Request timeout                                                                          |
| `AI_BASE_URL`       | Anthropic API         | Override only if you know you need it                                                    |
| `COOKIE_SECURE`     | _(unset)_             | `1` adds the `Secure` flag to the session cookie                                         |

**Required credentials:** none to run. An Anthropic API key is needed only for the optional plain-language explanations. Without one, the UI says "AI explanation is not configured", and all calculations still work.

## Sales CSV format

Download the template from **Sales → Import CSV**, or use:

```csv
date,menu_item,quantity,service_period,unit_price_inr
2026-10-01,Masala Dosa,42,Breakfast,70
02/10/2026,Filter Coffee,118,Breakfast,
```

- `date` (YYYY-MM-DD or DD/MM/YYYY), `menu_item` (must match a menu item name; case is ignored) and `quantity` are required.
- Each row is one item, one date and one service period. A row that duplicates another row in the file, or an existing record, is reported and not imported.
- The import shows a review step: invalid, unknown-item and duplicate rows are listed with reasons. Nothing is saved until you confirm, and only valid rows are saved.
- Exported CSVs prefix cells starting with `= + - @` with `'` to prevent spreadsheet formula injection.

## Users and roles

| Role    | Can                                                                                           |
| ------- | --------------------------------------------------------------------------------------------- |
| Owner   | Everything, including outlet settings, team members, approval rules and deleting the outlet   |
| Manager | Maintain stock, recipes, sales; run the engine; create, submit and (if allowed) approve plans |
| Staff   | View records; record use, waste and outcomes; complete tasks                                  |

Roles and outlet membership are checked on the server for every request. A user who is not a member of an outlet gets "not found".

## Known limitations (honest list)

- **Single-server deployment.** Sessions and data live on one machine. There is no cloud sync, no multi-region, and no password-reset email. It has not been deployed anywhere.
- **The AI explanation has never been run against the live API.** No key was available during development. The adapter's error handling (missing key, HTTP 401/429/500, timeout, malformed output) is tested with injected transports.
- **Forecasting is simple arithmetic.** It uses a same-weekday average or a recent-days average. It is not machine learning and does not model festivals, weather or events.
- **Units:** only same-kind conversions are supported (g↔kg, ml↔L, pc). Count-to-weight conversions such as "1 onion ≈ 150 g" are rejected, not guessed. Sub-recipes (e.g. sambar as an ingredient) are not modelled.
- **Stockout checks look at one ingredient at a time.** A dish limited by two ingredients appears in two recommendations.
- **No integrations** with POS, Petpooja, Swiggy, Zomato or suppliers. Purchases are tasks only; nothing is ordered automatically.
- **Offline:** the service worker caches only the app shell. Data cannot be viewed or saved without the server. Android installability was not verified on a physical device.
- **Timezone** is fixed to Asia/Kolkata.
- Fonts load from Google Fonts. When they are unavailable, the system fonts are used instead.
- No real-world savings have been measured. The analytics screen shows estimates and observed differences, and labels both as such.

## Troubleshooting

- **"Cannot reach the server"**: the API is not running. Use `npm run dev`, not only `vite`.
- **Port already in use**: set `API_PORT=8788` (and update the proxy in `vite.config.ts` for dev).
- **`node:sqlite` not found**: upgrade Node to ≥ 22.13.
- **Locked out after failed sign-ins**: wait 5 minutes (in-memory throttle), or restart the server.
- **E2E tests cannot find Chrome**: install Chrome or set `channel: 'msedge'`.

## Documentation

- [Implementation plan](docs/IMPLEMENTATION_PLAN.md)
- [Build status](docs/BUILD_STATUS.md)
- [Architecture](docs/ARCHITECTURE.md)
- [Data dictionary](docs/DATA_DICTIONARY.md)
- [Test report](docs/TEST_REPORT.md)
- [Demo script](docs/DEMO_SCRIPT.md)
