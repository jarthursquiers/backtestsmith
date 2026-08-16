/**
 * Internal, provider-agnostic option contract model.
 *
 * Massive (and other OPRA-derived providers) return their own field naming;
 * every provider adapter is responsible for normalizing into this shape so the
 * research engine never sees vendor-specific structures.
 */
export type OptionType = 'call' | 'put'

export type ExerciseStyle = 'american' | 'european' | 'bermudan'

/**
 * Settlement timing. For SPX this is not cosmetic:
 *
 *  - 'am' : standard monthly SPX. Trading stops at the Thursday close and it
 *           settles against Friday's opening prints (SET), so there is no
 *           Friday session to observe.
 *  - 'pm' : SPXW weeklies / end-of-month, settled at the 4:00 PM Friday close.
 *
 * A 7-DTE study must branch on this rather than assume a final Friday session.
 */
export type SettlementStyle = 'am' | 'pm'

export interface OptionContract {
  /** Provider ticker for the contract, e.g. "O:SPXW251219C06000000". */
  ticker: string
  /** Underlying root symbol as reported by the provider, e.g. "SPX". */
  underlying: string
  /** Expiration date in ISO calendar form, YYYY-MM-DD (Eastern market date). */
  expirationDate: string
  strike: number
  type: OptionType
  exerciseStyle?: ExerciseStyle
  sharesPerContract?: number
  primaryExchange?: string
  /** Option root encoded in the symbol, e.g. "SPX" or "SPXW". */
  root?: string
  /** Derived from the root where known; undefined when it cannot be determined. */
  settlement?: SettlementStyle
}

/** Filters supported when discovering contracts from a provider. */
export interface ContractQuery {
  underlying: string
  /** Exact expiration date, YYYY-MM-DD. */
  expirationDate?: string
  expirationDateGte?: string
  expirationDateLte?: string
  type?: OptionType
  strike?: number
  strikeGte?: number
  strikeLte?: number
  /** Include contracts that have already expired. Required for historical research. */
  expired?: boolean
  /**
   * Point-in-time view of the reference universe. Important for avoiding
   * look-ahead bias: what contracts existed as of the simulated date.
   */
  asOf?: string
  /** Page size hint. Provider adapters clamp this to their documented maximum. */
  limit?: number
  /** Hard ceiling on total results across all pages; guards runaway pagination. */
  maxResults?: number
}
