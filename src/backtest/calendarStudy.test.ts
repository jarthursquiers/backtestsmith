import { describe, expect, it } from 'vitest'
import type { OptionBar, UnderlyingBar } from '../domain/bars.js'
import { DEFAULT_CALENDAR_EXECUTION } from '../domain/doubleCalendar.js'
import { easternToTimestamp, tradingDaysBetween, type MarketDate } from '../core/time/marketTime.js'
import { blackPrice } from './optionMath.js'
import type { ChainQuote } from './calendarStrikes.js'
import {
  entrySessions,
  nearestExpiration,
  normalizeCalendarSkip,
  runDoubleCalendarStudy,
  DEFAULT_CALENDAR_STUDY,
  type CalendarDataSource,
  type DoubleCalendarStudyConfig
} from './calendarStudy.js'

const CONFIG: DoubleCalendarStudyConfig = {
  ...DEFAULT_CALENDAR_STUDY,
  from: '2026-03-02',
  to: '2026-03-20',
  managements: ['hold', 'tp25', 'tp25-sl50']
}

describe('entrySessions', () => {
  it('takes one session per week on the scheduled weekday', () => {
    const sessions = entrySessions({ ...CONFIG, entryWeekdays: [1] })
    expect(sessions).toEqual(['2026-03-02', '2026-03-09', '2026-03-16'])
  })

  it('falls back to the first session of a week whose scheduled day is a holiday', () => {
    // 2026-01-19 is the Martin Luther King Jr. holiday, a Monday.
    const sessions = entrySessions({
      ...CONFIG,
      from: '2026-01-12',
      to: '2026-01-30',
      entryWeekdays: [1]
    })
    expect(sessions).toContain('2026-01-20')
    expect(sessions).not.toContain('2026-01-19')
    // One entry per week, holiday or not.
    expect(sessions).toHaveLength(3)
  })

  it('returns every session when no weekday is specified', () => {
    const sessions = entrySessions({ ...CONFIG, entryWeekdays: [] })
    expect(sessions).toEqual(tradingDaysBetween('2026-03-02', '2026-03-20'))
  })
})

describe('nearestExpiration', () => {
  const available = ['2026-03-13', '2026-03-16', '2026-03-17', '2026-03-23', '2026-03-30']

  it('takes the closest listed expiration to the target', () => {
    expect(nearestExpiration('2026-03-02', available, 14, 3)).toEqual({
      expiration: '2026-03-16',
      dte: 14
    })
  })

  it('refuses anything beyond the tolerance', () => {
    expect(nearestExpiration('2026-03-02', available, 60, 3)).toBeNull()
  })

  it('ignores expirations at or before the entry date', () => {
    expect(nearestExpiration('2026-03-16', available, 0, 3)?.expiration).toBe('2026-03-17')
  })
})

describe('normalizeCalendarSkip', () => {
  it('groups the same cause across different dates and contracts', () => {
    const a = normalizeCalendarSkip('the 2026-03-16 chain has no quotes at the entry minute')
    const b = normalizeCalendarSkip('the 2026-04-20 chain has no quotes at the entry minute')
    expect(a).toBe(b)
  })
})

// --- an end-to-end run against a synthetic archive ---------------------------

const ATM_VOL = 0.16
const SKEW_PER_PERCENT = 0.012
/** The front month is priced richer than the back: the calendar's premise. */
const FRONT_VOL_PREMIUM = 0.02

function strikeLadder(spot: number): number[] {
  const centre = Math.round(spot / 5) * 5
  const strikes: number[] = []
  for (let strike = centre - 600; strike <= centre + 600; strike += 5) strikes.push(strike)
  return strikes
}

function ticker(expiration: MarketDate, right: 'call' | 'put', strike: number): string {
  const compact = expiration.replace(/-/g, '').slice(2)
  return `O:SPXW${compact}${right === 'call' ? 'C' : 'P'}${String(Math.round(strike * 1000)).padStart(8, '0')}`
}

