/** One bin of a histogram. */
export interface HistogramBin {
  from: number
  to: number
  count: number
  /** Fraction of the sample in this bin, 0..1. */
  share: number
}

export interface Histogram {
  bins: HistogramBin[]
  count: number
  min: number
  max: number
}

/** Probability with a confidence interval, so small samples cannot mislead. */
export interface ProbabilityEstimate {
  probability: number
  low: number
  high: number
  count: number
}

/** What became of the trades that reached a given return threshold. */
export interface ConditionalRow {
  threshold: number
  /** Trades that ever reached this threshold. */
  cohortSize: number
  /** Cohort as a fraction of all trades. */
  cohortShare: number
  /** Probability of going on to each higher threshold, keyed by threshold. */
  wentOnTo: Record<string, ProbabilityEstimate>
  /** Fraction whose return went negative after first touching this threshold. */
  fellBackToLoss: number
  fellBackToLossInterval: { low: number; high: number }
  medianEventualMfe: number
  medianFinalReturn: number
  endedProfitable: number
}

export interface ConditionalReport {
  totalTrades: number
  rows: ConditionalRow[]
}

/** Outcomes conditioned on how close the underlying came to the centre. */
export interface TentRow {
  /** Normalized distance band, in wing widths. */
  band: number
  cohortSize: number
  cohortShare: number
  medianMfe: number
  medianFinalReturn: number
  endedProfitable: number
}

export interface TentReport {
  tradesWithUnderlying: number
  /** Excluded for want of underlying data, rather than assumed never to approach. */
  tradesWithoutUnderlying: number
  rows: TentRow[]
}

/** Everything the Results analytics section renders. */
export interface AnalyticsReport {
  strategyId: string
  returnDistribution: Histogram
  mfeDistribution: Histogram
  maeDistribution: Histogram
  captureDistribution: Histogram
  dteAtMfe: Histogram
  conditional: ConditionalReport
  tent: TentReport
  byWeekday: { group: string; count: number; median: number; mean: number }[]
  byMonth: { group: string; count: number; median: number; mean: number }[]
  /** Exit return against maximum favourable excursion, for a scatter plot. */
  exitVsMfe: { mfe: number; exit: number; capture: number | null }[]
}
