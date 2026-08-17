import { describe, expect, it } from 'vitest'
import { isTradingDay, tradingDaysBetween } from './marketTime.js'

/**
 * Regression tests for reasoning about a requested date range versus what a
 * provider actually returns.
 *
 * A backfill warning once fired because a requested start of Saturday
 * 2024-08-17 was compared against the first returned bar on Monday 2024-08-19,
 * and reported two years of complete history as truncated. The comparison must
 * be against the first *trading day* in the range, never the raw start date.
 */
describe('requested range versus trading days', () => {
  it('identifies the first trading day when a range starts on a weekend', () => {
    expect(isTradingDay('2024-08-17')).toBe(false) // Saturday
    expect(isTradingDay('2024-08-18')).toBe(false) // Sunday
    expect(isTradingDay('2024-08-19')).toBe(true) // Monday

    const days = tradingDaysBetween('2024-08-17', '2026-08-16')
    expect(days[0]).toBe('2024-08-19')
  })

  it('identifies the last trading day when a range ends on a weekend', () => {
    // 2026-08-16 is a Sunday; the final session is Friday the 14th.
    const days = tradingDaysBetween('2024-08-17', '2026-08-16')
    expect(days[days.length - 1]).toBe('2026-08-14')
  })

  it('agrees with Schwab on the session count over two real years', () => {
    /*
     * Independent validation of the holiday calendar. Schwab returned exactly
     * 499 daily bars for $SPX between 2024-08-19 and 2026-08-14; the calendar,
     * which computes holidays from rules rather than a table, predicts the same
     * count. A change that breaks Good Friday, a weekend-observed holiday,
     * Juneteenth, or the 2025-01-09 closure would move this number.
     */
    expect(tradingDaysBetween('2024-08-19', '2026-08-14')).toHaveLength(499)
  })

  it('excludes the holidays that fall inside that window', () => {
    const days = new Set(tradingDaysBetween('2024-08-19', '2026-08-14'))
    for (const holiday of [
      '2024-09-02', // Labor Day
      '2024-11-28', // Thanksgiving
      '2024-12-25', // Christmas
      '2025-01-01', // New Year's Day
      '2025-01-09', // National Day of Mourning, Jimmy Carter
      '2025-04-18', // Good Friday
      '2025-06-19', // Juneteenth
      '2026-01-19', // MLK Jr. Day
      '2026-04-03', // Good Friday
      '2026-07-03' // Independence Day observed (July 4 is a Saturday)
    ]) {
      expect(days.has(holiday), `${holiday} should not be a session`).toBe(false)
    }
  })
})
