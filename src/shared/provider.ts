/**
 * Provider DTOs that cross the IPC boundary.
 *
 * The `OptionsHistoricalDataProvider` interface itself stays in `src/data`,
 * because only the main process implements or calls it. These result shapes are
 * shared so the renderer can render them without importing engine modules.
 */

export interface ProviderStatus {
  ok: boolean
  providerId: string
  /** Short human-readable state for the UI, e.g. "Connected". */
  message: string
  /** Round-trip time of the probe request, when one was made. */
  latencyMs?: number
  checkedAt: number
}

/**
 * Result of a bar request, carrying enough context that callers can distinguish
 * "no qualifying trades occurred" from "we never asked".
 *
 * This distinction is load-bearing: Massive minute aggregates are trade-derived,
 * so an absent bar means unobserved, never a price of zero.
 */
export interface BarFetchResult<T> {
  ticker: string
  bars: T[]
  requestedFrom: string
  requestedTo: string
  /** True when the provider explicitly returned no bars for the range. */
  empty: boolean
  /** When this data was retrieved, for provenance and reproducibility records. */
  fetchedAt: number
  /** Provider-reported result count, when supplied. */
  reportedCount?: number
}
