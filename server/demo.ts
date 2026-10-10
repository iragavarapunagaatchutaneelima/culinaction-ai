// DEMO MODE — per-visitor sandbox with four FICTIONAL Hyderabad outlets.
// Every outlet is flagged is_illustrative = 1, every row has source = 'illustrative', and the
// owning user is flagged is_demo = 1. Nothing here is a real restaurant, a real measurement, a
// live integration or a real business result. Real users never have access to these outlets,
// and resetting a demo only touches outlets owned by that demo user.

import { randomBytes } from 'node:crypto';
import { addDays, todayInTz, weekday } from '../shared/dates';
import { replay, type OrderEvent, type OrderEventType, type OrderStatus } from '../shared/orders';
import type { Db } from './db/database';
import { audit, insertMany, insertReturning, iso } from './services';

export const DEMO_TTL_HOURS = 24;
export const MAX_ACTIVE_DEMOS = 300;

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function prng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}
const between = (r: () => number, a: number, b: number) => a + (b - a) * r();
const ri = (r: () => number, a: number, b: number) => Math.round(between(r, a, b));

/** IST wall-clock → UTC ISO */
function ist(date: string, hh: number, mm: number): string {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d, hh, mm) - 330 * 60_000).toISOString();
}
const plusMin = (isoTs: string, min: number) =>
  new Date(Date.parse(isoTs) + Math.round(min * 60_000)).toISOString();

type Base = 'g' | 'ml' | 'pc';
interface IngSpec {
  name: string;
  category: string;
  base: Base;
  storage?: string;
  supplier?: string;
  countedDaysAgo?: number;
  /** [qtyBase, rupees per kg | L | pc, dateType, dateOffsetDays, storageVerified] */
  batches: [number, number, 'use_by' | 'expiry' | 'best_before' | null, number | null, boolean?][];
}
interface ItemSpec {
  name: string;
  category: string;
  price: number; // ₹
  verified: boolean;
  lines: [string, number, string, number][]; // ingredient, qty, unit, loss%
  handling: ['hot' | 'cold' | 'ambient' | 'frozen', number] | null; // class, verified max hold minutes
  allergens?: string;
  /** average portions per day per service period (weekday) */
  demand: Record<string, number>;
  /** recorded preparation per period (for outcome history); omit when no outcomes recorded */
  prepared?: Record<string, number>;
  /** share of portions that go out as delivery/takeaway orders */
  orderShare: number;
}
interface OutletSpec {
  key: string;
  name: string;
  type: string;
  locality: string;
  hours: string;
  periods: string[];
  settings: { prep: number; warn: number; high: number; target: number };
  ingredients: IngSpec[];
  items: ItemSpec[];
  /** delivery order timing profile (minutes) */
  orders: {
    prefix: string;
    prep: [number, number];
    pack: [number, number];
    wait: [number, number];
    travel: [number, number];
    channels: string[];
    packaging: Record<string, string>;
  };
  seed: number;
}

const perBasePaise = (base: Base, rupees: number) => (base === 'pc' ? rupees * 100 : (rupees * 100) / 1000);

// ---------------------------------------------------------------------------
// The four fictional outlets
// ---------------------------------------------------------------------------

