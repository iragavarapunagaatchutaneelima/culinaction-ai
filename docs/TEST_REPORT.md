# Test Report

**Run date:** 10/10/2026 · Windows 11 · Node v24.16.0 · npm 11.13.0 · Google Chrome (system install) for E2E.

All results below come from commands that were actually executed in this environment.

## Summary

| Check             | Command                    | Result                                                                                                                                                             |
| ----------------- | -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Formatting        | `npm run format:check`     | ✅ "All matched files use Prettier code style!"                                                                                                                    |
| Lint              | `npm run lint`             | ✅ 0 errors, 0 warnings                                                                                                                                            |
| Type check        | `npm run typecheck`        | ✅ no errors (server, shared, web, tests)                                                                                                                          |
| Unit tests        | `npm run test:unit`        | ✅ 5 files, **57 passed**                                                                                                                                          |
| Integration tests | `npm run test:integration` | ✅ 1 file, **20 passed**                                                                                                                                           |
| Production build  | `npm run build`            | ✅ `tsc --noEmit` + Vite build (JS ≈ 413 kB, 121 kB gzip)                                                                                                          |
| End-to-end        | `npm run test:e2e`         | ✅ **11 passed** (≈1.1 min)                                                                                                                                        |
| DB init           | `npm run db:migrate`       | ✅ "Applied migrations: 1" on a fresh file; reports "Schema already up to date" on re-run                                                                          |
| Production start  | `npm start` (port 8790)    | ✅ `/api/health` → `{"ok":true}`; SPA route 200; manifest 200 `application/manifest+json`; `/sw.js` 200; unauthenticated API → 401; POST without CSRF header → 403 |

## Unit tests (57)

- **Units, money, dates (12):** conversions within a dimension; incompatible and unknown units rejected; mixed compatible units added; purchase rounding; exact rupee → paise parsing; half-away-from-zero rounding; fractional unit costs; Indian digit grouping; ISO and DD/MM/YYYY parsing; date arithmetic; "today" in Asia/Kolkata across the UTC day boundary.
- **Food safety and forecasting (9):** missing dates are not invented; past use-by and expiry dates are excluded; the warning window; best-before requires a same-day check; quarantine overrides everything; same-weekday average; trading days count as zero sales for an item; fallback to recent days; insufficient-data handling; future sales ignored.
- **CSV, plan states, metrics (16):** RFC 4180 parsing; unterminated quotes; formula-injection escaping; valid rows in both date formats; missing columns; invalid date, quantity, unknown item and price rows reported without being dropped; duplicates within the file and against existing records; future dates; allowed and invalid plan transitions; required reasons; role enforcement; waste per 100 portions only with a valid denominator; recorded vs estimated waste cost; forecast error; baseline comparison only with ≥ 3 prior outcomes.
- **Decision engine (14):** unsafe stock excluded and weighted cost; unsafe stock is tier 1 with no "use" option; stockout from recipe × forecast (exact kg, purchase qty, cost, revenue at risk, confidence); loss factor; shared ingredients aggregated; unverified recipes excluded and reported; incompatible recipe units reported instead of converted; FIFO expiry risk with 3 alternatives; infeasible option when no verified recipe uses the ingredient; preparation adjustment from outcomes; no demand-based recommendations without sales history; deterministic output; ranking order; deterministic tie-breaking.
- **AI adapter (6):** not configured without a key; unsupported provider; non-JSON output discarded; schema-mismatched JSON discarded; timeout instead of a hang; numbers not present in the input are flagged.

## Integration tests (20), real Express app and real SQLite file per test

