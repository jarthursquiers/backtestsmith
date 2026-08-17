import type { UnderlyingBar } from '../domain/bars.js'
import { marketDateOf, type MarketDate } from '../core/time/marketTime.js'

/**
 * Technical indicators, computed so that look-ahead bias is structurally
 * impossible rather than merely avoided by discipline.
 *
 * The rule that matters: a daily candle is not complete until its session
 * closes. A trade entered at 9:35 on Tuesday cannot use Tuesday's daily bar,
 * because at 9:35 that bar is six and a half hours from existing. Every function
 * here therefore takes the date being traded and uses only bars that closed
 * strictly before it.
 */

/** Exponential moving average smoothing factor for a period. */
export function emaMultiplier(period: number): number {
  if (!Number.isInteger(period) || period < 1) {
    throw new Error(`EMA period must be a positive integer, received ${period}`)
  }
  return 2 / (period + 1)
}

export interface EmaPoint {
  /** Market date of the bar whose close produced this value. */
  marketDate: MarketDate
  value: number
}

/**
 * Full EMA series over closes, seeded with the simple average of the first
 * `period` values, which is the conventional warm-up.
 *
 * The result begins at the (period-1)th bar; earlier bars have no defined value
 * and are omitted rather than filled with a partial average.
 */
export function emaSeries(bars: readonly UnderlyingBar[], period: number): EmaPoint[] {
  const multiplier = emaMultiplier(period)
  if (bars.length < period) return []

  const sorted = [...bars].sort((a, b) => a.timestamp - b.timestamp)
  const out: EmaPoint[] = []

  let seed = 0
  for (let i = 0; i < period; i++) seed += sorted[i]!.close
  let current = seed / period
  out.push({ marketDate: marketDateOf(sorted[period - 1]!.timestamp), value: current })

  for (let i = period; i < sorted.length; i++) {
    const bar = sorted[i]!
    current = (bar.close - current) * multiplier + current
    out.push({ marketDate: marketDateOf(bar.timestamp), value: current })
  }

  return out
}

/**
 * EMA as it stood at the open of `asOfDate`, using only sessions that had
 * already closed.
 *
 * This is the look-ahead guard. Passing the full history is safe: bars dated on
 * or after `asOfDate` are discarded before anything is computed, so the answer
 * for a given date can never change as later data arrives.
 */
export function emaAsOf(
  bars: readonly UnderlyingBar[],
  asOfDate: MarketDate,
  period: number
): number | null {
  const completed = bars.filter((bar) => marketDateOf(bar.timestamp) < asOfDate)
  const series = emaSeries(completed, period)
  return series.length > 0 ? series[series.length - 1]!.value : null
}

/**
 * The most recent completed daily bar before `asOfDate`.
 *
 * Useful for rules that reference "yesterday's close" without needing the whole
 * indicator series.
 */
export function previousCompletedBar(
  bars: readonly UnderlyingBar[],
  asOfDate: MarketDate
): UnderlyingBar | null {
  let best: UnderlyingBar | null = null
  for (const bar of bars) {
    const date = marketDateOf(bar.timestamp)
    if (date >= asOfDate) continue
    if (!best || bar.timestamp > best.timestamp) best = bar
  }
  return best
}

/** Simple moving average of the last `period` completed closes before a date. */
export function smaAsOf(
  bars: readonly UnderlyingBar[],
  asOfDate: MarketDate,
  period: number
): number | null {
  const completed = bars
    .filter((bar) => marketDateOf(bar.timestamp) < asOfDate)
    .sort((a, b) => a.timestamp - b.timestamp)
  if (completed.length < period) return null
  const window = completed.slice(-period)
  return window.reduce((sum, bar) => sum + bar.close, 0) / period
}