const OUTLETS: OutletSpec[] = [
  {
    key: 'biryani',
    name: 'Charminar Biryani House (fictional demo)',
    type: 'biryani',
    locality: 'Old City — fictional',
    hours: '12:00–15:30, 19:00–23:00',
    periods: ['Lunch', 'Dinner'],
    settings: { prep: 25, warn: 10, high: 20, target: 45 },
    seed: 101,
    ingredients: [
      {
        name: 'Basmati rice',
        category: 'Grains',
        base: 'g',
        storage: 'Dry store',
        supplier: 'Sample wholesaler A',
        batches: [[40000, 110, null, null]],
      },
      {
        name: 'Chicken (curry cut)',
        category: 'Meat',
        base: 'g',
        storage: 'Chiller 1, 0–4 °C',
        supplier: 'Sample meat supplier',
        batches: [[22000, 240, 'use_by', 1, true]],
      },
      {
        name: 'Mutton',
        category: 'Meat',
        base: 'g',
        storage: 'Chiller 1, 0–4 °C',
        supplier: 'Sample meat supplier',
        batches: [[7000, 720, 'use_by', 1, true]],
      },
      {
        name: 'Curd',
        category: 'Dairy',
        base: 'g',
        storage: 'Chiller 2',
        batches: [[9000, 70, 'use_by', 3, true]],
      },
      {
        name: 'Onion',
        category: 'Produce',
        base: 'g',
        storage: 'Dry store',
        batches: [[30000, 32, null, null]],
      },
      {
        name: 'Biryani masala',
        category: 'Spices',
        base: 'g',
        storage: 'Dry store',
        batches: [[3000, 520, 'best_before', 90]],
      },
      {
        name: 'Ghee',
        category: 'Dairy',
        base: 'g',
        storage: 'Dry store',
        batches: [[6000, 620, 'best_before', 45]],
      },
      {
        name: 'Mint leaves',
        category: 'Produce',
        base: 'g',
        storage: 'Chiller 2',
        batches: [[800, 90, 'use_by', 0, false]],
      },
      {
        name: 'Eggs',
        category: 'Dairy',
        base: 'pc',
        storage: 'Chiller 2',
        batches: [[90, 6.5, 'best_before', 10]],
      },
      {
        name: 'Paneer',
        category: 'Dairy',
        base: 'g',
        storage: 'Chiller 2, 0–4 °C',
        batches: [[2600, 380, 'use_by', 1, false]],
      },
    ],
    items: [
      {
        name: 'Chicken Dum Biryani',
        category: 'Biryani',
        price: 280,
        verified: true,
        handling: ['hot', 60],
        allergens: 'Milk (curd) — sample note',
        lines: [
          ['Basmati rice', 150, 'g', 0],
          ['Chicken (curry cut)', 180, 'g', 10],
          ['Curd', 30, 'g', 0],
          ['Onion', 40, 'g', 10],
          ['Biryani masala', 8, 'g', 0],
          ['Ghee', 10, 'g', 0],
          ['Mint leaves', 3, 'g', 0],
        ],
        demand: { Lunch: 30, Dinner: 40 },
        prepared: { Lunch: 48, Dinner: 60 },
        orderShare: 0.35,
      },
      {
        name: 'Mutton Biryani',
        category: 'Biryani',
        price: 380,
        verified: true,
        handling: ['hot', 60],
        lines: [
          ['Basmati rice', 150, 'g', 0],
          ['Mutton', 180, 'g', 15],
          ['Curd', 30, 'g', 0],
          ['Onion', 40, 'g', 10],
          ['Biryani masala', 8, 'g', 0],
          ['Ghee', 12, 'g', 0],
        ],
        demand: { Lunch: 10, Dinner: 15 },
        orderShare: 0.3,
      },
      {
        name: 'Veg Dum Biryani',
        category: 'Biryani',
        price: 200,
        verified: true,
        handling: ['hot', 60],
        lines: [
          ['Basmati rice', 150, 'g', 0],
          ['Onion', 60, 'g', 10],
          ['Curd', 30, 'g', 0],
          ['Biryani masala', 6, 'g', 0],
          ['Ghee', 8, 'g', 0],
        ],
        demand: { Lunch: 14, Dinner: 16 },
        orderShare: 0.25,
      },
      {
        name: 'Egg Biryani',
        category: 'Biryani',
        price: 220,
        verified: true,
        handling: ['hot', 60],
        lines: [
          ['Basmati rice', 150, 'g', 0],
          ['Eggs', 2, 'pc', 0],
          ['Onion', 40, 'g', 10],
          ['Biryani masala', 6, 'g', 0],
          ['Ghee', 8, 'g', 0],
        ],
        demand: { Lunch: 7, Dinner: 8 },
        orderShare: 0.25,
      },
      {
        name: 'Paneer 65',
        category: 'Starters',
        price: 240,
        verified: true,
        handling: ['hot', 30],
        allergens: 'Milk — sample note',
        lines: [
          ['Paneer', 150, 'g', 5],
          ['Curd', 20, 'g', 0],
        ],
        demand: { Lunch: 8, Dinner: 12 },
        orderShare: 0.3,
      },
      {
        name: 'Double ka Meetha',
        category: 'Desserts',
        price: 120,
        verified: false,
        handling: null,
        lines: [],
        demand: { Lunch: 6, Dinner: 12 },
        orderShare: 0.1,
      },
    ],
    orders: {
      prefix: 'CBH',
      prep: [14, 24],
      pack: [2, 5],
      wait: [5, 20],
      travel: [15, 30],
      channels: ['aggregator', 'aggregator', 'own_delivery', 'takeaway'],
      packaging: {
        aggregator: 'Sealed foil container in insulated bag',
        own_delivery: 'Sealed foil container',
        takeaway: 'Foil container',
      },
    },
  },
  {
    key: 'tiffin',
    name: 'Udupi Tiffin Corner (fictional demo)',
    type: 'tiffin',
    locality: 'Ameerpet — fictional',
    hours: '06:30–11:30, 12:00–15:00',
    periods: ['Breakfast', 'Lunch'],
    settings: { prep: 15, warn: 8, high: 15, target: 35 },
    seed: 202,
    ingredients: [
      {
        name: 'Idli batter',
        category: 'Batters',
        base: 'g',
        storage: 'Chiller 1',
        batches: [[14000, 60, 'use_by', 0, true]],
      },
      {
        name: 'Dosa batter',
        category: 'Batters',
        base: 'g',
        storage: 'Chiller 1',
        batches: [[18000, 65, 'use_by', 1, true]],
      },
      {
        name: 'Toor dal',
        category: 'Pulses',
        base: 'g',
        storage: 'Dry store',
        batches: [[8000, 140, null, null]],
      },
      {
        name: 'Fresh coconut',
        category: 'Produce',
        base: 'pc',
        storage: 'Dry store',
        batches: [[30, 35, null, null]],
      },
      {
        name: 'Potato',
        category: 'Produce',
        base: 'g',
        storage: 'Dry store',
        batches: [[3000, 30, null, null]],
      },
      {
        name: 'Bombay rava',
        category: 'Grains',
        base: 'g',
        storage: 'Dry store',
        countedDaysAgo: 6,
        batches: [[25000, 50, null, null]],
      },
      {
        name: 'Ghee',
        category: 'Dairy',
        base: 'g',
        storage: 'Dry store',
        batches: [[2000, 600, 'best_before', 30]],
      },
      {
        name: 'Milk',
        category: 'Dairy',
        base: 'ml',
        storage: 'Chiller 1',
        batches: [
          [4000, 62, 'use_by', -1],
          [22000, 62, 'use_by', 2, true],
        ],
      },
      {
        name: 'Filter coffee powder',
        category: 'Beverages',
        base: 'g',
        storage: 'Dry store',
        batches: [[3000, 600, 'best_before', 60]],
      },
      {
        name: 'Sugar',
        category: 'Staples',
        base: 'g',
        storage: 'Dry store',
        batches: [[6000, 45, null, null]],
      },
      {
        name: 'Cashew nuts',
        category: 'Dry fruits',
        base: 'g',
        storage: 'Dry store',
        batches: [[500, 900, 'best_before', -2]],
      },
    ],
    items: [
      {
        name: 'Idli (2 pc)',
        category: 'Breakfast',
        price: 40,
        verified: true,
        handling: ['hot', 45],
        lines: [
          ['Idli batter', 120, 'g', 0],
          ['Toor dal', 25, 'g', 0],
          ['Fresh coconut', 0.1, 'pc', 0],
        ],
        demand: { Breakfast: 50, Lunch: 10 },
        orderShare: 0.2,
      },
      {
        name: 'Masala Dosa',
        category: 'Dosa',
        price: 70,
        verified: true,
        handling: ['hot', 30],
        lines: [
          ['Dosa batter', 150, 'g', 0],
          ['Potato', 100, 'g', 10],
          ['Toor dal', 20, 'g', 0],
          ['Fresh coconut', 0.1, 'pc', 0],
        ],
        demand: { Breakfast: 30, Lunch: 15 },
        orderShare: 0.25,
      },
      {
        name: 'Plain Dosa',
        category: 'Dosa',
        price: 50,
        verified: true,
        handling: ['hot', 30],
        lines: [
          ['Dosa batter', 150, 'g', 0],
          ['Toor dal', 20, 'g', 0],
          ['Fresh coconut', 0.1, 'pc', 0],
        ],
        demand: { Breakfast: 18, Lunch: 7 },
        orderShare: 0.2,
      },
      {
        name: 'Upma',
        category: 'Breakfast',
        price: 45,
        verified: true,
        handling: ['hot', 45],
        allergens: 'Milk (ghee) — sample note',
        lines: [
          ['Bombay rava', 80, 'g', 0],
          ['Ghee', 5, 'g', 0],
        ],
        demand: { Breakfast: 30 },
        prepared: { Breakfast: 50 },
        orderShare: 0.1,
      },
      {
        name: 'Filter Coffee',
        category: 'Beverages',
        price: 30,
        verified: true,
        handling: ['hot', 20],
        allergens: 'Milk — sample note',
        lines: [
          ['Milk', 100, 'ml', 0],
          ['Filter coffee powder', 10, 'g', 0],
          ['Sugar', 10, 'g', 0],
        ],
        demand: { Breakfast: 90, Lunch: 30 },
        orderShare: 0.05,
      },
      {
        name: 'Medu Vada',
        category: 'Snacks',
        price: 40,
        verified: false,
        handling: null,
        lines: [],
        demand: { Breakfast: 30, Lunch: 5 },
        orderShare: 0.1,
      },
      {
        name: 'Ven Pongal',
        category: 'Breakfast',
        price: 55,
        verified: false,
        handling: null,
        lines: [
          ['Toor dal', 30, 'g', 0],
          ['Ghee', 10, 'g', 0],
          ['Cashew nuts', 5, 'g', 0],
        ],
        demand: { Breakfast: 20 },
        orderShare: 0.1,
      },
    ],
    orders: {
      prefix: 'UTC',
      prep: [6, 12],
      pack: [1, 3],
      wait: [3, 12],
      travel: [10, 20],
      channels: ['takeaway', 'takeaway', 'aggregator'],
      packaging: { aggregator: 'Paper box with foil liner', takeaway: 'Paper box' },
    },
  },
  {
    key: 'cafe',
    name: 'Banjara Brew Café (fictional demo)',
    type: 'cafe',
    locality: 'Banjara Hills — fictional',
    hours: '08:00–22:00',
    periods: ['Morning', 'Evening'],
    settings: { prep: 12, warn: 8, high: 15, target: 35 },
    seed: 303,
    ingredients: [
      {
        name: 'Milk',
        category: 'Dairy',
        base: 'ml',
        storage: 'Chiller, 0–4 °C',
        batches: [[30000, 64, 'use_by', 2, true]],
      },
      {
        name: 'Coffee beans',
        category: 'Beverages',
        base: 'g',
        storage: 'Airtight, dry store',
        batches: [[4000, 1400, 'best_before', 40]],
      },
      {
        name: 'Sugar',
        category: 'Staples',
        base: 'g',
        storage: 'Dry store',
        batches: [[5000, 45, null, null]],
      },
      {
        name: 'Sandwich bread',
        category: 'Bakery',
        base: 'pc',
        storage: 'Bread rack',
        batches: [[48, 4, 'best_before', 2]],
      },
      {
        name: 'Grilled chicken',
        category: 'Meat',
        base: 'g',
        storage: 'Chiller, 0–4 °C',
        batches: [[3000, 420, 'use_by', 2, true]],
      },
      {
        name: 'Cheese slices',
        category: 'Dairy',
        base: 'pc',
        storage: 'Chiller',
        batches: [[120, 9, 'use_by', 12, true]],
      },
      {
        name: 'Lettuce',
        category: 'Produce',
        base: 'g',
        storage: 'Chiller',
        batches: [[1500, 140, 'use_by', 1, true]],
      },
      {
        name: 'Chocolate syrup',
        category: 'Beverages',
        base: 'ml',
        storage: 'Dry store',
        batches: [[3000, 350, 'best_before', 120]],
      },
      {
        name: 'Vanilla ice cream',
        category: 'Frozen',
        base: 'ml',
        storage: 'Freezer, −18 °C',
        batches: [[8000, 260, 'best_before', 60]],
      },
    ],
    items: [
      {
        name: 'Cappuccino',
        category: 'Hot coffee',
        price: 160,
        verified: true,
        handling: ['hot', 20],
        allergens: 'Milk — sample note',
        lines: [
          ['Milk', 150, 'ml', 0],
          ['Coffee beans', 18, 'g', 0],
        ],
        demand: { Morning: 45, Evening: 35 },
        orderShare: 0.2,
      },
      {
        name: 'Cold Coffee',
        category: 'Cold coffee',
        price: 190,
        verified: true,
        handling: ['cold', 30],
        allergens: 'Milk — sample note',
        lines: [
          ['Milk', 200, 'ml', 0],
          ['Coffee beans', 15, 'g', 0],
          ['Sugar', 20, 'g', 0],
          ['Vanilla ice cream', 60, 'ml', 0],
          ['Chocolate syrup', 15, 'ml', 0],
        ],
        demand: { Morning: 15, Evening: 35 },
        orderShare: 0.4,
      },
      {
        name: 'Chicken Club Sandwich',
        category: 'Sandwiches',
        price: 280,
        verified: true,
        handling: ['hot', 40],
        allergens: 'Gluten, milk — sample note',
        lines: [
          ['Sandwich bread', 3, 'pc', 0],
          ['Grilled chicken', 90, 'g', 0],
          ['Cheese slices', 2, 'pc', 0],
          ['Lettuce', 20, 'g', 15],
        ],
        demand: { Morning: 10, Evening: 16 },
        orderShare: 0.45,
      },
      {
        name: 'Veg Grilled Sandwich',
        category: 'Sandwiches',
        price: 210,
        verified: true,
        handling: ['hot', 40],
        allergens: 'Gluten, milk — sample note',
        lines: [
          ['Sandwich bread', 2, 'pc', 0],
          ['Cheese slices', 2, 'pc', 0],
          ['Lettuce', 25, 'g', 15],
        ],
        demand: { Morning: 9, Evening: 12 },
        orderShare: 0.4,
      },
      {
        name: 'Walnut Brownie',
        category: 'Desserts',
        price: 150,
        verified: false,
        handling: null,
        lines: [],
        demand: { Morning: 6, Evening: 14 },
        orderShare: 0.3,
      },
    ],
    orders: {
      prefix: 'BBC',
      prep: [4, 10],
      pack: [1, 3],
      wait: [4, 16],
      travel: [12, 25],
      channels: ['aggregator', 'aggregator', 'takeaway'],
      packaging: {
        aggregator: 'Sealed cup / sandwich box, paper bag',
        takeaway: 'Sealed cup / sandwich box',
      },
    },
  },
  {
    key: 'bakery',
    name: 'Secunderabad Bake Studio (fictional demo)',
    type: 'bakery',
    locality: 'Secunderabad — fictional',
    hours: '09:00–21:30',
    periods: ['Day'],
    settings: { prep: 20, warn: 10, high: 20, target: 45 },
    seed: 404,
    ingredients: [
      {
        name: 'Refined flour (maida)',
        category: 'Flour',
        base: 'g',
        storage: 'Dry store',
        batches: [[60000, 42, 'best_before', 60]],
      },
      {
        name: 'Butter',
        category: 'Dairy',
        base: 'g',
        storage: 'Chiller, 0–4 °C',
        batches: [[8000, 520, 'use_by', 20, true]],
      },
      {
        name: 'Sugar',
        category: 'Staples',
        base: 'g',
        storage: 'Dry store',
        batches: [[15000, 45, null, null]],
      },
      {
        name: 'Eggs',
        category: 'Dairy',
        base: 'pc',
        storage: 'Chiller',
        batches: [[180, 6.5, 'best_before', 12]],
      },
      {
        name: 'Fresh cream',
        category: 'Dairy',
        base: 'ml',
        storage: 'Chiller, 0–4 °C — must stay chilled',
        batches: [[6000, 300, 'use_by', 1, false]],
      },
      {
        name: 'Dark chocolate',
        category: 'Baking',
        base: 'g',
        storage: 'Cool dry store',
        batches: [[4000, 900, 'best_before', 90]],
      },
      {
        name: 'Strawberries',
        category: 'Produce',
        base: 'g',
        storage: 'Chiller',
        batches: [[1200, 450, 'use_by', 0, true]],
      },
      {
        name: 'Mixed vegetables',
        category: 'Produce',
        base: 'g',
        storage: 'Chiller',
        batches: [[5000, 80, 'use_by', 2, true]],
      },
    ],
    items: [
      {
        name: 'Black Forest Pastry',
        category: 'Pastries',
        price: 120,
        verified: true,
        handling: ['cold', 45],
        allergens: 'Gluten, egg, milk — sample note',
        lines: [
          ['Refined flour (maida)', 30, 'g', 0],
          ['Sugar', 25, 'g', 0],
          ['Eggs', 0.5, 'pc', 0],
          ['Fresh cream', 60, 'ml', 0],
          ['Dark chocolate', 15, 'g', 0],
        ],
        demand: { Day: 40 },
        orderShare: 0.25,
      },
      {
        name: 'Chocolate Truffle Slice',
        category: 'Cakes',
        price: 140,
        verified: true,
        handling: ['cold', 45],
        allergens: 'Gluten, egg, milk — sample note',
        lines: [
          ['Refined flour (maida)', 30, 'g', 0],
          ['Sugar', 25, 'g', 0],
          ['Eggs', 0.5, 'pc', 0],
          ['Fresh cream', 40, 'ml', 0],
          ['Dark chocolate', 35, 'g', 0],
        ],
        demand: { Day: 30 },
        orderShare: 0.25,
      },
      {
        name: 'Butter Croissant',
        category: 'Viennoiserie',
        price: 110,
        verified: true,
        handling: ['ambient', 240],
        allergens: 'Gluten, milk — sample note',
        lines: [
          ['Refined flour (maida)', 60, 'g', 0],
          ['Butter', 35, 'g', 0],
          ['Sugar', 6, 'g', 0],
        ],
        demand: { Day: 28 },
        prepared: { Day: 45 },
        orderShare: 0.15,
      },
      {
        name: 'Strawberry Tart',
        category: 'Pastries',
        price: 160,
        verified: true,
        handling: ['cold', 45],
        allergens: 'Gluten, egg, milk — sample note',
        lines: [
          ['Refined flour (maida)', 40, 'g', 0],
          ['Butter', 20, 'g', 0],
          ['Fresh cream', 30, 'ml', 0],
          ['Strawberries', 45, 'g', 10],
        ],
        demand: { Day: 14 },
        orderShare: 0.2,
      },
      {
        name: 'Veg Puff',
        category: 'Savouries',
        price: 45,
        verified: true,
        handling: ['hot', 60],
        allergens: 'Gluten — sample note',
        lines: [
          ['Refined flour (maida)', 50, 'g', 0],
          ['Butter', 15, 'g', 0],
          ['Mixed vegetables', 50, 'g', 10],
        ],
        demand: { Day: 55 },
        orderShare: 0.15,
      },
    ],
    orders: {
      prefix: 'SBS',
      prep: [3, 9],
      pack: [2, 5],
      wait: [5, 15],
      travel: [15, 30],
      channels: ['aggregator', 'takeaway', 'takeaway'],
      packaging: { aggregator: 'Cake box with ice pack', takeaway: 'Cake box' },
    },
  },
];

