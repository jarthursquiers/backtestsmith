/**
 * Excursion DTOs that cross the IPC boundary.
 *
 * The computation lives in `src/backtest`; only these shapes are shared, so the
 * renderer never imports an engine module.
 */
export interface Excursion {
  /** Peak unrealized P/L in dollars. */
  dollars: number
  /** Peak unrealized return, percent of the entry debit. */
  pct: number
  timestamp: number
  minutesSinceEntry: number
  dte: number
  underlyingPrice?: number
  normalizedDistanceToCenter?: number
}

export interface Excursions {
  /** Best point reached. Null only when there are no observations. */
  mfe: Excursion | null
  /** Worst point reached. */
  mae: Excursion | null
}
