import type { ButterflyDefinition, ButterflyObservation } from '../domain/butterfly.js'
import {
  easternToTimestamp,
  marketDateOf,
  parseTimeOfDay,
  sessionClose,
  sessionOpen
} from '../core/time/marketTime.js'

/**
 * Exit strategies.
 *
 * Deliberately built as a composable rule engine rather than around any one
 * exit, because the research question is which management method wins, and that
 * comparison is only meaningful if every rule is evaluated identically against
 * the same entries.
 *
 * ## Execution semantics
 *
 * Rules evaluate on the minute's *mark* - a single value from the chosen pricing
 * model. They may also consult the minute's value bounds to notice that a
 * threshold could have been touched intra-minute without the mark crossing it.
 * Because minute bars cannot reveal the order of events inside the minute, such
 * a crossing is reported as `ambiguous` rather than assumed. Where a favorable
 * and an adverse threshold are both reachable in the same minute, the adverse
 * one is taken. The engine never silently chooses the favorable outcome.
 */

export type ExitReason =
  | 'expiration'
  | 'profitTarget'
  | 'stopLoss'
  | 'timeExit'
  | 'centerTouch'
  | 'tentEntry'
  | 'trailingProfit'
  | 'endOfData'

export interface ExitDecision {
  reason: ExitReason
  /** Butterfly value the exit is assumed to fill at, before exit slippage. */
  exitValue: number
  /**
   * True when the minute's bounds show the trigger was reachable but the mark
   * did not confirm it, or when opposing triggers were both reachable.
   */
  ambiguous: boolean
  note?: string
}

/** Running state a rule may need beyond the current observation. */
export interface PositionState {
  definition: ButterflyDefinition
  entryDebit: number
  entryTimestamp: number
  /** Highest P/L percent seen so far, inclusive of the current minute. */
  peakPnlPct: number
  /** Lowest P/L percent seen so far. */
  troughPnlPct: number
  /** Underlying level at entry, when known. */
  entryUnderlying?: number
}

export interface EvaluationContext {
  observation: ButterflyObservation
  position: PositionState
  /** True on the final observation, where the trade must close regardless. */
  isLast: boolean
}

export interface ExitStrategy {
  readonly id: string
  readonly label: string
  /** Returns a decision to close, or null to keep holding. */
  evaluate(context: EvaluationContext): ExitDecision | null
}

/** Converts a P/L percentage into a butterfly value, given the entry debit. */
export function valueForPnlPct(entryDebit: number, pct: number): number {
  return entryDebit * (1 + pct / 100)
}

/**
 * Whether a threshold was reachable within the minute but unconfirmed by the mark.
 *
 * Bounds are wider than the butterfly's true range, so this deliberately
 * over-reports reachability: it is a flag for "we cannot be sure", not a claim
 * that the level traded.
 */
function reachableButUnconfirmed(
  observation: ButterflyObservation,
  threshold: number,
  direction: 'above' | 'below',
  wingWidth: number
): boolean {
  if (direction === 'above') {
    if (observation.butterflyValue >= threshold) return false
    return observation.valueUpperBound !== undefined &&
      Math.min(observation.valueUpperBound, wingWidth) >= threshold
  }
  if (observation.butterflyValue <= threshold) return false
  return observation.valueLowerBound !== undefined &&
    Math.max(observation.valueLowerBound, 0) <= threshold
}

// --- individual strategies ---------------------------------------------------

/** Never exits early; the trade runs to the end of the observed data. */
export function holdToExpiration(): ExitStrategy {
  return {
    id: 'hold',
    label: 'Hold to expiration',
    evaluate: ({ observation, isLast }) =>
      isLast
        ? { reason: 'expiration', exitValue: observation.butterflyValue, ambiguous: false }
        : null
  }
}

/** Closes once the mark reaches a fixed percentage gain on the entry debit. */
export function profitTarget(targetPct: number): ExitStrategy {
  return {
    id: `tp${targetPct}`,
    label: `+${targetPct}% target`,
    evaluate: ({ observation, position, isLast }) => {
      const threshold = valueForPnlPct(position.entryDebit, targetPct)

      // A target above the package's theoretical maximum can never execute.
      if (threshold > position.definition.wingWidth) {
        return isLast
          ? { reason: 'expiration', exitValue: observation.butterflyValue, ambiguous: false }
          : null
      }

      if (observation.pnlPct >= targetPct) {
        return {
          reason: 'profitTarget',
          // Fill at the threshold, not the mark: assuming the better of the two
          // would credit the strategy with a gap it never had to earn.
          exitValue: Math.min(observation.butterflyValue, Math.max(threshold, 0)),
          ambiguous: false
        }
      }

      if (reachableButUnconfirmed(observation, threshold, 'above', position.definition.wingWidth)) {
        return {
          reason: 'profitTarget',
          exitValue: threshold,
          ambiguous: true,
          note: 'The target was inside the minute’s possible range but the mark did not confirm it.'
        }
      }

      return isLast
        ? { reason: 'expiration', exitValue: observation.butterflyValue, ambiguous: false }
        : null
    }
  }
}