- CSRF header required; no session → 401; second setup → 409.
- Wrong passwords → 401, and the 6th attempt is throttled (429).
- **Cross-outlet access prevented:** another outlet's data → 404; staff cannot create ingredients or run the engine (403).
- Inventory: create with opening stock, edit, receipt, consumption, physical count; movement history persisted in order with reasons.
- Incompatible units, negative quantities and half-entered dates → 400 with field errors.
- Expired stock can never be consumed (409).
- CSV export escapes `=HYPERLINK(...)`.
- Recipe: incompatible unit rejected; cost per portion ₹18.00 and food cost 10% computed.
- Sales import: preview of 7 rows → 2 valid / 3 invalid / 1 duplicate in file / 1 duplicate of an existing record; nothing saved before commit; only valid rows saved; a second commit → 409; missing columns → 400.
- **Full workflow:** engine on persisted data → stockout recommendation with evidence → draft plan → line edit → approve blocked before submit → staff cannot approve → approve keeps original and edited quantities plus history → staff completes the task (actual quantity required) → plan auto-completes → outcome deducts ingredients and records sales → analytics: waste per 100, recorded vs estimated cost, and no baseline claim without history → audit entries present.
- Reject requires a reason, and the reason is stored in history.
- Discard task removes expired stock and records waste at the actual batch cost (₹124.00).
- An infeasible option cannot be planned.
- AI not configured → 503 with an honest status; provider HTTP 500/429/401 → 502 with typed status, **no explanation stored**, status recorded.
- **Data persists across an application restart** (DB closed and reopened, login and data intact).
- The illustrative workspace is separate from real outlets and produces safety, quality and data-gap recommendations.

## End-to-end tests (11), Playwright with system Chrome, production build, fresh DB

1. Onboarding: empty-form validation, password mismatch, outlet form validation, outlet created → Today.
2. Empty states for tasks, recommendations, inventory and analytics ("Not enough data").
3. Inventory: invalid quantity message, add with stock (₹90.00/kg shown), edit supplier, record use requires a reason, stock 3.5 kg; **Escape closes the dialog** (keyboard).
4. Menu: item + verified recipe; ingredient cost ₹18.00 shown.
5. CSV import through the file picker: unknown item reported; 21 valid rows imported; 2 rows reported as not imported; forecast method visible.
6. Decisions: run engine; open evidence; calculation line visible; "AI explanation is not configured" shown; choose option B; edit 17 → 16; submit; approve; task created; completing without a quantity is blocked; complete; record outcome (sales recorded, ingredients deducted); analytics shows the "needs ≥ 3 earlier outcomes" message instead of a saving.
7. Rejection is disabled until a reason is typed; the reason is shown afterwards.
8. Unknown outlet → "Not found"; unknown page → "Page not found".
9. **360 px** and 10. **390 px**: bottom navigation, the More sheet, and **no horizontal overflow on 13 screens**; bottom-bar touch targets ≥ 44 px.
10. Illustrative workspace banner on every page; safety recommendations appear.

Screenshots from the run are written to `test-results/screens/` (git-ignored).

## Defects found by testing and fixed

| Found by         | Defect                                                                           | Fix                                                                    |
| ---------------- | -------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| Integration test | `POST /api/outlets/illustrative` was captured by the `/:oid` route (404)         | Mounted the outlets router before the outlet-scoped router             |
| Preview run      | The dev API picked up `PORT=5173` set by the preview tool and collided with Vite | `API_PORT` takes precedence; dev scripts set `API_PORT=8787`           |
| E2E (360 px)     | Sales page overflowed horizontally by 230 px                                     | Grid children get `min-width: 0` so tables scroll inside their wrapper |
| E2E              | "Done" filter tab and "Done" task button had the same accessible name            | Task buttons renamed "Mark done", with per-task accessible labels      |

## Not verified

- **A live AI provider call** was never made (no `ANTHROPIC_API_KEY` available). Only error paths and validation are tested, using injected transports.
- **Android device installation of the PWA.** The manifest, icons and service worker are served correctly, but installation on a phone was not tested. Mobile layouts were verified only by viewport emulation in desktop Chrome.
- Screen-reader testing with NVDA/TalkBack was not performed. Keyboard checks were limited to dialog Escape and focus handling.
- Load and concurrency testing were not performed.
