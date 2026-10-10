import { diffDays } from './dates';
import type { BatchSnap } from './types';

export type BatchStatus = 'unsafe' | 'verify' | 'expiring' | 'ok';

export interface BatchSafety {
  status: BatchStatus;
  usable: boolean;
  reason: string;
  daysToDate: number | null;
}

/**
 * Food-safety classification of a batch. This is a HARD constraint: anything not
 * `usable` is excluded from every stock calculation and can never be proposed for use.
 * It does not certify food as safe — it only applies the dates and flags the operator supplied.
 */
export function batchSafety(
  b: Pick<BatchSnap, 'dateType' | 'dateValue' | 'quarantined' | 'qualityCheckedOn'>,
  today: string,
  warnDays: number,
): BatchSafety {
  if (b.quarantined) {
    return {
      status: 'unsafe',
      usable: false,
      reason: 'Marked unsafe / quarantined by an operator',
      daysToDate: null,
    };
  }
  if (!b.dateType || !b.dateValue) {
    return {
      status: 'ok',
      usable: true,
      reason: 'No use-by, expiry or best-before date supplied',
      daysToDate: null,
    };
  }
  const days = diffDays(today, b.dateValue);
  if (b.dateType === 'use_by' || b.dateType === 'expiry') {
    const label = b.dateType === 'use_by' ? 'Use-by' : 'Expiry';
    if (days < 0)
      return { status: 'unsafe', usable: false, reason: `${label} date has passed`, daysToDate: days };
    if (days <= warnDays) {
      return {
        status: 'expiring',
        usable: true,
        reason: `${label} date in ${days} day(s)`,
        daysToDate: days,
      };
    }
    return { status: 'ok', usable: true, reason: `${label} date in ${days} day(s)`, daysToDate: days };
  }
  // best_before: quality date, not a safety date. Past it, an operator must check it today.
  if (days < 0) {
    if (b.qualityCheckedOn === today) {
      return {
        status: 'ok',
        usable: true,
        reason: 'Best-before passed; quality checked today by operator',
        daysToDate: days,
      };
    }
    return {
      status: 'verify',
      usable: false,
      reason: 'Best-before date has passed — quality check required',
      daysToDate: days,
    };
  }
  return { status: 'ok', usable: true, reason: `Best-before in ${days} day(s)`, daysToDate: days };
}

/** Sort key for FIFO-by-date consumption: earliest dated first, undated last, then by received date. */
export function fifoCompare(
  a: { dateValue: string | null; receivedOn: string; id: number },
  b: { dateValue: string | null; receivedOn: string; id: number },
): number {
  if (a.dateValue && b.dateValue && a.dateValue !== b.dateValue) return a.dateValue < b.dateValue ? -1 : 1;
  if (a.dateValue && !b.dateValue) return -1;
  if (!a.dateValue && b.dateValue) return 1;
  if (a.receivedOn !== b.receivedOn) return a.receivedOn < b.receivedOn ? -1 : 1;
  return a.id - b.id;
}
