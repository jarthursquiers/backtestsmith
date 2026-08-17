import { describe, expect, it } from 'vitest'
import type { OptionBar, UnderlyingBar } from '../domain/bars.js'
import type { ButterflyDefinition, PricingAssumptions } from '../domain/butterfly.js'
import { easternToTimestamp, sessionMinuteCount } from '../core/time/marketTime.js'
import { butterflyValue, latestAtOrBefore, legPrice } from './legPricing.js'
import { ReconstructionError, reconstructButterfly, sessionMinuteGrid } from './reconstruct.js'

const EXPIRATION = '2025-06-20'

/** A 25-wide downside put butterfly, the shape this study actually trades. */
const DEF: ButterflyDefinition = {
  underlying: 'SPX',
  direction: 'bearish',
  optionType: 'put',
  expiration: EXPIRATION,
  lowerStrike: 5850,
  centerStrike: 5875,
  upperStrike: 5900,
  lowerTicker: 'O:SPXW250620P05850000',
  centerTicker: 'O:SPXW250620P05875000',
  upperTicker: 'O:SPXW250620P05900000',
  wingWidth: 25,
  quantity: 1
}

const t = (date: string, hour: number, minute: number): number => easternToTimestamp(date, hour, minute)

/** Builds a flat bar at a single price, so leg maths stays easy to reason about. */
function bar(ticker: string, timestamp: number, price: number): OptionBar {
  return { ticker, timestamp, open: price, high: price, low: price, close: price, volume: 10 }
}

/**
 * Generates leg bars that produce an exact target butterfly value each minute.
 *
 * Center and upper are pinned, and the lower leg absorbs the difference, so the
 * butterfly value at minute i is exactly `values[i]`.
 */
function legsForValues(startTs: number, values: readonly number[]) {
  const lower: OptionBar[] = []
  const center: OptionBar[] = []
  const upper: OptionBar[] = []
  values.forEach((value, i) => {
    const ts = startTs + i * 60_000
    const centerPrice = 10
    const upperPrice = 20
    // value = lower - 2*center + upper  =>  lower = value + 2*center - upper
    const lowerPrice = value + 2 * centerPrice - upperPrice
    lower.push(bar(DEF.lowerTicker, ts, lowerPrice))
    center.push(bar(DEF.centerTicker, ts, centerPrice))
    upper.push(bar(DEF.upperTicker, ts, upperPrice))
  })
  return { lower, center, upper }
}

describe('butterfly value', () => {
  it('uses the long-butterfly sign convention', () => {
    // Long 1 lower, short 2 center, long 1 upper.
    expect(butterflyValue(30, 20, 12)).toBe(2)
    expect(butterflyValue(10, 10, 10)).toBe(0)
  })

  it('is bounded by zero and the wing width in realistic cases', () => {
    // Deep OTM: all legs near zero, so the fly is worth about nothing.
    expect(butterflyValue(0.1, 0.05, 0.05)).toBeCloseTo(0.05, 5)
    // Pinned at the center at expiry: worth the full wing width.
    expect(butterflyValue(25, 0, 0)).toBe(25)
  })
})

describe('leg pricing models', () => {
  const b: OptionBar = {
    ticker: 'X', timestamp: 0, open: 2, high: 4, low: 1, close: 3, volume: 1
  }

  it('extracts the documented prices', () => {
    expect(legPrice(b, 'close')).toBe(3)
    expect(legPrice(b, 'ohlc4')).toBe((2 + 4 + 1 + 3) / 4)
    expect(legPrice(b, 'hl2')).toBe(2.5)
  })

  it('uses the NBBO midpoint for quote-backed bars', () => {
    const quote: OptionBar = { ...b, bid: 4.2, ask: 4.6 }
    expect(legPrice(quote, 'close')).toBe(4.4)
    expect(legPrice(quote, 'ohlc4')).toBe(4.4)
  })
})

