# CulinAction AI — Architecture

## Overview

```
 Browser (React SPA, PWA)                     Server (Express 5)                               Storage
 ────────────────────────                     ──────────────────                               ───────
 /           Landing (public)                 loadUser: picks ca_session or ca_demo cookie     Db interface (async)
 /demo/...   Demo Mode ── X-CulinAction-Mode  csrfGuard (X-CulinAction header)                  ├─ SqliteDb  node:sqlite file
 /app/...    Real Mode (sign-in)   : demo     outletAccess + requireRole (server-side)          │   (dev, tests, self-host)
   api.ts ──fetch /api/*────────────────────► routes/* (Zod-validated)                          └─ LibsqlDb  Turso over HTTP
                                              ├─ shared/engine.ts      deterministic decisions       (Vercel)
                                              ├─ shared/orders.ts      order lifecycle & durations
                                              ├─ shared/deliveryRisk.ts rule-based quality risk
                                              ├─ shared/whatIf.ts      simulator
                                              ├─ shared/explain.ts     rule-based explanation (no AI)
                                              ├─ server/demo.ts        per-visitor demo sandbox
                                              └─ server/ai/provider.ts ─HTTPS─► Anthropic (optional, validated)
```

- **Development**: Vite on :5173 proxies `/api` to Express on :8787. **Self-hosted production**: Express serves `dist/web` and the API on one port. **Vercel**: static files + one bundled Node.js function (`server/vercel.ts`) via the Build Output API — see [DEPLOYMENT.md](DEPLOYMENT.md).
- **`shared/`** contains pure functions with no I/O. The server loads rows, maps them to plain objects and calls the engine, so trusted arithmetic is testable without a database.
- **Data layer**: `server/db/database.ts` defines one async `Db` interface with two drivers that share all SQL and migrations. Transactions use `AsyncLocalStorage` so nested calls become savepoints; migrations that rebuild tables run with foreign keys disabled and are followed by `PRAGMA foreign_key_check`.
- **Two modes**: Real Mode (accounts, `ca_session` cookie) and Demo Mode (anonymous per-visitor sandbox, `ca_demo` cookie, outlets flagged `is_illustrative`). The client sends `X-CulinAction-Mode: demo` from Demo pages; the server only resolves a demo cookie to a demo user and a real cookie to a real user. See [SECURITY.md](SECURITY.md).

## Data rules

- **Money** is stored as integer **paise**. Unit costs are stored as paise per _base unit_ (REAL, because ₹/g is often fractional) and every displayed money value is rounded to whole paise with `roundPaise` (half-away-from-zero).
- **Quantities** are stored in the ingredient's **base unit**: `g` for mass, `ml` for volume, `pc` for count. `shared/units.ts` is the only place conversions happen; converting between dimensions throws `IncompatibleUnitError`.
- **Dates** are stored as ISO `YYYY-MM-DD` (business dates in `Asia/Kolkata`) and timestamps as ISO UTC. The UI displays `DD/MM/YYYY`.
- **Provenance**: every ingredient batch, sales record, waste log and outcome has a `source` (`manual`, `csv_import`, `service_outcome`, `illustrative`). Illustrative outlets are flagged `is_illustrative = 1` and bannered in the UI.

## Inventory and food-safety model

Stock is held as **batches** (`inventory_batches`) with `qty_remaining`, `unit_cost_paise`, and an optional date of one explicit type: `use_by`, `expiry`, or `best_before`. Missing dates are stored as NULL and shown as "No date supplied" — never inferred.

