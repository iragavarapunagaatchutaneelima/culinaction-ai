# Data Dictionary

SQLite schema (migration v1, `server/db/migrations.ts`). Foreign keys are enforced (`PRAGMA foreign_keys = ON`). Timestamps are ISO-8601 UTC. Business dates are `YYYY-MM-DD` in Asia/Kolkata.

**Conventions**

- **Money** is stored as INTEGER **paise** (`*_paise`). Unit costs are REAL paise per **base unit**, because ₹/g is fractional.
- **Quantities** are stored as REAL in the ingredient's **base unit**: `g`, `ml` or `pc`. Menu-item quantities are in portions.
- **`source`** records provenance: `manual`, `csv_import`, `service_outcome`, `task`, `adjustment`, or `illustrative` (synthetic sample data).

## Identity & access

| Table            | Key columns                                                            | Notes                                       |
| ---------------- | ---------------------------------------------------------------------- | ------------------------------------------- |
| `users`          | `username` (unique, case-insensitive), `display_name`, `password_hash` | scrypt hash. No email or phone is collected |
| `sessions`       | `token_hash` (SHA-256 of cookie token), `user_id`, `expires_at`        | 14-day sessions                             |
| `outlet_members` | `outlet_id`, `user_id`, `role` (`owner`/`manager`/`staff`)             | Authorisation source for every outlet route |

## Outlet

| Column                                                                                          | Meaning                                                    |
| ----------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| `name`, `outlet_type` (`cafe`, `bakery`, `tiffin`, `biryani`, `restaurant`), `city`, `locality` | Profile                                                    |
| `timezone` (`Asia/Kolkata`), `currency` (`INR`), `preferred_mass_unit`, `preferred_volume_unit` | Regional settings                                          |
| `service_periods`                                                                               | JSON array of names, e.g. `["Breakfast","Lunch"]`          |
| `expiry_warn_days`                                                                              | Use-by/expiry within this many days → "use soon"           |
| `excess_cover_days`                                                                             | Stock beyond this many days of forecast use → excess       |
| `stale_count_days`                                                                              | Stock not counted or received for this long → recount task |
| `purchase_buffer_pct`                                                                           | Added to the shortfall when suggesting purchases           |
| `managers_can_approve`                                                                          | 0 = only the owner approves plans                          |
| `is_illustrative`                                                                               | 1 = synthetic demo workspace                               |

## Inventory

| Table               | Columns                                                                                                                                                                                                                                                                                           |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ingredients`       | `name` (unique per outlet), `category`, `base_unit` (`g`/`ml`/`pc`), `storage_notes`, `supplier_name`, `last_counted_at` (last count or receipt), `archived`                                                                                                                                      |
| `inventory_batches` | `lot_code`, `qty_received`, `qty_remaining` (≥ 0), `unit_cost_paise` (per base unit, nullable), `total_cost_paise` (bill amount, nullable), `received_on`, `date_type` (`use_by`/`expiry`/`best_before`, nullable), `date_value` (nullable; both or neither), `quarantined`, `quality_checked_on` |
| `stock_movements`   | `movement_type` (`receipt`, `adjustment`, `consumption`, `waste`, `count`), `qty_delta` (signed, base unit), `reason` (required), `batch_id`, `reference_type`/`reference_id`, `user_id`                                                                                                          |

Current stock is the sum of `qty_remaining` across batches. Every change writes a movement.

## Menu & recipes

| Table                | Columns                                                                                                                                |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `menu_items`         | `name` (unique per outlet), `category`, `price_paise` (nullable), `allergens` (free text, as supplied), `allergens_verified`, `active` |
| `recipes`            | One per menu item: `yield_portions`, `notes`, `verified`, `verified_by`, `verified_at`                                                 |
| `recipe_ingredients` | `ingredient_id`, `qty` (> 0), `unit` (must be compatible with the ingredient's base unit), `loss_pct` (0–99)                           |

The gross quantity per serving is `toBase(qty, unit) ÷ (1 − loss_pct/100)`.

## Sales

| Table           | Columns                                                                                                                                                         |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `sales_records` | `sale_date`, `menu_item_id`, `service_period` ('' = whole day), `qty`, `unit_price_paise`, `source`, `import_id`. Unique on (outlet, date, item, lower(period)) |
| `sales_imports` | `filename`, `status` (`previewed`/`committed`), row counts, `payload` (validated rows JSON), `imported_rows`                                                    |

## Waste & outcomes

| Table              | Columns                                                                                                                                                                                                                                                                                                                                                                       |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `waste_logs`       | `subject_type` (`ingredient`/`menu_item`), `ingredient_id`/`menu_item_id`, `batch_id`, `qty`, `unit`, `qty_base`, `occurred_at`, `business_date`, `reason` (`expired`, `over_preparation`, `spoilage`, `prep_trim`, `returned`, `other`), `cost_paise`, `cost_basis` (`batch_cost` = actual bill cost; `recipe_estimate` = estimate; NULL = unknown), `outcome_id`, `task_id` |
| `service_outcomes` | `business_date`, `service_period`, `menu_item_id`, `qty_prepared`, `qty_sold`, `qty_remaining`, `qty_discarded` (sold + remaining + discarded ≤ prepared), `task_id`. Unique per date, period and item                                                                                                                                                                        |

## Decisions

| Table                  | Columns                                                                                                                                                                                                                                                                |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `recommendation_runs`  | `plan_date`, `business_today`, `engine_version`, `summary_json`, `stock_json`                                                                                                                                                                                          |
| `recommendation_items` | `position` (rank), `rec_key`, `kind`, `severity_tier`, `title`, `estimated_impact_paise`, `confidence`, `payload_json` (full recommendation incl. evidence, calculation and options), `ai_status`, `ai_explanation_json`, `ai_error`, `ai_model`, `ai_generated_at`    |
| `forecast_snapshots`   | Forecast per run, date and item: `method`, `forecast_mean/min/max`, `days_used`. Used later for forecast-vs-actual                                                                                                                                                     |
| `action_plans`         | `status` (`draft`, `awaiting_approval`, `approved`, `rejected`, `completed`, `cancelled`), `plan_date`, `created_by`, `decided_by`, `decided_at`, `rejection_reason`, `cancel_reason`, `submitted_at`, `completed_at`                                                  |
| `plan_lines`           | `line_type` (`prep`, `purchase`, `reduce_purchase`, `discard`, `verify`, `count`), subject, `proposed_qty` (editable before approval), `approved_qty` (frozen at approval), `original_json` (engine's original line), `estimated_cost_paise`, `estimated_impact_paise` |
| `tasks`                | Created only on approval: `due_date`, `title`, `status` (`open`/`done`/`skipped`/`cancelled`), `target_qty`, `actual_qty`, `notes`, `completed_by`, `completed_at`                                                                                                     |
| `approval_history`     | `action` (`create`, `edit_line`, `remove_line`, `submit`, `approve`, `reject`, `cancel`, `complete`), `from_status`, `to_status`, `user_id`, `reason`, `changes_json`                                                                                                  |

## Audit & provider

| Table             | Columns                                                                                                                                 |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `audit_events`    | `entity_type`, `entity_id`, `action`, `details_json`, `user_id`, `created_at`. Written for every create/update/delete and workflow step |
| `provider_status` | Single row: `provider`, `model`, `last_checked_at`, `last_result`, `last_error`. **API keys are never stored in the database**          |
