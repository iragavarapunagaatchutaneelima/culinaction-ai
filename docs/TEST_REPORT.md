# Test Report

**Run date:** 10/10/2026 · Windows 11 · Node v24.16.0 · npm 11.13.0 · Google Chrome (system install) for E2E. Every result below comes from commands actually executed in this environment.

## Summary (v2, final run)

| Check                                              | Command                           | Result                          |
| -------------------------------------------------- | --------------------------------- | ------------------------------- |
| Formatting                                         | `npm run format:check`            | ✅ all files use Prettier style |
| Lint (incl. type-aware promise rules on `server/`) | `npm run lint`                    | ✅ 0 errors, 0 warnings         |
| Type check                                         | `npm run typecheck`               | ✅ no errors                    |
| Unit                                               | `npm run test:unit`               | ✅ 7 files, **81 passed**       |
| Integration (node:sqlite)                          | `npm run test:integration`        | ✅ 2 files, **35 passed**       |
| Integration (libSQL / Turso driver)                | `npm run test:integration:libsql` | ✅ 2 files, **35 passed**       |
| Production build                                   | `npm run build`                   | ✅                              |
| End-to-end, production server                      | `npm run test:e2e`                | ✅ **21 passed**                |
| End-to-end, bundled Vercel output                  | `npm run test:e2e:vercel`         | ✅ **21 passed**                |

Baseline before the v2 upgrade (commit `c86131d`): 78 unit + integration tests, 11 E2E, 21 libSQL integration — all passing ([TECHNICAL_AUDIT.md](TECHNICAL_AUDIT.md)).

## What the tests cover

### Unit (81)

- Units, money, dates (12), food-safety statuses and forecasting (9), CSV / plan state machine / metrics (16), decision engine and ranking (14), AI adapter error paths (6) — carried over from v1.
- **Order lifecycle (7):** valid replay; first event must be "received"; skipped steps rejected; backwards and future timestamps rejected; rider assignment once; durations only from recorded timestamps (missing → null); ongoing pickup wait measured to now; cancellation stages.
- **Delivery risk (5):** low within thresholds; moderate at the warning wait; high when projected hold exceeds the verified limit; missing information reported (unverified limit, no travel estimate, no packaging); insufficient information with no usable timestamps.
- **Engine delivery/order rules (5):** pickup delay escalates to tier 1 with manager review when the verified limit is exceeded; uncollected prepared order → disposal + hold-only-within-limit (infeasible after the limit); returned food never held or re-served; no disposition for never-prepared or already-disposed orders; expiring batch requires a storage check before use.
- **What-if (5):** ingredient use, remaining stock, shortfall, max portions, cost; replay against comparable days; no history when insufficient; purchase cover and FIFO expiry exposure; no guessing without daily use.
- **Rule-based explanation (2):** only re-uses engine text; picks the first feasible actionable option (never an infeasible one).

### Integration (35 per driver; real Express app + real database file per test)

- v1 (21): CSRF/session, sign-in throttle, cross-outlet isolation and roles, inventory movements, unit validation, expired stock never consumed, CSV formula injection, recipes and costing, sales import review, full decision workflow, rejection reason, discard tasks, infeasible options, AI not configured, provider 500/429/401, persistence across restart, cascading outlet deletion.
- **Demo mode (4):** starts without an account with 4 flagged outlets; demo rows labelled `illustrative`; real first-time setup still works with demo users present; real users cannot see demo outlets; demo users blocked from real-only actions and password sign-in; **reset regenerates only that visitor's outlets — real data and another visitor's sandbox untouched**; scenarios 1–5 produce the expected records and are refused for real outlets.
- **Orders (3):** validated lifecycle via the API with duration and risk results; CSV import of order events (6 valid / 3 invalid rows, durations, delay reasons); disposal task records categorised waste at recipe cost, closes the order and cannot be repeated.
- **What-if (1):** refuses unverified recipes; calculations from persisted records; incompatible purchase unit rejected.
- **AI validation with fixture responses (4):** valid evidence-grounded explanation accepted; option blocked by a constraint → `safety_conflict`, rule-based summary still served; unsupported quantity or non-existent option → `unsupported_claims`; malformed output → `invalid_output` and the rest of the app unaffected.
- **Outcomes (1):** transferred portions recorded; over-accounting rejected; discards logged as `unsold_cooked`.
- **Regression (2):** blank handling fields accepted as "not specified"; disposition counts only include orders whose food was prepared.

### End-to-end (21, system Chrome, fresh database)

- v1 workflow (10): onboarding, empty states, inventory (incl. keyboard Escape), recipes, sales CSV import, decision → plan → approve → task → outcome → analytics, rejection, not-found pages, 360 px and 390 px layouts (18 screens each, no horizontal overflow, ≥ 44 px touch targets).
- **Landing (4):** opens without login, both calls to action, theme toggle (dark background verified, persisted across reload, system mode), Real Mode entry protected; no horizontal overflow at 360 / 390 / 768 px.
- **Demo journeys (5):** food-waste journey (scenario 1 → evidence → approve → task → outcome with transferred/discarded → verification); delivery journey (scenario 4 → timeline and high risk → recommended action → approve → task with delay reason → record pickup on the timeline); uncollected order (no resale) and what-if comparison; reset + Real Mode cannot open a demo outlet; dark theme across 5 demo screens.
- **Responsive demo (2):** 9 demo screens plus order detail at 360 and 390 px without horizontal overflow.

The same 21 tests also pass against the bundled Vercel output (`scripts/vercel-local.mjs` reproduces the production routing).

## Defects found by testing during v2 and fixed

| Found by           | Defect                                                                                                            | Fix                                                                            |
| ------------------ | ----------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| Demo smoke test    | Preparation-surplus rule compared per-service outcomes with the whole-day forecast, so scenario 1 never triggered | Outcomes summed per day before comparison (assumption documented)              |
| Code review        | First-time owner setup counted demo visitors, so one demo visit would block it                                    | Setup counts real users only; covered by an integration test                   |
| E2E (360 px)       | Order detail overflowed by 84–114 px (non-wrapping risk values)                                                   | Values wrap                                                                    |
| E2E                | Menu dialog sent blank handling fields as `''` → rejected (0 minutes)                                             | Server treats blank as "not specified"; regression test                        |
| Visual review      | Dashboard counted orders cancelled before preparation as needing a food disposition                               | Uses the same "prepared but not delivered" rule as the engine; regression test |
| E2E (intermittent) | A navigation failed with `ERR_FAILED` when the service worker's network request failed with no cached shell       | Service worker retries the network once; cache version bumped                  |

## Visual validation

Screenshots from the E2E runs (`test-results/screens/`, git-ignored) were inspected: landing page in light and dark, demo scenarios, surplus evidence, order timeline and risk, what-if, outcome verification, dark dashboard, and 360 px order detail. Both themes had readable contrast and consistent structure. The issues found are listed above and were fixed. Chart colours were validated with the dataviz palette validator for the light surface (`#1F7A53` / `#C27A12`) and the dark surface (`#2F9D69` / `#BF7A1A`): lightness, chroma, colour-vision-deficiency separation and contrast all passed.

## Not verified

- **Live AI provider**: no `ANTHROPIC_API_KEY` was available. AI behaviour is tested only with fixture responses at the HTTP boundary.
- **Live Turso / Vercel deployment**: needs the account owner's Vercel and Turso logins ([DEPLOYMENT.md](DEPLOYMENT.md)). The libSQL driver is tested through the local libSQL engine, and the Vercel bundle and routing through local emulation, but not the real HTTP connection to Turso.
- Android device installation, screen readers, load and concurrency testing.
