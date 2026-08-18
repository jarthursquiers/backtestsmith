import { describe, expect, it } from 'vitest'
import type { UnderlyingBar } from '../domain/bars.js'
import { easternToTimestamp, sessionOpen } from '../core/time/marketTime.js'
import { findOrbBreakout, measureOpeningRange } from './openingRange.js'

const DATE = '2024-03-06'
const OPEN = sessionOpen(DATE)

/** One-minute bars from 09:30, each described as [open, high, low, close]. */
function bars(...quads: [number, number, number, number][]): UnderlyingBar[] {
  return quads.map(([open, high, low, close], index) => ({
    ticker: 'I:SPX',
    timestamp: OPEN + index * 60_000,
    open,
    high,
    low,
    close
  }))
}

/** A flat bar that neither extends the range nor breaks it. */
function flat(price: number): [number, number, number, number] {
  return [price, price, price, price]
}

function session(...extra: [number, number, number, number][]): UnderlyingBar[] {
  // Fifteen minutes of opening range spanning 4990..5010, then whatever follows.
  const range: [number, number, number, number][] = [
    [5000, 5010, 4995, 5005],
    [5005, 5008, 4990, 5000],
    ...Array.from({ length: 13 }, () => flat(5000))
  ]
  return bars(...range, ...extra)
}

const OPTIONS = {
  entryDate: DATE,
  openingRangeMinutes: 15,
  confirmationMinutes: 5,
  cutoffTimestamp: easternToTimestamp(DATE, 12, 0)
}

describe('measureOpeningRange', () => {
  it('spans exactly the first N minutes and excludes the minute it closes on', () => {
    const range = measureOpeningRange(session(flat(9999)), OPEN, 15)
    expect(range).not.toBeNull()
    expect(range!.high).toBe(5010)
    expect(range!.low).toBe(4990)
    expect(range!.barCount).toBe(15)
    // The 09:45 bar priced at 9999 belongs to the next candle, not the range.
    expect(range!.closedAt).toBe(OPEN + 15 * 60_000)
  })

  it('returns null when no bars fall inside the window', () => {
    expect(measureOpeningRange(bars(flat(5000)), OPEN + 60 * 60_000, 15)).toBeNull()
  })
})

describe('findOrbBreakout', () => {
  it('confirms on the close of the candle, not on a wick through the range', () => {
    // 09:45-09:49: trades above the range high but closes back inside.
    // 09:50-09:54: closes above it.
    const outcome = findOrbBreakout(
      session(
        [5005, 5030, 5005, 5006],
        ...Array.from({ length: 4 }, () => flat(5006) as [number, number, number, number]),
        ...Array.from({ length: 4 }, () => flat(5008) as [number, number, number, number]),
        [5008, 5015, 5008, 5012]
      ),
      OPTIONS
    )

    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    expect(outcome.breakout.direction).toBe('bullish')
    expect(outcome.breakout.closePrice).toBe(5012)
    expect(outcome.breakout.candleFrom).toBe(OPEN + 20 * 60_000)
  })

  it('enters on the bar after the confirming candle closed, never inside it', () => {
    const outcome = findOrbBreakout(
      session(...Array.from({ length: 4 }, () => flat(5000) as [number, number, number, number]), flat(4980)),
      OPTIONS
    )

    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    expect(outcome.breakout.direction).toBe('bearish')
    // The 09:45-09:49 candle closes at 09:50, which is the first actionable bar.
    expect(outcome.breakout.confirmedAt).toBe(easternToTimestamp(DATE, 9, 50))
    expect(outcome.breakout.confirmedAt).toBeGreaterThan(outcome.breakout.candleFrom)
  })

  it('takes the first qualifying candle, not the largest break', () => {
    const outcome = findOrbBreakout(
      session(
        ...Array.from({ length: 4 }, () => flat(5000) as [number, number, number, number]),
        flat(4989),
        ...Array.from({ length: 4 }, () => flat(4000) as [number, number, number, number]),
        flat(4000)
      ),
      OPTIONS
    )

    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    expect(outcome.breakout.closePrice).toBe(4989)
  })

  it('reports no breakout when every candle closes inside the range', () => {
    const inside = Array.from({ length: 60 }, () => flat(5000) as [number, number, number, number])
    const outcome = findOrbBreakout(session(...inside), OPTIONS)

    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.reason).toContain('no 5-minute candle closed outside')
  })

  it('ignores a break that only happens after the cutoff', () => {
    const quiet = Array.from({ length: 150 }, () => flat(5000) as [number, number, number, number])
    const outcome = findOrbBreakout(session(...quiet, flat(4900), flat(4900), flat(4900), flat(4900), flat(4900)), {
      ...OPTIONS,
      cutoffTimestamp: easternToTimestamp(DATE, 11, 0)
    })

    expect(outcome.ok).toBe(false)
  })

  it('refuses a session with no intraday bars rather than guessing', () => {
    const outcome = findOrbBreakout([], OPTIONS)
    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.reason).toContain('no intraday index bars')
  })

  it('refuses an opening range built from too few bars', () => {
    const sparse = bars(flat(5000), flat(5001)).concat(
      Array.from({ length: 10 }, (_, i) => ({
        ticker: 'I:SPX',
        timestamp: OPEN + (20 + i) * 60_000,
        open: 5000,
        high: 5000,
        low: 5000,
        close: 4900
      }))
    )
    const outcome = findOrbBreakout(sparse, OPTIONS)

    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.reason).toContain('too few')
  })
})