// ---------------------------------------------------------------------------
// Seeding
// ---------------------------------------------------------------------------

interface Ctx {
  db: Db;
  userId: number;
  now: Date;
  today: string;
  ts: string;
}

function recipeCostPaise(spec: OutletSpec, item: ItemSpec): number | null {
  if (!item.lines.length) return null;
  let sum = 0;
  for (const [ingName, qty, unit, loss] of item.lines) {
    const ing = spec.ingredients.find((i) => i.name === ingName)!;
    const qtyBase = unit === 'kg' || unit === 'L' ? qty * 1000 : qty;
    sum += (qtyBase / (1 - loss / 100)) * perBasePaise(ing.base, ing.batches[0][1]);
  }
  return Math.round(sum);
}

/** Period start hour (IST) used to place sales, outcomes and orders on a timeline. */
const PERIOD_HOURS: Record<string, [number, number]> = {
  Breakfast: [7, 10],
  Lunch: [12, 15],
  Dinner: [19, 22],
  Morning: [9, 13],
  Evening: [16, 21],
  Day: [10, 20],
};

async function seedOutlet(c: Ctx, spec: OutletSpec): Promise<number> {
  const { db, ts, today } = c;
  const r = prng(spec.seed + (Number(today.replace(/-/g, '')) % 997));
  const outletId = (
    await db.run(
      `INSERT INTO outlets (name, outlet_type, city, locality, service_periods, operating_hours, notes, prep_warn_min, ready_wait_warn_min, ready_wait_high_min, delivery_target_min, is_illustrative, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,1,?,?)`,
      [
        spec.name,
        spec.type,
        'Hyderabad',
        spec.locality,
        JSON.stringify(spec.periods),
        spec.hours,
        'DEMO MODE: fictional outlet with generated sample data. Not a real restaurant; no number here is a real measurement or business result.',
        spec.settings.prep,
        spec.settings.warn,
        spec.settings.high,
        spec.settings.target,
        ts,
        ts,
      ],
    )
  ).lastId;
  await db.run('INSERT INTO outlet_members (outlet_id, user_id, role, created_at) VALUES (?,?,?,?)', [
    outletId,
    c.userId,
    'owner',
    ts,
  ]);

  // Ingredients
  const ingIds = await insertReturning(
    db,
    'ingredients',
    [
      'outlet_id',
      'name',
      'category',
      'base_unit',
      'storage_notes',
      'supplier_name',
      'source',
      'last_counted_at',
      'created_at',
      'updated_at',
    ],
    spec.ingredients.map((i) => [
      outletId,
      i.name,
      i.category,
      i.base,
      i.storage ?? null,
      i.supplier ?? null,
      'illustrative',
      new Date(c.now.getTime() - (i.countedDaysAgo ?? 0) * 86400000 - 3600_000).toISOString(),
      ts,
      ts,
    ]),
    'name',
  );

  // Batches + receipt movements
  const batchRows: unknown[][] = [];
  for (const i of spec.ingredients) {
    i.batches.forEach(([qty, rupees, dateType, off, storageOk], k) => {
      const unitCost = perBasePaise(i.base, rupees);
      batchRows.push([
        outletId,
        ingIds.get(i.name),
        `DEMO-${spec.key.toUpperCase()}-${ingIds.get(i.name)}-${k + 1}`,
        qty,
        qty,
        unitCost,
        Math.round(qty * unitCost),
        addDays(today, -(2 + k)),
        dateType,
        off === null ? null : addDays(today, off),
        storageOk ? today : null,
        'illustrative',
        ts,
        ts,
      ]);
    });
  }
  const batchIds = await insertReturning(
    db,
    'inventory_batches',
    [
      'outlet_id',
      'ingredient_id',
      'lot_code',
      'qty_received',
      'qty_remaining',
      'unit_cost_paise',
      'total_cost_paise',
      'received_on',
      'date_type',
      'date_value',
      'storage_verified_on',
      'source',
      'created_at',
      'updated_at',
    ],
    batchRows,
    'lot_code',
  );
  await insertMany(
    db,
    'stock_movements',
    [
      'outlet_id',
      'ingredient_id',
      'batch_id',
      'movement_type',
      'qty_delta',
      'reason',
      'user_id',
      'created_at',
    ],
    batchRows.map((b) => [
      outletId,
      b[1],
      batchIds.get(String(b[2])),
      'receipt',
      b[3],
      'Demo opening stock (generated sample data)',
      c.userId,
      ts,
    ]),
  );

  // Menu items + recipes
  const itemIds = await insertReturning(
    db,
    'menu_items',
    [
      'outlet_id',
      'name',
      'category',
      'price_paise',
      'allergens',
      'allergens_verified',
      'handling_class',
      'handling_max_hold_min',
      'handling_verified',
      'created_at',
      'updated_at',
    ],
    spec.items.map((m) => [
      outletId,
      m.name,
      m.category,
      m.price * 100,
      m.allergens ?? null,
      0,
      m.handling?.[0] ?? null,
      m.handling?.[1] ?? null,
      m.handling ? 1 : 0,
      ts,
      ts,
    ]),
    'name',
  );
  const recipeIds = await insertReturning(
    db,
    'recipes',
    ['menu_item_id', 'verified', 'verified_by', 'verified_at', 'notes', 'updated_at'],
    spec.items.map((m) => [
      itemIds.get(m.name),
      m.verified ? 1 : 0,
      m.verified ? c.userId : null,
      m.verified ? ts : null,
      'Demo recipe quantities — generated sample data, not from a real kitchen.',
      ts,
    ]),
    'menu_item_id',
  );
  await insertMany(
    db,
    'recipe_ingredients',
    ['recipe_id', 'ingredient_id', 'qty', 'unit', 'loss_pct'],
    spec.items.flatMap((m) =>
      m.lines.map(([ing, qty, unit, loss]) => [
        recipeIds.get(String(itemIds.get(m.name))),
        ingIds.get(ing),
        qty,
        unit,
        loss,
      ]),
    ),
  );

  // 28 days of sales (+ outcomes where preparation is recorded). sold ≤ prepared always.
  const salesRows: unknown[][] = [];
  const outcomeRows: unknown[][] = [];
  const wasteRows: unknown[][] = [];
  const soldByDayItem = new Map<string, number>();
  for (let d = 28; d >= 1; d--) {
    const date = addDays(today, -d);
    const wd = weekday(date);
    const mult = wd === 0 || wd === 6 ? 1.3 : 1;
    for (const m of spec.items) {
      for (const p of Object.keys(m.demand)) {
        const demand = Math.max(0, Math.round(m.demand[p] * mult * between(r, 0.85, 1.15)));
        // Scenario history: the tiffin outlet reduced Upma prep to 40 after a plan 3 days ago.
        let prepared = m.prepared?.[p];
        if (prepared !== undefined && spec.key === 'tiffin' && m.name === 'Upma' && d <= 3) prepared = 40;
        const sold = prepared === undefined ? demand : Math.min(demand, prepared);
        salesRows.push([
          outletId,
          date,
          itemIds.get(m.name),
          p,
          sold,
          m.price * 100,
          'illustrative',
          c.userId,
          ts,
          ts,
        ]);
        soldByDayItem.set(`${date}|${m.name}`, (soldByDayItem.get(`${date}|${m.name}`) ?? 0) + sold);
        if (prepared !== undefined && d <= 14) {
          const left = prepared - sold;
          const transferred = left > 0 ? Math.min(left, ri(r, 1, 3)) : 0; // e.g. staff meal, recorded
          const discarded = left - transferred;
          outcomeRows.push([
            outletId,
            date,
            p,
            itemIds.get(m.name),
            prepared,
            sold,
            0,
            transferred,
            discarded,
            'Demo outcome (generated sample data)',
            'illustrative',
            c.userId,
            ts,
          ]);
          if (discarded > 0) {
            const cpp = recipeCostPaise(spec, m);
            wasteRows.push([
              outletId,
              'menu_item',
              null,
              itemIds.get(m.name),
              null,
              discarded,
              'portions',
              discarded,
              ist(date, PERIOD_HOURS[p][1], 30),
              date,
              'unsold_cooked',
              'Unsold at end of service (demo)',
              p,
              cpp === null ? null : Math.round(discarded * cpp),
              cpp === null ? null : 'recipe_estimate',
              null,
              'illustrative',
              c.userId,
              ts,
            ]);
          }
        }
      }
    }
  }
  await insertMany(
    db,
    'sales_records',
    [
      'outlet_id',
      'sale_date',
      'menu_item_id',
      'service_period',
      'qty',
      'unit_price_paise',
      'source',
      'created_by',
      'created_at',
      'updated_at',
    ],
    salesRows,
  );
  const outcomeIds = await insertReturning(
    db,
    'service_outcomes',
    [
      'outlet_id',
      'business_date',
      'service_period',
      'menu_item_id',
      'qty_prepared',
      'qty_sold',
      'qty_remaining',
      'qty_transferred',
      'qty_discarded',
      'notes',
      'source',
      'created_by',
      'created_at',
    ],
    outcomeRows,
    "business_date || '|' || service_period || '|' || menu_item_id",
  );

  // Ingredient spoilage history (recorded at batch purchase cost)
  for (let k = 0; k < 3; k++) {
    const ing = spec.ingredients.filter((i) => i.base !== 'pc')[
      ri(r, 0, spec.ingredients.filter((i) => i.base !== 'pc').length - 1)
    ];
    const qty = ing.base === 'g' || ing.base === 'ml' ? ri(r, 200, 900) : ri(r, 2, 6);
    const date = addDays(today, -ri(r, 2, 20));
    wasteRows.push([
      outletId,
      'ingredient',
      ingIds.get(ing.name),
      null,
      null,
      qty,
      ing.base,
      qty,
      ist(date, 22, 0),
      date,
      k === 0 ? 'prep_trim' : 'spoilage',
      k === 0 ? 'Trim and peel (demo)' : 'Found spoiled during count (demo)',
      null,
      Math.round(qty * perBasePaise(ing.base, ing.batches[0][1])),
      'batch_cost',
      null,
      'illustrative',
      c.userId,
      ts,
    ]);
  }

  // Delivery / takeaway orders for the last 7 days, generated through the lifecycle validator.
  const orderRows: unknown[][] = [];
  const itemRows: [string, number, number][] = [];
  const eventRows: [string, OrderEvent][] = [];
  let seq = 1000;
  const verifiedItems = spec.items.filter((m) => m.verified);
  for (let d = 7; d >= 1; d--) {
    const date = addDays(today, -d);
    for (const p of spec.periods) {
      const [h0, h1] = PERIOD_HOURS[p];
      const count = ri(r, 3, 6);
      for (let k = 0; k < count; k++) {
        const ref = `${spec.orders.prefix}-${++seq}`;
        const m = verifiedItems[ri(r, 0, verifiedItems.length - 1)];
        const qty = ri(r, 1, 2);
        const sold = soldByDayItem.get(`${date}|${m.name}`) ?? 0;
        if (sold < qty) continue; // orders never exceed recorded sales for that day
        soldByDayItem.set(`${date}|${m.name}`, sold - qty);
        const channel = spec.orders.channels[ri(r, 0, spec.orders.channels.length - 1)];
        const placed = ist(date, ri(r, h0, h1 - 1), ri(r, 0, 59));
        const roll = r();
        const fate =
          roll < 0.05
            ? 'cancelled_before'
            : roll < 0.08
              ? 'uncollected'
              : roll < 0.1
                ? 'returned'
                : 'delivered';
        const { events, status } = timeline(r, spec, channel, placed, fate);
        orderRows.push([
          outletId,
          ref,
          channel,
          status,
          placed,
          channel === 'takeaway' || channel === 'dine_in' ? null : ri(r, ...spec.orders.travel),
          spec.orders.packaging[channel] ?? null,
          fate === 'delivered' ? null : fate === 'cancelled_before' ? null : 'disposed',
          null,
          'illustrative',
          c.userId,
          ts,
          ts,
        ]);
        itemRows.push([ref, itemIds.get(m.name)!, qty]);
        for (const e of events) eventRows.push([ref, e]);
        if (fate === 'uncollected' || fate === 'returned') {
          const cpp = recipeCostPaise(spec, m);
          const at = events[events.length - 1].at;
          wasteRows.push([
            outletId,
            'menu_item',
            null,
            itemIds.get(m.name),
            null,
            qty,
            'portions',
            qty,
            at,
            date,
            fate === 'returned' ? 'returned' : 'uncollected_order',
            `Order ${ref} (demo)`,
            p,
            cpp === null ? null : Math.round(qty * cpp),
            cpp === null ? null : 'recipe_estimate',
            null,
            'illustrative',
            c.userId,
            ts,
          ]);
        }
      }
    }
  }
  // Two live (open) orders relative to "now", so the delivery workspace has something to show.
  const nowIso = iso(c.now);
  const live = (minAgo: number) => new Date(c.now.getTime() - minAgo * 60_000).toISOString();
  // live orders use the dish with the longest verified handling limit, so they start at moderate (not high) risk
  const m0 = [...verifiedItems].sort((a, b) => (b.handling?.[1] ?? 0) - (a.handling?.[1] ?? 0))[0];
  const liveOrders: [string, string, OrderEvent[], OrderStatus, number | null][] = [
    [
      `${spec.orders.prefix}-L1`,
      'aggregator',
      [
        ev('received', live(32)),
        ev('prep_started', live(30)),
        ev('prep_completed', live(17)),
        ev('pack_started', live(16)),
        ev('pack_completed', live(14)),
        ev('rider_assigned', live(14)),
        ev('ready_for_pickup', live(13)),
      ],
      'ready_for_pickup',
      spec.orders.travel[0],
    ],
    [
      `${spec.orders.prefix}-L2`,
      'own_delivery',
      [ev('received', live(9)), ev('prep_started', live(7))],
      'preparing',
      spec.orders.travel[0],
    ],
  ];
  for (const [ref, channel, events, status, travel] of liveOrders) {
    if (replay(events, nowIso) !== status) throw new Error('demo live order invalid');
    orderRows.push([
      outletId,
      ref,
      channel,
      status,
      events[0].at,
      travel,
      spec.orders.packaging[channel] ?? 'Sealed container',
      null,
      null,
      'illustrative',
      c.userId,
      ts,
      ts,
    ]);
    itemRows.push([ref, itemIds.get(m0.name)!, 1]);
    for (const e of events) eventRows.push([ref, e]);
  }
  const orderIds = await insertReturning(
    db,
    'orders',
    [
      'outlet_id',
      'order_ref',
      'channel',
      'status',
      'placed_at',
      'est_travel_min',
      'packaging',
      'disposition',
      'delay_reason',
      'source',
      'created_by',
      'created_at',
      'updated_at',
    ],
    orderRows,
    'order_ref',
  );
  await insertMany(
    db,
    'order_items',
    ['order_id', 'menu_item_id', 'qty'],
    itemRows.map(([ref, mid, q]) => [orderIds.get(ref), mid, q]),
  );
  await insertMany(
    db,
    'order_events',
    ['order_id', 'outlet_id', 'event_type', 'occurred_at', 'reason', 'source', 'user_id', 'created_at'],
    eventRows.map(([ref, e]) => [
      orderIds.get(ref),
      outletId,
      e.type,
      e.at,
      e.reason ?? null,
      'illustrative',
      c.userId,
      ts,
    ]),
  );
  // link order waste rows to orders
  for (const w of wasteRows) {
    const m = /^Order (\S+) \(demo\)$/.exec(String(w[11] ?? ''));
    if (m) w[15] = orderIds.get(m[1]) ?? null;
  }
  await insertMany(
    db,
    'waste_logs',
    [
      'outlet_id',
      'subject_type',
      'ingredient_id',
      'menu_item_id',
      'batch_id',
      'qty',
      'unit',
      'qty_base',
      'occurred_at',
      'business_date',
      'reason',
      'notes',
      'service_period',
      'cost_paise',
      'cost_basis',
      'outcome_id',
      'order_id',
      'source',
      'created_by',
      'created_at',
    ],
    wasteRows.map((w) => {
      // [outlet, subject, ing, item, batch, qty, unit, qtyBase, at, date, reason, notes, period, cost, basis, outcome, order, source, by, ts]
      const [
        o,
        st,
        ing,
        item,
        batch,
        qty,
        unit,
        qb,
        at,
        date,
        reason,
        notes,
        period,
        cost,
        basis,
        order,
        source,
        by,
        t,
      ] = w;
      const outcome =
        reason === 'unsold_cooked' ? (outcomeIds.get(`${date}|${period}|${item}`) ?? null) : null;
      return [
        o,
        st,
        ing,
        item,
        batch,
        qty,
        unit,
        qb,
        at,
        date,
        reason,
        notes,
        period,
        cost,
        basis,
        outcome,
        order,
        source,
        by,
        t,
      ];
    }),
  );

  if (spec.key === 'tiffin') await seedCompletedPlan(c, outletId, itemIds.get('Upma')!);
  await audit(
    db,
    { outletId, userId: c.userId, entityType: 'outlet', entityId: outletId, action: 'create_demo' },
    c.now,
  );
  return outletId;
}

