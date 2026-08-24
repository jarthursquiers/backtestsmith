import { CONTRACT_MULTIPLIER, type DataQuality } from '../domain/butterfly.js'
import type {
  CalendarEntryContext,
  CalendarObservation,
  CalendarPriceAudit,
  DoubleCalendarDefinition,
  DoubleCalendarSeries
} from '../domain/doubleCalendar.js'
import type { Excursion, Excursions } from '../shared/excursions.js'
import type { CalendarTradeResultDto } from '../shared/trade.js'
import type {
  CalendarExitReason,
  CalendarExitStrategy,
  CalendarPositionState
} from './calendarExits.js'

/**
 * Runs one management rule over one reconstructed double calendar.
 *
 * The same separation the butterfly engine relies on: reconstruction is
 * expensive and archive-bound, simulation is pure and cheap, so every rule sees
 * the identical minute series and a comparison between rules cannot be
 * contaminated by a different entry population.
 */

/**
 * Return thresholds whose first-touch time is recorded for every trade.
 *
 * Much lower than the butterfly set, and deliberately so. A butterfly bought
 * for two points routinely returns several hundred percent of its debit; a
 * calendar bought for twenty-five points has no such upside and is managed in
 * the 10-to-50 percent range. Recording only the butterfly thresholds would
 * have reported that nothing ever reached anything.
 */
export const CALENDAR_EXCURSION_THRESHOLDS = [5, 10, 15, 20, 25, 30, 40, 50, 75, 100] as const

/**
 * One completed double calendar under one management method.
 *
 * Declared as the shared result narrowed to this structure, rather than as its
 * own shape, so the compiler enforces that a calendar trade is storable,
 * exportable and displayable by everything that already handles a butterfly
 * one. The calendar-only measures - the entry context, the sessions held, how
 * far the index left the tent - are optional fields on the shared type for
 * exactly this reason, and are made required again here.
 */
export interface CalendarTradeResult extends CalendarTradeResultDto {
  entryAudit?: CalendarPriceAudit
  exitAudit?: CalendarPriceAudit
  exitReason: CalendarExitReason
  /** Package midpoint at entry, before friction. */
  entryMid: number
  /** What the delta selection measured at entry. */
  calendarContext: CalendarEntryContext
  /** Trading sessions from entry to exit. */
  sessionsHeld: number
  /**
   * Days from the exit to the **front** expiration - the one the position is
   * defined by and closed against. Named for the shared contract rather than
   * for the structure, since that is the field storage and export read.
   */
  exitDte: number
}

function toExcursion(o: CalendarObservation): Excursion {
  return {
    dollars: o.pnlDollars,
    pct: o.pnlPct,
    timestamp: o.timestamp,
    minutesSinceEntry: o.minutesSinceEntry,
    dte: o.frontDte,
    ...(o.underlyingPrice !== undefined ? { underlyingPrice: o.underlyingPrice } : {})
  }
}

function excursionsOver(observations: readonly CalendarObservation[]): Excursions {
  if (observations.length === 0) return { mfe: null, mae: null }
  let best = observations[0]!
  let worst = observations[0]!
  for (const o of observations) {
    if (o.pnlDollars > best.pnlDollars) best = o
    if (o.pnlDollars < worst.pnlDollars) worst = o
  }
  return { mfe: toExcursion(best), mae: toExcursion(worst) }
}

export interface SimulateCalendarOptions {
  /** Thresholds recorded for path analysis; defaults to the calendar set. */
  thresholds?: readonly number[]
}

