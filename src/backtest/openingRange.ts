import type { UnderlyingBar } from '../domain/bars.js'
import { sessionClose, sessionOpen, toEastern, type MarketDate } from '../core/time/marketTime.js'

/**
 * Opening range breakout detection.
 *
 * The rule under study: mark the high and low of the session's first candle of a
 * given length, then wait for the first shorter candle that *closes* outside
 * that range. The close is what confirms; a wick through the level is not a
 * signal, which is the whole point of waiting for a candle to complete.
 *
 * ## Why this is a separate module
 *
 * The breakout decides two things at once - the direction of the trade and the
 * minute it is entered - and those are consumed by different parts of the
 * engine. Keeping the detection pure and free of study configuration means it
 * can be tested against hand-built bars, which matters because an off-by-one
 * minute here is indistinguishable from a profitable edge.
 *
 * ## Look-ahead
 *
 * A confirmation candle covering 09:45 through 09:49 has not closed until
 * 09:50:00. The earliest bar a trader could act on is therefore the 09:50 bar,
 * and that is the timestamp reported. Reporting the candle's own last bar would
 * hand the strategy a minute of hindsight on every single trade.
 */

export interface OpeningRange {
  high: number
  low: number
  /** First minute included in the range. */
  from: number
  /** Instant the opening-range candle closed; also the first minute after it. */
  closedAt: number
  /** One-minute bars that formed the range. */
  barCount: number
}

export interface OrbBreakout {
  range: OpeningRange
  direction: 'bullish' | 'bearish'
  /** First minute of the confirming candle. */
  candleFrom: number
  /**
   * Instant the confirming candle closed, which is the earliest minute bar an
   * entry may be attributed to.
   */
  confirmedAt: number
  /** Closing price of the confirming candle. */
  closePrice: number
  /** One-minute bars behind the confirming candle. */
  barCount: number
}

export type OrbOutcome = { ok: true; breakout: OrbBreakout } | { ok: false; reason: string }

export interface OrbOptions {
  entryDate: MarketDate
  /** Length of the opening-range candle, in minutes. */
  openingRangeMinutes: number
  /** Length of each confirmation candle, in minutes. */
  confirmationMinutes: number
  /**
   * Latest instant a breakout may be confirmed. Past it the session is left
   * alone rather than chased, since a midday break of the opening range is a
   * different phenomenon from an opening drive.
   */
  cutoffTimestamp: number
  /**
   * Fraction of an opening range's minutes that must have bars before the range
   * is trusted. A range measured from three bars of a fifteen-minute window is
   * not the session's opening range, it is a guess.
   */
  minimumRangeCoverage?: number
}

const MINUTE = 60_000

/** Formats an instant as Eastern HH:mm, for skip reasons a human has to read. */
function et(timestamp: number): string {
  return toEastern(timestamp).toFormat('HH:mm')
}

/**
 * Measures the opening range from one-minute bars.
 *
 * The range spans `[open, open + minutes)`: a 15-minute range on a 09:30 open is
 * the bars stamped 09:30 through 09:44, and it has closed at 09:45.
 */
export function measureOpeningRange(
  bars: readonly UnderlyingBar[],
  openTimestamp: number,
  minutes: number
): OpeningRange | null {
  if (!Number.isFinite(minutes) || minutes < 1) return null
  const closedAt = openTimestamp + minutes * MINUTE

  let high = Number.NEGATIVE_INFINITY
  let low = Number.POSITIVE_INFINITY
  let barCount = 0

  for (const bar of bars) {
    if (bar.timestamp < openTimestamp || bar.timestamp >= closedAt) continue
    if (bar.high > high) high = bar.high
    if (bar.low < low) low = bar.low
    barCount++
  }

  if (barCount === 0 || !Number.isFinite(high) || !Number.isFinite(low)) return null
  return { high, low, from: openTimestamp, closedAt, barCount }
}

/**
 * Finds the first confirmation candle that closes outside the opening range.
 *
 * Candles are laid out from the instant the opening range closed, so they are
 * aligned to the range rather than to the clock. With a 15-minute range and
 * 5-minute candles those coincide; with a 20-minute range on a 09:30 open they
 * do not, and following the range is the behaviour the rule describes.
 */
export function findOrbBreakout(bars: readonly UnderlyingBar[], options: OrbOptions): OrbOutcome {
  const { entryDate, openingRangeMinutes, confirmationMinutes, cutoffTimestamp } = options
  const minimumCoverage = options.minimumRangeCoverage ?? 0.6

  if (!Number.isFinite(confirmationMinutes) || confirmationMinutes < 1) {
    throw new Error(`Confirmation candle length must be at least one minute, received ${confirmationMinutes}`)
  }

  const open = sessionOpen(entryDate)
  const close = sessionClose(entryDate)

  const sessionBars = bars
    .filter((bar) => bar.timestamp >= open && bar.timestamp < close)
    .sort((a, b) => a.timestamp - b.timestamp)

  if (sessionBars.length === 0) {
    return { ok: false, reason: 'no intraday index bars for the session, so the opening range cannot be measured' }
  }

  const range = measureOpeningRange(sessionBars, open, openingRangeMinutes)
  if (!range) {
    return { ok: false, reason: `no index bars in the ${openingRangeMinutes}-minute opening range` }
  }
  if (range.barCount < Math.ceil(openingRangeMinutes * minimumCoverage)) {
    return {
      ok: false,
      reason:
        `the ${openingRangeMinutes}-minute opening range has only ${range.barCount} of ${openingRangeMinutes} ` +
        'index bars, too few to trust'
    }
  }

  /*
   * The trade is entered on the bar after the candle closes, so a candle whose
   * confirmation lands at or after the session close could never be acted on.
   */
  const lastActionableEntry = close - MINUTE

  for (
    let candleFrom = range.closedAt;
    candleFrom + confirmationMinutes * MINUTE <= Math.min(cutoffTimestamp, lastActionableEntry);
    candleFrom += confirmationMinutes * MINUTE
  ) {
    const candleEnd = candleFrom + confirmationMinutes * MINUTE
    let closePrice: number | null = null
    let barCount = 0

    for (const bar of sessionBars) {
      if (bar.timestamp < candleFrom) continue
      if (bar.timestamp >= candleEnd) break
      // The candle's close is the close of its last observed one-minute bar.
      closePrice = bar.close
      barCount++
    }

    if (closePrice === null) continue

    if (closePrice > range.high || closePrice < range.low) {
      const bullish = closePrice > range.high
      return {
        ok: true,
        breakout: {
          range,
          direction: bullish ? 'bullish' : 'bearish',
          candleFrom,
          confirmedAt: candleEnd,
          closePrice,
          barCount
        }
      }
    }
  }

  return {
    ok: false,
    reason:
      `no ${confirmationMinutes}-minute candle closed outside the ${range.low.toFixed(2)}-${range.high.toFixed(2)} ` +
      `opening range between ${et(range.closedAt)} and ${et(Math.min(cutoffTimestamp, lastActionableEntry))} ET`
  }
}
