# API Reference

Base path `/api`. JSON in and out. Every non-GET request must send `X-CulinAction: 1`. Demo Mode requests also send `X-CulinAction-Mode: demo` (GET downloads may use `?mode=demo`). Errors: `{ "error": { "code", "message", "details?": { "fields": { … } } } }`.

Outlet-scoped routes are under `/api/outlets/:oid` and require membership (404 otherwise). Roles: **O** owner, **M** manager, **S** staff.

## Session

| Method | Path                           | Notes                                                      |
| ------ | ------------------------------ | ---------------------------------------------------------- |
| GET    | `/health`                      | `{ ok: true }`                                             |
| GET    | `/auth/state`                  | `{ needsSetup, user }` (Real Mode)                         |
| POST   | `/auth/setup`                  | First real account only                                    |
| POST   | `/auth/login` · `/auth/logout` |                                                            |
| GET    | `/auth/me`                     | User + outlets for the current mode                        |
| POST   | `/demo/start`                  | Creates (or resumes) a demo sandbox; sets `ca_demo` cookie |
| POST   | `/demo/reset`                  | Demo session only; regenerates this visitor's demo outlets |
| POST   | `/demo/end`                    | Ends the demo session                                      |

## Outlets & team

| Method              | Path                           | Roles                                                |
| ------------------- | ------------------------------ | ---------------------------------------------------- |
| POST                | `/outlets`                     | Real users only                                      |
| GET / PUT / DELETE  | `/outlets/:oid`                | GET all · PUT O · DELETE O (real) with `confirmName` |
| GET / POST / DELETE | `/outlets/:oid/members[/:uid]` | O (real)                                             |

## Inventory, menu, sales

| Method                    | Path                                                                                                | Roles                 |
| ------------------------- | --------------------------------------------------------------------------------------------------- | --------------------- |
| GET / POST                | `/ingredients`                                                                                      | GET all · POST O,M    |
| GET / PUT                 | `/ingredients/:id`                                                                                  |                       |
| POST                      | `/ingredients/:id/receipts` · `/consumption` · `/count` · `/archive`                                | O,M (consumption all) |
| POST                      | `/batches/:bid/adjust` · `/batches/:bid/flags` (`quarantined`, `qualityChecked`, `storageVerified`) |                       |
| GET                       | `/movements`                                                                                        |                       |
| GET / POST / PUT          | `/menu-items`, `/menu-items/:id`, `/menu-items/:id/recipe`                                          | write O,M             |
| GET / POST / PUT / DELETE | `/sales`, `/sales/:id`                                                                              | write O,M             |
| GET                       | `/sales/template.csv` · `/sales/forecast?date=` · `/sales/imports`                                  |                       |
| POST                      | `/sales/import/preview` → `/sales/import/:importId/commit`                                          | O,M                   |

## Orders & delivery

| Method    | Path                                               | Notes                                                                                      |
| --------- | -------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| GET       | `/orders?view=open\|recent\|all`                   | With durations, risk level, needs-disposition flag                                         |
| POST      | `/orders`                                          | `{ channel, placedAt, items[], estTravelMin?, packaging? }` — creates the "received" event |
| GET / PUT | `/orders/:id`                                      | Detail: events, durations, stage, allowed next events, risk factors                        |
| POST      | `/orders/:id/events`                               | `{ type, at, reason?, note? }` — validated transition, 409 if invalid                      |
| GET       | `/delivery/summary`                                | 7-day medians, open orders by risk, delay reasons                                          |
| GET       | `/orders/import/template.csv`                      |                                                                                            |
| POST      | `/orders/import/preview` · `/orders/import/commit` | Same CSV both times; commit re-validates                                                   |

## Decisions

| Method       | Path                                                       | Notes                                                                                 |
| ------------ | ---------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| POST         | `/recommendations/run`                                     | O,M · stores run, items, forecasts, order risk assessments                            |
| GET          | `/recommendations/latest` · `/recommendations/runs[/:rid]` |                                                                                       |
| GET          | `/recommendations/items/:iid`                              | Includes `ruleBased` deterministic summary                                            |
| POST         | `/recommendations/items/:iid/explain`                      | O,M · AI explanation (validated); 503 not configured, 502 provider/validation failure |
| POST         | `/whatif/prep`                                             | `{ menuItemId, date?, portions[] }` — read-only                                       |
| POST         | `/whatif/purchase`                                         | `{ ingredientId, qty, unit, useByDays? }` — read-only                                 |
| POST / GET   | `/plans`, `/plans/:pid`                                    | create from `{ runId, selections[{itemId, optionKey}] }`                              |
| PUT / DELETE | `/plans/:pid/lines/:lid`                                   | edit quantity / remove line                                                           |
| POST         | `/plans/:pid/submit\|approve\|reject\|cancel\|complete`    | reason required for reject/cancel                                                     |
| GET          | `/tasks?status=open\|done\|all`                            |                                                                                       |
| POST         | `/tasks/:tid/complete\|skip`                               | `{ actualQty?, notes?, qualityOk?, delayReason? }`                                    |
| POST         | `/demo/scenarios/:n`                                       | Demo session + demo outlet only; returns `{ navigate, message }`                      |

## Operations & insights

| Method     | Path                                                                                             | Notes                                                                   |
| ---------- | ------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------- |
| GET / POST | `/waste`                                                                                         | ingredient (deducts stock at batch cost) or menu item (recipe estimate) |
| GET / POST | `/outcomes`                                                                                      | prepared, sold, remaining, transferred, discarded                       |
| GET        | `/dashboard` · `/analytics?from&to` · `/ai/status` · `/audit`                                    |                                                                         |
| GET        | `/export/inventory.csv` · `sales.csv` · `waste.csv` · `outcomes.csv` · `orders.csv` · `all.json` |                                                                         |
