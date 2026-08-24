import { describe, expect, it } from 'vitest'
import type { CalendarObservation, DoubleCalendarSeries } from '../domain/doubleCalendar.js'
import {
  buildCalendarManagement,
  buildCalendarManagementSet,
  calendarStrikeBreach,
  calendarTargetWithStop
} from './calendarExits.js'
import { simulateCalendarTrade } from './simulateCalendar.js'

const ENTRY_COST = 20
const START = Date.UTC(2026, 2, 12, 14, 0)

/**
 * Builds a path from percentage returns against a 20.00 debit.
 *
 * `netValue` is what the rules read, so it is derived from the percentage
 * rather than set independently: a test whose observation disagreed with itself
 * would pass or fail for reasons unrelated to the rule under test.
 */
function path(
  pcts: readonly number[],
  extras: (index: number) => Partial<CalendarObservation> = () => ({})
): DoubleCalendarSeries {
  const observations: CalendarObservation[] = pcts.map((pct, i) => {
    const netValue = ENTRY_COST * (1 + pct / 100)
    return {
      timestamp: START + i * 60_000,
      midValue: netValue + 1,
      netValue,
      spread: 2,
      pnlDollars: (netValue - ENTRY_COST) * 100,
      pnlPct: pct,
      frontDte: Math.max(0, 14 - i),
      frontTradingDte: Math.max(0, 10 - i),
      minutesSinceEntry: i,
      sessionsSinceEntry: i,
      stale: false,
      maxLegAgeMs: 0,
      ...extras(i)
    }
  })

  return {
    definition: {
      structure: 'doubleCalendar',
      underlying: 'SPX',
      root: 'SPXW',
      frontExpiration: '2026-03-26',
      backExpiration: '2026-04-02',
      putStrike: 6700,
      callStrike: 6900,
      tickers: {
        putShort: 'a',
        putLong: 'b',
        callShort: 'c',
        callLong: 'd'
      },
      quantity: 1
    },
    entryCost: ENTRY_COST,
    entryMid: ENTRY_COST,
    entryTimestamp: START,
    entryContext: {
      spot: 6800,
      forward: 6810,
      discountFactor: 0.998,
      putDelta: -0.3,
      callDelta: 0.3,
      putIv: 0.19,
      callIv: 0.14,
      frontDte: 14,
      backDte: 21,
      tentWidth: 200
    },
    observations,
    quality: {
      expectedMinutes: pcts.length,
      pricedMinutes: pcts.length,
      freshMinutes: pcts.length,
      staleMinutes: 0,
      unpricedMinutes: 0,
      invalidPriceMinutes: 0,
      longestStaleRunMinutes: 0,
      missingByLeg: { lower: 0, center: 0, upper: 0 },
      coverage: 1,
      freshness: 1
    },
    execution: {
      spreadFraction: 0.5,
      commissionPerContract: 1.3,
      missingData: { mode: 'carryForward', maxStaleMinutes: 5 }
    },
    warnings: []
  }
}

describe('profit targets', () => {
  it('fills at the threshold rather than at the mark that overshot it', () => {
    const trade = simulateCalendarTrade(path([0, 10, 40]), buildCalendarManagement('tp25'))

    expect(trade.exitReason).toBe('profitTarget')
    expect(trade.pnlPct).toBeCloseTo(25, 10)
    expect(trade.exitValue).toBeCloseTo(25, 10)
    expect(trade.holdingMinutes).toBe(2)
  })

  it('holds to the horizon when the target is never reached', () => {
    const trade = simulateCalendarTrade(path([0, 5, 12, 8]), buildCalendarManagement('tp25'))
    expect(trade.exitReason).toBe('horizon')
    expect(trade.pnlPct).toBeCloseTo(8, 10)
  })
})

describe('stops', () => {
  it('fills at the threshold rather than at the worse mark below it', () => {
    const trade = simulateCalendarTrade(path([0, -20, -60]), buildCalendarManagement('sl50'))
    expect(trade.exitReason).toBe('stopLoss')
    expect(trade.pnlPct).toBeCloseTo(-50, 10)
  })

  it('cannot report a loss beyond the debit', () => {
    const trade = simulateCalendarTrade(path([0, -100, -140]), buildCalendarManagement('sl120'))
    expect(trade.pnlPct).toBeGreaterThanOrEqual(-100)
    expect(trade.exitValue).toBeGreaterThanOrEqual(0)
  })
})

describe('paired rules', () => {
  it('takes the loss when a target and a stop are satisfied in the same minute', () => {
    /*
     * One snapshot cannot say which came first, and the rule must not be
     * allowed to assume the pleasant one. The observation is built so both
     * thresholds are satisfied by the same reading.
     */
    const series = path([0, -60])
    const strategy = calendarTargetWithStop(25, 50)
    const decision = strategy.evaluate({
      observation: { ...series.observations[1]!, pnlPct: 30 },
      position: {
        definition: series.definition,
        entryCost: ENTRY_COST,
        entryTimestamp: START,
        peakPnlPct: 30,
        troughPnlPct: -60
      },
      isLast: false
    })
    expect(decision?.reason).toBe('profitTarget')

    const adverse = strategy.evaluate({
      observation: { ...series.observations[1]!, pnlPct: -60, netValue: ENTRY_COST * 0.4 },
      position: {
        definition: series.definition,
        entryCost: ENTRY_COST,
        entryTimestamp: START,
        peakPnlPct: 30,
        troughPnlPct: -60
      },
      isLast: false
    })
    expect(adverse?.reason).toBe('stopLoss')
  })

  it('resolves a target-and-stop id into both halves', () => {
    const trade = simulateCalendarTrade(path([0, 10, -70, 40]), buildCalendarManagement('tp25-sl50'))
    expect(trade.exitReason).toBe('stopLoss')
    expect(trade.strategyId).toBe('tp25-sl50')
  })
})

