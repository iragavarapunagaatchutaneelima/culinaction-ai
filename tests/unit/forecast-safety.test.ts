import { describe, expect, it } from 'vitest';
import { buildSalesIndex, forecastItem } from '../../shared/forecast';
import { batchSafety } from '../../shared/safety';

const T = '2026-10-10'; // Saturday

describe('batch safety', () => {
  const base = { quarantined: false, qualityCheckedOn: null };
  it('treats missing dates as usable but does not invent a date', () => {
    const s = batchSafety({ ...base, dateType: null, dateValue: null }, T, 2);
    expect(s.status).toBe('ok');
    expect(s.usable).toBe(true);
    expect(s.daysToDate).toBeNull();
    expect(s.reason).toMatch(/No use-by/);
  });
  it('excludes past use-by and expiry dates', () => {
    expect(batchSafety({ ...base, dateType: 'use_by', dateValue: '2026-10-09' }, T, 2)).toMatchObject({
      status: 'unsafe',
      usable: false,
    });
    expect(batchSafety({ ...base, dateType: 'expiry', dateValue: '2026-10-01' }, T, 2)).toMatchObject({
      status: 'unsafe',
      usable: false,
    });
  });
  it('flags use-by within the warning window as expiring but usable', () => {
    expect(batchSafety({ ...base, dateType: 'use_by', dateValue: '2026-10-10' }, T, 2)).toMatchObject({
      status: 'expiring',
      usable: true,
      daysToDate: 0,
    });
    expect(batchSafety({ ...base, dateType: 'use_by', dateValue: '2026-10-13' }, T, 2)).toMatchObject({
      status: 'ok',
    });
  });
  it('requires a same-day quality check after best-before', () => {
    expect(batchSafety({ ...base, dateType: 'best_before', dateValue: '2026-10-08' }, T, 2)).toMatchObject({
      status: 'verify',
      usable: false,
    });
    expect(
      batchSafety({ ...base, dateType: 'best_before', dateValue: '2026-10-08', qualityCheckedOn: T }, T, 2),
    ).toMatchObject({ status: 'ok', usable: true });
    expect(
      batchSafety(
        { ...base, dateType: 'best_before', dateValue: '2026-10-08', qualityCheckedOn: '2026-10-09' },
        T,
        2,
      ).status,
    ).toBe('verify');
  });
  it('quarantine overrides everything', () => {
    expect(
      batchSafety(
        { quarantined: true, qualityCheckedOn: null, dateType: 'use_by', dateValue: '2026-12-01' },
        T,
        2,
      ),
    ).toMatchObject({ status: 'unsafe', usable: false });
  });
});

describe('forecast', () => {
  it('uses the same-weekday average when ≥ 2 same-weekday trading days exist', () => {
    const sales = [
      { date: '2026-10-03', menuItemId: 1, qty: 40 }, // Sat
      { date: '2026-09-26', menuItemId: 1, qty: 50 }, // Sat
      { date: '2026-09-19', menuItemId: 1, qty: 30 }, // Sat
      { date: '2026-10-09', menuItemId: 1, qty: 10 }, // Fri — ignored by same-weekday
    ];
    const f = forecastItem(buildSalesIndex(sales), 1, T);
    expect(f.method).toBe('same_weekday');
    expect(f.daysUsed).toBe(3);
    expect(f.mean).toBe(40);
    expect(f.min).toBe(30);
    expect(f.max).toBe(50);
    expect(f.from).toBe('2026-09-19');
  });
  it('counts trading days without a record for this item as zero', () => {
    const sales = [
      { date: '2026-10-03', menuItemId: 1, qty: 20 },
      { date: '2026-09-26', menuItemId: 2, qty: 5 }, // outlet traded; item 1 sold none
    ];
    const f = forecastItem(buildSalesIndex(sales), 1, T);
    expect(f.method).toBe('same_weekday');
    expect(f.values).toEqual([
      { date: '2026-09-26', qty: 0 },
      { date: '2026-10-03', qty: 20 },
    ]);
    expect(f.mean).toBe(10);
  });
  it('falls back to recent days, then reports insufficient data', () => {
    const recent = [
      { date: '2026-10-09', menuItemId: 1, qty: 9 },
      { date: '2026-10-08', menuItemId: 1, qty: 12 },
      { date: '2026-10-07', menuItemId: 1, qty: 15 },
    ];
    const f = forecastItem(buildSalesIndex(recent), 1, T);
    expect(f.method).toBe('recent_days');
    expect(f.mean).toBe(12);

    const thin = forecastItem(buildSalesIndex(recent.slice(0, 2)), 1, T);
    expect(thin.method).toBe('insufficient');
    expect(thin.mean).toBeNull();
    expect(thin.explanation).toMatch(/Insufficient/);
  });
  it('ignores sales on or after the target date', () => {
    const sales = [
      { date: '2026-10-10', menuItemId: 1, qty: 999 },
      { date: '2026-10-17', menuItemId: 1, qty: 999 },
    ];
    expect(forecastItem(buildSalesIndex(sales), 1, T).method).toBe('insufficient');
  });
});