describe('latestAtOrBefore', () => {
  const xs = [10, 20, 30, 40]
  it('finds the most recent value at or before a target', () => {
    expect(latestAtOrBefore(xs, 30)).toBe(30)
    expect(latestAtOrBefore(xs, 35)).toBe(30)
    expect(latestAtOrBefore(xs, 41)).toBe(40)
    expect(latestAtOrBefore(xs, 5)).toBeNull()
    expect(latestAtOrBefore([], 5)).toBeNull()
  })
})

describe('session minute grid', () => {
  it('covers only regular session minutes', () => {
    const grid = sessionMinuteGrid(t('2025-06-17', 9, 35), t('2025-06-17', 9, 39))
    expect(grid).toHaveLength(5)
    expect(grid[0]).toBe(t('2025-06-17', 9, 35))
    expect(grid[4]).toBe(t('2025-06-17', 9, 39))
  })

  it('stops at the close and resumes at the next session open', () => {
    const grid = sessionMinuteGrid(t('2025-06-17', 15, 58), t('2025-06-18', 9, 32))
    // 15:58, 15:59, then 9:30, 9:31, 9:32 the next day. 16:00 is the close and
    // is excluded, matching how session bounds are defined elsewhere.
    expect(grid.map((ts) => new Date(ts).toISOString())).toEqual([
      '2025-06-17T19:58:00.000Z',
      '2025-06-17T19:59:00.000Z',
      '2025-06-18T13:30:00.000Z',
      '2025-06-18T13:31:00.000Z',
      '2025-06-18T13:32:00.000Z'
    ])
  })

  it('matches sessionMinuteCount for a full session', () => {
    // The grid and the calendar must agree, or coverage denominators drift.
    const grid = sessionMinuteGrid(t('2025-06-17', 9, 30), t('2025-06-17', 16, 0))
    expect(grid).toHaveLength(sessionMinuteCount('2025-06-17'))
    expect(grid).toHaveLength(390)
    expect(grid[grid.length - 1]).toBe(t('2025-06-17', 15, 59))
  })

  it('respects a 1:00 PM half session', () => {
    const grid = sessionMinuteGrid(t('2025-11-28', 9, 30), t('2025-11-28', 16, 0))
    expect(grid).toHaveLength(sessionMinuteCount('2025-11-28'))
    expect(grid).toHaveLength(210)
  })

  it('skips weekends and holidays', () => {
    // 2025-06-19 is Juneteenth; 06-21/22 is a weekend.
    const grid = sessionMinuteGrid(t('2025-06-18', 15, 59), t('2025-06-23', 9, 30))
    const dates = [...new Set(grid.map((ts) => new Date(ts).toISOString().slice(0, 10)))]
    expect(dates).toEqual(['2025-06-18', '2025-06-20', '2025-06-23'])
  })
})

