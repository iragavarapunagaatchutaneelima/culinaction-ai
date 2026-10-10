import type { BaseUnit } from './units';

export type DateType = 'use_by' | 'expiry' | 'best_before';
export type Role = 'owner' | 'manager' | 'staff';

export const OUTLET_TYPES = ['cafe', 'bakery', 'tiffin', 'biryani', 'restaurant'] as const;
export type OutletType = (typeof OUTLET_TYPES)[number];
export const OUTLET_TYPE_LABELS: Record<OutletType, string> = {
  cafe: 'Café / coffee shop',
  bakery: 'Bakery / dessert outlet',
  tiffin: 'South Indian breakfast & tiffin',
  biryani: 'Biryani & rice meals',
  restaurant: 'General restaurant / meal combos',
};

export const WASTE_REASONS = [
  'expired',
  'over_preparation',
  'spoilage',
  'prep_trim',
  'returned',
  'other',
] as const;
export type WasteReason = (typeof WASTE_REASONS)[number];
export const WASTE_REASON_LABELS: Record<WasteReason, string> = {
  expired: 'Expired / past safe-use date',
  over_preparation: 'Over-preparation',
  spoilage: 'Spoilage',
  prep_trim: 'Preparation trim',
  returned: 'Returned food',
  other: 'Other',
};

export type DataSource = 'manual' | 'csv_import' | 'service_outcome' | 'illustrative' | 'adjustment' | 'task';

// ---- Engine snapshot (plain data loaded from the DB) ----

export interface BatchSnap {
  id: number;
  lotCode: string | null;
  qtyRemaining: number; // base units
  unitCostPaise: number | null; // per base unit
  receivedOn: string;
  dateType: DateType | null;
  dateValue: string | null;
  quarantined: boolean;
  qualityCheckedOn: string | null;
}

export interface IngredientSnap {
  id: number;
  name: string;
  category: string;
  baseUnit: BaseUnit;
  lastCountedAt: string | null; // ISO timestamp
  batches: BatchSnap[];
}

export interface RecipeLineSnap {
  ingredientId: number;
  qty: number;
  unit: string;
  lossPct: number;
}

export interface MenuItemSnap {
  id: number;
  name: string;
  category: string;
  pricePaise: number | null;
  active: boolean;
  recipeVerified: boolean;
  allergens: string | null;
  allergensVerified: boolean;
  lines: RecipeLineSnap[];
}

export interface SaleSnap {
  id: number;
  date: string;
  menuItemId: number;
  qty: number;
}

export interface OutcomeSnap {
  id: number;
  date: string;
  menuItemId: number;
  prepared: number;
  sold: number;
  remaining: number;
  discarded: number;
}

export interface PastForecastSnap {
  date: string;
  menuItemId: number;
  mean: number;
}

export interface EngineSettings {
  expiryWarnDays: number;
  excessCoverDays: number;
  staleCountDays: number;
  purchaseBufferPct: number;
}

export interface Snapshot {
  today: string;
  planDate: string;
  nowIso: string;
  settings: EngineSettings;
  ingredients: IngredientSnap[];
  menuItems: MenuItemSnap[];
  sales: SaleSnap[];
  outcomes: OutcomeSnap[];
  pastForecasts: PastForecastSnap[];
}

// ---- Engine output ----

export type LineType = 'prep' | 'purchase' | 'reduce_purchase' | 'discard' | 'verify' | 'count';
export type SubjectType = 'ingredient' | 'menu_item' | 'batch';

export interface PlanLineDraft {
  type: LineType;
  subjectType: SubjectType;
  subjectId: number;
  subjectName: string;
  qty: number | null; // base units for ingredient/batch, portions for menu_item
  unit: string | null;
  note: string;
  estimatedCostPaise: number | null;
}

export interface RecOption {
  key: string;
  label: string;
  description: string;
  feasible: boolean;
  infeasibleReason?: string;
  effects: { label: string; value: string }[];
  estimatedCostPaise: number | null;
  lines: PlanLineDraft[];
}

export type Confidence = 'high' | 'medium' | 'low';
export type RecKind =
  | 'unsafe_stock'
  | 'verify_best_before'
  | 'stockout_risk'
  | 'expiry_waste_risk'
  | 'prep_adjustment'
  | 'excess_stock'
  | 'forecast_deviation'
  | 'data_gap';

export interface EvidenceBatch {
  batchId: number;
  ingredient: string;
  lot: string | null;
  qtyRemaining: string;
  dateType: DateType | null;
  dateValue: string | null;
  status: string;
  unitCost: string;
}
export interface EvidenceRecipe {
  menuItem: string;
  ingredient: string;
  qtyPerServing: string;
  lossPct: number;
  verified: boolean;
}
export interface EvidenceSales {
  menuItem: string;
  method: string;
  from: string | null;
  to: string | null;
  daysUsed: number;
  values: { date: string; qty: number }[];
  mean: number | null;
  min: number | null;
  max: number | null;
}

export interface Recommendation {
  key: string;
  kind: RecKind;
  severityTier: 1 | 2 | 3 | 4;
  title: string;
  problem: string;
  subjectName: string;
  evidence: { batches: EvidenceBatch[]; recipes: EvidenceRecipe[]; sales: EvidenceSales[]; other: string[] };
  calculation: string[];
  assumptions: string[];
  options: RecOption[];
  confidence: Confidence;
  missingInfo: string[];
  safetyChecks: string[];
  nextStep: string;
  estimatedImpactPaise: number | null;
  impactLabel: string;
  sortKey: string;
}
