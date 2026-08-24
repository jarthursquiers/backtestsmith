import type { CalendarObservation, DoubleCalendarDefinition } from '../domain/doubleCalendar.js'

/**
 * Management rules for a double calendar.
 *
 * A separate engine from `exits.ts`, for one substantive reason rather than
 * convenience. Every butterfly rule is written against a position whose maximum
 * value is known at entry: a target above the wing width is refused because it
 * provably cannot fill, and a threshold "reachable but unconfirmed" is decided
 * from bounds the wing width supplies. A calendar has no such ceiling. Its
 * maximum profit is not knowable at entry, only its maximum loss is, so the
 * refusal has nothing to test against and the bounds have nothing to clamp to.
 *
 * ## What a percentage means here
 *
 * Every target and stop is a percentage of the **entry cost** - the debit paid,
 * including entry friction and commissions. That is the capital at risk, so
 * -100% is the structural floor and +25% means a quarter of the debit was
 * banked. Calendars have no defined maximum profit for a "percent of max" to
 * refer to, which is why the debit is the denominator throughout.
 *
 * ## Execution semantics
 *
 * Rules evaluate against `netValue`, what closing the package in that minute
 * would actually realize after crossing four spreads. A target therefore fires
 * only when the trader could genuinely have banked it.
 *
 * The archive is a one-per-minute NBBO snapshot with no intra-minute range, so
 * unlike the butterfly engine there is no bound from which to infer that a
 * level was touched between snapshots. Triggers are evaluated on the snapshots
 * alone and no exit is marked ambiguous on that basis; the limitation is real
 * and is stated in the study's report rather than papered over here.
 */

export type CalendarExitReason =
  | 'horizon'
  | 'profitTarget'
  | 'stopLoss'
  | 'timeExit'
  | 'strikeBreach'
  | 'trailingProfit'

export interface CalendarExitDecision {
  reason: CalendarExitReason
  /** Package value the exit fills at, in index points, net of friction. */
  exitValue: number
  note?: string
}

export interface CalendarPositionState {
  definition: DoubleCalendarDefinition
  entryCost: number
  entryTimestamp: number
  entryUnderlying?: number
  /** Highest P/L percent seen so far, inclusive of the current minute. */
  peakPnlPct: number
  /** Lowest P/L percent seen so far. */
  troughPnlPct: number
}

export interface CalendarEvaluationContext {
  observation: CalendarObservation
  position: CalendarPositionState
  /** True on the final observation, where the trade must close regardless. */
  isLast: boolean
}

export interface CalendarExitStrategy {
  readonly id: string
  readonly label: string
  evaluate(context: CalendarEvaluationContext): CalendarExitDecision | null
}

/** Converts a P/L percentage into a net package value, given the entry cost. */
export function valueForCalendarPnlPct(entryCost: number, pct: number): number {
  return entryCost * (1 + pct / 100)
}

/** The forced close at the end of the tracked path. */
function atHorizon(observation: CalendarObservation, isLast: boolean): CalendarExitDecision | null {
  return isLast ? { reason: 'horizon', exitValue: observation.netValue, note: undefined } : null
}

/**
 * Holds until the front expiration.
 *
 * The baseline every managed rule is measured against. Note that "expiration"
 * here means the study's horizon on the front expiration day, not settlement:
 * the position is closed while both expirations still trade, because a double
 * calendar carried through the short's settlement is no longer a double
 * calendar.
 */
export function holdToHorizon(): CalendarExitStrategy {
  return {
    id: 'hold',
    label: 'Hold to front expiration',
    evaluate: ({ observation, isLast }) => atHorizon(observation, isLast)
  }
}

/** Closes the whole position once it has made a percentage of the debit. */
export function calendarProfitTarget(targetPct: number): CalendarExitStrategy {
  return {
    id: `tp${targetPct}`,
    label: `+${targetPct}% of debit`,
    evaluate: ({ observation, position, isLast }) => {
      if (observation.pnlPct >= targetPct) {
        return {
          reason: 'profitTarget',
          // Fill at the threshold, never at the better mark that crossed it:
          // crediting the overshoot would pay the rule for a gap between
          // snapshots that no order could have captured.
          exitValue: Math.min(observation.netValue, valueForCalendarPnlPct(position.entryCost, targetPct))
        }
      }
      return atHorizon(observation, isLast)
    }
  }
}