describe('reconstructButterfly', () => {
  const entry = t('2025-06-17', 9, 35)

  it('reconstructs the documented synthetic path', () => {
    // From the spec: entry debit 2.00, then 2.20, 3.00, 4.00, 3.20.
    const legs = legsForValues(entry, [2.0, 2.2, 3.0, 4.0, 3.2])
    const series = reconstructButterfly({
      definition: DEF,
      legBars: legs,
      entryTimestamp: entry,
      exitTimestamp: entry + 4 * 60_000
    })

    expect(series.entryDebit).toBeCloseTo(2.0, 10)
    expect(series.observations).toHaveLength(5)
    expect(series.observations.map((o) => Number(o.butterflyValue.toFixed(2)))).toEqual([
      2.0, 2.2, 3.0, 4.0, 3.2
    ])

    // P/L in dollars is (value - debit) x 100 x quantity.
    expect(series.observations[3]!.pnlDollars).toBeCloseTo(200, 6)
    // +100% at 4.00 against a 2.00 debit.
    expect(series.observations[3]!.pnlPct).toBeCloseTo(100, 6)
    expect(series.observations[1]!.pnlPct).toBeCloseTo(10, 6)
    expect(series.observations[4]!.pnlPct).toBeCloseTo(60, 6)
  })

  it('tracks minutes since entry and DTE', () => {
    const legs = legsForValues(entry, [2, 2, 2])
    const series = reconstructButterfly({
      definition: DEF,
      legBars: legs,
      entryTimestamp: entry,
      exitTimestamp: entry + 2 * 60_000
    })

    expect(series.observations.map((o) => o.minutesSinceEntry)).toEqual([0, 1, 2])
    // 2025-06-17 to 2025-06-20 is 3 calendar days; Juneteenth removes one session.
    expect(series.observations[0]!.dte).toBe(3)
    expect(series.observations[0]!.tradingDte).toBe(2)
  })

  it('applies entry slippage against the trader', () => {
    const legs = legsForValues(entry, [2.0, 3.0])
    const pricing: PricingAssumptions = {
      model: 'close',
      slippage: 0.1,
      missingData: { mode: 'strict' }
    }
    const series = reconstructButterfly({
      definition: DEF, legBars: legs, entryTimestamp: entry,
      exitTimestamp: entry + 60_000, pricing
    })

    // Paying 2.10 for a fly marked at 2.00 starts the trade slightly negative.
    expect(series.entryDebit).toBeCloseTo(2.1, 10)
    expect(series.observations[0]!.pnlDollars).toBeCloseTo(-10, 6)
  })

  it('computes normalized distance to the center strike', () => {
    const legs = legsForValues(entry, [2, 2, 2])
    const underlying: UnderlyingBar[] = [
      { ticker: 'I:SPX', timestamp: entry, open: 5900, high: 5900, low: 5900, close: 5900 },
      { ticker: 'I:SPX', timestamp: entry + 60_000, open: 5887.5, high: 5887.5, low: 5887.5, close: 5887.5 },
      { ticker: 'I:SPX', timestamp: entry + 120_000, open: 5875, high: 5875, low: 5875, close: 5875 }
    ]
    const series = reconstructButterfly({
      definition: DEF, legBars: legs, underlyingBars: underlying,
      entryTimestamp: entry, exitTimestamp: entry + 2 * 60_000
    })

    // Center 5875, wing width 25: one full wing away, half a wing, then at the center.
    expect(series.observations.map((o) => o.normalizedDistanceToCenter)).toEqual([1, 0.5, 0])
    expect(series.observations.map((o) => o.distanceToCenter)).toEqual([25, 12.5, 0])
    expect(series.entryUnderlying).toBe(5900)
  })

  it('leaves distance undefined when the underlying is unavailable', () => {
    const legs = legsForValues(entry, [2, 2])
    const series = reconstructButterfly({
      definition: DEF, legBars: legs, entryTimestamp: entry, exitTimestamp: entry + 60_000
    })
    expect(series.observations[0]!.underlyingPrice).toBeUndefined()
    expect(series.observations[0]!.normalizedDistanceToCenter).toBeUndefined()
    expect(series.warnings.join(' ')).toMatch(/No underlying data/)
  })
})

