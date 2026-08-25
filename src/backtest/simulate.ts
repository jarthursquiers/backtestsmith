import type { ButterflySeries, DataQuality } from '../domain/butterfly.js'
import { CONTRACT_MULTIPLIER } from '../domain/butterfly.js'
import type { Excursions } from '../shared/excursions.js'
import type { ButterflyTradeResult } from '../shared/trade.js'
import { computeExcursions, firstReachedTimes } from './excursions.js'
import type { ExitReason, ExitStrategy, PositionState } from './exits.js'

/**
 * Runs one exit strategy over one reconstructed butterfly.
 *
 * The separation matters: reconstruction is expensive and provider-bound, while
 * simulation is pure and cheap. Many management methods can therefore be run
 * against the *identical* observation series, which is what makes a comparison
 * between them honest - no rule ever sees a different entry population.
 */

/** Return thresholds whose first-touch time is recorded for every trade. */
export const EXCURSION_THRESHOLDS = [25, 50, 75, 100, 150, 200, 300, 500] as const

export interface SimulateOptions {
  /** Deducted from the exit value, in price points, mirroring entry slippage. */
  exitSlippage?: number
}

export function simulateTrade(
  series: ButterflySeries,
  strategy: ExitStrategy,
  options: SimulateOptions = {}
): ButterflyTradeResult {
  const { observations, definition, entryDebit } = series
  const exitSlippage = options.exitSlippage ?? series.pricing.slippage

  if (observations.length === 0) {
    throw new Error('Cannot simulate a trade with no observations')
  }
  if (entryDebit <= 0 || entryDebit > definition.wingWidth + 0.01) {
    throw new Error(
      `Cannot simulate an invalid ${definition.wingWidth}-wide butterfly entry debit of ${entryDebit.toFixed(2)}`
    )
  }

  const position: PositionState = {
    definition,
    entryDebit,
    entryTimestamp: series.entryTimestamp,
    peakPnlPct: observations[0]!.pnlPct,
    troughPnlPct: observations[0]!.pnlPct,
    ...(series.entryUnderlying !== undefined ? { entryUnderlying: series.entryUnderlying } : {})
  }

  let exitIndex = observations.length - 1
  let exitReason: ExitReason = 'endOfData'
  let exitValue = observations[exitIndex]!.butterflyValue
  let ambiguous = false
  let note: string | undefined

  for (let i = 0; i < observations.length; i++) {
    const observation = observations[i]!

    // The peak must include the current minute before the rule sees it, or a
    // trailing stop could never fire on the same bar that set the peak.
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
      ambiguous = decision.ambiguous
      note = decision.note
      break
    }
  }

  const exitObservation = observations[exitIndex]!
  if (!Number.isFinite(exitValue) || exitValue < -0.01 || exitValue > definition.wingWidth + 0.01) {
    throw new Error(
      `Exit strategy ${strategy.id} produced invalid butterfly value ${exitValue} ` +
        `outside 0..${definition.wingWidth}`
    )
  }
  // Slippage works against the trader on the way out as it did on the way in.
  const netExitValue = Math.max(0, exitValue - exitSlippage)

  const pnlDollars = (netExitValue - entryDebit) * CONTRACT_MULTIPLIER * definition.quantity
  const pnlPct = entryDebit > 0 ? ((netExitValue - entryDebit) / entryDebit) * 100 : 0

  // Excursions are measured over the *held* portion of the path only. Including
  // minutes after the exit would credit or penalise a rule for a path it never
  // experienced.
  const held = observations.slice(0, exitIndex + 1)
  const excursions: Excursions = computeExcursions(held)

  const mfeDollars = excursions.mfe?.dollars ?? 0
  const profitGiveback = mfeDollars > 0 ? mfeDollars - pnlDollars : 0
  const mfeCaptureRatio = mfeDollars > 0 ? pnlDollars / mfeDollars : null

  const reached = firstReachedTimes(held, EXCURSION_THRESHOLDS)
  const firstReached: Record<string, number | null> = {}
  const lowestAfterReaching: Record<string, number | null> = {}

  for (const [threshold, hit] of reached) {
    const key = String(threshold)
    firstReached[key] = hit ? hit.minutesSinceEntry : null

    if (!hit) {
      lowestAfterReaching[key] = null
      continue
    }
    // Everything from the first touch onward, so a dip before the peak does not
    // masquerade as a give-back after it.
    let lowest = Number.POSITIVE_INFINITY
    for (const o of held) {
      if (o.minutesSinceEntry < hit.minutesSinceEntry) continue
      if (o.pnlPct < lowest) lowest = o.pnlPct
    }
    lowestAfterReaching[key] = Number.isFinite(lowest) ? lowest : null
  }

  const distances = held
    .map((o) => o.normalizedDistanceToCenter)
    .filter((d): d is number => d !== undefined)
  const minNormalizedDistance = distances.length > 0 ? Math.min(...distances) : undefined

  return {
    definition,
    strategyId: strategy.id,
    strategyLabel: strategy.label,
    entryTimestamp: series.entryTimestamp,
    ...(series.entryUnderlying !== undefined ? { entryUnderlying: series.entryUnderlying } : {}),
    entryDebit,
    ...(series.entryAudit ? { entryAudit: series.entryAudit } : {}),
    ...(series.entryIndicators ? { entryIndicators: series.entryIndicators } : {}),
    exitTimestamp: exitObservation.timestamp,
    exitValue: netExitValue,
    ...(exitObservation.priceAudit ? { exitAudit: exitObservation.priceAudit } : {}),
    exitReason,
    ambiguous,
    ...(note !== undefined ? { note } : {}),
    ...(exitObservation.underlyingPrice !== undefined
      ? { exitUnderlying: exitObservation.underlyingPrice }
      : {}),
    pnlDollars,
    pnlPct,
    holdingMinutes: exitObservation.minutesSinceEntry,
    exitDte: exitObservation.dte,
    excursions,
    profitGiveback,
    mfeCaptureRatio,
    firstReached,
    lowestAfterReaching,
    ...(minNormalizedDistance !== undefined ? { minNormalizedDistance } : {}),
    quality: qualityUpToExit(series.quality, observations.length, exitIndex + 1),
    ...(series.invalidPriceSamples && series.invalidPriceSamples.length > 0
      ? { invalidPriceSamples: series.invalidPriceSamples }
      : {})
  }
}