/** Closes once the mark falls to a fixed percentage loss of the entry debit. */
export function stopLoss(stopPct: number): ExitStrategy {
  const magnitude = Math.abs(stopPct)
  return {
    id: `sl${magnitude}`,
    label: `-${magnitude}% stop`,
    evaluate: ({ observation, position, isLast }) => {
      const threshold = valueForPnlPct(position.entryDebit, -magnitude)

      if (observation.pnlPct <= -magnitude) {
        return {
          reason: 'stopLoss',
          exitValue: Math.max(observation.butterflyValue, Math.max(threshold, 0)),
          ambiguous: false
        }
      }

      if (reachableButUnconfirmed(observation, threshold, 'below', position.definition.wingWidth)) {
        return {
          reason: 'stopLoss',
          exitValue: Math.max(threshold, 0),
          ambiguous: true,
          note: 'The stop was inside the minute’s possible range but the mark did not confirm it.'
        }
      }

      return isLast
        ? { reason: 'expiration', exitValue: observation.butterflyValue, ambiguous: false }
        : null
    }
  }
}

/** Closes at or below a given DTE, optionally at a specific time of day. */
export function timeExit(options: { atDte: number; useTradingDte?: boolean }): ExitStrategy {
  const { atDte, useTradingDte = false } = options
  return {
    id: `time${atDte}${useTradingDte ? 't' : ''}`,
    label: `Exit at ${atDte} ${useTradingDte ? 'trading ' : ''}DTE`,
    evaluate: ({ observation, isLast }) => {
      const dte = useTradingDte ? observation.tradingDte : observation.dte
      // A scheduled exit is meant to model an executable action, so never base
      // it on a carried-forward leg. Continue to the first fresh valid mark.
      if (dte <= atDte && !observation.stale) {
        return { reason: 'timeExit', exitValue: observation.butterflyValue, ambiguous: false }
      }
      return isLast
        ? { reason: 'expiration', exitValue: observation.butterflyValue, ambiguous: false }
        : null
    }
  }
}

/**
 * Closes at a fixed Eastern wall-clock time.
 *
 * The natural management axis for an intraday trade: a 0DTE butterfly has no
 * days left to count down, so "get out by 15:45" is the scheduled exit that
 * actually means something. On a multi-day trade the same rule fires on the
 * first afternoon, which is why the catalogue offers it to intraday studies
 * only.
 */
export function timeOfDayExit(time: string): ExitStrategy {
  const { hour, minute } = parseTimeOfDay(time)
  const id = `at${String(hour).padStart(2, '0')}${String(minute).padStart(2, '0')}`

  /*
   * Resolving the Eastern wall clock for every observation would put a timezone
   * conversion in the innermost loop of the engine. Instead the threshold is
   * computed once per session and reused for every minute inside that session's
   * open/close bounds, which are already memoized.
   */
  let validFrom = Number.POSITIVE_INFINITY
  let validTo = Number.NEGATIVE_INFINITY
  let threshold = 0
  const thresholdFor = (timestamp: number): number => {
    if (timestamp < validFrom || timestamp >= validTo) {
      const date = marketDateOf(timestamp)
      validFrom = sessionOpen(date)
      validTo = sessionClose(date)
      threshold = easternToTimestamp(date, hour, minute)
    }
    return threshold
  }

  return {
    id,
    label: `Exit at ${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')} ET`,
    evaluate: ({ observation, isLast }) => {
      // As with the DTE exit, a scheduled action must not be filled on a
      // carried-forward leg; hold on to the first fresh mark at or past the time.
      if (observation.timestamp >= thresholdFor(observation.timestamp) && !observation.stale) {
        return { reason: 'timeExit', exitValue: observation.butterflyValue, ambiguous: false }
      }
      return isLast
        ? { reason: 'expiration', exitValue: observation.butterflyValue, ambiguous: false }
        : null
    }
  }
}

/**
 * Closes after a fixed number of minutes in the trade.
 *
 * Distinct from a wall-clock exit because entries do not all happen at the same
 * time: a signal-triggered strategy may enter at 09:50 on one session and 11:20
 * on the next, and "how long is this structure worth holding" is then a
 * different question from "when in the day should it be closed".
 */
export function elapsedExit(minutes: number): ExitStrategy {
  if (!Number.isFinite(minutes) || minutes <= 0) {
    throw new Error(`Elapsed exit needs a positive number of minutes, received ${minutes}`)
  }
  return {
    id: `elapsed${minutes}m`,
    label: `Exit ${minutes} minutes in`,
    evaluate: ({ observation, isLast }) => {
      if (observation.minutesSinceEntry >= minutes && !observation.stale) {
        return { reason: 'timeExit', exitValue: observation.butterflyValue, ambiguous: false }
      }
      return isLast
        ? { reason: 'expiration', exitValue: observation.butterflyValue, ambiguous: false }
        : null
    }
  }
}

/**
 * Closes when the underlying first reaches the center strike.
 *
 * Requires underlying data; without it the rule cannot fire and the trade runs
 * to the end rather than silently behaving like hold-to-expiration.
 */
