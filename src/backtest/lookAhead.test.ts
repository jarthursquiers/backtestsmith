import { describe, expect, it } from 'vitest'
import type { UnderlyingBar } from '../domain/bars.js'
import { easternToTimestamp } from '../core/time/marketTime.js'
import { emaAsOf, emaMultiplier, emaSeries, previousCompletedBar, smaAsOf } from './indicators.js'
import { emaDirectionStrategy, fixedDirectionStrategy, type EntryContext } from './entryStrategy.js'
import { candidateExpirationDates, selectExpiration } from './expirationSelection.js'
import {
  expectedMovePlacement,
  fixedDistancePlacement,
  nearestStrike,
  normalizedDistancePlacement
} from './placement.js'

/** Daily bar anchored at the session close of its date. */
function daily(date: string, close: number): UnderlyingBar {
  return {
    ticker: 'I:SPX',
    timestamp: easternToTimestamp(date, 16, 0),
    open: close,
    high: close,
    low: close,
    close
  }
}

/** Ten consecutive sessions with a clear uptrend. */
const HISTORY: UnderlyingBar[] = [
  daily('2025-06-02', 5900),
  daily('2025-06-03', 5910),
  daily('2025-06-04', 5920),
  daily('2025-06-05', 5930),
  daily('2025-06-06', 5940),
  daily('2025-06-09', 5950),
  daily('2025-06-10', 5960),
  daily('2025-06-11', 5970),
  daily('2025-06-12', 5980),
  daily('2025-06-13', 5990)
]

describe('EMA arithmetic', () => {
  it('uses the conventional smoothing factor', () => {
    expect(emaMultiplier(9)).toBeCloseTo(0.2, 10)
    expect(emaMultiplier(1)).toBe(1)
    expect(() => emaMultiplier(0)).toThrow(/positive integer/)
    expect(() => emaMultiplier(2.5)).toThrow(/positive integer/)
  })

  it('seeds with a simple average and then smooths', () => {
    const series = emaSeries(HISTORY, 9)
    // First value is the mean of the first nine closes.
    const seed = HISTORY.slice(0, 9).reduce((s, b) => s + b.close, 0) / 9
    expect(series[0]!.value).toBeCloseTo(seed, 10)
    expect(series[0]!.marketDate).toBe('2025-06-12')

    // Then EMA_t = (close - EMA_prev) * k + EMA_prev.
    const expected = (5990 - seed) * emaMultiplier(9) + seed
    expect(series[1]!.value).toBeCloseTo(expected, 10)
  })

  it('produces nothing before the warm-up completes', () => {
    expect(emaSeries(HISTORY.slice(0, 8), 9)).toEqual([])
  })

  it('is order independent', () => {
    const shuffled = [...HISTORY].reverse()
    expect(emaSeries(shuffled, 9)).toEqual(emaSeries(HISTORY, 9))
  })
})

describe('look-ahead prevention', () => {
  it('excludes the entry date, whose candle has not closed yet', () => {
    /*
     * The defining case from the specification: entering at 9:35 on a Tuesday
     * cannot use Tuesday's daily candle, which will not exist for another six
     * and a half hours.
     */
    const withToday = [...HISTORY, daily('2025-06-16', 6500)]
    const emaExcludingToday = emaAsOf(HISTORY, '2025-06-16', 9)
    const emaWithTodayPresent = emaAsOf(withToday, '2025-06-16', 9)

    expect(emaWithTodayPresent).toBeCloseTo(emaExcludingToday!, 10)
  })

  it('does not change when future bars are appended', () => {
    // The strongest statement of the property: the answer for a date is fixed
    // once that date arrives, no matter what data shows up later.
    const asOf = emaAsOf(HISTORY, '2025-06-16', 9)

    const withFuture = [
      ...HISTORY,
      daily('2025-06-16', 9999),
      daily('2025-06-17', 1),
      daily('2025-06-18', 12345)
    ]
    expect(emaAsOf(withFuture, '2025-06-16', 9)).toBeCloseTo(asOf!, 10)
  })

  it('advances only as sessions actually close', () => {
    const withMonday = [...HISTORY, daily('2025-06-16', 6100)]
    const mondayView = emaAsOf(withMonday, '2025-06-16', 9)
    const tuesdayView = emaAsOf(withMonday, '2025-06-17', 9)

    // Monday's close is invisible on Monday and visible on Tuesday.
    expect(tuesdayView).not.toBeCloseTo(mondayView!, 6)
    expect(tuesdayView).toBeGreaterThan(mondayView!)
  })

  it('applies the same rule to SMA and to the previous close', () => {
    const withToday = [...HISTORY, daily('2025-06-16', 9999)]
    expect(smaAsOf(withToday, '2025-06-16', 5)).toBeCloseTo(smaAsOf(HISTORY, '2025-06-16', 5)!, 10)
    expect(previousCompletedBar(withToday, '2025-06-16')?.close).toBe(5990)
  })

  it('returns null rather than a partial value before warm-up', () => {
    expect(emaAsOf(HISTORY.slice(0, 3), '2025-06-16', 9)).toBeNull()
    expect(smaAsOf(HISTORY.slice(0, 2), '2025-06-16', 5)).toBeNull()
    expect(previousCompletedBar(HISTORY, '2025-01-01')).toBeNull()
  })
})

