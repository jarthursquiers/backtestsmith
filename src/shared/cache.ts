/** Local cache telemetry surfaced to the UI. */
export interface CacheStats {
  optionContracts: number
  optionBars: number
  underlyingBars: number
  /** (ticker, date) pairs the provider has been asked about. */
  coveredOptionDays: number
  /** Of those, days confirmed to have had no qualifying trades. */
  emptyOptionDays: number
  distinctOptionTickers: number
  earliestDate: string | null
  latestDate: string | null
  databaseBytes: number
  databasePath: string
}
