import { estimateFromParity } from './putCallParity.js'
import { blackDelta, impliedVolatility, type OptionRight } from './optionMath.js'

/**
 * Choosing a double calendar's two strikes by delta.
 *
 * A butterfly is placed by distance - so many points from the index, or so many
 * expected moves - and distance needs no model. A calendar is placed by delta,
 * which does. The sequence here keeps the modelled part as small as it can be:
 *
 *   1. Recover the forward and the discount factor from put-call parity across
 *      the quoted chain. This is arithmetic on observed prices, not a model,
 *      and it means no interest rate or dividend yield is ever assumed.
 *   2. Solve each strike's own implied volatility from its own midpoint.
 *   3. Report the delta that volatility implies, and take the strike whose
 *      delta is nearest the target.
 *
 * Step 2 is the only place lognormality enters, and it enters per strike, so
 * the SPX skew is carried rather than averaged away. That matters: a single
 * at-the-money volatility applied across the chain misplaces the 30-delta put
 * by 30 to 50 points on a 6800 index, which is six to ten strikes.
 */

/** One contract's two-sided quote in a chain snapshot. */
export interface ChainQuote {
  ticker: string
  strike: number
  right: OptionRight
  bid: number
  ask: number
  /** Milliseconds between the quote and the instant it is being used for. */
  ageMs: number
}

export interface StrikeSelectionRequest {
  /** Every quote for one expiration at one instant, both rights. */
  quotes: readonly ChainQuote[]
  /** Index level, used only to bound the search around the money. */
  spot: number
  /** Time from the selection instant to the expiration, in years. */
  years: number
  /** Absolute delta to target on each side, e.g. 0.30. */
  targetDelta: number
  /**
   * Half-width of the strike band searched, as a fraction of spot. Wide enough
   * to contain any plausible 10-to-45 delta strike, narrow enough to keep the
   * parity fit and the volatility solves away from the illiquid tails.
   */
  searchFraction?: number
  /** Reject a candidate whose bid is at or below this, in points. */
  minimumBid?: number
  /**
   * Strikes a candidate may be chosen from, when something outside the front
   * chain constrains the choice.
   *
   * A double calendar needs the same strike listed in both expirations, and SPX
   * does not list the same ladder in each: near-dated weeklies carry five-point
   * strikes far further out than the expirations a week behind them. Selecting
   * from the front chain alone therefore picks a strike the back month has
   * never heard of, and the position cannot be built at all. Restricting the
   * search is the fix; restricting the parity fit as well would be a mistake,
   * since the fit wants every near-the-money pair it can get.
   */
  allowedStrikes?: ReadonlySet<number>
}

export interface SelectedStrike {
  ticker: string
  strike: number
  right: OptionRight
  bid: number
  ask: number
  mid: number
  impliedVolatility: number
  delta: number
}

export interface StrikeSelection {
  put: SelectedStrike
  call: SelectedStrike
  forward: number
  discountFactor: number
  /** Strikes that produced a usable delta. */
  candidatesPriced: number
  /** RMS residual of the parity fit, in points; a check on the snapshot. */
  parityResidualRms: number | null
}

export class StrikeSelectionError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'StrikeSelectionError'
  }
}

const DEFAULT_SEARCH_FRACTION = 0.12
const DEFAULT_MINIMUM_BID = 0.05

/** Two-sided quotes only; a one-sided or crossed quote is not a price. */
function usable(quote: ChainQuote): boolean {
  return (
    Number.isFinite(quote.bid) &&
    Number.isFinite(quote.ask) &&
    quote.bid >= 0 &&
    quote.ask > quote.bid
  )
}

function mid(quote: ChainQuote): number {
  return (quote.bid + quote.ask) / 2
}

/**
 * Recovers the forward and discount factor from the chain's own quotes.
 *
 * Restricted to strikes near the money, where both sides trade tightly. Far
 * out, one side of every pair is a few cents wide in absolute terms but
 * enormous in relative terms, and including those strikes visibly drags the
 * regression.
 */