describe('EMA direction strategy', () => {
  const context = (underlying: number, bars = HISTORY): EntryContext => ({
    entryTimestamp: easternToTimestamp('2025-06-16', 9, 35),
    entryDate: '2025-06-16',
    dailyBars: bars,
    underlyingAtEntry: underlying
  })

  const strategy = emaDirectionStrategy({ period: 9 })
  const emaValue = emaAsOf(HISTORY, '2025-06-16', 9)!

  it('goes bearish with puts below the EMA', () => {
    const signal = strategy.getSignal(context(emaValue - 50))!
    expect(signal.direction).toBe('bearish')
    expect(signal.optionType).toBe('put')
    expect(signal.reason).toMatch(/below the 9 EMA/)
    expect(signal.indicators.ema).toBeCloseTo(emaValue, 10)
  })

  it('goes bullish with calls above the EMA', () => {
    const signal = strategy.getSignal(context(emaValue + 50))!
    expect(signal.direction).toBe('bullish')
    expect(signal.optionType).toBe('call')
  })

  it('can invert the mapping without touching the engine', () => {
    const inverted = emaDirectionStrategy({ period: 9, invert: true })
    expect(inverted.getSignal(context(emaValue - 50))!.direction).toBe('bullish')
  })

  it('suppresses entries too close to the average', () => {
    const filtered = emaDirectionStrategy({ period: 9, minimumDistance: 25 })
    expect(filtered.getSignal(context(emaValue + 5))).toBeNull()
    expect(filtered.getSignal(context(emaValue + 30))).not.toBeNull()
  })

  it('declines to signal without an entry price or enough history', () => {
    const noPrice: EntryContext = {
      entryTimestamp: easternToTimestamp('2025-06-16', 9, 35),
      entryDate: '2025-06-16',
      dailyBars: HISTORY
    }
    expect(strategy.getSignal(noPrice)).toBeNull()
    expect(strategy.getSignal(context(6000, HISTORY.slice(0, 4)))).toBeNull()
  })

  it('is unaffected by bars dated on or after the entry', () => {
    // A signal must not flip because a later session was appended.
    const baseline = strategy.getSignal(context(emaValue - 50))!
    const polluted = strategy.getSignal(
      context(emaValue - 50, [...HISTORY, daily('2025-06-16', 1), daily('2025-06-17', 9999)])
    )!
    expect(polluted.direction).toBe(baseline.direction)
    expect(polluted.indicators.ema).toBeCloseTo(baseline.indicators.ema!, 10)
  })

  it('offers a fixed-direction control', () => {
    const control = fixedDirectionStrategy('bearish')
    expect(control.getSignal(context(6000))!.direction).toBe('bearish')
  })
})

