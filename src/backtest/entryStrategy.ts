import type { UnderlyingBar } from '../domain/bars.js'
import type { OptionType } from '../domain/contracts.js'
import {
  easternToTimestamp,
  marketDateOf,
  parseTimeOfDay,
  sessionClose,
  toEastern,
  type MarketDate
} from '../core/time/marketTime.js'
import { emaAsOf, emaSeries } from './indicators.js'
import { findOrbBreakout } from './openingRange.js'

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
  /**
   * What the timing rule established, for strategies whose trigger also fixes
   * the direction. Present only when the strategy resolved its own entry
   * instant.
   */
  timing?: EntryTiming
}

/** What a strategy needs to choose its own entry instant within a session. */
export interface EntryTimingContext {
  entryDate: MarketDate
  /** The instant the study configuration nominally asked for, epoch ms. */
  scheduledTimestamp: number
  /**
   * One-minute underlying bars cached for the entry date.
   *
   * Only the entry date is supplied: a rule that needs earlier sessions belongs
   * in `getSignal`, which receives daily history, rather than here.
   */
  underlyingMinutes: readonly UnderlyingBar[]
}

/** An entry instant chosen from intraday data rather than the clock. */
export interface EntryTiming {
  /** Earliest minute bar the entry may be attributed to, epoch ms. */
  entryTimestamp: number
  /** Set when the trigger also determines which way the trade is placed. */
  direction?: 'bullish' | 'bearish'
  /** Human-readable justification, carried into the trade's entry reason. */
  reason: string
  indicators: Record<string, number>
}

/**
 * Timing outcome.
 *
 * A failure carries its reason rather than being a bare null, because "no
 * breakout today" and "no data today" are different findings and a study that
 * conflates them cannot be diagnosed.
 */