function ev(type: OrderEventType, at: string, reason?: string): OrderEvent {
  return { type, at, reason };
}

/** Builds a consistent timeline and validates it with the real lifecycle rules. */
function timeline(
  r: () => number,
  spec: OutletSpec,
  channel: string,
  placed: string,
  fate: string,
): { events: OrderEvent[]; status: OrderStatus } {
  const P = spec.orders;
  const e: OrderEvent[] = [ev('received', placed)];
  let t = placed;
  const step = (type: OrderEventType, min: number, reason?: string) => {
    t = plusMin(t, min);
    e.push(ev(type, t, reason));
  };
  if (fate === 'cancelled_before') {
    step('cancelled', ri(r, 2, 6), 'Customer cancelled (demo)');
  } else {
    step('prep_started', ri(r, 1, 3));
    step('prep_completed', ri(r, ...P.prep));
    if (channel !== 'takeaway') {
      step('pack_started', 1);
      step('pack_completed', ri(r, ...P.pack));
      step('rider_assigned', 0);
    }
    step('ready_for_pickup', 0.5);
    if (fate === 'uncollected') {
      step(
        'marked_uncollected',
        ri(r, 40, 60),
        channel === 'takeaway' ? 'Customer did not arrive (demo)' : 'Rider did not arrive (demo)',
      );
      step('closed', 5);
    } else if (channel === 'takeaway') {
      step('picked_up', ri(r, 2, 10));
      step('closed', 1);
    } else {
      const wait = ri(r, ...P.wait);
      step(
        'picked_up',
        wait,
        wait >= spec.settings.warn
          ? r() < 0.5
            ? 'Rider arrived late (demo)'
            : 'Rider waiting for batch of orders (demo)'
          : undefined,
      );
      step('out_for_delivery', 1);
      step('delivered', ri(r, ...P.travel));
      if (fate === 'returned') {
        step('returned', ri(r, 5, 15), 'Customer reported wrong item (demo)');
        step('closed', 5);
      }
    }
  }
  const status = replay(e, new Date(Date.parse(t) + 60_000).toISOString());
  return { events: e, status };
}

