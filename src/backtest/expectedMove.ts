import type { OptionBar } from '../domain/bars.js'
import { legPrice, resolveLegQuote, type LegSeries } from './legPricing.js'
import type { LegPricingModel, MissingDataPolicy } from '../domain/butterfly.js'

/**
 * Expected move, taken as the at-the-money straddle price.
 *
 * The straddle is what the market charges to be wrong in either direction, so
 * its price is the market's own statement of the move it expects by expiration.
 * It is not a one-standard-deviation figure - a straddle runs somewhat richer
 * than 1 SD, commonly quoted around 1.25 SD - so `multiplier` exists for studies
 * that prefer a scaled version. The default of 1.0 is the raw straddle, which is
 * the convention this project uses.
 *
 * No model is involved: no volatility input, no distribution assumption. That
 * keeps the number honest but also means it inherits every weakness of the
 * prints behind it, so the staleness of both legs travels with the result.
 */

export interface ExpectedMoveEstimate {
  /** Expected move in underlying points. */
  points: number
  /** Strike the straddle was taken at. */
  strike: number
  callPrice: number
  putPrice: number
  /** Worst leg staleness behind the estimate, in milliseconds. */
  maxAgeMs: number
  /** Distance from the underlying to the strike used, in points. */
  moneynessGap: number
}

export interface ExpectedMoveOptions {
  underlyingAtEntry: number
  strike: number
  callBars: readonly OptionBar[]
  putBars: readonly OptionBar[]
  /** Instant the estimate is for. */
  timestamp: number
  model?: LegPricingModel
  missingData?: MissingDataPolicy
  /** Scales the raw straddle. 1.0 keeps it as-is. */
  multiplier?: number
}

/**
 * Computes the expected move from a straddle at one strike.
 *
 * Returns null when either leg cannot be priced under the missing-data policy.
 * Falling back to a fabricated value would place the entire butterfly in the
 * wrong location, so an unpriceable straddle must skip the trade instead.
 */
export function expectedMoveFromStraddle(
  options: ExpectedMoveOptions,
  legs: { call: LegSeries; put: LegSeries }
): ExpectedMoveEstimate | null {
  const model = options.model ?? 'close'
  const policy = options.missingData ?? { mode: 'carryForward', maxStaleMinutes: 5 }
  const multiplier = options.multiplier ?? 1

  const call = resolveLegQuote(legs.call.ticker, options.timestamp, legs.call.index, legs.call.minutes, model, policy)
  const put = resolveLegQuote(legs.put.ticker, options.timestamp, legs.put.index, legs.put.minutes, model, policy)
  if (!call || !put) return null

  const straddle = call.price + put.price
  if (!(straddle > 0)) return null

  return {
    points: straddle * multiplier,
    strike: options.strike,
    callPrice: call.price,
    putPrice: put.price,
    maxAgeMs: Math.max(call.ageMs, put.ageMs),
    moneynessGap: Math.abs(options.underlyingAtEntry - options.strike)
  }
}

/**
 * Direct form, for callers that already hold the two prices.
 *
 * Exposed separately so the arithmetic can be tested and reused without the
 * bar-resolution machinery.
 */
export function straddlePrice(callBar: OptionBar, putBar: OptionBar, model: LegPricingModel = 'close'): number {
  return legPrice(callBar, model) + legPrice(putBar, model)
}
