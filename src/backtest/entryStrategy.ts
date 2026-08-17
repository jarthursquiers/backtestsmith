import type { UnderlyingBar } from '../domain/bars.js'
import type { OptionType } from '../domain/contracts.js'
import type { MarketDate } from '../core/time/marketTime.js'
import { emaAsOf } from './indicators.js'

/**
 * Entry signals.
 *
 * Kept separate from butterfly construction, execution, and management so that
 * many exit rules can be compared against one identical entry population. The
 * context carries only what was knowable at the entry instant; nothing here can
 * reach for a later bar even by accident, because later bars are not present.
 */

export interface EntryContext {
  /** Simulated entry instant, epoch ms. */
  entryTimestamp: number
  entryDate: MarketDate
  /**
   * Daily bars available at entry. Callers pass full history; strategies must
   * still filter by date, and the indicator helpers do so unconditionally.
   */
  dailyBars: readonly UnderlyingBar[]
  /**
   * Underlying level at the entry minute. Known at entry, so using it is not
   * look-ahead. Undefined when no intraday data exists for that minute.
   */
  underlyingAtEntry?: number
}

export interface EntrySignal {
  direction: 'bullish' | 'bearish'
  /** Downside butterflies are built from puts, upside from calls. */
  optionType: OptionType
  underlyingAtEntry: number
  /** Human-readable justification, stored with the trade for auditability. */
  reason: string
  /** Indicator values behind the decision, for later analysis. */
  indicators: Record<string, number>
}

export interface EntryStrategy {
  readonly id: string
  readonly label: string
  getSignal(context: EntryContext): EntrySignal | null
}

export interface EmaDirectionOptions {
  period: number
  /**
   * Inverts the mapping. The default follows the stated research rule: below the
   * EMA implies a downside put butterfly, above implies an upside call one.
   */
  invert?: boolean
  /**
   * Minimum distance from the EMA, in underlying points, before a signal is
   * taken. Zero means any separation qualifies; a positive value suppresses
   * entries when price is sitting on the average.
   */
  minimumDistance?: number
}

/**
 * Direction from price relative to a daily EMA.
 *
 * The EMA uses only sessions that closed before the entry date. The comparison
 * price is the underlying at the entry minute, which is genuinely observable
 * then - so the rule is "where is price now, against the average as of last
 * night", which is what a trader could actually act on.
 */
export function emaDirectionStrategy(options: EmaDirectionOptions): EntryStrategy {
  const { period, invert = false, minimumDistance = 0 } = options

  return {
    id: `ema${period}${invert ? '-inv' : ''}${minimumDistance ? `-min${minimumDistance}` : ''}`,
    label: `${period} EMA direction${invert ? ' (inverted)' : ''}`,

    getSignal(context: EntryContext): EntrySignal | null {
      const { underlyingAtEntry } = context
      if (underlyingAtEntry === undefined) return null

      const ema = emaAsOf(context.dailyBars, context.entryDate, period)
      if (ema === null) return null

      const distance = underlyingAtEntry - ema
      if (Math.abs(distance) < minimumDistance) return null

      const below = distance < 0
      const bearish = invert ? !below : below

      return {
        direction: bearish ? 'bearish' : 'bullish',
        optionType: bearish ? 'put' : 'call',
        underlyingAtEntry,
        reason: `SPX ${underlyingAtEntry.toFixed(2)} is ${below ? 'below' : 'above'} the ${period} EMA ${ema.toFixed(2)} (${distance >= 0 ? '+' : ''}${distance.toFixed(2)})`,
        indicators: { ema, distanceFromEma: distance }
      }
    }
  }
}

/** Always trades one direction. Useful as a control against a directional rule. */
export function fixedDirectionStrategy(direction: 'bullish' | 'bearish'): EntryStrategy {
  return {
    id: `fixed-${direction}`,
    label: `Always ${direction}`,
    getSignal(context) {
      if (context.underlyingAtEntry === undefined) return null
      return {
        direction,
        optionType: direction === 'bearish' ? 'put' : 'call',
        underlyingAtEntry: context.underlyingAtEntry,
        reason: `Fixed ${direction} direction`,
        indicators: {}
      }
    }
  }
}
