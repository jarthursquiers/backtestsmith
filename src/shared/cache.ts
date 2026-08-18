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

/** Verified metadata returned after creating a standalone database backup. */
export interface DatabaseBackupResult {
  path: string
  manifestPath: string
  createdAt: number
  bytes: number
  sha256: string
  optionContracts: number
  optionBars: number
  underlyingBars: number
  coveredOptionDays: number
  optionEarliestDate: string | null
  optionLatestDate: string | null
  underlyingEarliestDate: string | null
  underlyingLatestDate: string | null
  studyRuns: number
  forwardTests: number
  studyEarliestDate: string | null
  studyLatestDate: string | null
  referencedOptionTickers: number
  referencedTickersMissingContracts: number
  referencedTickersMissingBars: number
}