Batch safety status (computed in `shared/safety.ts`, evaluated against the outlet's local business date):

| Status     | Rule                                                                                     | Counts as usable stock?               |
| ---------- | ---------------------------------------------------------------------------------------- | ------------------------------------- |
| `unsafe`   | `use_by`/`expiry` date **before** today, or operator marked the batch unsafe/quarantined | **No — hard constraint**              |
| `verify`   | `best_before` date before today                                                          | No, until an operator records a check |
| `expiring` | `use_by`/`expiry` within the outlet's warning window (default 2 days)                    | Yes                                   |
| `ok`       | otherwise (including no date supplied)                                                   | Yes, flagged "no date supplied"       |

Consumption and waste deduct from batches FIFO by earliest date (undated last). Every change writes a `stock_movements` row with a reason.

## Demand baseline (`shared/forecast.ts`)

Not machine learning. For target date _D_ and menu item _m_:

1. _Trading days_ = dates on which the outlet recorded **any** sales. A trading day where _m_ has no record counts as 0 sold.
2. **Same-weekday method**: trading days in the 28 days before _D_ that share _D_'s weekday. If ≥ 2 exist → forecast = mean, range = [min, max].
3. Else **recent-days method**: trading days in the 14 days before _D_. If ≥ 3 exist → mean, range = [min, max].
4. Else → `insufficient` (no number is produced).

The forecast object carries the date range, the number of days used, the per-day actuals and the method name, so the UI can show it.

## Decision engine (`shared/engine.ts`)

Input: a snapshot of the outlet (ingredients + batches, menu items + recipe lines, sales, service outcomes, settings) and a plan date. Output: an ordered list of **recommendations**, each containing:

`kind, severityTier, title, problem, evidence {batches, recipes, sales}, calculation[], assumptions[], options[], confidence, missingInfo[], safetyChecks[], nextStep, estimatedImpactPaise`

Each **option** is an alternative the operator can choose. It has a label, computed effects (quantities, estimated ₹), feasibility flag + reason, and the proposed **plan lines** (`prep`, `purchase`, `discard`, `verify`) that will be put into an action plan if the option is chosen.

### Recommendation kinds

| Kind                 | Trigger                                                                                                                                  | Options compared                                                                                                                                                 |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `unsafe_stock`       | batch status `unsafe` with qty > 0                                                                                                       | Remove & record waste (only option — never "use it")                                                                                                             |
| `verify_best_before` | batch status `verify`                                                                                                                    | Verify quality then keep / discard                                                                                                                               |
| `stockout_risk`      | Σ forecast demand × recipe qty for all items sharing an ingredient > usable stock                                                        | (A) purchase the shortfall; (B) cap preparation to what usable stock supports, allocating to items in order of forecast demand                                   |
| `expiry_waste_risk`  | `expiring` batch where expected use before its date (forecast × recipe) < qty remaining                                                  | (A) prioritise existing verified dishes that use it (bounded by their forecast demand); (B) reduce next purchase; (C) take no action — shows estimated ₹ at risk |
| `prep_adjustment`    | ≥ 3 recorded service outcomes for an item with average leftover+discard > 0, and a forecast exists                                       | (A) prepare the forecast quantity (rounded up); (B) keep the recent average prep quantity                                                                        |
| `excess_stock`       | usable stock covers > `excess_cover_days` (default 7) of forecast consumption                                                            | Reduce next purchase by the excess                                                                                                                               |
| `data_gap`           | menu items without verified recipe, recipe lines with incompatible units, ingredients with no cost, no sales history, stale stock counts | Record the verification task                                                                                                                                     |

### Ranking (deterministic)

Recommendations are sorted by the tuple:

1. **`severityTier`** ascending — `1` food safety, `2` service-impacting risk (stockout, expiry waste), `3` cost optimisation (prep adjustment, excess stock), `4` data quality.
2. **`estimatedImpactPaise`** descending — the ₹ value the calculation could compute (cost at risk, ingredient cost of excess prep, or forecast revenue at risk for stockouts when selling price is known). `null` sorts after any number.
3. **`confidence`** descending — `high` > `medium` > `low`.
4. **`sortKey`** ascending — stable tiebreaker (kind + subject name), so identical inputs always give identical order.

**Confidence** has a fixed definition: `high` = forecast from same-weekday method with ≥ 3 days, all recipes involved verified, all costs known; `medium` = forecast exists but fewer days / recent-days method, or a cost is missing; `low` = no forecast or unverified recipe involved. No numeric "AI score" is produced.

Food safety is a **filter, not a score**: unsafe and unverified batches are removed from usable stock before any other calculation, and no option can propose consuming them.

## Action plans

State machine (`shared/planState.ts`):

```
draft ──submit──► awaiting_approval ──approve──► approved ──complete──► completed
  │                     │                          │
  └──cancel──► cancelled └──reject(reason)──► rejected └──cancel──► cancelled
```

- Only `owner`/`manager` roles can approve or reject (server-enforced). The approver may edit line quantities; originals are kept (`proposed_qty` vs `approved_qty`).
- Approval creates `tasks`. Nothing is ordered, messaged or published externally.
- Every transition writes `approval_history` and `audit_events`.

## Outcome verification (`shared/metrics.ts`)

- **Recorded** values come from waste logs / outcomes (ingredient waste is costed from the batch's actual unit cost).
- **Estimated** values (menu-item waste cost via recipe cost, impact estimates from recommendations) are labelled _Estimate_.
- **Waste per 100 portions sold** = discarded portions ÷ portions sold × 100, only when portions sold > 0.
- **Forecast error** compares stored forecast snapshots with actual sales for that date (MAE and per-item absolute error).
- **Observed difference vs baseline** for a completed prep task = mean discarded portions in the item's previous ≥ 3 outcomes − discarded portions on the plan date, costed at recipe cost. It is presented as an observed difference over a small sample, **not** as proven savings.

## AI explanation layer (`server/ai/`)

- Provider adapter interface `explain(rec, context) → ExplainResult`. Implementation: official `@anthropic-ai/sdk` (`beta.messages.parse` with a Zod output format), server-side only, with an explicit `baseURL` so an unrelated `ANTHROPIC_BASE_URL` in the environment is never used.
- Enabled only when `ANTHROPIC_API_KEY` is set. Model from `AI_MODEL` (default `claude-opus-5-5`), effort `low`, server-side refusal fallback (`fallbacks: "default"`) enabled. Only the recommendation's text, calculation lines, options and missing-info list are sent — no raw stock, sales or user data.
- Called only by an explicit user action ("Explain in plain language"), never on page render. Results are stored on the recommendation item.
- After parsing, every number in the explanation is checked against the numbers in the input; unmatched numbers are listed to the user as a warning.
- Input = the already-computed recommendation (numbers, options, missing info). The model is instructed to explain, not compute. Output must be JSON matching a Zod schema; malformed output is rejected and reported as an error. The deterministic numbers are always shown from the engine, never from the model.
- Timeout (default 20 s), HTTP error, 429 and network failures map to typed errors shown in the UI. No fallback text is fabricated.

## Security

- Session cookie (`HttpOnly`, `SameSite=Strict`), passwords hashed with scrypt, sessions stored hashed.
- CSRF: `SameSite=Strict` plus a required `X-CulinAction: 1` header on all mutating requests (cross-site forms cannot set it; CORS is not enabled).
- Every outlet-scoped route checks membership and role on the server.
- All SQL uses prepared statements. React escapes output. CSV export prefixes cells starting with `= + - @ \t \r` with `'`.
- Secrets come only from environment variables; `.env` is git-ignored; API key never sent to the browser.

## v2 additions

### Orders and delivery (`shared/orders.ts`, `shared/deliveryRisk.ts`, `server/routes/orders.ts`)

- Orders have items and an append-only **event timeline** (`order_events`). `applyEvent` validates each event against the current status (state machine) and requires non-decreasing, non-future timestamps. Status is derived from the replayed events.
- `durations()` computes preparation, packing, ready→pickup wait (ongoing waits measured to "now"), delivery, total and hold time (prep completed → delivered/now) **only between recorded timestamps**.
- `orderStage()` classifies cancellations: before preparation, during preparation, prepared not packed, packed not collected, dispatched not delivered, delivered, returned.
- `assessDeliveryRisk()` returns `low | moderate | high | insufficient` with every contributing factor. Rules are in [FOOD_SAFETY_AND_RISK_RULES.md](FOOD_SAFETY_AND_RISK_RULES.md). Assessments for open orders are stored in `risk_assessments` on every engine run.

### New engine generators

| Kind                | Tier                                               | Options                                                                                                                   |
| ------------------- | -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `pickup_delay`      | 1 if a verified handling limit is exceeded, else 2 | (C) manager review before hand-over [only when limit exceeded] · (A) alert staff / chase pickup · (B) record delay reason |
| `order_disposition` | 2                                                  | (A) record disposal as waste (closes order) · (B) hold until verified limit [never for returned food]                     |
| `prep_bottleneck`   | 3                                                  | (A) investigate · (B) record delay reasons for a week (needs ≥ 5 orders)                                                  |

Expiry-waste options now start with a **storage-check task** when the batch's storage was not confirmed today. Preparation adjustment sums service-period outcomes per day before comparing with the daily forecast, and counts transferred portions as left over.

### What-if simulator (`shared/whatIf.ts`)

- **Preparation**: for each candidate quantity → ingredient use (recipe × portions, incl. loss), remaining usable stock after this dish and the forecast use of other dishes, shortfall, max portions from stock, ingredient cost; plus a replay against each comparable historical day (days short, days with surplus, average surplus/shortfall, estimated surplus cost and lost sales). No probabilities are invented.
- **Purchasing**: days of cover before/after, whether above target cover, and quantity likely unused before its date (existing stock used first).

### Explanations

- `ruleBasedExplanation()` (`shared/explain.ts`) is returned with every recommendation item: it only re-arranges the engine's text and picks the first feasible actionable option.
- The AI provider (optional) must return `recommended_option`; `validateExplanation()` rejects infeasible options (`safety_conflict`), non-existent options and any number not present in the calculation (`unsupported_claims`). Failures store an error and the UI keeps showing the rule-based summary.

### Demo sandbox (`server/demo.ts`)

- `/api/demo/start` creates a demo user (`is_demo = 1`, no usable password) and seeds four fictional outlets with ~1 100 sales rows, ~230 orders and ~1 800 order events using multi-row inserts (≈ 0.1–0.3 s locally). Every generated timeline is replayed through the real lifecycle validator; sold ≤ prepared is guaranteed and orders never exceed recorded sales.
- Scenario triggers (`/api/outlets/:oid/demo/scenarios/:n`) create simulated orders relative to "now" or run the engine and return where to navigate.
- Reset deletes only illustrative outlets owned by that demo user and reseeds. Expired demo users (24 h) are purged when new demos start.
