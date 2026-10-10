# CulinAction AI — Architecture

## Overview

```
 Browser (React SPA, PWA manifest)            Server (Express 5, Node 24)                 Storage
 ─────────────────────────────────            ──────────────────────────────              ─────────────
 pages/ ── api.ts ──fetch /api/*──────────►   auth middleware (session cookie,           data/culinaction.db
                     X-CulinAction header      role + outlet membership checks)           (node:sqlite, WAL,
                                               │                                          foreign_keys=ON)
                                               ├─ routes/* (Zod-validated)  ───────────►
                                               ├─ shared/engine.ts  (pure, deterministic)
                                               ├─ shared/forecast.ts, units.ts, money.ts
                                               └─ server/ai/provider.ts ──HTTPS──► Anthropic Messages API
                                                    (only when ANTHROPIC_API_KEY is set; explicit user action)
```

- **One process**. In development Vite serves the SPA on :5173 and proxies `/api` to Express on :8787. In production Express serves `dist/web` and the API from one port.
- **`shared/`** contains pure functions with no I/O. The server loads rows from SQLite, maps them to plain objects and calls the engine. This keeps the trusted arithmetic testable without a database.

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