export function centerTouch(): ExitStrategy {
  return {
    id: 'centerTouch',
    label: 'Center strike touch',
    evaluate: ({ observation, isLast }) => {
      if (observation.normalizedDistanceToCenter !== undefined && observation.normalizedDistanceToCenter <= 0) {
        return { reason: 'centerTouch', exitValue: observation.butterflyValue, ambiguous: false }
      }
      return isLast
        ? { reason: 'expiration', exitValue: observation.butterflyValue, ambiguous: false }
        : null
    }
  }
}

/** Closes when the underlying comes within a normalized distance of the center. */
export function tentEntry(maxNormalizedDistance: number): ExitStrategy {
  return {
    id: `tent${maxNormalizedDistance}`,
    label: `Tent entry <= ${maxNormalizedDistance}`,
    evaluate: ({ observation, isLast }) => {
      const distance = observation.normalizedDistanceToCenter
      if (distance !== undefined && distance <= maxNormalizedDistance) {
        return { reason: 'tentEntry', exitValue: observation.butterflyValue, ambiguous: false }
      }
      return isLast
        ? { reason: 'expiration', exitValue: observation.butterflyValue, ambiguous: false }
        : null
    }
  }
}

export interface TrailingOptions {
  /** Trailing only arms once this return has been reached. */
  triggerPct: number
  /**
   * Give-back measured as a fraction of the peak profit. 0.3 exits after
   * surrendering 30% of the best gain, so a peak of +100% exits at +70%.
   */
  givebackFractionOfPeak?: number
  /**
   * Give-back measured in percentage points from the peak return. 30 exits a
   * peak of +100% at +70% as well, but a peak of +200% at +170% rather than
   * +140%. These are genuinely different rules, so both are supported.
   */
  givebackPoints?: number
}

/** Trails a peak profit once a trigger has been reached. */
export function trailingProfit(options: TrailingOptions): ExitStrategy {
  const { triggerPct, givebackFractionOfPeak, givebackPoints } = options
  if (givebackFractionOfPeak === undefined && givebackPoints === undefined) {
    throw new Error('trailingProfit requires either givebackFractionOfPeak or givebackPoints')
  }

  const suffix =
    givebackFractionOfPeak !== undefined
      ? `${Math.round(givebackFractionOfPeak * 100)}%ofPeak`
      : `${givebackPoints}pts`

  return {
    id: `trail${triggerPct}-${suffix}`,
    label: `Trail after +${triggerPct}%, give back ${suffix}`,
    evaluate: ({ observation, position, isLast }) => {
      if (position.peakPnlPct >= triggerPct) {
        const exitLevel =
          givebackFractionOfPeak !== undefined
            ? position.peakPnlPct * (1 - givebackFractionOfPeak)
            : position.peakPnlPct - givebackPoints!

        if (observation.pnlPct <= exitLevel) {
          return {
            reason: 'trailingProfit',
            exitValue: observation.butterflyValue,
            ambiguous: false,
            note: `Peak was +${position.peakPnlPct.toFixed(1)}%; exit level +${exitLevel.toFixed(1)}%.`
          }
        }
      }
      return isLast
        ? { reason: 'expiration', exitValue: observation.butterflyValue, ambiguous: false }
        : null
    }
  }
}

/**
 * Combines rules; the first to fire wins.
 *
 * When several fire in the same minute the adverse one is preferred, because
 * minute bars cannot establish which happened first and choosing the favorable
 * result would flatter every combined strategy.
 */
export function combine(id: string, label: string, strategies: readonly ExitStrategy[]): ExitStrategy {
  const ADVERSE: ReadonlySet<ExitReason> = new Set(['stopLoss', 'centerTouch', 'tentEntry'])

  return {
    id,
    label,
    evaluate: (context) => {
      const decisions = strategies
        .map((s) => s.evaluate(context))
        .filter((d): d is ExitDecision => d !== null)

      if (decisions.length === 0) return null
      if (decisions.length === 1) return decisions[0]!

      const realDecisions = decisions.filter((d) => d.reason !== 'expiration')
      if (realDecisions.length === 0) return decisions[0]!
      if (realDecisions.length === 1) return realDecisions[0]!

      const adverse = realDecisions.find((d) => ADVERSE.has(d.reason))
      const chosen = adverse ?? realDecisions[0]!
      const others = realDecisions.filter((d) => d !== chosen).map((d) => d.reason)

      return {
        ...chosen,
        // Simultaneous opposing triggers are irreducibly ambiguous at minute
        // resolution; say so rather than pick a winner quietly.
        ambiguous: true,
        note: `Multiple rules triggered in the same minute (${[chosen.reason, ...others].join(', ')}); the adverse outcome was assumed.`
      }
    }
  }
}

/** Profit target combined with a stop, the most common paired management. */
export function targetWithStop(targetPct: number, stopPct: number): ExitStrategy {
  return combine(
    `tp${targetPct}-sl${Math.abs(stopPct)}`,
    `+${targetPct}% / -${Math.abs(stopPct)}%`,
    [profitTarget(targetPct), stopLoss(stopPct)]
  )
}