export function fitForward(
  quotes: readonly ChainQuote[],
  spot: number,
  years: number
): { forward: number; discountFactor: number; residualRms: number | null; strikes: number } | null {
  const calls = new Map<number, ChainQuote>()
  const puts = new Map<number, ChainQuote>()
  for (const quote of quotes) {
    if (!usable(quote)) continue
    ;(quote.right === 'call' ? calls : puts).set(quote.strike, quote)
  }

  const pairs = [...calls.keys()]
    .filter((strike) => puts.has(strike))
    .filter((strike) => Math.abs(strike - spot) <= spot * 0.03)
    .sort((a, b) => Math.abs(a - spot) - Math.abs(b - spot))
    .slice(0, 20)

  if (pairs.length < 3) return null

  const estimate = estimateFromParity(
    pairs.map((strike) => {
      const call = calls.get(strike)!
      const put = puts.get(strike)!
      return {
        strike,
        callPrice: mid(call),
        putPrice: mid(put),
        callAgeMs: call.ageMs,
        putAgeMs: put.ageMs
      }
    }),
    { yearsToExpiry: years }
  )

  if (!estimate || estimate.discountFactor === null) return null

  /*
   * The regression recovers the discount factor from the slope of (C - P)
   * against K, and that slope is the noisiest thing it produces: midpoints
   * carry half a point of quote noise apiece, and the strike band is only a few
   * percent wide. On a fast-moving session it lands slightly above one, which
   * would be a negative interest rate. The forward is a ratio of the two fitted
   * coefficients and is barely affected, so the fix is to cap the factor at one
   * rather than discard an otherwise sound fit.
   */
  const discountFactor = Math.min(1, estimate.discountFactor)

  return {
    forward: estimate.forward,
    discountFactor,
    residualRms: estimate.residualRms,
    strikes: estimate.strikesUsed
  }
}

/**
 * Picks the put and call strikes nearest a target delta.
 *
 * Both strikes come from the *front* expiration. The short options define the
 * tent the position profits inside, and it is their deltas a trader quotes when
 * describing the trade; the long legs simply inherit the same strikes.
 */
export function selectCalendarStrikes(request: StrikeSelectionRequest): StrikeSelection {
  const {
    quotes,
    spot,
    years,
    targetDelta,
    searchFraction = DEFAULT_SEARCH_FRACTION,
    minimumBid = DEFAULT_MINIMUM_BID,
    allowedStrikes
  } = request

  if (!(targetDelta > 0 && targetDelta < 1)) {
    throw new StrikeSelectionError(`Target delta must be between 0 and 1, received ${targetDelta}.`)
  }
  if (!(years > 0)) {
    throw new StrikeSelectionError('Time to expiration must be positive to imply a delta.')
  }

  const fit = fitForward(quotes, spot, years)
  if (!fit) {
    throw new StrikeSelectionError(
      'Put-call parity could not be fitted: fewer than three strikes near the money have two-sided quotes.'
    )
  }

  const window = spot * searchFraction
  const priced: SelectedStrike[] = []

  for (const quote of quotes) {
    if (!usable(quote)) continue
    if (Math.abs(quote.strike - spot) > window) continue
    if (allowedStrikes && !allowedStrikes.has(quote.strike)) continue

    const price = mid(quote)
    const iv = impliedVolatility(price, fit.forward, quote.strike, years, fit.discountFactor, quote.right)
    if (iv === null) continue

    const delta = blackDelta(fit.forward, quote.strike, years, iv, quote.right)
    if (delta === null) continue

    priced.push({
      ticker: quote.ticker,
      strike: quote.strike,
      right: quote.right,
      bid: quote.bid,
      ask: quote.ask,
      mid: price,
      impliedVolatility: iv,
      delta
    })
  }

  /*
   * Only out-of-the-money strikes are considered. Delta alone does not say
   * which side of the forward a strike is on - a 30-delta call exists below the
   * forward too, as a deep in-the-money 70-delta put's counterpart - and an
   * in-the-money short leg turns the structure into something else entirely.
   */
  const nearest = (right: OptionRight): SelectedStrike | null => {
    const side = priced.filter((candidate) => {
      if (candidate.right !== right) return false
      if (candidate.bid < minimumBid) return false
      return right === 'call' ? candidate.strike > fit.forward : candidate.strike < fit.forward
    })
    if (side.length === 0) return null
    return side.reduce((best, candidate) =>
      Math.abs(Math.abs(candidate.delta) - targetDelta) < Math.abs(Math.abs(best.delta) - targetDelta)
        ? candidate
        : best
    )
  }

  const put = nearest('put')
  const call = nearest('call')

  if (!put || !call) {
    throw new StrikeSelectionError(
      `No out-of-the-money ${!put ? 'put' : 'call'} in the chain could be priced to a delta ` +
        `(${priced.length} of ${quotes.length} quotes yielded one` +
        `${allowedStrikes ? `, from ${allowedStrikes.size} strikes listed in both expirations` : ''}).`
    )
  }

  return {
    put,
    call,
    forward: fit.forward,
    discountFactor: fit.discountFactor,
    candidatesPriced: priced.length,
    parityResidualRms: fit.residualRms
  }
}
