# Build Status

_Last updated 10/10/2026. "Tested" means covered by an automated test that was run and passed (see [TEST_REPORT.md](TEST_REPORT.md))._

## Phases

- [x] Phase 0: workspace inspected, plan and architecture documented
- [x] Phase 1: baseline (dependencies, migrations, dev server, production build)
- [x] Phase 2: data model (17 tables, FKs, indexes, paise money, central units)
- [x] Phase 3: decision engine (deterministic risks, options, ranking, safety filter)
- [x] Phase 4: core UI (all 19 required screens wired to the real API)
- [x] Phase 5: AI explanation layer. **Implemented, but not verified live** (no API key available)
- [x] Phase 6: analytics, mobile layouts, PWA manifest and service worker
- [x] Phase 7: full test run (format, lint, typecheck, 57 unit, 20 integration, 11 E2E, build)
- [x] Phase 8: README, data dictionary, test report, demo script

## Feature checklist

| Area                                                                                                                                   | Status | Tested                                                |
| -------------------------------------------------------------------------------------------------------------------------------------- | ------ | ----------------------------------------------------- |
| Owner setup, sign-in, sessions, sign-in throttle                                                                                       | Done   | Integration + E2E                                     |
| Server-side roles (owner/manager/staff), outlet membership, CSRF header                                                                | Done   | Integration                                           |
| Outlet profile, service periods, decision-rule settings                                                                                | Done   | E2E (create)                                          |
| Team members                                                                                                                           | Done   | Integration                                           |
| Ingredients: add/edit/archive, search, filter, sort                                                                                    | Done   | Integration + E2E (add/edit)                          |
| Batches with use-by / expiry / best-before (never inferred)                                                                            | Done   | Unit + integration                                    |
| Receipts, consumption (usable stock only), batch adjustment, physical count                                                            | Done   | Integration + E2E                                     |
| Mark unsafe / quality check                                                                                                            | Done   | Unit (safety rules); UI used manually                 |
| Stock movement history                                                                                                                 | Done   | Integration + E2E                                     |
| Menu items, recipes, loss %, verification, cost per portion, shared ingredients                                                        | Done   | Unit + integration + E2E                              |
| Sales: manual entry, edit, delete                                                                                                      | Done   | Integration (create)                                  |
| Sales CSV template, preview, validation, duplicates, confirm, summary                                                                  | Done   | Unit + integration + E2E                              |
| Demand baseline with method, range and days shown                                                                                      | Done   | Unit + E2E                                            |
| Waste logging (ingredient with stock deduction / dish with estimated cost)                                                             | Done   | Integration (via outcome and discard task)            |
| Service outcomes (+ optional sales record and ingredient deduction)                                                                    | Done   | Integration + E2E                                     |
| Decision engine: unsafe stock, best-before check, stockout, expiry-waste, prep adjustment, excess stock, forecast deviation, data gaps | Done   | Unit + integration                                    |
| Evidence and calculation view, missing info, safety checks                                                                             | Done   | E2E                                                   |
| Plans: draft → submit → approve/reject/cancel → complete, line edits, history                                                          | Done   | Unit + integration + E2E                              |
| Tasks with real effects (discard → waste and stock; count → adjustment; quality check)                                                 | Done   | Integration + E2E                                     |
| Analytics: recorded vs estimated waste, waste per 100, forecast error, observed prep outcomes                                          | Done   | Unit + integration + E2E                              |
| AI explanation (Anthropic SDK, structured output, timeout, error mapping, number check)                                                | Done   | Error paths only (unit + integration)                 |
| Exports (CSV with formula-injection protection, full JSON), audit log, outlet deletion                                                 | Done   | Integration (CSV)                                     |
| Illustrative workspace (separate, flagged, bannered)                                                                                   | Done   | Integration + E2E                                     |
| Mobile 360/390 px, bottom navigation, no horizontal overflow                                                                           | Done   | E2E                                                   |
| PWA manifest, icons, shell-only service worker                                                                                         | Done   | Served (HTTP check); install not verified on a device |

## Blocked / not done

- **Live AI verification**: blocked on an `ANTHROPIC_API_KEY`.
- **Android install test**: needs a physical device or emulator.
- **Not built** (out of MVP scope, documented in README): POS and delivery-platform integrations, supplier ordering, sub-recipes, count-to-weight conversions, multi-timezone, password reset, Telugu localisation.