/** A flat index at 6800 for every minute of every session in the range. */
function indexLevel(): number {
  return 6800
}

function yearsTo(from: number, expiration: MarketDate): number {
  return Math.max(1e-6, (easternToTimestamp(expiration, 16, 0) - from) / (365 * 24 * 3600 * 1000))
}

function quoteFor(
  expiration: MarketDate,
  right: 'call' | 'put',
  strike: number,
  minute: number,
  isFront: boolean
): { bid: number; ask: number } {
  const spot = indexLevel()
  const forward = spot * 1.0015
  const years = yearsTo(minute, expiration)
  const moneyness = ((forward - strike) / forward) * 100
  const volatility = Math.max(
    0.05,
    ATM_VOL + SKEW_PER_PERCENT * moneyness + (isFront ? FRONT_VOL_PREMIUM : 0)
  )
  const price = blackPrice({ forward, strike, years, volatility, discountFactor: 0.998, right })
  const halfSpread = 0.25
  return { bid: Math.max(0.05, price - halfSpread), ask: price + halfSpread }
}

/**
 * An archive of one synthetic world.
 *
 * Every weekday lists an expiration, the index never moves, and the front month
 * carries a volatility premium over the back. A calendar in this world can only
 * make money, which is exactly what makes it a usable fixture: any loss, any
 * skipped session, or any strike away from 30 delta is a defect in the runner
 * rather than a property of the market.
 */
function syntheticSource(expirations: readonly MarketDate[]): CalendarDataSource {
  const frontFor = new Set(expirations)

  return {
    listExpirations: async () => [...expirations],

    chainSnapshot: async (_root, expiration, _onDate, minute): Promise<ChainQuote[]> => {
      if (!frontFor.has(expiration)) return []
      const quotes: ChainQuote[] = []
      for (const strike of strikeLadder(indexLevel())) {
        for (const right of ['call', 'put'] as const) {
          const { bid, ask } = quoteFor(expiration, right, strike, minute, true)
          quotes.push({ ticker: ticker(expiration, right, strike), strike, right, bid, ask, ageMs: 0 })
        }
      }
      return quotes
    },

    getOptionBars: async (tickers, from, to): Promise<Record<string, OptionBar[]>> => {
      const out: Record<string, OptionBar[]> = {}
      const dates = tradingDaysBetween(from, to)
      for (const t of tickers) {
        const match = /^O:SPXW(\d{6})([CP])(\d{8})$/.exec(t)!
        const expiration = `20${match[1]!.slice(0, 2)}-${match[1]!.slice(2, 4)}-${match[1]!.slice(4, 6)}`
        const right = match[2] === 'C' ? ('call' as const) : ('put' as const)
        const strike = Number(match[3]) / 1000
        // The shorter-dated of the two legs is the front; expiry order decides.
        const isFront = expiration === dates.at(-1)

        const bars: OptionBar[] = []
        for (const date of dates) {
          for (let hour = 10; hour < 16; hour++) {
            for (let minute = 0; minute < 60; minute += 10) {
              const ts = easternToTimestamp(date, hour, minute)
              if (ts >= easternToTimestamp(expiration, 16, 0)) continue
              const { bid, ask } = quoteFor(expiration, right, strike, ts, isFront)
              const mid = (bid + ask) / 2
              bars.push({
                ticker: t,
                timestamp: ts,
                open: mid,
                high: mid,
                low: mid,
                close: mid,
                volume: 0,
                bid,
                ask
              })
            }
          }
        }
        out[t] = bars
      }
      return out
    },

    getUnderlyingMinutes: async (tickerName, date): Promise<UnderlyingBar[]> => {
      const bars: UnderlyingBar[] = []
      for (let hour = 9; hour < 16; hour++) {
        for (let minute = 0; minute < 60; minute++) {
          if (hour === 9 && minute < 30) continue
          const level = indexLevel()
          bars.push({
            ticker: tickerName,
            timestamp: easternToTimestamp(date, hour, minute),
            open: level,
            high: level,
            low: level,
            close: level
          })
        }
      }
      return bars
    }
  }
}