/** Closes the whole position once it has lost a percentage of the debit. */
export function calendarStopLoss(stopPct: number): CalendarExitStrategy {
  const magnitude = Math.abs(stopPct)
  return {
    id: `sl${magnitude}`,
    label: `-${magnitude}% of debit`,
    evaluate: ({ observation, position, isLast }) => {
      if (observation.pnlPct <= -magnitude) {
        const threshold = valueForCalendarPnlPct(position.entryCost, -magnitude)
        return {
          reason: 'stopLoss',
          exitValue: Math.max(observation.netValue, Math.max(threshold, 0))
        }
      }
      return atHorizon(observation, isLast)
    }
  }
}

/** Closes at or below a given number of days to the front expiration. */
export function calendarDteExit(atDte: number): CalendarExitStrategy {
  return {
    id: `dte${atDte}`,
    label: `Close at ${atDte} DTE`,
    evaluate: ({ observation, isLast }) => {
      // A scheduled action must not fill on a carried-forward quote; hold on to
      // the first genuinely quoted minute at or past the trigger.
      if (observation.frontDte <= atDte && !observation.stale) {
        return { reason: 'timeExit', exitValue: observation.netValue }
      }
      return atHorizon(observation, isLast)
    }
  }
}

/**
 * Closes after a fixed number of trading sessions in the trade.
 *
 * Distinct from a DTE exit whenever the front expiration is not exactly the
 * intended number of days out, which happens around holidays.
 */
export function calendarSessionExit(sessions: number): CalendarExitStrategy {
  if (!Number.isFinite(sessions) || sessions <= 0) {
    throw new Error(`A session exit needs a positive number of sessions, received ${sessions}`)
  }
  return {
    id: `day${sessions}`,
    label: `Close after ${sessions} session${sessions === 1 ? '' : 's'}`,
    evaluate: ({ observation, isLast }) => {
      if (observation.sessionsSinceEntry >= sessions && !observation.stale) {
        return { reason: 'timeExit', exitValue: observation.netValue }
      }
      return atHorizon(observation, isLast)
    }
  }
}

/**
 * Closes when the index reaches a short strike, or a buffer inside it.
 *
 * The calendar's structural risk rule. A double calendar earns while the index
 * stays between its shorts and bleeds once it leaves, so "get out when the tent
 * is breached" is the natural analogue of the butterfly's centre-touch rule -
 * inverted, because a butterfly wants the index to arrive and a calendar wants
 * it to stay away.
 *
 * `offsetPoints` is measured outward from the short strike: 0 exits on a touch,
 * -20 exits twenty points before it, +20 tolerates a twenty-point breach.
 */
export function calendarStrikeBreach(offsetPoints: number): CalendarExitStrategy {
  const sign = offsetPoints === 0 ? '' : offsetPoints > 0 ? `+${offsetPoints}` : `${offsetPoints}`
  return {
    id: `breach${sign}`,
    label:
      offsetPoints === 0
        ? 'Close on a short strike touch'
        : `Close ${Math.abs(offsetPoints)} points ${offsetPoints > 0 ? 'beyond' : 'inside'} a short strike`,
    evaluate: ({ observation, isLast }) => {
      if (observation.breachPoints !== undefined && observation.breachPoints >= offsetPoints) {
        return {
          reason: 'strikeBreach',
          exitValue: observation.netValue,
          note: `Index ${observation.underlyingPrice?.toFixed(2) ?? '?'} was ` +
            `${observation.breachPoints.toFixed(1)} points from the nearer short strike.`
        }
      }
      return atHorizon(observation, isLast)
    }
  }
}

export interface CalendarTrailingOptions {
  /** Trailing only arms once this return has been reached. */
  triggerPct: number
  /** Give-back as a fraction of the peak return. */
  givebackFractionOfPeak?: number
  /** Give-back in percentage points from the peak return. */
  givebackPoints?: number
}

/** Trails a peak profit once a trigger has been reached. */
export function calendarTrailingProfit(options: CalendarTrailingOptions): CalendarExitStrategy {
  const { triggerPct, givebackFractionOfPeak, givebackPoints } = options
  if (givebackFractionOfPeak === undefined && givebackPoints === undefined) {
    throw new Error('A trailing rule requires either givebackFractionOfPeak or givebackPoints')
  }

  const suffix =
    givebackFractionOfPeak !== undefined
      ? `${Math.round(givebackFractionOfPeak * 100)}pct`
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
            exitValue: observation.netValue,
            note: `Peak was +${position.peakPnlPct.toFixed(1)}%; exit level +${exitLevel.toFixed(1)}%.`
          }
        }
      }
      return atHorizon(observation, isLast)
    }
  }
}

