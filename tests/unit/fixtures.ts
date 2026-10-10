// TEST FIXTURES ONLY — synthetic values for isolated unit tests. Not restaurant data.
import { addDays } from '../../shared/dates';
import type { BatchSnap, IngredientSnap, MenuItemSnap, SaleSnap, Snapshot } from '../../shared/types';

let id = 1000;
export const nextId = () => ++id;

export function batch(p: Partial<BatchSnap> & { qtyRemaining: number }): BatchSnap {
  return {
    id: nextId(),
    lotCode: null,
    unitCostPaise: 1,
    receivedOn: '2026-10-01',
    dateType: null,
    dateValue: null,
    quarantined: false,
    qualityCheckedOn: null,
    ...p,
  };
}

export function ingredient(
  p: Partial<IngredientSnap> & { id: number; name: string; batches: BatchSnap[] },
): IngredientSnap {
  return { category: 'General', baseUnit: 'g', lastCountedAt: '2026-10-10T03:00:00.000Z', ...p };
}

export function menuItem(p: Partial<MenuItemSnap> & { id: number; name: string }): MenuItemSnap {
  return {
    category: 'Mains',
    pricePaise: 10000,
    active: true,
    recipeVerified: true,
    allergens: null,
    allergensVerified: false,
    lines: [],
    ...p,
  };
}

/** `perDay` sales of an item on each of `days` days before `planDate`. */
export function dailySales(
  menuItemId: number,
  planDate: string,
  days: number,
  perDay: number | ((i: number) => number),
): SaleSnap[] {
  return Array.from({ length: days }, (_, i) => ({
    id: nextId(),
    date: addDays(planDate, -(i + 1)),
    menuItemId,
    qty: typeof perDay === 'function' ? perDay(i) : perDay,
  }));
}

export function snapshot(p: Partial<Snapshot>): Snapshot {
  return {
    today: '2026-10-10',
    planDate: '2026-10-10',
    nowIso: '2026-10-10T04:00:00.000Z',
    settings: { expiryWarnDays: 2, excessCoverDays: 7, staleCountDays: 3, purchaseBufferPct: 10 },
    ingredients: [],
    menuItems: [],
    sales: [],
    outcomes: [],
    pastForecasts: [],
    ...p,
  };
}
