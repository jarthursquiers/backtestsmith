import type { BarQuery, OptionBar, UnderlyingBar } from '../domain/bars.js'
import type { ContractQuery, OptionContract } from '../domain/contracts.js'
import type { BarFetchResult, ProviderStatus } from '../shared/provider.js'

/**
 * The seam between the research engine and any historical data vendor.
 *
 * Massive is the first implementation, but nothing above this interface may
 * import vendor modules or know vendor field names. Swapping in a second
 * provider (or a CSV importer) must require no changes to the backtest engine.
 */

export type { ProviderStatus, BarFetchResult } from '../shared/provider.js'

export interface FetchOptions {
  signal?: AbortSignal
  /** Lower dispatches sooner; used to keep interactive requests ahead of bulk downloads. */
  priority?: number
  label?: string
}

/**
 * Underlying/index history only.
 *
 * Split out because the two capabilities are separately entitled in practice:
 * Massive's Options plans serve option data but return HTTP 403 for `I:SPX`,
 * while a broker feed may serve the index and no option history at all. Keeping
 * them separate lets SPX come from one source and options from another.
 */
export interface UnderlyingHistoricalDataProvider {
  readonly id: string
  readonly name: string

  /** Cheap probe used by the UI to validate credentials and connectivity. */
  testConnection(options?: FetchOptions): Promise<ProviderStatus>

  /** Historical aggregate bars for an underlying or index. */
  getUnderlyingBars(query: BarQuery, options?: FetchOptions): Promise<BarFetchResult<UnderlyingBar>>
}

export interface OptionsHistoricalDataProvider extends UnderlyingHistoricalDataProvider {
  /** Discovers option contracts, including expired ones, with pagination handled internally. */
  getContracts(query: ContractQuery, options?: FetchOptions): Promise<OptionContract[]>

  /** Historical aggregate bars for a single option contract. */
  getOptionBars(query: BarQuery, options?: FetchOptions): Promise<BarFetchResult<OptionBar>>
}

/** Optional capability used by composite providers to keep cache provenance exact. */
export interface ProviderSources {
  sourceId(capability: 'contracts' | 'option' | 'underlying'): string
}
