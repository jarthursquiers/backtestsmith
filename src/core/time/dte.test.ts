import { describe, expect, it } from 'vitest'
import { calendarDaysBetween, dteAt, tradingDaysUntil } from './dte.js'
import { easternToTimestamp } from './marketTime.js'

describe('calendar vs trading DTE', () => {
  it('counts calendar days across a weekend', () => {
    // Friday 2025-06-13 to Friday 2025-06-20
    expect(calendarDaysBetween('2025-06-13', '2025-06-20')).toBe(7)
  })

  it('counts calendar days across a DST transition without drift', () => {
    // Spans the 2025-03-09 spring-forward; a raw ms/86400000 division yields 6.958.
    expect(calendarDaysBetween('2025-03-06', '2025-03-13')).toBe(7)
    expect(calendarDaysBetween('2025-10-30', '2025-11-06')).toBe(7)
  })

  it('counts remaining sessions, excluding the current day', () => {
    // Tue 2025-06-10 -> Fri 2025-06-13 is Wed, Thu, Fri.
    expect(tradingDaysUntil('2025-06-10', '2025-06-13')).toBe(3)
  })

  it('excludes ad-hoc market closures', () => {
    // Thu 2025-01-09 was closed for the Jimmy Carter day of mourning, so
    // Tue 2025-01-07 -> Fri 2025-01-10 is only Wed and Fri.
    expect(calendarDaysBetween('2025-01-07', '2025-01-10')).toBe(3)
    expect(tradingDaysUntil('2025-01-07', '2025-01-10')).toBe(2)
  })

  it('excludes holidays from trading DTE', () => {
    // Mon 2025-11-24 -> Fri 2025-11-28 spans Thanksgiving (Thu 11-27).
    expect(calendarDaysBetween('2025-11-24', '2025-11-28')).toBe(4)
    expect(tradingDaysUntil('2025-11-24', '2025-11-28')).toBe(3) // Tue, Wed, Fri
  })

  it('returns zero on and after expiration', () => {
    expect(tradingDaysUntil('2025-06-20', '2025-06-20')).toBe(0)
    expect(tradingDaysUntil('2025-06-23', '2025-06-20')).toBe(0)
  })
})

describe('dteAt', () => {
  it('reports both DTE flavors as of a simulated entry timestamp', () => {
    // Entering 9:35 ET Friday 2025-06-13 targeting Friday 2025-06-20.
    const entry = easternToTimestamp('2025-06-13', 9, 35)
    const dte = dteAt(entry, '2025-06-20')

    expect(dte.asOfDate).toBe('2025-06-13')
    expect(dte.calendarDte).toBe(7)
    // Juneteenth (Thu 2025-06-19) closes the market, so 7 calendar days is
    // only 4 sessions: Mon 16, Tue 17, Wed 18, Fri 20.
    expect(dte.tradingDte).toBe(4)
    expect(dte.fractionalDte).toBeCloseTo(7 + (16 - 9.5833) / 24, 2)
  })

  it('does not go negative past expiration', () => {
    const after = easternToTimestamp('2025-06-23', 10, 0)
    expect(dteAt(after, '2025-06-20').fractionalDte).toBe(0)
  })

  it('keeps calendar and trading DTE distinct on the same trade', () => {
    // A 7-calendar-day butterfly is only 4 sessions when a holiday intervenes.
    const entry = easternToTimestamp('2025-11-21', 9, 35)
    const dte = dteAt(entry, '2025-11-28')
    expect(dte.calendarDte).toBe(7)
    expect(dte.tradingDte).toBe(4) // Mon, Tue, Wed, Fri (Thanksgiving closed)
  })
})