/**
 * Scales the trade's data quality to the held portion.
 *
 * Only the counts that are meaningfully proportional are scaled; ratios are
 * recomputed. This is an approximation and is labelled as one, since the exact
 * per-minute breakdown is not retained after reconstruction.
 */
function qualityUpToExit(quality: DataQuality, totalObservations: number, heldObservations: number): DataQuality {
  if (heldObservations >= totalObservations || totalObservations === 0) return quality
  const fraction = heldObservations / totalObservations
  const expectedMinutes = Math.round(quality.expectedMinutes * fraction)
  const pricedMinutes = Math.min(heldObservations, expectedMinutes)
  const freshMinutes = Math.round(quality.freshMinutes * fraction)

  return {
    ...quality,
    expectedMinutes,
    pricedMinutes,
    freshMinutes,
    staleMinutes: Math.max(0, pricedMinutes - freshMinutes),
    unpricedMinutes: Math.max(0, expectedMinutes - pricedMinutes),
    invalidPriceMinutes: Math.round((quality.invalidPriceMinutes ?? 0) * fraction),
    coverage: expectedMinutes > 0 ? pricedMinutes / expectedMinutes : 0,
    freshness: pricedMinutes > 0 ? freshMinutes / pricedMinutes : 0
  }
}

/**
 * Runs many strategies against one reconstructed series.
 *
 * Every strategy receives the identical observation array, which is the
 * guarantee that makes management comparison valid.
 */
export function simulateAll(
  series: ButterflySeries,
  strategies: readonly ExitStrategy[],
  options: SimulateOptions = {}
): ButterflyTradeResult[] {
  return strategies.map((strategy) => simulateTrade(series, strategy, options))
}
