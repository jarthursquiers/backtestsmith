import type { OptionType } from './contracts.js'

/**
 * A symmetrical three-leg butterfly.
 *
 * Stored as an explicit three-leg structure rather than a strike plus a width,
 * so the exact contracts that were priced are always recoverable from a stored
 * result.
 */
export interface ButterflyDefinition {
  underlying: string
  /**
   * Directional intent of the position, not the option type. A downside/bearish
   * butterfly is normally built from puts below the market, an upside/bullish
   * one from calls above it.
   */
  direction: 'bullish' | 'bearish'
  optionType: OptionType
  expiration: string

  lowerStrike: number
  centerStrike: number
  upperStrike: number

  lowerTicker: string
  centerTicker: string
  upperTicker: string

  /** Distance from the center to either wing, in underlying points. */
  wingWidth: number
  /** Number of butterflies. One butterfly is 1 x 2 x 1 contracts. */
  quantity: number
}

/** Contract multiplier for SPX-style index options. */
export const CONTRACT_MULTIPLIER = 100

export type LegRole = 'lower' | 'center' | 'upper'

/** A single leg's price at one instant, with the provenance needed to judge it. */
export interface LegQuote {
  ticker: string
  price: number
  /** Timestamp of the bar the price came from. */
  observedAt: number
  /**
   * Milliseconds between the observation and the instant it is being used for.
   * Zero means a bar existed in that very minute; anything larger is a
   * carried-forward price.
   */
  ageMs: number
}

/**
 * One minute of a butterfly's life.
 *
 * `underlyingPrice` and the distance measures are optional because the
 * underlying series is sourced separately from the option legs and may be
 * absent; recording them as undefined is honest, recording zero would not be.
 */
export interface ButterflyObservation {
  timestamp: number
  underlyingPrice?: number
  butterflyValue: number
  pnlDollars: number
  pnlPct: number
  /** Calendar days to expiration at this instant. */
  dte: number
  /** Remaining trading sessions to expiration. */
  tradingDte: number
  minutesSinceEntry: number
  distanceToCenter?: number
  normalizedDistanceToCenter?: number
  /** True when any leg price was carried forward rather than observed. */
  stale: boolean
  /** Largest carry-forward age across the three legs, in milliseconds. */
  maxLegAgeMs: number
}

/**
 * Per-trade data quality.
 *
 * Aggregate bars are not continuous quotes, so every result carries a measure of
 * how much of it rests on observed prices versus carried-forward ones. Trades
 * can be excluded below a threshold rather than silently trusted.
 */
export interface DataQuality {
  /** Regular-session minutes between entry and exit. */
  expectedMinutes: number
  /** Minutes where a butterfly value could be computed at all. */
  pricedMinutes: number
  /** Minutes where all three legs traded in that very minute. */
  freshMinutes: number
  /** Minutes priced using at least one carried-forward leg. */
  staleMinutes: number
  /** Minutes that could not be priced under the missing-data policy. */
  unpricedMinutes: number
  /** Longest consecutive run of carried-forward or unpriced minutes. */
  longestStaleRunMinutes: number
  /** Minutes each leg was absent, keyed by role. */
  missingByLeg: Record<LegRole, number>
  /** pricedMinutes / expectedMinutes, in the range 0..1. */
  coverage: number
  /** freshMinutes / pricedMinutes, in the range 0..1. */
  freshness: number
}

/** How a single option's price is derived from its bar. */
export type LegPricingModel = 'close' | 'ohlc4' | 'hl2'

/** What to do when a leg has no bar in a given minute. */
export type MissingDataPolicy =
  | { mode: 'strict' }
  | { mode: 'carryForward'; maxStaleMinutes: number }

export interface PricingAssumptions {
  model: LegPricingModel
  /**
   * Per-butterfly slippage in price points, applied against the trader on both
   * entry and exit. Aggregate bars are trade prints, not executable quotes, so
   * results are estimates and this makes the assumption explicit.
   */
  slippage: number
  missingData: MissingDataPolicy
}

export const DEFAULT_PRICING: PricingAssumptions = {
  model: 'close',
  slippage: 0,
  // Short carry-forward by default: strict is unusable on OTM wings, but long
  // fills would invent price paths that never existed.
  missingData: { mode: 'carryForward', maxStaleMinutes: 5 }
}

/** A reconstructed butterfly lifecycle. */
export interface ButterflySeries {
  definition: ButterflyDefinition
  /** Net debit paid per butterfly, in price points, including entry slippage. */
  entryDebit: number
  entryTimestamp: number
  entryUnderlying?: number
  observations: ButterflyObservation[]
  quality: DataQuality
  pricing: PricingAssumptions
  /** Non-fatal problems worth surfacing, e.g. a leg with almost no data. */
  warnings: string[]
}
