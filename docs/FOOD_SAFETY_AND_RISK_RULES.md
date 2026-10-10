# Food-Safety and Risk Rules

CulinAction applies **rules that the outlet configures and verifies**. It does not measure food, does not know temperatures, and does not certify safety or regulatory compliance. Follow your FSSAI-compliant procedures; these rules only make sure recorded information is never ignored or overridden.

All rules live in pure, unit-tested modules in `shared/`.

## 1. Ingredient batches (`shared/safety.ts`)

| Status                       | Rule                                                                              | Usable in calculations?                     |
| ---------------------------- | --------------------------------------------------------------------------------- | ------------------------------------------- |
| **Do not use** (`unsafe`)    | Use-by or expiry date is before today, **or** an operator marked the batch unsafe | **Never** — a hard filter, not a score      |
| **Check quality** (`verify`) | Best-before date has passed and no quality check was recorded **today**           | No, until an operator records today's check |
| **Use soon** (`expiring`)    | Use-by / expiry within the outlet's warning window (default 2 days)               | Yes                                         |
| **Usable** (`ok`)            | Otherwise, including "no date supplied"                                           | Yes; missing dates are shown as missing     |

- Dates are stored exactly as entered; a missing date is never inferred.
- Consumption only ever draws from usable batches (earliest date first). Recording waste may draw from any batch.
- **Storage check before use (v2):** when a recommendation proposes using a batch that is near its date, the plan includes a mandatory "confirm this lot has been stored as required" task unless an operator recorded a storage check for that batch today. A date alone is never treated as proof of safety.

## 2. Recommendations never propose unsafe use (`shared/engine.ts`)

- Excluded batches are removed from usable stock before any other calculation.
- No option can contain an action that consumes an excluded batch.
- "Prioritise dishes" options only use **existing verified recipes**; no new recipes are invented.
- Allergen text is shown exactly as recorded, with its verified/unverified status; the engine never infers allergen safety.

## 3. Cancelled, uncollected and returned orders

Food is only considered for a disposition when it was actually prepared (`preparedButUndelivered` in `shared/orders.ts`). Options offered:

| Option                                  | When it is offered                                                                                                                                                 |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Record disposal as waste**            | Always. Completing the task records waste (reason: cancelled order / uncollected order / customer-returned food) at the recipe-cost estimate and closes the order. |
| **Hold for re-collection until _time_** | Only if **every** item has a verified handling limit, preparation-completed time is recorded, and the limit has not passed. Never for returned food.               |

CulinAction **never** suggests reselling, reusing or donating cancelled/uncollected food, and **never** suggests serving customer-returned food to another customer.

## 4. Delivery quality-risk rules (`shared/deliveryRisk.ts`)

Inputs are only recorded data: order events (received, prep started/completed, pack started/completed, ready, picked up, delivered…), the estimated travel time **entered by staff**, packaging text, and per-dish **verified** handling limits ("max minutes from preparation to customer"). There is no traffic, GPS, rider-location or temperature data.

| Factor                                                                      | Moderate                                            | High                              |
| --------------------------------------------------------------------------- | --------------------------------------------------- | --------------------------------- |
| Preparation time (prep started → completed)                                 | > outlet preparation guideline (default 25 min)     | —                                 |
| Waiting for pickup (ready → picked up, or → now while waiting)              | ≥ warning threshold (default 10 min)                | ≥ high threshold (default 20 min) |
| Time since preparation, projected to delivery when a travel estimate exists | ≥ 80 % of the strictest **verified** handling limit | > the verified handling limit     |
| Total time (received → delivered or now)                                    | > delivery target (default 45 min)                  | —                                 |

- The level is the highest triggered level. Each factor is listed with its value and the threshold it was compared with.
- If no time-based factor can be computed → **Insufficient information** (never "low").
- Missing information (unverified handling limits, no travel estimate, no packaging for hot/cold food, missing prep-completed time) is listed explicitly.
- Packaging and delay reasons are displayed but do not change the level (no verified rule exists for them).
- When a verified handling limit is exceeded, the recommendation is escalated to **tier 1** and its first option is **manager review before hand-over** — CulinAction does not decide whether to hand the order over.
- Nothing is dispatched, cancelled or sent to a platform automatically.

## 5. Order lifecycle rules (`shared/orders.ts`)

- The first event must be "Order received". Events must follow allowed transitions (e.g. "Picked up" only after "Ready for pickup").
- Event times may not go backwards or be in the future (5-minute tolerance).
- Durations are computed only between recorded timestamps; a missing timestamp leaves the duration blank.

## 6. AI explanation constraints (`server/ai/provider.ts`)

An AI explanation is **discarded** (and the rule-based summary shown instead) if it:

- favours an option the engine marked not feasible (`safety_conflict`),
- refers to an option that does not exist, or states any number not present in the calculation (`unsupported_claims`),
- is malformed, cut off, refused, or the provider fails (timeout, rate limit, auth, network).

The AI never changes quantities, never approves anything and is never asked whether food is safe.