/**
 * Combines rules; the adverse one wins a tie.
 *
 * One minute's snapshot cannot establish which of two triggers came first, so
 * where a target and a stop are both satisfied the loss is taken. Choosing the
 * favourable outcome would flatter every combined rule in exactly the sessions
 * that decide whether it is any good.
 */
export function combineCalendarExits(
  id: string,
  label: string,
  strategies: readonly CalendarExitStrategy[]
): CalendarExitStrategy {
  const ADVERSE: ReadonlySet<CalendarExitReason> = new Set(['stopLoss', 'strikeBreach'])

  return {
    id,
    label,
    evaluate: (context) => {
      const decisions = strategies
        .map((s) => s.evaluate(context))
        .filter((d): d is CalendarExitDecision => d !== null)

      if (decisions.length === 0) return null
      if (decisions.length === 1) return decisions[0]!

      const real = decisions.filter((d) => d.reason !== 'horizon')
      if (real.length === 0) return decisions[0]!
      if (real.length === 1) return real[0]!

      const adverse = real.find((d) => ADVERSE.has(d.reason))
      const chosen = adverse ?? real[0]!
      const others = real.filter((d) => d !== chosen).map((d) => d.reason)

      return {
        ...chosen,
        note: `Several rules triggered in the same minute (${[chosen.reason, ...others].join(', ')}); ` +
          'the adverse outcome was assumed.'
      }
    }
  }
}

/** Profit target paired with a stop, the most common calendar management. */
export function calendarTargetWithStop(targetPct: number, stopPct: number): CalendarExitStrategy {
  return combineCalendarExits(
    `tp${targetPct}-sl${Math.abs(stopPct)}`,
    `+${targetPct}% / -${Math.abs(stopPct)}%`,
    [calendarProfitTarget(targetPct), calendarStopLoss(stopPct)]
  )
}

/**
 * Resolves management ids into rules.
 *
 * Ids are parsed rather than looked up in a fixed table. The butterfly
 * catalogue is a curated list because it drives checkboxes in the UI; this set
 * exists to answer a research question, and the question includes targets and
 * stops the curated list would not contain.
 */
export function buildCalendarManagement(id: string): CalendarExitStrategy {
  const strategy = parseCalendarManagement(id)
  if (!strategy) throw new Error(`Unknown calendar management method "${id}"`)
  return strategy.id === id ? strategy : { ...strategy, id }
}

export function buildCalendarManagementSet(ids: readonly string[]): CalendarExitStrategy[] {
  return ids.map(buildCalendarManagement)
}

function parseCalendarManagement(id: string): CalendarExitStrategy | null {
  if (id === 'hold') return holdToHorizon()

  const number = (value: string): number => Number(value)

  let match = /^tp(\d+(?:\.\d+)?)$/.exec(id)
  if (match) return calendarProfitTarget(number(match[1]!))

  match = /^sl(\d+(?:\.\d+)?)$/.exec(id)
  if (match) return calendarStopLoss(number(match[1]!))

  match = /^tp(\d+(?:\.\d+)?)-sl(\d+(?:\.\d+)?)$/.exec(id)
  if (match) return calendarTargetWithStop(number(match[1]!), number(match[2]!))

  match = /^dte(\d+)$/.exec(id)
  if (match) return calendarDteExit(number(match[1]!))

  match = /^day(\d+)$/.exec(id)
  if (match) return calendarSessionExit(number(match[1]!))

  match = /^breach([+-]?\d+)?$/.exec(id)
  if (match) return calendarStrikeBreach(match[1] ? number(match[1]) : 0)

  match = /^trail(\d+(?:\.\d+)?)-(\d+)pct$/.exec(id)
  if (match) {
    return calendarTrailingProfit({
      triggerPct: number(match[1]!),
      givebackFractionOfPeak: number(match[2]!) / 100
    })
  }

  match = /^trail(\d+(?:\.\d+)?)-(\d+)pts$/.exec(id)
  if (match) {
    return calendarTrailingProfit({ triggerPct: number(match[1]!), givebackPoints: number(match[2]!) })
  }

  // Composites: any two rules joined by '+', so 'tp25+breach' and
  // 'tp25-sl50+dte3' resolve without a table entry for every combination.
  if (id.includes('+')) {
    const parts = id.split('+')
    const resolved = parts.map(parseCalendarManagement)
    if (resolved.every((s): s is CalendarExitStrategy => s !== null)) {
      return combineCalendarExits(id, resolved.map((s) => s.label).join(' / '), resolved)
    }
  }

  return null
}
