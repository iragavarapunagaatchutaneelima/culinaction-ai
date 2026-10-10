# CulinAction AI — Implementation Plan

_Created 10/10/2026 after inspecting the workspace. All phases below were completed on 10/10/2026; see BUILD_STATUS.md for what is and is not verified._

## Phase 0 findings (workspace inspection)

| Item                                 | Finding                                                                                                                                                 |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Existing project                     | None — `C:\Users\Ril\Desktop\hyd hack` was empty                                                                                                        |
| Git                                  | Not a git repository                                                                                                                                    |
| Runtime                              | Node.js v24.16.0, npm 11.13.0. Python not installed. pnpm not installed                                                                                 |
| Database                             | None configured. Node 24 ships `node:sqlite` (verified working) → no native build needed                                                                |
| Env vars                             | `ANTHROPIC_API_KEY` and `OPENAI_API_KEY` are **not set**. (Claude Code's own session variables exist but are not usable as an application runtime key.) |
| Auth / integrations / tests / README | None                                                                                                                                                    |
| Browsers                             | Microsoft Edge and Google Chrome installed → Playwright can drive the system browser without downloading one                                            |

## Stack decision

Single TypeScript package (no microservices):

- **Server**: Express 5, Zod validation, `node:sqlite` (file DB at `data/culinaction.db`), run with `tsx`.
- **Domain logic** (`shared/`): pure, framework-free TypeScript — units, money, forecasting, decision engine, CSV, plan state machine, metrics. Unit-tested in isolation.
- **Web**: React 19 + React Router + Vite, hand-written CSS design system, mobile-first, PWA manifest.
- **Tests**: Vitest (unit + integration with supertest), Playwright (E2E against system Edge/Chrome).

## Phases

| #   | Phase                  | Depends on | Acceptance criteria                                                                                                      |
| --- | ---------------------- | ---------- | ------------------------------------------------------------------------------------------------------------------------ |
| 0   | Inspect & plan         | —          | This file, BUILD_STATUS.md, ARCHITECTURE.md exist                                                                        |
| 1   | Baseline               | 0          | `npm install` succeeds; dev server and `npm run build` succeed; DB migrations apply                                      |
| 2   | Data model             | 1          | All entities migrated with FKs/indexes; money in integer paise; central unit conversion; unit tests pass                 |
| 3   | Decision engine        | 2          | Deterministic risks + options from persisted records; safety exclusion tested; ranking & ties tested                     |
| 4   | Core UI                | 2,3        | Onboarding, inventory, recipes, sales + CSV import, waste, outcomes, recommendations, plans, tasks all wired to real API |
| 5   | AI explanation         | 3          | Provider adapter with timeout, schema validation, error states; honest "not configured" when no key                      |
| 6   | Analytics, mobile, PWA | 4          | Metrics only from records; 360/390/desktop layouts verified; manifest served                                             |
| 7   | Test & fix             | all        | lint, typecheck, unit, integration, E2E, build executed and recorded                                                     |
| 8   | Submission             | 7          | README, TEST_REPORT, DEMO_SCRIPT, DATA_DICTIONARY reflect reality                                                        |

## Known risks

1. **No runtime AI key** — AI explanation cannot be verified live. Mitigation: adapter + error handling tested with injected transport; UI labels AI as "Not configured".
2. **`node:sqlite` is marked experimental in Node 24** — API could change in later Node versions. Mitigation: pin Node ≥ 22.13 in `engines`; data access isolated in `server/db`.
3. **No real restaurant data available** — the app ships with an empty workspace. An optional, clearly-labelled _illustrative_ outlet can be created for judging; it is flagged in the DB and bannered in every screen.
4. **Local single-user/small-team deployment only** — sessions are cookie-based on one machine; not production multi-tenant hardened.
5. **Unit conversion is limited to same-dimension units** (g↔kg, ml↔L, pc). Count↔mass conversions (e.g. "1 onion = 150 g") are rejected, not guessed.