describe('missing data handling', () => {
  const entry = t('2025-06-17', 9, 35)

  /** Removes the bar at a given minute offset from one leg. */
  function dropMinute(legs: ReturnType<typeof legsForValues>, role: 'lower' | 'center' | 'upper', offset: number) {
    const ts = entry + offset * 60_000
    return { ...legs, [role]: legs[role].filter((b) => b.timestamp !== ts) }
  }

  it('strict mode refuses to price a minute with a missing leg', () => {
    const legs = dropMinute(legsForValues(entry, [2, 3, 4]), 'center', 1)
    const series = reconstructButterfly({
      definition: DEF, legBars: legs, entryTimestamp: entry, exitTimestamp: entry + 2 * 60_000,
      pricing: { model: 'close', slippage: 0, missingData: { mode: 'strict' } }
    })

    // The middle minute is skipped entirely rather than interpolated.
    expect(series.observations.map((o) => o.minutesSinceEntry)).toEqual([0, 2])
    expect(series.quality.unpricedMinutes).toBe(1)
    expect(series.quality.missingByLeg.center).toBe(1)
    expect(series.quality.coverage).toBeCloseTo(2 / 3, 6)
  })

  it('carry-forward reuses the last observed price and flags it as stale', () => {
    const legs = dropMinute(legsForValues(entry, [2, 3, 4]), 'center', 1)
    const series = reconstructButterfly({
      definition: DEF, legBars: legs, entryTimestamp: entry, exitTimestamp: entry + 2 * 60_000,
      pricing: { model: 'close', slippage: 0, missingData: { mode: 'carryForward', maxStaleMinutes: 5 } }
    })

    expect(series.observations).toHaveLength(3)
    const middle = series.observations[1]!
    expect(middle.stale).toBe(true)
    expect(middle.maxLegAgeMs).toBe(60_000)
    // Center carried forward at 10 while lower moved, so the value still moves.
    expect(series.quality.staleMinutes).toBe(1)
    expect(series.quality.freshMinutes).toBe(2)
    expect(series.quality.freshness).toBeCloseTo(2 / 3, 6)
  })

  it('refuses to carry a price beyond the staleness limit', () => {
    // Center trades at minute 0 then goes silent for the rest.
    const legs = legsForValues(entry, [2, 3, 4, 5, 6])
    const sparse = {
      ...legs,
      center: legs.center.filter((b) => b.timestamp === entry)
    }
    const series = reconstructButterfly({
      definition: DEF, legBars: sparse, entryTimestamp: entry, exitTimestamp: entry + 4 * 60_000,
      pricing: { model: 'close', slippage: 0, missingData: { mode: 'carryForward', maxStaleMinutes: 2 } }
    })

    // Minutes 0,1,2 priced (ages 0,1,2); minutes 3 and 4 exceed the tolerance.
    expect(series.observations.map((o) => o.minutesSinceEntry)).toEqual([0, 1, 2])
    expect(series.quality.unpricedMinutes).toBe(2)
    expect(series.quality.longestStaleRunMinutes).toBe(4)
  })

  it('reports a data-quality warning when coverage is poor', () => {
    const legs = legsForValues(entry, [2, 3, 4, 5, 6, 7, 8, 9])
    const sparse = { ...legs, upper: legs.upper.filter((_, i) => i === 0) }
    const series = reconstructButterfly({
      definition: DEF, legBars: sparse, entryTimestamp: entry, exitTimestamp: entry + 7 * 60_000,
      pricing: { model: 'close', slippage: 0, missingData: { mode: 'carryForward', maxStaleMinutes: 1 } }
    })
    expect(series.quality.coverage).toBeLessThan(0.5)
    expect(series.warnings.join(' ')).toMatch(/could be priced/)
  })

  it('fails clearly when the butterfly can never be priced', () => {
    const legs = legsForValues(entry, [2, 3])
    const noCenter = { ...legs, center: [] as OptionBar[] }
    expect(() =>
      reconstructButterfly({
        definition: DEF, legBars: noCenter, entryTimestamp: entry, exitTimestamp: entry + 60_000
      })
    ).toThrow(/could not be priced at any minute/)
  })

  it('uses the first priceable minute when entry itself is silent', () => {
    const legs = legsForValues(entry, [2, 3, 4])
    // Nothing trades in the entry minute on the lower leg.
    const delayed = { ...legs, lower: legs.lower.filter((b) => b.timestamp !== entry) }
    const series = reconstructButterfly({
      definition: DEF, legBars: delayed, entryTimestamp: entry, exitTimestamp: entry + 2 * 60_000,
      pricing: { model: 'close', slippage: 0, missingData: { mode: 'strict' } }
    })

    expect(series.entryTimestamp).toBe(entry + 60_000)
    expect(series.entryDebit).toBeCloseTo(3, 10)
    expect(series.warnings.join(' ')).toMatch(/first fill was 1 minute/)
  })

  it('rejects an exit before entry', () => {
    const legs = legsForValues(entry, [2])
    expect(() =>
      reconstructButterfly({
        definition: DEF, legBars: legs, entryTimestamp: entry, exitTimestamp: entry - 60_000
      })
    ).toThrow(ReconstructionError)
  })
})
