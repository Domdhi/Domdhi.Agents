import { describe, it, expect, beforeEach } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const rs = require('../../../.agents/core/_lib/run-stamp');

describe('run-stamp', () => {
  beforeEach(() => rs._resetCache());

  it('stamp_isYYMMDD_HHMM', () => {
    // 2026-06-07 17:45 → 260607-1745
    expect(rs.stamp(new Date(2026, 5, 7, 17, 45))).toBe('260607-1745');
    // single-digit month/day/hour/min all zero-padded
    expect(rs.stamp(new Date(2026, 0, 3, 4, 9))).toBe('260103-0409');
  });

  it('monthBucket_isYYYY_MM', () => {
    expect(rs.monthBucket(new Date(2026, 5, 7))).toBe('2026-06');
    expect(rs.monthBucket(new Date(2026, 11, 31))).toBe('2026-12');
  });

  it('dayKey_isYYYY_MM_DD', () => {
    expect(rs.dayKey(new Date(2026, 5, 7))).toBe('2026-06-07');
    expect(rs.dayKey(new Date(2026, 0, 3))).toBe('2026-01-03');
  });

  it('cachedStamp_isStableAcrossCalls', () => {
    const a = rs.cachedStamp();
    const b = rs.cachedStamp();
    expect(a).toBe(b);
  });

  it('cachedStamp_monthBucket_dayKey_allDerivedFromOneInstant', () => {
    // The cached stamp's date prefix must match the cached month bucket and day key.
    const stamp = rs.cachedStamp();            // YYMMDD-HHMM
    const month = rs.cachedMonthBucket();       // YYYY-MM
    const day = rs.cachedDayKey();              // YYYY-MM-DD
    const yymmdd = stamp.slice(0, 6);           // YYMMDD
    expect(month.slice(2).replace('-', '')).toBe(yymmdd.slice(0, 4)); // YY+MM
    expect(day.slice(2).replace(/-/g, '')).toBe(yymmdd);             // YY+MM+DD
  });

  it('_resetCache_allowsRestamp', () => {
    const a = rs.cachedStamp();
    rs._resetCache();
    // After reset a fresh instant is taken; format is still valid.
    expect(rs.cachedStamp()).toMatch(/^\d{6}-\d{4}$/);
    expect(typeof a).toBe('string');
  });
});
