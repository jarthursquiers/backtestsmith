import type { ExpectedMoveAnchor } from '../shared/study.js'
import type { EntrySignal } from './entryStrategy.js'

/**
 * Where to put the butterfly.
 *
 * A strategy module rather than a formula, because placement is one of the
 * variables under study. The methods below all resolve to a concrete centre and
 * two wings validated against the strikes the chain actually lists - a placement
 * that names a strike which does not exist is an error, not a rounding problem.
 */

export interface PlacementResult {
  centerStrike: number
  lowerStrike: number
  upperStrike: number
  wingWidth: number
  /** How the centre was chosen, recorded with the trade. */
  reason: string
}

export interface PlacementContext {
  signal: EntrySignal
  /** Strikes listed for the chosen expiration, ascending. */
  availableStrikes: readonly number[]
  wingWidth: number
}

export interface ButterflyPlacement {
  readonly id: string
  readonly label: string
  place(context: PlacementContext): PlacementResult | null
}

/** Nearest listed strike to a target, or null when the chain is empty. */
export function nearestStrike(target: number, available: readonly number[]): number | null {
  if (available.length === 0) return null
  return available.reduce((best, strike) =>
    Math.abs(strike - target) < Math.abs(best - target) ? strike : best
  )
}

/**
 * Completes a butterfly around a centre, requiring both wings to be listed.
 *
 * Returning null when a wing is missing is deliberate. Substituting the nearest
 * available strike would silently change the wing width, and therefore the risk,
 * the maximum value, and every normalized distance derived from it.
 */
function completeButterfly(
  center: number,
  wingWidth: number,
  available: readonly number[],
  reason: string
): PlacementResult | null {
  const lower = center - wingWidth
  const upper = center + wingWidth
  const listed = new Set(available)
  if (!listed.has(center) || !listed.has(lower) || !listed.has(upper)) return null

  return { centerStrike: center, lowerStrike: lower, upperStrike: upper, wingWidth, reason }
}

/**
 * Places the centre a fixed number of points away from the underlying, in the
 * direction of the trade.
 *
 * A bearish butterfly sits below the market, a bullish one above, so the offset
 * is applied against the signal's direction.
 */
export function fixedDistancePlacement(offsetPoints: number): ButterflyPlacement {
  return {
    id: `fixed${offsetPoints}`,
    label: `${offsetPoints} points OTM`,
    place({ signal, availableStrikes, wingWidth }) {
      const direction = signal.direction === 'bearish' ? -1 : 1
      const target = signal.underlyingAtEntry + direction * offsetPoints
      const center = nearestStrike(target, availableStrikes)
      if (center === null) return null

      return completeButterfly(
        center,
        wingWidth,
        availableStrikes,
        `Centre ${center} is ${offsetPoints} points ${signal.direction === 'bearish' ? 'below' : 'above'} SPX ${signal.underlyingAtEntry.toFixed(2)}`
      )
    }
  }
}

/**
 * Places the centre a number of wing widths away from the underlying.
 *
 * Expresses placement in the same normalized units used to measure distance
 * during the trade, so a study can vary wing width without also changing how far
 * out of the money the structure sits.
 */
export function normalizedDistancePlacement(wingsAway: number): ButterflyPlacement {
  return {
    id: `wings${wingsAway}`,
    label: `${wingsAway} wing widths OTM`,
    place({ signal, availableStrikes, wingWidth }) {
      const direction = signal.direction === 'bearish' ? -1 : 1
      const target = signal.underlyingAtEntry + direction * wingsAway * wingWidth
      const center = nearestStrike(target, availableStrikes)
      if (center === null) return null

      return completeButterfly(
        center,
        wingWidth,
        availableStrikes,
        `Centre ${center} is ${wingsAway} wing widths (${(wingsAway * wingWidth).toFixed(0)} points) ${signal.direction === 'bearish' ? 'below' : 'above'} SPX ${signal.underlyingAtEntry.toFixed(2)}`
      )
    }
  }
}

/**
 * First listed strike at or beyond a target, moving away from the money.
 *
 * "Beyond" follows the trade's direction: below the target for a downside
 * structure, above it for an upside one. Returns null when the chain does not
 * extend that far, which is a real condition on far-out-of-the-money wings and
 * must skip the trade rather than quietly pull the wing back inside.
 */
export function strikeAtOrBeyond(
  target: number,
  available: readonly number[],
  direction: 1 | -1
): number | null {
  let best: number | null = null
  for (const strike of available) {
    if (direction < 0 ? strike > target : strike < target) continue
    if (best === null || Math.abs(strike - target) < Math.abs(best - target)) best = strike
  }
  return best
}

/**
 * Places the butterfly against a supplied expected move.
 *
 * This is the placement the primary study uses. The expected move is *not*
 * computed here - it must be supplied from data, since deriving it requires an
 * at-the-money straddle price at the entry minute. Passing an unverified
 * estimate would put the entire structure in the wrong place, so the caller is
 * required to have measured it.
 *
 * The anchor decides what gets rounded to a listed strike. Rounding the centre
 * (`nearestCenter`) keeps the structure closest to its ideal location but can
 * pull the near wing a few points inside the expected move. Rounding the near
 * wing outward (`nearWingOutside`) guarantees the whole butterfly sits beyond
 * the move, at the cost of pushing the centre slightly further out. Both are in
 * use, so neither is hard-coded.
 */
export function expectedMovePlacement(options: {
  expectedMove: number
  /** Extra distance beyond the expected move for the near wing, in points. */
  buffer?: number
  anchor?: ExpectedMoveAnchor
}): ButterflyPlacement {
  const { expectedMove, buffer = 0, anchor = 'nearestCenter' } = options

  return {
    id: `em${expectedMove.toFixed(0)}${buffer ? `+${buffer}` : ''}${anchor === 'nearWingOutside' ? '-wing' : ''}`,
    label: `Near wing outside a ${expectedMove.toFixed(0)}-point expected move`,
    place({ signal, availableStrikes, wingWidth }) {
      const direction = signal.direction === 'bearish' ? -1 : 1
      // The near wing is the one closest to the money, so the centre sits a
      // further wing width beyond it.
      const nearWingTarget = signal.underlyingAtEntry + direction * (expectedMove + buffer)

      if (anchor === 'nearWingOutside') {
        const nearWing = strikeAtOrBeyond(nearWingTarget, availableStrikes, direction)
        if (nearWing === null) return null
        const center = nearWing + direction * wingWidth

        return completeButterfly(
          center,
          wingWidth,
          availableStrikes,
          `Near wing ${nearWing} is the first listed strike ${signal.direction === 'bearish' ? 'at or below' : 'at or above'} ` +
            `the ${expectedMove.toFixed(1)}-point expected move${buffer ? ` plus ${buffer}` : ''} from SPX ${signal.underlyingAtEntry.toFixed(2)}`
        )
      }

      const centerTarget = nearWingTarget + direction * wingWidth
      const center = nearestStrike(centerTarget, availableStrikes)
      if (center === null) return null

      return completeButterfly(
        center,
        wingWidth,
        availableStrikes,
        `Near wing ${center - direction * wingWidth} sits outside the ${expectedMove.toFixed(1)}-point expected move${buffer ? ` plus ${buffer}` : ''}`
      )
    }
  }
}
