import type { ButterflyObservation } from '../domain/butterfly.js'
import type { Excursion, Excursions } from '../shared/excursions.js'

/**
 * Maximum favorable and adverse excursion.
 *
 * Full excursion-timeline and conditional-path analysis comes later; this is the
 * minimum needed to mark up a single trade, and it is computed from the same
 * observation series everything else uses so the numbers can never disagree.
 */

export type { Excursion, Excursions } from '../shared/excursions.js'

function toExcursion(o: ButterflyObservation): Excursion {
  return {
    dollars: o.pnlDollars,
    pct: o.pnlPct,
    timestamp: o.timestamp,
    minutesSinceEntry: o.minutesSinceEntry,
    dte: o.dte,
    ...(o.underlyingPrice !== undefined ? { underlyingPrice: o.underlyingPrice } : {}),
    ...(o.normalizedDistanceToCenter !== undefined
      ? { normalizedDistanceToCenter: o.normalizedDistanceToCenter }
      : {})
  }
}

/**
 * Computes MFE and MAE over the observed path.
 *
 * Both are measured against the entry debit, so a trade that never went positive
 * reports an MFE at or below zero rather than a fabricated best case. The first
 * occurrence of an extreme is kept, since "when did it first get there" is the
 * research question.
 */
export function computeExcursions(observations: readonly ButterflyObservation[]): Excursions {
  if (observations.length === 0) return { mfe: null, mae: null }

  let best = observations[0]!
  let worst = observations[0]!

  for (const o of observations) {
    if (o.pnlDollars > best.pnlDollars) best = o
    if (o.pnlDollars < worst.pnlDollars) worst = o
  }

  return { mfe: toExcursion(best), mae: toExcursion(worst) }
}

/**
 * First timestamp at which the trade reached each return threshold.
 *
 * Answers "when butterflies make money, how quickly do they make it". A
 * threshold never reached maps to null rather than being omitted, so callers
 * can distinguish "not reached" from "not measured".
 */
export function firstReachedTimes(
  observations: readonly ButterflyObservation[],
  thresholdsPct: readonly number[]
): Map<number, { timestamp: number; minutesSinceEntry: number; dte: number } | null> {
  const result = new Map<number, { timestamp: number; minutesSinceEntry: number; dte: number } | null>()
  for (const threshold of thresholdsPct) {
    const hit = observations.find((o) => o.pnlPct >= threshold)
    result.set(
      threshold,
      hit ? { timestamp: hit.timestamp, minutesSinceEntry: hit.minutesSinceEntry, dte: hit.dte } : null
    )
  }
  return result
}
