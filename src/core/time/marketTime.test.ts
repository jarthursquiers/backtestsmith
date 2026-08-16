import { describe, expect, it } from 'vitest'
import { isEarlyCloseDay, isMarketHoliday } from './holidays.js'
import {
  easternToTimestamp,
  isDuringRegularSession,
  isTradingDay,
  marketDateOf,
  nextTradingDay,
  parseTimeOfDay,
  previousTradingDay,
  sessionClose,
  sessionMinuteCount,
  sessionOpen,
  tradingDaysBetween
} from './marketTime.js'

/** Renders a timestamp as a UTC ISO string, for asserting the zone math directly. */
const utc = (ms: number): string => new Date(ms).toISOString()

describe('Eastern time conversion', () => {
  it('maps 9:30 ET to 14:30 UTC during EST', () => {
    expect(utc(sessionOpen('2025-01-06'))).toBe('2025-01-06T14:30:00.000Z')
  })

  it('maps 9:30 ET to 13:30 UTC during EDT', () => {
    expect(utc(sessionOpen('2025-07-07'))).toBe('2025-07-07T13:30:00.000Z')
  })

  it('handles the spring-forward boundary', () => {
    // 2025-03-09 is the DST transition; the Friday before is EST, Monday after is EDT.
    expect(utc(sessionOpen('2025-03-07'))).toBe('2025-03-07T14:30:00.000Z')
    expect(utc(sessionOpen('2025-03-10'))).toBe('2025-03-10T13:30:00.000Z')
  })

  it('handles the fall-back boundary', () => {
    // 2025-11-02 is the DST transition.
    expect(utc(sessionOpen('2025-10-31'))).toBe('2025-10-31T13:30:00.000Z')
    expect(utc(sessionOpen('2025-11-03'))).toBe('2025-11-03T14:30:00.000Z')
  })

  it('assigns after-hours UTC timestamps to the correct Eastern market date', () => {
    // 01:00 UTC on Jan 7 is 20:00 ET on Jan 6 - naive UTC slicing would say Jan 7.
    expect(marketDateOf(Date.UTC(2025, 0, 7, 1, 0))).toBe('2025-01-06')
    expect(marketDateOf(Date.UTC(2025, 0, 6, 14, 30))).toBe('2025-01-06')
  })

  it('round-trips an Eastern wall clock through a timestamp', () => {
    const ts = easternToTimestamp('2025-06-17', 9, 35)
    expect(utc(ts)).toBe('2025-06-17T13:35:00.000Z')
    expect(marketDateOf(ts)).toBe('2025-06-17')
  })

  it('rejects malformed dates and times', () => {
    expect(() => sessionOpen('06/17/2025')).toThrow(/YYYY-MM-DD/)
    expect(() => parseTimeOfDay('9.35')).toThrow(/HH:mm/)
    expect(() => parseTimeOfDay('25:00')).toThrow(/out of range/)
    expect(parseTimeOfDay('9:35')).toEqual({ hour: 9, minute: 35, second: 0 })
  })
})

describe('holiday calendar', () => {
  it('identifies the 2025 NYSE holidays', () => {
    const holidays2025 = [
      '2025-01-01', // New Year
      '2025-01-20', // MLK Jr. Day
      '2025-02-17', // Washington Birthday
      '2025-04-18', // Good Friday
      '2025-05-26', // Memorial Day
      '2025-06-19', // Juneteenth
      '2025-07-04', // Independence Day
      '2025-09-01', // Labor Day
      '2025-11-27', // Thanksgiving
      '2025-12-25'  // Christmas
    ]
    for (const d of holidays2025) {
      expect(isMarketHoliday(d), d + ' should be a holiday').toBe(true)
      expect(isTradingDay(d), d + ' should not be a trading day').toBe(false)
    }
  })

  it('applies the weekend observation rule', () => {
    // July 4 2026 falls on a Saturday, so the market closes Friday July 3.
    expect(isMarketHoliday('2026-07-03')).toBe(true)
    expect(isMarketHoliday('2026-07-04')).toBe(false)
  })

  it('computes Good Friday from Easter for multiple years', () => {
    expect(isMarketHoliday('2024-03-29')).toBe(true)
    expect(isMarketHoliday('2026-04-03')).toBe(true)
  })

  it('identifies 1:00 PM half sessions', () => {
    expect(isEarlyCloseDay('2025-11-28')).toBe(true) // day after Thanksgiving
    expect(isEarlyCloseDay('2025-12-24')).toBe(true) // Christmas Eve
    expect(isEarlyCloseDay('2025-11-26')).toBe(false)
  })

  it('shortens the session on a half day', () => {
    expect(utc(sessionClose('2025-11-28'))).toBe('2025-11-28T18:00:00.000Z') // 13:00 ET
    expect(utc(sessionClose('2025-11-26'))).toBe('2025-11-26T21:00:00.000Z') // 16:00 ET
    expect(sessionMinuteCount('2025-11-28')).toBe(210)
    expect(sessionMinuteCount('2025-11-26')).toBe(390)
    expect(sessionMinuteCount('2025-11-27')).toBe(0) // holiday
  })
})

describe('trading day navigation', () => {
  it('skips weekends', () => {
    expect(nextTradingDay('2025-06-13')).toBe('2025-06-16') // Fri -> Mon
    expect(previousTradingDay('2025-06-16')).toBe('2025-06-13')
  })

  it('skips holidays', () => {
    // Thursday Nov 27 2025 is Thanksgiving.
    expect(nextTradingDay('2025-11-26')).toBe('2025-11-28')
    expect(previousTradingDay('2025-11-28')).toBe('2025-11-26')
  })

  it('enumerates trading days across a holiday week', () => {
    expect(tradingDaysBetween('2025-11-24', '2025-11-28')).toEqual([
      '2025-11-24',
      '2025-11-25',
      '2025-11-26',
      '2025-11-28'
    ])
  })

  it('bounds the regular session', () => {
    expect(isDuringRegularSession(easternToTimestamp('2025-06-17', 9, 29))).toBe(false)
    expect(isDuringRegularSession(easternToTimestamp('2025-06-17', 9, 30))).toBe(true)
    expect(isDuringRegularSession(easternToTimestamp('2025-06-17', 15, 59))).toBe(true)
    expect(isDuringRegularSession(easternToTimestamp('2025-06-17', 16, 0))).toBe(false)
    expect(isDuringRegularSession(easternToTimestamp('2025-06-14', 12, 0))).toBe(false) // Saturday
  })
})