describe('expiration selection', () => {
  // Mon/Wed/Fri weeklies around a Monday entry of 2025-06-16.
  const available = [
    '2025-06-16', '2025-06-18', '2025-06-20', '2025-06-23',
    '2025-06-25', '2025-06-27', '2025-06-30'
  ]

  it('never selects an expiration on or before the entry date', () => {
    const choice = selectExpiration({ entryDate: '2025-06-16', available, targetDte: 0 })!
    expect(choice.expiration > '2025-06-16').toBe(true)
  })

  it('picks the closest expiration to the target', () => {
    const choice = selectExpiration({ entryDate: '2025-06-16', available, targetDte: 7 })!
    expect(choice.expiration).toBe('2025-06-23')
    expect(choice.calendarDte).toBe(7)
    expect(choice.deviation).toBe(0)
  })

  it('reports calendar and trading DTE separately', () => {
    // 2025-06-19 is Juneteenth, so a 4-calendar-day trade is 3 sessions.
    const choice = selectExpiration({ entryDate: '2025-06-16', available, targetDte: 4 })!
    expect(choice.expiration).toBe('2025-06-20')
    expect(choice.calendarDte).toBe(4)
    expect(choice.tradingDte).toBe(3)
  })

  it('honours a preference for longer or shorter than the target', () => {
    const gte = selectExpiration({ entryDate: '2025-06-16', available, targetDte: 6, rule: 'preferGte' })!
    expect(gte.expiration).toBe('2025-06-23') // 7 days
    const lte = selectExpiration({ entryDate: '2025-06-16', available, targetDte: 6, rule: 'preferLte' })!
    expect(lte.expiration).toBe('2025-06-20') // 4 days
  })

  it('breaks a tie toward the longer-dated contract', () => {
    // Target 5 is equidistant from 06-18 (2) and... construct an exact tie.
    const tie = selectExpiration({
      entryDate: '2025-06-16',
      available: ['2025-06-18', '2025-06-24'],
      targetDte: 5
    })!
    // 06-18 is 2 days (dev -3); 06-24 is 8 days (dev +3). Longer wins.
    expect(tie.expiration).toBe('2025-06-24')
  })

  it('returns null when nothing falls inside the tolerance', () => {
    expect(
      selectExpiration({ entryDate: '2025-06-16', available, targetDte: 60, maxDeviation: 3 })
    ).toBeNull()
    expect(selectExpiration({ entryDate: '2025-06-16', available: [], targetDte: 7 })).toBeNull()
  })

  it('generates Mon/Wed/Fri candidates without asserting they exist', () => {
    const candidates = candidateExpirationDates('2025-06-16', '2025-06-22')
    expect(candidates).toEqual(['2025-06-16', '2025-06-18', '2025-06-20'])
  })
})

describe('butterfly placement', () => {
  // 5-point strikes, as SPX lists near the money. Wide enough that both the
  // bearish and bullish structures have their wings listed.
  const strikes = Array.from({ length: 141 }, (_, i) => 5700 + i * 5) // 5700..6400
  const bearish = {
    direction: 'bearish' as const,
    optionType: 'put' as const,
    underlyingAtEntry: 6000,
    reason: '',
    indicators: {}
  }
  const bullish = { ...bearish, direction: 'bullish' as const, optionType: 'call' as const }

  it('places a bearish butterfly below the market', () => {
    const result = fixedDistancePlacement(100).place({
      signal: bearish,
      availableStrikes: strikes,
      wingWidth: 25
    })!
    expect(result.centerStrike).toBe(5900)
    expect(result.lowerStrike).toBe(5875)
    expect(result.upperStrike).toBe(5925)
    expect(result.wingWidth).toBe(25)
  })

  it('places a bullish butterfly above the market', () => {
    const result = fixedDistancePlacement(100).place({
      signal: bullish,
      availableStrikes: strikes,
      wingWidth: 25
    })!
    expect(result.centerStrike).toBe(6100)
  })

  it('expresses placement in wing widths', () => {
    const result = normalizedDistancePlacement(4).place({
      signal: bearish,
      availableStrikes: strikes,
      wingWidth: 25
    })!
    // Four wing widths of 25 is 100 points below 6000.
    expect(result.centerStrike).toBe(5900)
  })

  it('puts the near wing outside the expected move', () => {
    /*
     * The placement the primary study uses. With a 90-point expected move and a
     * 25-wide wing, the near wing sits at 5910 and the centre a further wing
     * beyond it at 5885.
     */
    const result = expectedMovePlacement({ expectedMove: 90 }).place({
      signal: bearish,
      availableStrikes: strikes,
      wingWidth: 25
    })!
    expect(result.centerStrike).toBe(5885)
    expect(result.upperStrike).toBe(5910) // the near wing, closest to the money
    expect(result.lowerStrike).toBe(5860)
    expect(6000 - result.upperStrike).toBeGreaterThanOrEqual(90)
  })

  it('refuses rather than silently narrowing a wing', () => {
    // A chain missing the lower wing must not be completed with a nearby strike:
    // that would change the width, and therefore the risk and every normalized
    // distance derived from it.
    const gapped = strikes.filter((k) => k !== 5875)
    expect(
      fixedDistancePlacement(100).place({ signal: bearish, availableStrikes: gapped, wingWidth: 25 })
    ).toBeNull()
  })

  it('rounds the centre to a listed strike', () => {
    const result = fixedDistancePlacement(97).place({
      signal: bearish,
      availableStrikes: strikes,
      wingWidth: 25
    })!
    // 6000 - 97 = 5903, nearest listed is 5905.
    expect(result.centerStrike).toBe(5905)
  })

  it('handles an empty chain', () => {
    expect(nearestStrike(6000, [])).toBeNull()
    expect(
      fixedDistancePlacement(100).place({ signal: bearish, availableStrikes: [], wingWidth: 25 })
    ).toBeNull()
  })
})