export type EntryTimingOutcome =
  | { ok: true; timing: EntryTiming }
  | { ok: false; reason: string }

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
  /**
   * Chooses the entry instant from intraday data.
   *
   * Optional: strategies that enter at a fixed wall-clock time omit it and the
   * runner uses the configured entry time unchanged. Implementing it is what
   * makes a signal-triggered entry - an opening-range breakout, a level cross -
   * expressible without every such rule inventing its own scheduling.
   */
  resolveEntryTiming?(context: EntryTimingContext): EntryTimingOutcome
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
  /**
   * Base direction on the previous completed close versus its EMA, then reverse
   * when the last two candles are wholly on one side and the latest candle's
   * colour points back toward the average.
   */
  meanReversionOverride?: boolean
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
  const { period, invert = false, minimumDistance = 0, meanReversionOverride = false } = options

  return {
    id: `ema${period}${meanReversionOverride ? '-mr2' : ''}${invert ? '-inv' : ''}${minimumDistance ? `-min${minimumDistance}` : ''}`,
    label: `${period} EMA direction${meanReversionOverride ? ' + two-candle mean reversion' : ''}${invert ? ' (inverted)' : ''}`,

    getSignal(context: EntryContext): EntrySignal | null {
      const { underlyingAtEntry } = context
      if (underlyingAtEntry === undefined) return null

      if (meanReversionOverride) {
        const completed = context.dailyBars
          .filter((bar) => marketDateOf(bar.timestamp) < context.entryDate)
          .sort((a, b) => a.timestamp - b.timestamp)
        if (completed.length < 2) return null

        const points = emaSeries(completed, period)
        const emaByDate = new Map(points.map((point) => [point.marketDate, point.value]))
        const latest = completed.at(-1)!
        const prior = completed.at(-2)!
        const latestDate = marketDateOf(latest.timestamp)
        const priorDate = marketDateOf(prior.timestamp)
        const latestEma = emaByDate.get(latestDate)
        const priorEma = emaByDate.get(priorDate)
        if (latestEma === undefined || priorEma === undefined) return null

        const distance = latest.close - latestEma
        if (Math.abs(distance) < minimumDistance) return null

        const bothAbove = prior.open > priorEma && prior.close > priorEma &&
          latest.open > latestEma && latest.close > latestEma
        const bothBelow = prior.open < priorEma && prior.close < priorEma &&
          latest.open < latestEma && latest.close < latestEma
        const latestRed = latest.close < latest.open
        const latestGreen = latest.close > latest.open
        const bearishOverride = bothAbove && latestRed
        const bullishOverride = bothBelow && latestGreen

        let bearish = distance < 0
        if (bearishOverride) bearish = true
        if (bullishOverride) bearish = false
        if (invert) bearish = !bearish

        const override = bearishOverride
          ? 'two candles wholly above the EMA and the latest candle is red: bearish mean-reversion override'
          : bullishOverride
            ? 'two candles wholly below the EMA and the latest candle is green: bullish mean-reversion override'
            : `previous close is ${distance < 0 ? 'below' : 'above'} its EMA`

        return {
          direction: bearish ? 'bearish' : 'bullish',
          optionType: bearish ? 'put' : 'call',
          underlyingAtEntry,
          reason: `${period} EMA previous-close rule: ${override}`,
          indicators: {
            ema: latestEma,
            distanceFromEma: distance,
            previousOpen: latest.open,
            previousClose: latest.close,
            priorOpen: prior.open,
            priorClose: prior.close,
            priorEma,
            meanReversionOverride: bearishOverride || bullishOverride ? 1 : 0
          }
        }
      }

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

export interface OrbBreakoutOptions {
  /** Length of the opening-range candle, in minutes. */
  openingRangeMinutes: number
  /** Length of each confirmation candle, in minutes. */
  confirmationMinutes: number
  /** Latest Eastern wall-clock time a breakout may be confirmed, HH:mm. */
  cutoffTime: string
  /**
   * Fades the breakout instead of following it.
   *
   * A butterfly is a bet on where price *stops*, so following a breakout and
   * fading one are both defensible readings of the same signal. Which is right
   * is a research question, not an assumption, so both are runnable.
   */
  invert?: boolean
}

/**
 * Opening range breakout.
 *
 * Direction and entry instant are decided by the same event: the first
 * confirmation candle to close outside the session's opening range. A close
 * below the range is bearish and takes a downside put butterfly; a close above
 * is bullish and takes an upside call one.
 *
 * The rule needs intraday index bars and cannot be approximated without them.
 * Where the rest of the engine can fall back to put-call parity for a single
 * entry-minute level, an opening range is a statement about a whole window of
 * the session, and reconstructing that from option prints would be inventing
 * the signal rather than measuring it. Sessions without minute bars are
 * therefore refused with a reason, never guessed.
 */
export function orbBreakoutStrategy(options: OrbBreakoutOptions): EntryStrategy {
  const { openingRangeMinutes, confirmationMinutes, cutoffTime, invert = false } = options
  const cutoff = parseTimeOfDay(cutoffTime)

  return {
    id: `orb${openingRangeMinutes}-${confirmationMinutes}${invert ? '-fade' : ''}`,
    label:
      `${openingRangeMinutes}-minute opening range, ${confirmationMinutes}-minute confirmation` +
      `${invert ? ' (faded)' : ''}`,

    resolveEntryTiming(context: EntryTimingContext): EntryTimingOutcome {
      const cutoffTimestamp = Math.min(
        easternToTimestamp(context.entryDate, cutoff.hour, cutoff.minute),
        sessionClose(context.entryDate)
      )

      const outcome = findOrbBreakout(context.underlyingMinutes, {
        entryDate: context.entryDate,
        openingRangeMinutes,
        confirmationMinutes,
        cutoffTimestamp
      })
      if (!outcome.ok) return outcome

      const { breakout } = outcome
      const direction = invert
        ? breakout.direction === 'bullish'
          ? 'bearish'
          : 'bullish'
        : breakout.direction

      return {
        ok: true,
        timing: {
          entryTimestamp: breakout.confirmedAt,
          direction,
          reason:
            `The ${confirmationMinutes}-minute candle from ${toEastern(breakout.candleFrom).toFormat('HH:mm')} ET ` +
            `closed at ${breakout.closePrice.toFixed(2)}, ` +
            `${breakout.direction === 'bullish' ? 'above' : 'below'} the ${openingRangeMinutes}-minute opening range ` +
            `${breakout.range.low.toFixed(2)}-${breakout.range.high.toFixed(2)}` +
            `${invert ? ', faded to trade the other way' : ''}`,
          indicators: {
            openingRangeHigh: breakout.range.high,
            openingRangeLow: breakout.range.low,
            openingRangeWidth: breakout.range.high - breakout.range.low,
            breakoutClose: breakout.closePrice,
            breakoutMinutesAfterOpen: Math.round(
              (breakout.confirmedAt - breakout.range.from) / 60_000
            ),
            faded: invert ? 1 : 0
          }
        }
      }
    },

    getSignal(context: EntryContext): EntrySignal | null {
      const { underlyingAtEntry, timing } = context
      if (underlyingAtEntry === undefined) return null
      // Direction comes from the trigger, so a context without one means the
      // runner never resolved the timing and the signal would be fabricated.
      if (!timing?.direction) return null

      return {
        direction: timing.direction,
        optionType: timing.direction === 'bearish' ? 'put' : 'call',
        underlyingAtEntry,
        reason: timing.reason,
        indicators: timing.indicators
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
