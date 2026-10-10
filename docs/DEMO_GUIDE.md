# Demo Guide (judges)

**Everything in Demo Mode is fictional.** The four outlets, their stock, recipes, prices, sales, orders and outcomes are generated sample data. Simulated events (a delayed or uncollected order) are created when you trigger a scenario. Nothing is a real Hyderabad restaurant, a live integration or a real result. The orange **DEMO MODE** bar is on every demo screen.

No account and no API key are needed. Your sandbox is private to your browser, expires after 24 hours, and **Reset demo** regenerates it at any time without affecting real data.

## Start (30 seconds)

1. Open the site → **Explore interactive demo**.
2. Four outlets appear: Charminar Biryani House (biryani), Udupi Tiffin Corner (breakfast), Banjara Brew Café (café), Secunderabad Bake Studio (bakery).
3. Choose **Guided scenarios** on any outlet. Each scenario card says what it shows and what to expect.

## Scenario walkthrough

| #                          | Do                                                                            | Expected result                                                                                                                                                                                                                                                                                                                                                                                      |
| -------------------------- | ----------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1 · Excess biryani         | _Start scenario 1_                                                            | "Prepare fewer Chicken Dum Biryani (recent avg 108, forecast ≈ 70–91)". Three options (average forecast / highest comparable day / keep). Evidence: the last 7 recorded services (prepared, sold, kept or transferred, discarded), the recipe quantities, the sales days used. The ingredient cost of over-preparation is labelled **Estimate**.                                                     |
| → approve                  | Click option A → _Create draft plan_ → _Submit for approval_ → _Approve_      | Plan shows original vs approved quantity and an approval history. A kitchen task is created.                                                                                                                                                                                                                                                                                                         |
| → act                      | _Open checklist_ → _Mark done_ → enter the portions actually prepared         | Task done; "Record outcome now" appears.                                                                                                                                                                                                                                                                                                                                                             |
| → verify                   | _Record outcome now_ → enter sold, transferred and discarded → _Save outcome_ | Effects listed (sales recorded, waste logged as "unsold cooked food" at recipe-cost estimate). **Outcome verification** shows approved vs prepared vs sold vs discarded next to the earlier average. It is labelled an observation, not proven savings.                                                                                                                                              |
| 2 · Ingredient near use-by | _Start scenario 2_ (bakery fresh cream)                                       | Quantity at risk (earliest-date-first), affected verified recipes, options: prioritise existing dishes / reduce next purchase / re-check on the date. Option A begins with a **storage check** task because storage was not confirmed. Expired stock is never offered.                                                                                                                               |
| 3 · Uncollected order      | _Start scenario 3_                                                            | A simulated packed order marked not collected. Options: **record disposal as waste**, or **hold for re-collection** only until the verified handling limit. Resale or donation is never suggested.                                                                                                                                                                                                   |
| 4 · Pickup delay           | _Start scenario 4_                                                            | Order timeline with a duration bar (prep / pack / waiting), every event with time and gaps, **High risk** with each factor and threshold (waiting 26 min ≥ 20; held 30 min ≈ 50 min at delivery vs verified 30-min limit). _Review recommended actions_ → option C "Manager review before hand-over" (tier 1). Approve → complete the task with a delay reason → record "Picked up" on the timeline. |
| 5 · What-if                | _Start scenario 5_ → _Compare quantities_                                     | Forecast with the comparable days, then a comparison table: usable stock, ingredient cost, comparable days on which each quantity would have run short, average surplus/shortfall (estimates). Ingredient table shows what each quantity uses and leaves. Purchase simulator below: days of cover and quantity likely unused before its date.                                                        |
| 6 · Verification           | _Start scenario 6_                                                            | The completed demo-history plan (Upma reduced from 50 to 40 at the tiffin outlet) with its recorded outcome next to the earlier services, plus any plans you completed.                                                                                                                                                                                                                              |

## Things worth pointing out

- **Rule-based summary (No AI)** on every recommendation. The AI panel says plainly that AI is not configured; with a key, AI text is checked and discarded if it invents numbers or favours an infeasible option.
- **Dashboard**: orders waiting for pickup, elevated-risk orders (click through), recorded waste by category for 7 days (Actual vs Estimate), recent outcomes, safety checks.
- **Light / dark / system theme** — switch in the header; works on every screen.
- **Phone width** — bottom navigation (Today, Orders, Decide, Tasks, More).
- **Reset demo** — returns everything to the starting data.

## What is and is not proven

- Proven by automated tests: the calculations, lifecycle rules, safety constraints, approval workflow, demo/real isolation and the UI journeys above.
- Not proven: any real-world saving. That requires a real outlet recording its own data for several weeks in Real Mode.
