/** Error statistics for one group of parity samples. */
export interface ParityErrorStats {
  count: number
  /** Mean signed error, in index points. Positive means parity ran high. */
  bias: number
  rms: number
  medianAbs: number
  p95Abs: number
  maxAbs: number
}

export interface ParityErrorBucket extends ParityErrorStats {
  /** Staleness band, e.g. "same minute" or "2-5 min stale". */
  label: string
}

export interface ParityAccuracyReport {
  sampleCount: number
  /** Regular-session minutes in the window that could have been compared. */
  expectedMinutes: number
  coverage: number
  /** Error using the assumed carry rate. */
  raw: ParityErrorStats
  /** Error after fitting the carry rate to the data. Null when unfittable. */
  calibrated: ParityErrorStats | null
  /** Annualized r - q implied by the samples. */
  fittedCarryRate: number | null
  buckets: ParityErrorBucket[]
  method: 'regression' | 'singleStrike'
}

export interface ParityValidationRequest {
  underlying: string
  /** Expiration whose chain supplies the call/put pairs. */
  expiration: string
  /** Inclusive range of sessions to validate against real index data. */
  from: string
  to: string
  /** Strikes either side of the money to include. 1 uses a single pair. */
  strikesPerSide: number
  /** Root disambiguation, e.g. SPXW. */
  preferredRoot?: string
  maxStaleMinutes: number
}

export interface ParityValidationResponse {
  report: ParityAccuracyReport
  /** Sessions that contributed samples. */
  sessionsUsed: string[]
  /** Sessions skipped, with the reason. */
  skipped: { date: string; reason: string }[]
  strikesRequested: number[]
  apiRequests: number
}
