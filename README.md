# CulinAction AI

**Smarter kitchen decisions. Less avoidable waste.**

CulinAction AI is a restaurant operations intelligence platform for restaurants, cafés and bakeries, built Hyderabad-first (₹ INR, Asia/Kolkata time, DD/MM/YYYY, g/kg, ml/L). It connects two problems kitchens usually track separately:

- **Food waste**: over-preparation, ingredients nearing their use-by date, cancelled and uncollected orders.
- **Delivery quality**: food waiting too long between preparation, packing, pickup and delivery.

Every decision follows one loop:

> **Your records → risk detected → evidence-backed options → human approval → kitchen action → outcome verified**

It is not a chatbot. A deterministic, unit-tested engine does the arithmetic and enforces safety rules. An optional AI model can only rewrite a calculation in plain words, and its output is validated. Without an AI key, a clearly labelled rule-based summary is shown instead.

**Repository:** <https://github.com/iragavarapunagaatchutaneelima/culinaction-ai>

## Two modes

|           | Demo Mode (`/demo`)                                                               | Real Mode (`/app`)                               |
| --------- | --------------------------------------------------------------------------------- | ------------------------------------------------ |
| Access    | No account; opens instantly from the landing page                                 | Sign-in required (owner / manager / staff roles) |
| Data      | 4 **fictional** Hyderabad outlets with generated sample data, labelled everywhere | Starts empty; only your own records              |
| Isolation | Per-visitor sandbox, separate cookie, enforced by the server; reset any time      | Outlet membership checked on every request       |
| Purpose   | Judges and visitors explore 6 guided scenarios                                    | Running a real kitchen                           |

## Features

| Area                 | What it does                                                                                                                                                                                                                                                                    |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Inventory & batches  | Use-by, expiry and best-before dates stored as printed; unsafe or unchecked stock never counts as usable; storage checks; stock movements with reasons; FIFO use                                                                                                                |
| Menu & recipes       | Verified recipes, preparation loss, shared ingredients, cost per portion, verified allergen text, verified **delivery handling limits**                                                                                                                                         |
| Sales                | Manual entry and CSV import with row-level review; transparent same-weekday / recent-days baseline (not ML)                                                                                                                                                                     |
| Waste & surplus      | 9 categories (spoilage, expired, excess preparation, unsold cooked, cancelled order, uncollected order, prep trim, customer-returned, other); recorded cost vs recipe-cost estimate; surplus by dish                                                                            |
| Service outcomes     | Prepared, sold, kept, **transferred** and discarded, each counted once                                                                                                                                                                                                          |
| Orders & delivery    | Order timelines with a validated lifecycle, manual events and CSV import; waits and durations from recorded timestamps only; rule-based **quality-risk** level with every factor shown                                                                                          |
| Decision engine      | Unsafe stock, quality checks, stockouts, expiry waste, preparation adjustment, excess stock, **pickup delay**, **cancelled/uncollected food**, **kitchen bottlenecks**, data gaps — each with evidence, calculation, options, confidence, missing information and safety checks |
| What-if simulator    | Compare preparation quantities against usable stock and every comparable sales day; purchase cover and expiry exposure                                                                                                                                                          |
| Approvals & tasks    | Draft → submit → approve / reject (reason) / cancel → tasks → completion with real effects; full approval history                                                                                                                                                               |
| Outcome verification | Approved vs prepared vs sold vs discarded, compared with earlier services; estimates never presented as savings                                                                                                                                                                 |
| Analytics            | Waste by category, waste per 100 portions, forecast error, delivery medians, actions                                                                                                                                                                                            |
| UX                   | Landing page, light / dark / system theme (no flash), mobile bottom navigation, accessible forms, PWA manifest                                                                                                                                                                  |

## Stack

| Layer         | Choice                                                                                                             |
| ------------- | ------------------------------------------------------------------------------------------------------------------ |
| Web           | React 19, React Router 7, Vite 8, hand-written CSS design system                                                   |
| Server        | Node.js ≥ 22.13 (tested on 24.16), Express 5, Zod                                                                  |
| Database      | SQLite: `node:sqlite` file locally / self-hosted; **Turso (libSQL over HTTP)** on Vercel — same SQL and migrations |
| Domain logic  | Pure TypeScript in `shared/` (engine, orders, delivery risk, what-if, forecast, units, money, CSV, metrics)        |
| AI (optional) | `@anthropic-ai/sdk`, server-side, schema- and safety-validated                                                     |
| Tests         | Vitest (unit + API integration on both DB drivers), Playwright (system Chrome)                                     |
| Hosting       | Vercel Build Output API (static + one Node function) — see [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md)                |

## Getting started