describe('runDoubleCalendarStudy', () => {
  const expirations = tradingDaysBetween('2026-03-03', '2026-04-30')
  const config: DoubleCalendarStudyConfig = {
    ...CONFIG,
    from: '2026-03-02',
    to: '2026-03-16',
    // The synthetic archive quotes every ten minutes, so the carry must span
    // the gaps or nine minutes in ten would be unquotable.
    execution: {
      ...DEFAULT_CALENDAR_EXECUTION,
      missingData: { mode: 'carryForward', maxStaleMinutes: 10 }
    },
    managements: ['hold', 'tp25', 'tp25-sl50', 'day5']
  }

  it('produces one entry per scheduled week, under every management rule', async () => {
    const outcome = await runDoubleCalendarStudy(config, syntheticSource(expirations))

    expect(outcome.skipped).toEqual([])
    expect(outcome.series).toHaveLength(3)
    expect(outcome.trades).toHaveLength(3 * 4)
    expect(new Set(outcome.trades.map((t) => t.strategyId))).toEqual(
      new Set(['hold', 'tp25', 'tp25-sl50', 'day5'])
    )
  })

  it('selects both short strikes near the target delta', async () => {
    const outcome = await runDoubleCalendarStudy(config, syntheticSource(expirations))

    for (const series of outcome.series) {
      expect(Math.abs(series.entryContext.putDelta)).toBeGreaterThan(0.27)
      expect(Math.abs(series.entryContext.putDelta)).toBeLessThan(0.33)
      expect(series.entryContext.callDelta).toBeGreaterThan(0.27)
      expect(series.entryContext.callDelta).toBeLessThan(0.33)
    }
  })

  it('uses the same pair of expirations for both calendars, seven days apart', async () => {
    const outcome = await runDoubleCalendarStudy(config, syntheticSource(expirations))

    for (const series of outcome.series) {
      expect(series.entryContext.frontDte).toBe(14)
      expect(series.entryContext.backDte).toBe(21)
      expect(series.definition.frontExpiration < series.definition.backExpiration).toBe(true)
      expect(series.definition.putStrike).toBeLessThan(series.definition.callStrike)
    }
  })

  it('opens for a debit and closes no later than the front expiration', async () => {
    const outcome = await runDoubleCalendarStudy(config, syntheticSource(expirations))

    for (const trade of outcome.trades) {
      expect(trade.entryDebit).toBeGreaterThan(0)
      const horizon = easternToTimestamp(trade.definition.frontExpiration, 15, 45)
      expect(trade.exitTimestamp).toBeLessThanOrEqual(horizon)
    }
  })

  it('skips a session rather than failing the run when no expiration fits', async () => {
    const outcome = await runDoubleCalendarStudy(
      { ...config, frontTargetDte: 400, backTargetDte: 410 },
      syntheticSource(expirations)
    )
    expect(outcome.series).toHaveLength(0)
    expect(outcome.skipped).toHaveLength(3)
    expect(Object.values(outcome.skipReasons)[0]).toBe(3)
  })

  it('refuses a configuration whose back month is not later than its front', async () => {
    await expect(
      runDoubleCalendarStudy({ ...config, backTargetDte: 14 }, syntheticSource(expirations))
    ).rejects.toThrow(/later than the front/)
  })

  it('refuses a spread fraction outside 0..1', async () => {
    await expect(
      runDoubleCalendarStudy(
        { ...config, execution: { ...config.execution, spreadFraction: 1.5 } },
        syntheticSource(expirations)
      )
    ).rejects.toThrow(/spread fraction/)
  })
})
