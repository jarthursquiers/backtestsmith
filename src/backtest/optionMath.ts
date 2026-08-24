/**
 * Black-76 pricing, implied volatility, and delta.
 *
 * The butterfly studies never needed a model: a butterfly is placed by distance
 * from the index, and distance is directly observable. A calendar is not. Its
 * strikes are chosen by delta, and delta exists only inside a model, so this
 * module is the one place in the engine where a price is turned into a number
 * that was never quoted.
 *
 * Two choices keep the model assumption as small as possible:
 *
 *  - **Black-76 on the forward**, not Black-Scholes on the spot. The forward and
 *    the discount factor are recovered from put-call parity across the quoted
 *    chain, so no interest rate and no dividend yield is ever assumed. The only
 *    genuine assumption left is lognormality, and that is confined to the strike
 *    *selection* step; nothing downstream prices anything with it.
 *  - **Implied volatility per strike**, solved from that strike's own midpoint.
 *    A single at-the-money volatility applied across the chain would place the
 *    put strike wrong by tens of points, because the SPX skew is the dominant
 *    term at 30 delta.
 */

/**
 * Standard normal CDF.
 *
 * Hart's double-precision rational approximation. The textbook
 * Abramowitz-Stegun 7.1.26 form is accurate to about 7.5e-8, which sounds
 * ample until it is inverted: near 30 delta, dN/dd1 is roughly 0.35, so that
 * error is invisible, but the same routine is used inside a volatility solve
 * where errors compound across iterations. Full double precision costs nothing
 * here and removes the question.
 */
export function normalCdf(x: number): number {
  const z = Math.abs(x)
  if (z > 37) return x > 0 ? 1 : 0

  const e = Math.exp(-(z * z) / 2)
  let c: number

  if (z < 7.07106781186547) {
    let n = 3.52624965998911e-2 * z + 0.700383064443688
    n = n * z + 6.37396220353165
    n = n * z + 33.912866078383
    n = n * z + 112.079291497871
    n = n * z + 221.213596169931
    n = n * z + 220.206867912376

    let d = 8.83883476483184e-2 * z + 1.75566716318264
    d = d * z + 16.064177579207
    d = d * z + 86.7807322029461
    d = d * z + 296.564248779674
    d = d * z + 637.333633378831
    d = d * z + 793.826512519948
    d = d * z + 440.413735824752

    c = (e * n) / d
  } else {
    // Continued-fraction tail, where the rational form above loses precision.
    let f = z + 0.65
    f = z + 4 / f
    f = z + 3 / f
    f = z + 2 / f
    f = z + 1 / f
    c = e / (f * 2.506628274631)
  }

  return x > 0 ? 1 - c : c
}

/** Standard normal PDF. */
export function normalPdf(x: number): number {
  return Math.exp(-(x * x) / 2) / 2.506628274631
}

export type OptionRight = 'call' | 'put'

export interface BlackInputs {
  /** Forward price of the underlying at expiration. */
  forward: number
  strike: number
  /** Time to expiration in years. */
  years: number
  /** Annualized volatility, as a decimal. */
  volatility: number
  /** Discount factor e^(-rT) applied to the expected payoff. */
  discountFactor: number
  right: OptionRight
}

/** d1 and d2 of the Black-76 formula. Null when the inputs are degenerate. */
export function blackD(
  forward: number,
  strike: number,
  years: number,
  volatility: number
): { d1: number; d2: number } | null {
  if (!(forward > 0) || !(strike > 0) || !(years > 0) || !(volatility > 0)) return null
  const sqrtT = Math.sqrt(years)
  const d1 = (Math.log(forward / strike) + 0.5 * volatility * volatility * years) / (volatility * sqrtT)
  return { d1, d2: d1 - volatility * sqrtT }
}

/** Black-76 option price. */
export function blackPrice(inputs: BlackInputs): number {
  const { forward, strike, years, volatility, discountFactor, right } = inputs
  const d = blackD(forward, strike, years, volatility)

  // At zero time or zero volatility the option is worth its discounted
  // intrinsic value, which is a real answer rather than a failure.
  if (!d) {
    const intrinsic = right === 'call' ? Math.max(0, forward - strike) : Math.max(0, strike - forward)
    return discountFactor * intrinsic
  }

  return right === 'call'
    ? discountFactor * (forward * normalCdf(d.d1) - strike * normalCdf(d.d2))
    : discountFactor * (strike * normalCdf(-d.d2) - forward * normalCdf(-d.d1))
}

/**
 * Spot delta, to the precision a strike selection needs.
 *
 * With F = S e^((r-q)T), dV/dS works out to e^(-qT) N(d1) for a call. On SPX at
 * three weeks that factor is 0.9995, so N(d1) is reported directly: pretending
 * to a fourth decimal would require a dividend yield assumption this module
 * exists to avoid, and 0.0005 of delta is a fraction of one strike increment.
 */
export function blackDelta(
  forward: number,
  strike: number,
  years: number,
  volatility: number,
  right: OptionRight
): number | null {
  const d = blackD(forward, strike, years, volatility)
  if (!d) return null
  return right === 'call' ? normalCdf(d.d1) : -normalCdf(-d.d1)
}

/** Sensitivity of price to volatility, per 1.00 of volatility. */
export function blackVega(
  forward: number,
  strike: number,
  years: number,
  volatility: number,
  discountFactor: number
): number {
  const d = blackD(forward, strike, years, volatility)
  if (!d) return 0
  return discountFactor * forward * normalPdf(d.d1) * Math.sqrt(years)
}

export const MIN_VOLATILITY = 1e-4
export const MAX_VOLATILITY = 5

/**
 * Solves for the volatility that reproduces an observed price.
 *
 * Bisection rather than Newton. Newton is faster but can wander off a flat vega
 * far from the money, and this runs a few thousand times per study - fast
 * enough that robustness is worth more than speed. Returns null rather than a
 * clamped guess when the price is outside the no-arbitrage band, since a
 * quote that cannot be produced by any volatility is a data problem and should
 * be reported as one.
 */
export function impliedVolatility(
  price: number,
  forward: number,
  strike: number,
  years: number,
  discountFactor: number,
  right: OptionRight
): number | null {
  if (!(price > 0) || !(forward > 0) || !(strike > 0) || !(years > 0) || !(discountFactor > 0)) {
    return null
  }

  const intrinsic =
    discountFactor * (right === 'call' ? Math.max(0, forward - strike) : Math.max(0, strike - forward))
  const ceiling = discountFactor * (right === 'call' ? forward : strike)

  // A price at or below discounted intrinsic implies zero or negative time
  // value; a price at or above the ceiling exceeds the payoff's own bound.
  if (price <= intrinsic + 1e-9 || price >= ceiling - 1e-9) return null

  let low = MIN_VOLATILITY
  let high = MAX_VOLATILITY

  const priceAt = (volatility: number): number =>
    blackPrice({ forward, strike, years, volatility, discountFactor, right })

  if (priceAt(high) < price) return null

  // 64 halvings take the bracket from 5.0 to below 1e-18; the loop is bounded
  // by the tolerance in practice and by the count only as a guarantee.
  for (let i = 0; i < 64; i++) {
    const mid = (low + high) / 2
    if (priceAt(mid) < price) low = mid
    else high = mid
    if (high - low < 1e-8) break
  }

  return (low + high) / 2
}
