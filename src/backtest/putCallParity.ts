/**
 * Deriving an index level from option prices via put-call parity.
 *
 * For European options on an index, with D the discount factor e^(-rT) and F the
 * forward price of the index at expiration:
 *
 *   C - P = D * (F - K)
 *
 * This is an identity, not a model: no volatility assumption, no pricing model.
 * What it yields is nonetheless the **forward**, not the spot index. Converting
 * requires a carry rate:
 *
 *   S = F * e^(-(r - q) T)
 *
 * At 7 DTE with r - q around 3%, the forward sits roughly 3.5 points above spot
 * on a 6000 index, and that gap decays to zero at expiration. Ignoring it does
 * not merely offset the series - it introduces a downward drift that mimics real
 * market movement, which is worse.
 *
 * The dominant error source is not the maths but the inputs. At the money the
 * call and put deltas are about +0.5 and -0.5, so d(C - P)/dS is about 1.0:
 * every point of index movement between the two legs' prints becomes a point of
 * error, one for one. Estimates therefore carry the staleness of the legs that
 * produced them, so callers can filter on it.
 */

export interface ParityQuote {
  strike: number
  callPrice: number
  putPrice: number
  /** Staleness of each leg, in milliseconds, from the reconstruction. */
  callAgeMs: number
  putAgeMs: number
}

export interface ParityEstimate {
  /** Implied forward price of the index at expiration. */
  forward: number
  /** Spot estimate, after applying the carry adjustment. */
  spot: number
  /** Discount factor, only recoverable when several strikes are available. */
  discountFactor: number | null
  strikesUsed: number
  /** Worst leg staleness behind this estimate. */
  maxAgeMs: number
  /** RMS residual of the multi-strike fit, in price points. Null for one strike. */
  residualRms: number | null
  method: 'regression' | 'singleStrike'
}

export interface ParityOptions {
  /** Time to expiration in years. */
  yearsToExpiry: number
  /**
   * Annualized carry, r - q. The default is a neutral placeholder; the honest
   * value is calibrated from data by `fitCarryRate` rather than assumed.
   */
  carryRate?: number
}

export const DEFAULT_CARRY_RATE = 0.03

/**
 * Estimates the forward and spot from one or more strikes.
 *
 * With a single strike the discount factor cannot be separated, so D is taken as
 * 1. The resulting forward error is (1 - D) * (C - P): at 7 DTE that is about
 * 0.08% of a near-the-money (C - P) of a few points, far below the noise floor
 * from non-synchronous prints.
 *
 * With three or more strikes, regressing (C - P) on K recovers both:
 *   C - P = D*F - D*K   ->   slope = -D,  intercept = D*F
 * which needs no assumption about interest rates at all.
 */
export function estimateFromParity(
  quotes: readonly ParityQuote[],
  options: ParityOptions
): ParityEstimate | null {
  if (quotes.length === 0) return null

  const carryRate = options.carryRate ?? DEFAULT_CARRY_RATE
  const spotFromForward = (forward: number): number =>
    forward * Math.exp(-carryRate * options.yearsToExpiry)

  const maxAgeMs = Math.max(...quotes.map((q) => Math.max(q.callAgeMs, q.putAgeMs)))

  if (quotes.length < 3) {
    // Nearest-the-money strike carries the tightest spreads and the most trade
    // activity, so it is the best single estimator available.
    const quote = quotes[0]!
    const forward = quote.strike + (quote.callPrice - quote.putPrice)
    return {
      forward,
      spot: spotFromForward(forward),
      discountFactor: null,
      strikesUsed: 1,
      maxAgeMs,
      residualRms: null,
      method: 'singleStrike'
    }
  }

  const n = quotes.length
  let sumK = 0
  let sumY = 0
  let sumKK = 0
  let sumKY = 0
  for (const q of quotes) {
    const y = q.callPrice - q.putPrice
    sumK += q.strike
    sumY += y
    sumKK += q.strike * q.strike
    sumKY += q.strike * y
  }

  const denominator = n * sumKK - sumK * sumK
  if (denominator === 0) return null

  const slope = (n * sumKY - sumK * sumY) / denominator
  const intercept = (sumY - slope * sumK) / n

  // slope = -D, so a non-negative slope means the data cannot be parity-consistent.
  const discountFactor = -slope
  if (!(discountFactor > 0)) return null

  const forward = intercept / discountFactor

  let sumSquaredResiduals = 0
  for (const q of quotes) {
    const predicted = slope * q.strike + intercept
    const residual = q.callPrice - q.putPrice - predicted
    sumSquaredResiduals += residual * residual
  }

  return {
    forward,
    spot: spotFromForward(forward),
    discountFactor,
    strikesUsed: n,
    maxAgeMs,
    residualRms: Math.sqrt(sumSquaredResiduals / n),
    method: 'regression'
  }
}

/**
 * Calibrates the annualized carry from forwards paired with known spot levels.
 *
 * Since F = S * e^((r-q)T), the carry is the slope of ln(F/S) against T through
 * the origin. Fitting it beats assuming a rate, and the residual spread is
 * itself a measure of how well parity is working.
 */
export function fitCarryRate(
  samples: readonly { forward: number; spot: number; yearsToExpiry: number }[]
): { carryRate: number; samples: number } | null {
  let sumTT = 0
  let sumTLog = 0
  let used = 0

  for (const s of samples) {
    if (!(s.forward > 0) || !(s.spot > 0) || !(s.yearsToExpiry > 0)) continue
    const t = s.yearsToExpiry
    sumTT += t * t
    sumTLog += t * Math.log(s.forward / s.spot)
    used++
  }

  if (used === 0 || sumTT === 0) return null
  return { carryRate: sumTLog / sumTT, samples: used }
}

/** Fraction of a year between two instants, on a 365-day basis. */
export function yearsBetween(fromMs: number, toMs: number): number {
  return Math.max(0, (toMs - fromMs) / (365 * 24 * 60 * 60 * 1000))
}
