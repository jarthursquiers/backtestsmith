import type { OptionBar } from '../domain/bars.js'
import type { LegPricingModel, LegQuote, LegRole, MissingDataPolicy } from '../domain/butterfly.js'

/**
 * Deriving leg prices from aggregate bars, and aligning three legs onto a
 * common minute grid.
 *
 * This is where the central data limitation is handled. Massive minute bars are
 * trade-derived: a minute with no qualifying trade produces no bar. A butterfly
 * cannot be marked unless all three legs have a price, and for the out-of-the-
 * money wings this study uses, silent minutes are common rather than rare.
 * Every price therefore carries its own age so downstream code can tell an
 * observation from an assumption.
 */

/** Extracts a single price from a bar under the chosen model. */
export function legPrice(bar: OptionBar, model: LegPricingModel): number {
  switch (model) {
    case 'close':
      return bar.close
    case 'ohlc4':
      return (bar.open + bar.high + bar.low + bar.close) / 4
    case 'hl2':
      return (bar.high + bar.low) / 2
  }
}

/**
 * Long butterfly value from its three leg prices.
 *
 *   value = lower - 2 x center + upper
 *
 * Sign convention: this is a *long* butterfly - long one lower strike, short two
 * center strikes, long one upper strike - so the result is the net debit and is
 * normally positive. It is bounded below by zero at expiration and above by the
 * wing width, which is what makes it a defined-risk position.
 *
 * The formula is identical for the call and put variants; what differs is which
 * strikes are chosen relative to the underlying, not the arithmetic.
 */
export function butterflyValue(lower: number, center: number, upper: number): number {
  return lower - 2 * center + upper
}

/** Indexes bars by their exact minute timestamp for O(1) lookup. */
export function indexBarsByMinute(bars: readonly OptionBar[]): Map<number, OptionBar> {
  const index = new Map<number, OptionBar>()
  for (const bar of bars) {
    // Normalize to a whole minute; providers occasionally emit sub-minute drift.
    index.set(Math.floor(bar.timestamp / 60_000) * 60_000, bar)
  }
  return index
}

/**
 * Resolves one leg's price at a given minute.
 *
 * Returns null when no acceptable price exists: under `strict` that means the
 * leg did not trade in that exact minute, and under `carryForward` it means the
 * most recent trade is older than the allowed staleness. Returning null rather
 * than a fabricated value is the whole point.
 */
export function resolveLegQuote(
  ticker: string,
  minute: number,
  index: Map<number, OptionBar>,
  sortedMinutes: readonly number[],
  model: LegPricingModel,
  policy: MissingDataPolicy
): LegQuote | null {
  const exact = index.get(minute)
  if (exact) {
    return { ticker, price: legPrice(exact, model), observedAt: minute, ageMs: 0 }
  }

  if (policy.mode === 'strict') return null

  const maxAgeMs = policy.maxStaleMinutes * 60_000
  const previous = latestAtOrBefore(sortedMinutes, minute)
  if (previous === null) return null

  const ageMs = minute - previous
  if (ageMs > maxAgeMs) return null

  const bar = index.get(previous)
  if (!bar) return null

  return { ticker, price: legPrice(bar, model), observedAt: previous, ageMs }
}

/** Binary search for the greatest value <= target. */
export function latestAtOrBefore(sorted: readonly number[], target: number): number | null {
  let lo = 0
  let hi = sorted.length - 1
  let best: number | null = null
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    const value = sorted[mid]!
    if (value <= target) {
      best = value
      lo = mid + 1
    } else {
      hi = mid - 1
    }
  }
  return best
}

export interface LegSeries {
  role: LegRole
  ticker: string
  index: Map<number, OptionBar>
  minutes: number[]
}

export function buildLegSeries(role: LegRole, ticker: string, bars: readonly OptionBar[]): LegSeries {
  const index = indexBarsByMinute(bars)
  return {
    role,
    ticker,
    index,
    minutes: [...index.keys()].sort((a, b) => a - b)
  }
}

export interface AlignedMinute {
  minute: number
  lower: LegQuote | null
  center: LegQuote | null
  upper: LegQuote | null
  /** True when all three legs resolved to a price. */
  priced: boolean
  /** True when priced but at least one leg was carried forward. */
  stale: boolean
  maxAgeMs: number
}

/** Resolves all three legs across a minute grid. */
export function alignLegs(
  minutes: readonly number[],
  legs: { lower: LegSeries; center: LegSeries; upper: LegSeries },
  model: LegPricingModel,
  policy: MissingDataPolicy
): AlignedMinute[] {
  return minutes.map((minute) => {
    const lower = resolveLegQuote(legs.lower.ticker, minute, legs.lower.index, legs.lower.minutes, model, policy)
    const center = resolveLegQuote(legs.center.ticker, minute, legs.center.index, legs.center.minutes, model, policy)
    const upper = resolveLegQuote(legs.upper.ticker, minute, legs.upper.index, legs.upper.minutes, model, policy)

    const priced = lower !== null && center !== null && upper !== null
    const maxAgeMs = Math.max(lower?.ageMs ?? 0, center?.ageMs ?? 0, upper?.ageMs ?? 0)

    return {
      minute,
      lower,
      center,
      upper,
      priced,
      stale: priced && maxAgeMs > 0,
      maxAgeMs: priced ? maxAgeMs : 0
    }
  })
}
