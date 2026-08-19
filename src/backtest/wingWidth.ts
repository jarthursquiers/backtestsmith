import type { UnderlyingBar } from '../domain/bars.js'
import { describeBands, type WingWidthBand, type WingWidthConfig } from '../shared/study.js'
import { marketDateOf, sessionOpen, type MarketDate } from '../core/time/marketTime.js'

/**
 * Wing width as a function of a volatility gauge.
 *
 * The research claim being tested is that a butterfly should be as wide as the
 * market is volatile: 20 points is a reasonable structure in a quiet tape and a
 * near-certain loser in a violent one. Expressing that as *bands over a gauge*
 * rather than as a formula keeps it something a trader can state and follow.
 *
 * ## Why this is not a swept parameter
 *
 * A parameter sweep over fixed widths asks "which single width was best over
 * this sample". A banded rule asks "does adapting the width to conditions beat
 * any single width". Those are different questions, and the second cannot be
 * answered by the first no matter how many values are swept.
 *
 * ## Look-ahead
 *
 * The gauge is read at the entry minute, which is observable then. Where a
 * reading is missing the rule falls back only to *earlier* observations - a
 * carried-forward level from earlier in the same session, then the previous
 * session's close. It never consults the entry day's closing value, which would
 * be six hours of hindsight applied to the size of every trade.
 */

/** Where a resolved gauge reading came from, recorded with the trade. */
export type GaugeSource = 'entryMinute' | 'carriedForward' | 'previousClose'

export interface GaugeReading {
  level: number
  source: GaugeSource
  /** Minutes between the observation and the entry instant. */
  ageMinutes: number
}

/**
 * Validates a band list, returning the problems rather than throwing.
 *
 * Bands come from user input, so a bad list is a message to show rather than a
 * crash. An overlapping or gapped list would silently size some trades by a
 * rule nobody wrote.
 */
export function validateBands(bands: readonly WingWidthBand[]): string[] {
  const problems: string[] = []
  if (bands.length === 0) return ['At least one wing width band is required.']

  bands.forEach((band, index) => {
    if (!Number.isFinite(band.wingWidth) || band.wingWidth <= 0) {
      problems.push(`Band ${index + 1} has a wing width of ${band.wingWidth}, which must be positive.`)
    }
    const isLast = index === bands.length - 1
    if (isLast && band.below !== undefined) {
      problems.push('The last band must be open-ended so that every gauge level falls inside a band.')
    }
    if (!isLast && band.below === undefined) {
      problems.push(`Band ${index + 1} is open-ended but is not the last band, so later bands can never apply.`)
    }
    if (!isLast && band.below !== undefined && !Number.isFinite(band.below)) {
      problems.push(`Band ${index + 1} has a non-numeric upper bound.`)
    }
  })

  const bounds = bands.slice(0, -1).map((band) => band.below!)
  for (let i = 1; i < bounds.length; i++) {
    if (!(bounds[i]! > bounds[i - 1]!)) {
      problems.push(
        `Band upper bounds must increase; ${bounds[i]} does not come after ${bounds[i - 1]}.`
      )
    }
  }

  return problems
}

/** The wing width for a gauge level. Bands are assumed already validated. */
export function wingWidthForLevel(bands: readonly WingWidthBand[], level: number): number {
  for (const band of bands) {
    if (band.below === undefined || level < band.below) return band.wingWidth
  }
  // Unreachable for a validated list, whose last band is open-ended.
  return bands[bands.length - 1]!.wingWidth
}

/**
 * Reads the gauge as of the entry instant.
 *
 * `minutes` are the gauge's bars for the entry session and `previousDaily` is
 * its most recent completed daily bar. Both are supplied by the caller so this
 * stays a pure function of data that was already knowable at entry.
 */
export function readGauge(options: {
  entryTimestamp: number
  minutes: readonly UnderlyingBar[]
  previousDaily?: UnderlyingBar | undefined
  /** How far back a within-session reading may be carried, in minutes. */
  maxCarryMinutes?: number
}): GaugeReading | null {
  const { entryTimestamp, minutes, previousDaily } = options
  const maxCarry = options.maxCarryMinutes ?? 30

  let best: UnderlyingBar | undefined
  for (const bar of minutes) {
    // Strictly at or before entry: a later bar is not knowable at entry.
    if (bar.timestamp > entryTimestamp) continue
    if (!best || bar.timestamp > best.timestamp) best = bar
  }

  if (best) {
    const ageMinutes = Math.round((entryTimestamp - best.timestamp) / 60_000)
    if (ageMinutes === 0) return { level: best.close, source: 'entryMinute', ageMinutes }
    if (ageMinutes <= maxCarry) {
      return { level: best.close, source: 'carriedForward', ageMinutes }
    }
  }

  if (previousDaily) {
    return {
      level: previousDaily.close,
      source: 'previousClose',
      ageMinutes: Math.round((entryTimestamp - previousDaily.timestamp) / 60_000)
    }
  }

  return null
}

/** The gauge's most recent daily bar strictly before a date. */
export function previousGaugeClose(
  dailyBars: readonly UnderlyingBar[],
  asOfDate: MarketDate
): UnderlyingBar | undefined {
  let best: UnderlyingBar | undefined
  for (const bar of dailyBars) {
    if (marketDateOf(bar.timestamp) >= asOfDate) continue
    if (!best || bar.timestamp > best.timestamp) best = bar
  }
  return best
}

/** Gauge minutes belonging to one session, for the readGauge call. */
export function gaugeMinutesForSession(
  bars: readonly UnderlyingBar[],
  date: MarketDate
): UnderlyingBar[] {
  const open = sessionOpen(date)
  return bars.filter((bar) => bar.timestamp >= open && marketDateOf(bar.timestamp) === date)
}
