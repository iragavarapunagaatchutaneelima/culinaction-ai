# Build Status

_Last updated 10/10/2026 (v2). "Tested" = covered by automated tests that were executed and passed — see [TEST_REPORT.md](TEST_REPORT.md)._

## Completed

| Area                                                                                                                                                          | Tested                                                    |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| v1 core: auth, roles, outlets, inventory & batches, recipes, sales + CSV, forecast, waste, outcomes, decision engine, plans, tasks, analytics, exports, audit | Unit + integration + E2E                                  |
| Landing page (public, both modes, features, data integrity)                                                                                                   | E2E (incl. 360/390/768 px)                                |
| Demo Mode: per-visitor sandbox, 4 fictional outlets, labelled data, 6 scenarios, reset, isolation                                                             | Integration + E2E                                         |
| Real Mode protection, demo/real separation enforced by the server                                                                                             | Integration + E2E                                         |
| Waste categories (9), recorded vs estimated cost, surplus view, transferred portions                                                                          | Unit + integration                                        |
| Orders: lifecycle validation, events, CSV import, durations, stage, disposition                                                                               | Unit + integration + E2E                                  |
| Delivery quality-risk engine and stored assessments                                                                                                           | Unit + integration + E2E                                  |
| New recommendations: pickup delay, order disposition, kitchen bottleneck, storage check                                                                       | Unit + integration + E2E                                  |
| What-if simulator (preparation + purchasing)                                                                                                                  | Unit + integration + E2E                                  |
| Approval queue, outcome verification screens                                                                                                                  | E2E                                                       |
| AI: validated structured output, safety-conflict / unsupported-claim rejection, rule-based fallback                                                           | Unit + integration (fixtures)                             |
| Light / dark / system themes across all screens                                                                                                               | E2E (dark backgrounds verified on 6 screens)              |
| Vercel packaging (Build Output API) + Turso driver                                                                                                            | Integration via libSQL engine; E2E against bundled output |
| Documentation (README, architecture, API, security, deployment, demo guide, food-safety rules, data dictionary, audit, test report)                           | —                                                         |

## Blocked

- **Live deployment**: needs the account owner to sign in to Vercel and create a Turso database ([DEPLOYMENT.md](DEPLOYMENT.md)).
- **Live AI verification**: needs an `ANTHROPIC_API_KEY`.

## Not built (documented as limitations)

POS / delivery-platform / supplier integrations, temperature sensors, sub-recipes, multi-timezone, password reset / 2FA, Telugu localisation.