```bash
npm install
```

```bash
npm run dev
```

Open <http://localhost:5173>. Choose **Explore interactive demo**, or **Use real application** to create the owner account (first visit) and your outlet.

Copy `.env.example` to `.env` only if you want to change defaults or enable AI.

### Commands

| Command                                                       | Purpose                                                          |
| ------------------------------------------------------------- | ---------------------------------------------------------------- |
| `npm run dev`                                                 | API on :8787 + web on :5173 (local SQLite `data/culinaction.db`) |
| `npm run db:migrate`                                          | Create / migrate the database (also runs on server start)        |
| `npm run build`                                               | Typecheck + production web build                                 |
| `npm start`                                                   | Production server (serves `dist/web` and the API)                |
| `npm run build:vercel`                                        | Build the Vercel output (`.vercel/output`)                       |
| `npm run lint` · `npm run typecheck` · `npm run format:check` | Quality checks                                                   |
| `npm run test:unit` · `npm run test:integration`              | Vitest                                                           |
| `npm run test:integration:libsql`                             | Integration suite through the libSQL (Turso) driver              |
| `npm run test:e2e`                                            | Browser tests against the production build (system Chrome)       |
| `npm run test:e2e:vercel`                                     | Browser tests against the bundled Vercel output                  |

### Environment variables

| Variable                                  | Default               | Purpose                                     |
| ----------------------------------------- | --------------------- | ------------------------------------------- |
| `API_PORT` / `PORT`                       | 8787                  | HTTP port (`API_PORT` wins)                 |
| `DATABASE_PATH`                           | `data/culinaction.db` | Local SQLite file                           |
| `TURSO_DATABASE_URL` / `TURSO_AUTH_TOKEN` | _(unset)_             | Remote libSQL database (required on Vercel) |
| `ANTHROPIC_API_KEY`                       | _(unset)_             | Enables AI explanations (server-side only)  |
| `AI_MODEL`                                | `claude-opus-5-5`     | Model for explanations                      |
| `AI_TIMEOUT_MS`                           | 20000                 | AI request timeout                          |
| `COOKIE_SECURE`                           | _(unset)_             | `1` adds `Secure` to cookies (HTTPS)        |

No credentials are required to run the app or the demo.

## CSV formats

**Sales** (`Sales → Import CSV`, template downloadable):

```csv
date,menu_item,quantity,service_period,unit_price_inr
2026-10-01,Masala Dosa,42,Breakfast,70
```

**Order events** (`Orders → Import CSV`, template downloadable). One row per event in time order. The first row of a new order is `received` with channel and items:

```csv
order_ref,event,occurred_at,channel,items,est_travel_min,packaging,reason
A1,received,2026-10-09 12:00,aggregator,Veg Biryani x2,20,Foil,
A1,prep_started,2026-10-09 12:02,,,,,
A1,picked_up,2026-10-09 12:35,,,,,Rider late
```

Both imports show a row-by-row review; only valid rows are saved, after confirmation. Exports neutralise spreadsheet formulas.

## Documentation

- [Demo guide for judges](docs/DEMO_GUIDE.md)
- [Architecture](docs/ARCHITECTURE.md) · [API](docs/API.md) · [Data dictionary](docs/DATA_DICTIONARY.md)
- [Food-safety and risk rules](docs/FOOD_SAFETY_AND_RISK_RULES.md) · [Security](docs/SECURITY.md)
- [Deployment](docs/DEPLOYMENT.md) · [Test report](docs/TEST_REPORT.md) · [Technical audit](docs/TECHNICAL_AUDIT.md) · [Build status](docs/BUILD_STATUS.md)

## Known limitations

- **AI explanations have not been verified against the live API** (no key was available). Validation and failure handling are tested with fixture responses; the app works fully without AI.
- **The live Turso connection is only exercised after deployment.** The libSQL driver is tested locally through the libSQL engine on a file.
- Forecasts are simple averages over recorded comparable days, not machine learning; festivals and weather are not modelled.
- Delivery risk uses recorded times and verified handling limits only. There is no temperature, traffic, GPS or delivery-platform data, and none is simulated outside clearly labelled demo scenarios.
- No POS, Swiggy, Zomato or supplier integrations; purchases and alerts are tasks for people.
- Same-dimension unit conversions only (no "1 onion ≈ 150 g"); no sub-recipes; timezone fixed to Asia/Kolkata.
- No password reset or 2FA; the sign-in throttle is per server instance.
- No real-world savings have been measured.

## Future enhancements

Telugu/Hindi UI, POS and platform integrations (with documented API access), temperature-probe input for verified readings, sub-recipes, per-outlet timezones, email password reset, scheduled engine runs.