describe('time exits', () => {
  it('closes at the configured days to the front expiration', () => {
    const trade = simulateCalendarTrade(path([0, 1, 2, 3, 4, 5]), buildCalendarManagement('dte10'))
    expect(trade.exitReason).toBe('timeExit')
    expect(trade.exitDte).toBe(10)
  })

  it('closes after the configured number of sessions', () => {
    const trade = simulateCalendarTrade(path([0, 1, 2, 3, 4, 5]), buildCalendarManagement('day3'))
    expect(trade.exitReason).toBe('timeExit')
    expect(trade.sessionsHeld).toBe(3)
  })

  it('never fills a scheduled exit on a carried-forward quote', () => {
    const series = path([0, 1, 2, 3, 4, 5], (i) => (i === 3 ? { stale: true } : {}))
    const trade = simulateCalendarTrade(series, buildCalendarManagement('day3'))
    expect(trade.sessionsHeld).toBe(4)
  })
})

describe('strike breach', () => {
  it('closes when the index reaches a short strike', () => {
    const series = path([0, -5, -12], (i) => ({ breachPoints: i === 2 ? 3 : -50, underlyingPrice: 6800 }))
    const trade = simulateCalendarTrade(series, calendarStrikeBreach(0))
    expect(trade.exitReason).toBe('strikeBreach')
    expect(trade.holdingMinutes).toBe(2)
  })

  it('can be armed inside the strike', () => {
    const series = path([0, -5, -12], (i) => ({ breachPoints: -30 + i * 10, underlyingPrice: 6800 }))
    const trade = simulateCalendarTrade(series, calendarStrikeBreach(-20))
    expect(trade.exitReason).toBe('strikeBreach')
    expect(trade.holdingMinutes).toBe(1)
  })

  it('does nothing without underlying data rather than firing blind', () => {
    const trade = simulateCalendarTrade(path([0, -5, -12]), calendarStrikeBreach(0))
    expect(trade.exitReason).toBe('horizon')
  })
})

describe('trailing', () => {
  it('does not arm below the trigger', () => {
    const trade = simulateCalendarTrade(path([0, 10, 2, 1]), buildCalendarManagement('trail25-50pct'))
    expect(trade.exitReason).toBe('horizon')
  })

  it('exits after giving back the configured share of the peak', () => {
    const trade = simulateCalendarTrade(path([0, 40, 30, 19]), buildCalendarManagement('trail25-50pct'))
    expect(trade.exitReason).toBe('trailingProfit')
    expect(trade.pnlPct).toBeCloseTo(19, 10)
    expect(trade.excursions.mfe?.pct).toBe(40)
  })
})

describe('management ids', () => {
  it('resolves every id the study uses', () => {
    const ids = [
      'hold',
      'tp10',
      'tp25',
      'tp50',
      'sl50',
      'tp25-sl50',
      'dte7',
      'day5',
      'breach',
      'breach-20',
      'trail25-50pct',
      'trail25-10pts',
      'tp25+breach',
      'tp25-sl50+dte3'
    ]
    const built = buildCalendarManagementSet(ids)
    expect(built.map((s) => s.id)).toEqual(ids)
  })

  it('rejects an unknown id rather than silently skipping it', () => {
    expect(() => buildCalendarManagement('takeProfitPlease')).toThrow(/Unknown/)
  })

  it('keeps a composite rule adverse-first', () => {
    const trade = simulateCalendarTrade(
      path([0, 30], (i) => ({ breachPoints: i === 1 ? 5 : -80, underlyingPrice: 6950 })),
      buildCalendarManagement('tp25+breach')
    )
    expect(trade.exitReason).toBe('strikeBreach')
  })
})

describe('trade result bookkeeping', () => {
  it('records excursions over the held path only', () => {
    // The +80% comes after the +25% target fires and must not be credited.
    const trade = simulateCalendarTrade(path([0, 25, 80, -50]), buildCalendarManagement('tp25'))
    expect(trade.excursions.mfe?.pct).toBe(25)
    expect(trade.excursions.mae?.pct).toBe(0)
  })

  it('records when each threshold was first reached', () => {
    const trade = simulateCalendarTrade(path([0, 6, 12, 22, 31]), buildCalendarManagement('hold'))
    expect(trade.firstReached['5']).toBe(1)
    expect(trade.firstReached['10']).toBe(2)
    expect(trade.firstReached['20']).toBe(3)
    expect(trade.firstReached['50']).toBeNull()
  })

  it('records the lowest point after each threshold was reached', () => {
    const trade = simulateCalendarTrade(path([0, 20, -10, 5]), buildCalendarManagement('hold'))
    expect(trade.lowestAfterReaching['20']).toBe(-10)
    expect(trade.lowestAfterReaching['50']).toBeNull()
  })

  it('reports the worst structural moment of the held path', () => {
    const series = path([0, -5, -12], (i) => ({ breachPoints: [-90, -20, 15][i]! }))
    const trade = simulateCalendarTrade(series, buildCalendarManagement('hold'))
    expect(trade.maxBreachPoints).toBe(15)
  })
})