export function simulateCalendarTrade(
  series: DoubleCalendarSeries,
  strategy: CalendarExitStrategy,
  options: SimulateCalendarOptions = {}
): CalendarTradeResult {
  const { observations, definition, entryCost } = series
  const thresholds = options.thresholds ?? CALENDAR_EXCURSION_THRESHOLDS

  if (observations.length === 0) {
    throw new Error('Cannot simulate a calendar with no observations')
  }
  if (!(entryCost > 0)) {
    throw new Error(`Cannot simulate a double calendar entered for ${entryCost.toFixed(2)} points`)
  }

  const position: CalendarPositionState = {
    definition,
    entryCost,
    entryTimestamp: series.entryTimestamp,
    peakPnlPct: observations[0]!.pnlPct,
    troughPnlPct: observations[0]!.pnlPct,
    ...(series.entryUnderlying !== undefined ? { entryUnderlying: series.entryUnderlying } : {})
  }

  let exitIndex = observations.length - 1
  let exitReason: CalendarExitReason = 'horizon'
  let exitValue = observations[exitIndex]!.netValue
  let note: string | undefined

  for (let i = 0; i < observations.length; i++) {
    const observation = observations[i]!

    // The peak must include the current minute before a rule sees it, or a
    // trailing stop could never fire on the same snapshot that set the peak.
    if (observation.pnlPct > position.peakPnlPct) position.peakPnlPct = observation.pnlPct
    if (observation.pnlPct < position.troughPnlPct) position.troughPnlPct = observation.pnlPct

    const decision = strategy.evaluate({
      observation,
      position,
      isLast: i === observations.length - 1
    })

    if (decision) {
      exitIndex = i
      exitReason = decision.reason
      exitValue = decision.exitValue
      note = decision.note
      break
    }
  }

  const exit = observations[exitIndex]!
  if (!Number.isFinite(exitValue)) {
    throw new Error(`Management ${strategy.id} produced a non-finite exit value`)
  }

  // A calendar cannot be closed for less than nothing, and its loss is capped
  // by the debit: both bounds are structural, not assumptions.
  const netExitValue = Math.max(0, exitValue)
  const pnlDollars = (netExitValue - entryCost) * CONTRACT_MULTIPLIER * definition.quantity
  const pnlPct = ((netExitValue - entryCost) / entryCost) * 100

  const held = observations.slice(0, exitIndex + 1)
  const excursions = excursionsOver(held)

  const mfeDollars = excursions.mfe?.dollars ?? 0
  const profitGiveback = mfeDollars > 0 ? mfeDollars - pnlDollars : 0
  const mfeCaptureRatio = mfeDollars > 0 ? pnlDollars / mfeDollars : null

  const firstReached: Record<string, number | null> = {}
  const lowestAfterReaching: Record<string, number | null> = {}

  for (const threshold of thresholds) {
    const key = String(threshold)
    const hitIndex = held.findIndex((o) => o.pnlPct >= threshold)
    if (hitIndex === -1) {
      firstReached[key] = null
      lowestAfterReaching[key] = null
      continue
    }
    firstReached[key] = held[hitIndex]!.minutesSinceEntry
    // Everything from the first touch onward, so a dip before the peak does not
    // masquerade as a give-back after it.
    let lowest = Number.POSITIVE_INFINITY
    for (let i = hitIndex; i < held.length; i++) {
      const value = held[i]!.pnlPct
      if (value < lowest) lowest = value
    }
    lowestAfterReaching[key] = Number.isFinite(lowest) ? lowest : null
  }

  const breaches = held.map((o) => o.breachPoints).filter((b): b is number => b !== undefined)

  return {
    definition,
    strategyId: strategy.id,
    strategyLabel: strategy.label,
    entryTimestamp: series.entryTimestamp,
    ...(series.entryUnderlying !== undefined ? { entryUnderlying: series.entryUnderlying } : {}),
    entryDebit: entryCost,
    entryMid: series.entryMid,
    ...(series.entryAudit ? { entryAudit: series.entryAudit } : {}),
    calendarContext: series.entryContext,
    exitTimestamp: exit.timestamp,
    exitValue: netExitValue,
    ...(exit.priceAudit ? { exitAudit: exit.priceAudit } : {}),
    exitReason,
    ...(exit.underlyingPrice !== undefined ? { exitUnderlying: exit.underlyingPrice } : {}),
    ...(note !== undefined ? { note } : {}),
    pnlDollars,
    pnlPct,
    holdingMinutes: exit.minutesSinceEntry,
    sessionsHeld: exit.sessionsSinceEntry,
    exitDte: exit.frontDte,
    excursions,
    profitGiveback,
    mfeCaptureRatio,
    firstReached,
    lowestAfterReaching,
    ...(breaches.length > 0 ? { maxBreachPoints: Math.max(...breaches) } : {}),
    quality: series.quality,
    ...(series.invalidPriceSamples ? { invalidPriceSamples: series.invalidPriceSamples } : {}),
    ambiguous: false
  }
}

/** Runs many management rules against one reconstructed calendar. */
export function simulateCalendarAll(
  series: DoubleCalendarSeries,
  strategies: readonly CalendarExitStrategy[],
  options: SimulateCalendarOptions = {}
): CalendarTradeResult[] {
  return strategies.map((strategy) => simulateCalendarTrade(series, strategy, options))
}
