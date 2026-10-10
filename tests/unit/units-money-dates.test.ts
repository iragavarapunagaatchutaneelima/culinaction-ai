import { describe, expect, it } from 'vitest';
import { addDays, diffDays, formatDate, parseBusinessDate, todayInTz, weekday } from '../../shared/dates';
import { costOf, formatINR, parseRupeesToPaise, roundPaise } from '../../shared/money';
import {
  addQuantities,
  convert,
  formatQty,
  IncompatibleUnitError,
  roundUpPurchase,
  toBase,
  UnknownUnitError,
} from '../../shared/units';

describe('unit conversion', () => {
  it('converts within a dimension', () => {
    expect(convert(1.5, 'kg', 'g')).toBe(1500);
    expect(convert(250, 'ml', 'L')).toBe(0.25);
    expect(toBase(2, 'L', 'ml')).toBe(2000);
    expect(convert(12, 'pc', 'pc')).toBe(12);
  });
  it('rejects incompatible units', () => {
    expect(() => convert(1, 'kg', 'ml')).toThrow(IncompatibleUnitError);
    expect(() => convert(1, 'pc', 'g')).toThrow(IncompatibleUnitError);
    expect(() => addQuantities({ qty: 1, unit: 'kg' }, { qty: 1, unit: 'L' }, 'g')).toThrow(
      IncompatibleUnitError,
    );
  });
  it('rejects unknown units', () => {
    expect(() => convert(1, 'cup', 'ml')).toThrow(UnknownUnitError);
  });
  it('adds mixed compatible units', () => {
    expect(addQuantities({ qty: 1, unit: 'kg' }, { qty: 250, unit: 'g' }, 'g')).toBe(1250);
  });
  it('formats and rounds purchase quantities', () => {
    expect(formatQty(2500, 'g')).toBe('2.5 kg');
    expect(formatQty(750, 'ml')).toBe('750 ml');
    expect(formatQty(null, 'g')).toBe('—');
    expect(roundUpPurchase(1234.2, 'g')).toBe(1240);
    expect(roundUpPurchase(3.1, 'pc')).toBe(4);
  });
});

describe('money', () => {
  it('parses rupees exactly into paise', () => {
    expect(parseRupeesToPaise('120')).toBe(12000);
    expect(parseRupeesToPaise('0.1')).toBe(10);
    expect(parseRupeesToPaise('1,250.75')).toBe(125075);
    expect(parseRupeesToPaise('')).toBeNull();
    expect(() => parseRupeesToPaise('12.345')).toThrow();
    expect(() => parseRupeesToPaise('-5')).toThrow();
  });
  it('rounds half away from zero', () => {
    expect(roundPaise(2.5)).toBe(3);
    expect(roundPaise(-2.5)).toBe(-3);
    expect(roundPaise(2.4999)).toBe(2);
    expect(Object.is(roundPaise(-0.2), 0)).toBe(true);
  });
  it('costs quantities at fractional unit costs', () => {
    // ₹68/kg = 6.8 paise per g; 1.5 kg → ₹102.00
    expect(costOf(1500, 6.8)).toBe(10200);
    expect(costOf(333, 0.3333)).toBe(111);
  });
  it('formats INR with Indian grouping', () => {
    expect(formatINR(12345678)).toBe('₹1,23,456.78');
    expect(formatINR(null)).toBe('—');
  });
});

describe('dates', () => {
  it('parses ISO and DD/MM/YYYY', () => {
    expect(parseBusinessDate('2026-10-05')).toBe('2026-10-05');
    expect(parseBusinessDate('5/10/2026')).toBe('2026-10-05');
    expect(parseBusinessDate('31/02/2026')).toBeNull();
    expect(parseBusinessDate('yesterday')).toBeNull();
  });
  it('does date arithmetic', () => {
    expect(addDays('2026-10-30', 3)).toBe('2026-11-02');
    expect(diffDays('2026-10-10', '2026-10-12')).toBe(2);
    expect(weekday('2026-10-10')).toBe(6); // Saturday
    expect(formatDate('2026-10-05')).toBe('05/10/2026');
  });
  it('computes today in Asia/Kolkata', () => {
    // 20:00 UTC on 9 Oct is 01:30 IST on 10 Oct
    expect(todayInTz('Asia/Kolkata', new Date('2026-10-09T20:00:00Z'))).toBe('2026-10-10');
  });
});
