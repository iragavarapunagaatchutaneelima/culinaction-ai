// Ordered schema migrations. Never edit an applied migration — add a new one.

export const MIGRATIONS: { version: number; name: string; sql: string }[] = [
  {
    version: 1,
    name: 'initial schema',
    sql: `
CREATE TABLE users (
  id INTEGER PRIMARY KEY,
  username TEXT NOT NULL UNIQUE COLLATE NOCASE,
  display_name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE sessions (
  id INTEGER PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE INDEX idx_sessions_user ON sessions(user_id);

CREATE TABLE outlets (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  outlet_type TEXT NOT NULL CHECK (outlet_type IN ('cafe','bakery','tiffin','biryani','restaurant')),
  city TEXT NOT NULL,
  locality TEXT,
  timezone TEXT NOT NULL DEFAULT 'Asia/Kolkata',
  currency TEXT NOT NULL DEFAULT 'INR',
  preferred_mass_unit TEXT NOT NULL DEFAULT 'kg' CHECK (preferred_mass_unit IN ('g','kg')),
  preferred_volume_unit TEXT NOT NULL DEFAULT 'L' CHECK (preferred_volume_unit IN ('ml','L')),
  service_periods TEXT NOT NULL DEFAULT '[]',
  operating_hours TEXT,
  notes TEXT,
  expiry_warn_days INTEGER NOT NULL DEFAULT 2 CHECK (expiry_warn_days BETWEEN 0 AND 30),
  excess_cover_days INTEGER NOT NULL DEFAULT 7 CHECK (excess_cover_days BETWEEN 1 AND 90),
  stale_count_days INTEGER NOT NULL DEFAULT 3 CHECK (stale_count_days BETWEEN 1 AND 60),
  purchase_buffer_pct INTEGER NOT NULL DEFAULT 10 CHECK (purchase_buffer_pct BETWEEN 0 AND 100),
  managers_can_approve INTEGER NOT NULL DEFAULT 1,
  is_illustrative INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE outlet_members (
  outlet_id INTEGER NOT NULL REFERENCES outlets(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('owner','manager','staff')),
  created_at TEXT NOT NULL,
  PRIMARY KEY (outlet_id, user_id)
);
CREATE INDEX idx_members_user ON outlet_members(user_id);

CREATE TABLE ingredients (
  id INTEGER PRIMARY KEY,
  outlet_id INTEGER NOT NULL REFERENCES outlets(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT 'General',
  base_unit TEXT NOT NULL CHECK (base_unit IN ('g','ml','pc')),
  storage_notes TEXT,
  supplier_name TEXT,
  source TEXT NOT NULL DEFAULT 'manual',
  last_counted_at TEXT,
  archived INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (outlet_id, name)
);

CREATE TABLE inventory_batches (
  id INTEGER PRIMARY KEY,
  outlet_id INTEGER NOT NULL REFERENCES outlets(id) ON DELETE CASCADE,
  ingredient_id INTEGER NOT NULL REFERENCES ingredients(id) ON DELETE CASCADE,
  lot_code TEXT,
  qty_received REAL NOT NULL CHECK (qty_received >= 0),
  qty_remaining REAL NOT NULL CHECK (qty_remaining >= 0),
  unit_cost_paise REAL CHECK (unit_cost_paise IS NULL OR unit_cost_paise >= 0),
  total_cost_paise INTEGER CHECK (total_cost_paise IS NULL OR total_cost_paise >= 0),
  received_on TEXT NOT NULL,
  date_type TEXT CHECK (date_type IN ('use_by','expiry','best_before')),
  date_value TEXT,
  quarantined INTEGER NOT NULL DEFAULT 0,
  quality_checked_on TEXT,
  source TEXT NOT NULL DEFAULT 'manual',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK ((date_type IS NULL) = (date_value IS NULL))
);
CREATE INDEX idx_batches_ingredient ON inventory_batches(ingredient_id);
CREATE INDEX idx_batches_outlet_date ON inventory_batches(outlet_id, date_value);

CREATE TABLE stock_movements (
  id INTEGER PRIMARY KEY,
  outlet_id INTEGER NOT NULL REFERENCES outlets(id) ON DELETE CASCADE,
  ingredient_id INTEGER NOT NULL REFERENCES ingredients(id) ON DELETE CASCADE,
  batch_id INTEGER REFERENCES inventory_batches(id) ON DELETE SET NULL,
  movement_type TEXT NOT NULL CHECK (movement_type IN ('receipt','adjustment','consumption','waste','count')),
  qty_delta REAL NOT NULL,
  reason TEXT NOT NULL,
  reference_type TEXT,
  reference_id INTEGER,
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_movements_ingredient ON stock_movements(ingredient_id, created_at);
CREATE INDEX idx_movements_outlet ON stock_movements(outlet_id, created_at);

CREATE TABLE menu_items (
  id INTEGER PRIMARY KEY,
  outlet_id INTEGER NOT NULL REFERENCES outlets(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT 'General',
  price_paise INTEGER CHECK (price_paise IS NULL OR price_paise >= 0),
  allergens TEXT,
  allergens_verified INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (outlet_id, name)
);

CREATE TABLE recipes (
  id INTEGER PRIMARY KEY,
  menu_item_id INTEGER NOT NULL UNIQUE REFERENCES menu_items(id) ON DELETE CASCADE,
  yield_portions REAL CHECK (yield_portions IS NULL OR yield_portions > 0),
  notes TEXT,
  verified INTEGER NOT NULL DEFAULT 0,
  verified_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  verified_at TEXT,
  updated_at TEXT NOT NULL
);

CREATE TABLE recipe_ingredients (
  id INTEGER PRIMARY KEY,
  recipe_id INTEGER NOT NULL REFERENCES recipes(id) ON DELETE CASCADE,
  ingredient_id INTEGER NOT NULL REFERENCES ingredients(id) ON DELETE RESTRICT,
  qty REAL NOT NULL CHECK (qty > 0),
  unit TEXT NOT NULL,
  loss_pct REAL NOT NULL DEFAULT 0 CHECK (loss_pct >= 0 AND loss_pct < 100),
  UNIQUE (recipe_id, ingredient_id)
);
CREATE INDEX idx_recipe_ing_ingredient ON recipe_ingredients(ingredient_id);

CREATE TABLE sales_imports (
  id INTEGER PRIMARY KEY,
  outlet_id INTEGER NOT NULL REFERENCES outlets(id) ON DELETE CASCADE,
  filename TEXT,
  status TEXT NOT NULL CHECK (status IN ('previewed','committed')),
  total_rows INTEGER NOT NULL,
  valid_rows INTEGER NOT NULL,
  invalid_rows INTEGER NOT NULL,
  duplicate_rows INTEGER NOT NULL,
  imported_rows INTEGER,
  payload TEXT NOT NULL,
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  committed_at TEXT
);

CREATE TABLE sales_records (
  id INTEGER PRIMARY KEY,
  outlet_id INTEGER NOT NULL REFERENCES outlets(id) ON DELETE CASCADE,
  sale_date TEXT NOT NULL,
  menu_item_id INTEGER NOT NULL REFERENCES menu_items(id) ON DELETE CASCADE,
  service_period TEXT NOT NULL DEFAULT '',
  qty REAL NOT NULL CHECK (qty >= 0),
  unit_price_paise INTEGER CHECK (unit_price_paise IS NULL OR unit_price_paise >= 0),
  source TEXT NOT NULL,
  import_id INTEGER REFERENCES sales_imports(id) ON DELETE SET NULL,
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX ux_sales_key ON sales_records(outlet_id, sale_date, menu_item_id, lower(service_period));
CREATE INDEX idx_sales_outlet_date ON sales_records(outlet_id, sale_date);

CREATE TABLE service_outcomes (
  id INTEGER PRIMARY KEY,
  outlet_id INTEGER NOT NULL REFERENCES outlets(id) ON DELETE CASCADE,
  business_date TEXT NOT NULL,
  service_period TEXT NOT NULL DEFAULT '',
  menu_item_id INTEGER NOT NULL REFERENCES menu_items(id) ON DELETE CASCADE,
  qty_prepared REAL NOT NULL CHECK (qty_prepared >= 0),
  qty_sold REAL NOT NULL CHECK (qty_sold >= 0),
  qty_remaining REAL NOT NULL CHECK (qty_remaining >= 0),
  qty_discarded REAL NOT NULL CHECK (qty_discarded >= 0),
  task_id INTEGER REFERENCES tasks(id) ON DELETE SET NULL,
  notes TEXT,
  source TEXT NOT NULL DEFAULT 'manual',
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX ux_outcome_key ON service_outcomes(outlet_id, business_date, lower(service_period), menu_item_id);

CREATE TABLE waste_logs (
  id INTEGER PRIMARY KEY,
  outlet_id INTEGER NOT NULL REFERENCES outlets(id) ON DELETE CASCADE,
  subject_type TEXT NOT NULL CHECK (subject_type IN ('ingredient','menu_item')),
  ingredient_id INTEGER REFERENCES ingredients(id) ON DELETE CASCADE,
  menu_item_id INTEGER REFERENCES menu_items(id) ON DELETE CASCADE,
  batch_id INTEGER REFERENCES inventory_batches(id) ON DELETE SET NULL,
  qty REAL NOT NULL CHECK (qty > 0),
  unit TEXT NOT NULL,
  qty_base REAL NOT NULL,
  occurred_at TEXT NOT NULL,
  business_date TEXT NOT NULL,
  reason TEXT NOT NULL CHECK (reason IN ('expired','over_preparation','spoilage','prep_trim','returned','other')),
  notes TEXT,
  service_period TEXT,
  cost_paise INTEGER,
  cost_basis TEXT CHECK (cost_basis IN ('batch_cost','recipe_estimate')),
  outcome_id INTEGER REFERENCES service_outcomes(id) ON DELETE SET NULL,
  task_id INTEGER REFERENCES tasks(id) ON DELETE SET NULL,
  source TEXT NOT NULL DEFAULT 'manual',
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  CHECK ((subject_type = 'ingredient' AND ingredient_id IS NOT NULL) OR (subject_type = 'menu_item' AND menu_item_id IS NOT NULL))
);
CREATE INDEX idx_waste_outlet_date ON waste_logs(outlet_id, business_date);

CREATE TABLE recommendation_runs (
  id INTEGER PRIMARY KEY,
  outlet_id INTEGER NOT NULL REFERENCES outlets(id) ON DELETE CASCADE,
  plan_date TEXT NOT NULL,
  business_today TEXT NOT NULL,
  engine_version TEXT NOT NULL,
  summary_json TEXT NOT NULL,
  stock_json TEXT NOT NULL,
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_runs_outlet ON recommendation_runs(outlet_id, created_at);

CREATE TABLE recommendation_items (
  id INTEGER PRIMARY KEY,
  run_id INTEGER NOT NULL REFERENCES recommendation_runs(id) ON DELETE CASCADE,
  outlet_id INTEGER NOT NULL REFERENCES outlets(id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  rec_key TEXT NOT NULL,
  kind TEXT NOT NULL,
  severity_tier INTEGER NOT NULL,
  title TEXT NOT NULL,
  estimated_impact_paise INTEGER,
  confidence TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  ai_status TEXT,
  ai_explanation_json TEXT,
  ai_error TEXT,
  ai_model TEXT,
  ai_generated_at TEXT
);
CREATE INDEX idx_rec_items_run ON recommendation_items(run_id, position);

CREATE TABLE forecast_snapshots (
  id INTEGER PRIMARY KEY,
  run_id INTEGER NOT NULL REFERENCES recommendation_runs(id) ON DELETE CASCADE,
  outlet_id INTEGER NOT NULL REFERENCES outlets(id) ON DELETE CASCADE,
  target_date TEXT NOT NULL,
  menu_item_id INTEGER NOT NULL REFERENCES menu_items(id) ON DELETE CASCADE,
  method TEXT NOT NULL,
  forecast_mean REAL,
  forecast_min REAL,
  forecast_max REAL,
  days_used INTEGER NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_fc_outlet_date ON forecast_snapshots(outlet_id, target_date);

CREATE TABLE action_plans (
  id INTEGER PRIMARY KEY,
  outlet_id INTEGER NOT NULL REFERENCES outlets(id) ON DELETE CASCADE,
  run_id INTEGER REFERENCES recommendation_runs(id) ON DELETE SET NULL,
  title TEXT NOT NULL,
  plan_date TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('draft','awaiting_approval','approved','rejected','completed','cancelled')),
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  decided_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  decided_at TEXT,
  rejection_reason TEXT,
  cancel_reason TEXT,
  submitted_at TEXT,
  completed_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_plans_outlet ON action_plans(outlet_id, status);

CREATE TABLE plan_lines (
  id INTEGER PRIMARY KEY,
  plan_id INTEGER NOT NULL REFERENCES action_plans(id) ON DELETE CASCADE,
  rec_item_id INTEGER REFERENCES recommendation_items(id) ON DELETE SET NULL,
  rec_title TEXT,
  option_key TEXT,
  option_label TEXT,
  line_type TEXT NOT NULL CHECK (line_type IN ('prep','purchase','reduce_purchase','discard','verify','count')),
  subject_type TEXT NOT NULL CHECK (subject_type IN ('ingredient','menu_item','batch')),
  subject_id INTEGER NOT NULL,
  subject_name TEXT NOT NULL,
  proposed_qty REAL,
  approved_qty REAL,
  unit TEXT,
  note TEXT,
  estimated_cost_paise INTEGER,
  estimated_impact_paise INTEGER,
  original_json TEXT NOT NULL
);
CREATE INDEX idx_lines_plan ON plan_lines(plan_id);

CREATE TABLE tasks (
  id INTEGER PRIMARY KEY,
  outlet_id INTEGER NOT NULL REFERENCES outlets(id) ON DELETE CASCADE,
  plan_id INTEGER NOT NULL REFERENCES action_plans(id) ON DELETE CASCADE,
  plan_line_id INTEGER NOT NULL REFERENCES plan_lines(id) ON DELETE CASCADE,
  due_date TEXT NOT NULL,
  title TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('open','done','skipped','cancelled')) DEFAULT 'open',
  target_qty REAL,
  unit TEXT,
  actual_qty REAL,
  notes TEXT,
  completed_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  completed_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_tasks_outlet ON tasks(outlet_id, status, due_date);

CREATE TABLE approval_history (
  id INTEGER PRIMARY KEY,
  plan_id INTEGER NOT NULL REFERENCES action_plans(id) ON DELETE CASCADE,
  action TEXT NOT NULL,
  from_status TEXT NOT NULL,
  to_status TEXT NOT NULL,
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  reason TEXT,
  changes_json TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_approval_plan ON approval_history(plan_id);

CREATE TABLE audit_events (
  id INTEGER PRIMARY KEY,
  outlet_id INTEGER REFERENCES outlets(id) ON DELETE CASCADE,
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  entity_type TEXT NOT NULL,
  entity_id INTEGER,
  action TEXT NOT NULL,
  details_json TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_audit_outlet ON audit_events(outlet_id, created_at);

-- Metadata about the AI provider. API keys are NEVER stored here (env only).
CREATE TABLE provider_status (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  provider TEXT,
  model TEXT,
  last_checked_at TEXT,
  last_result TEXT,
  last_error TEXT
);
`,
  },
];
