/**
 * OHLCV aggregate bar for a single option contract.
 *
 * IMPORTANT: Massive minute aggregates are trade-derived. A minute with no
 * qualifying trade produces NO bar at all. An absent bar therefore means
 * "unobserved", never "price was zero". Consumers must handle absence
 * explicitly rather than defaulting to 0.
 */
export interface OptionBar {
  ticker: string
  /** Unix epoch milliseconds, UTC. Start of the aggregation window. */
  timestamp: number
  open: number
  high: number
  low: number
  close: number
  volume: number
  vwap?: number
  transactions?: number
  /** NBBO fields when the source is a quote feed rather than trade aggregates. */
  bid?: number
  ask?: number
  bidSize?: number
  askSize?: number
}

/** OHLCV aggregate bar for an underlying instrument or index (e.g. I:SPX). */
export interface UnderlyingBar {
  ticker: string
  /** Unix epoch milliseconds, UTC. Start of the aggregation window. */
  timestamp: number
  open: number
  high: number
  low: number
  close: number
  /** Index feeds frequently report no volume; undefined means "not reported". */
  volume?: number
  vwap?: number
  transactions?: number
}

export type BarTimespan = 'minute' | 'hour' | 'day' | 'week' | 'month'

export interface BarQuery {
  ticker: string
  /** Inclusive start date, YYYY-MM-DD, interpreted by the provider in Eastern time. */
  from: string
  /** Inclusive end date, YYYY-MM-DD. */
  to: string
  multiplier?: number
  timespan?: BarTimespan
  /** Provider adapters clamp to their documented maximum. */
  limit?: number
}