/** One completed historical plan so outcome verification has something to show from the start. */
async function seedCompletedPlan(c: Ctx, outletId: number, upmaId: number) {
  const { db, today, userId } = c;
  const planDate = addDays(today, -3);
  const at = (h: number) => ist(addDays(today, -4), h, 0);
  const pid = (
    await db.run(
      `INSERT INTO action_plans (outlet_id, title, plan_date, status, created_by, decided_by, decided_at, submitted_at, completed_at, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      [
        outletId,
        'Reduce Upma preparation (demo history)',
        planDate,
        'completed',
        userId,
        userId,
        at(17),
        at(16),
        ist(planDate, 11, 0),
        at(15),
        ist(planDate, 11, 0),
      ],
    )
  ).lastId;
  const line = {
    type: 'prep',
    subjectType: 'menu_item',
    subjectId: upmaId,
    subjectName: 'Upma',
    qty: 40,
    unit: 'portions',
    note: 'Prepare 40 (average forecast)',
    estimatedCostPaise: null,
  };
  const lid = (
    await db.run(
      `INSERT INTO plan_lines (plan_id, rec_title, option_key, option_label, line_type, subject_type, subject_id, subject_name, proposed_qty, approved_qty, unit, note, original_json)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        pid,
        'Prepare fewer Upma (demo history)',
        'A',
        'Prepare 40 (average forecast)',
        'prep',
        'menu_item',
        upmaId,
        'Upma',
        40,
        40,
        'portions',
        line.note,
        JSON.stringify(line),
      ],
    )
  ).lastId;
  const tid = (
    await db.run(
      `INSERT INTO tasks (outlet_id, plan_id, plan_line_id, due_date, title, status, target_qty, unit, actual_qty, completed_by, completed_at, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        outletId,
        pid,
        lid,
        planDate,
        'Prepare 40 × Upma',
        'done',
        40,
        'portions',
        40,
        userId,
        ist(planDate, 7, 0),
        at(17),
      ],
    )
  ).lastId;
  await db.run(
    `UPDATE service_outcomes SET task_id = ? WHERE outlet_id = ? AND business_date = ? AND menu_item_id = ?`,
    [tid, outletId, planDate, upmaId],
  );
  await insertMany(
    db,
    'approval_history',
    ['plan_id', 'action', 'from_status', 'to_status', 'user_id', 'reason', 'created_at'],
    [
      [pid, 'create', 'draft', 'draft', userId, null, at(15)],
      [pid, 'submit', 'draft', 'awaiting_approval', userId, null, at(16)],
      [pid, 'approve', 'awaiting_approval', 'approved', userId, null, at(17)],
      [pid, 'complete', 'approved', 'completed', userId, 'All tasks closed', ist(planDate, 11, 0)],
    ],
  );
}

// ---------------------------------------------------------------------------
// Demo session lifecycle
// ---------------------------------------------------------------------------

export async function purgeExpiredDemos(db: Db, now: Date) {
  const cutoff = new Date(now.getTime() - DEMO_TTL_HOURS * 3600_000).toISOString();
  const old = await db.all<{ id: number }>('SELECT id FROM users WHERE is_demo = 1 AND created_at < ?', [
    cutoff,
  ]);
  for (const u of old) await deleteDemoUser(db, u.id);
  return old.length;
}

async function deleteDemoOutlets(db: Db, userId: number) {
  // Only outlets that are illustrative AND owned by this demo user — never real data.
  const outlets = await db.all<{ id: number }>(
    `SELECT o.id FROM outlets o JOIN outlet_members m ON m.outlet_id = o.id JOIN users u ON u.id = m.user_id
     WHERE m.user_id = ? AND m.role = 'owner' AND o.is_illustrative = 1 AND u.is_demo = 1`,
    [userId],
  );
  for (const o of outlets) await db.run('DELETE FROM outlets WHERE id = ? AND is_illustrative = 1', [o.id]);
  return outlets.length;
}

async function deleteDemoUser(db: Db, userId: number) {
  await db.tx(async () => {
    await deleteDemoOutlets(db, userId);
    await db.run('DELETE FROM users WHERE id = ? AND is_demo = 1', [userId]);
  });
}

export async function createDemoUser(db: Db, now: Date): Promise<number> {
  await purgeExpiredDemos(db, now);
  const active = (await db.get<{ n: number }>('SELECT COUNT(*) AS n FROM users WHERE is_demo = 1'))!.n;
  if (active >= MAX_ACTIVE_DEMOS) throw new Error('DEMO_CAPACITY');
  const username = `demo-${randomBytes(6).toString('hex')}`;
  const { lastId } = await db.run(
    'INSERT INTO users (username, display_name, password_hash, is_demo, created_at) VALUES (?,?,?,1,?)',
    [username, 'Demo visitor', 'demo-account-no-password-login', iso(now)],
  );
  return lastId;
}

export async function seedDemo(db: Db, userId: number, now: Date): Promise<number[]> {
  const c: Ctx = { db, userId, now, today: todayInTz('Asia/Kolkata', now), ts: iso(now) };
  const ids: number[] = [];
  await db.tx(async () => {
    for (const spec of OUTLETS) ids.push(await seedOutlet(c, spec));
  });
  return ids;
}

/** Deletes and regenerates this demo visitor's outlets. Real data is never touched. */
export async function resetDemo(db: Db, userId: number, now: Date): Promise<number[]> {
  const u = await db.get<{ is_demo: number }>('SELECT is_demo FROM users WHERE id = ?', [userId]);
  if (!u?.is_demo) throw new Error('Not a demo user');
  return db.tx(async () => {
    await deleteDemoOutlets(db, userId);
    return seedDemo(db, userId, now);
  });
}

export const DEMO_OUTLET_KEYS = OUTLETS.map((o) => ({ key: o.key, name: o.name, type: o.type }));
