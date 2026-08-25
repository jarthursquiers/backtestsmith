import type { TradeResult } from '../shared/trade.js'
import { isCalendarTrade } from '../shared/trade.js'
import type {
  AnalyticsReport,
  ConditionalReport,
  ConditionalRow,
  Histogram,
  HistogramBin,
  TentReport
} from '../shared/analytics.js'
import { median } from './metrics.js'

/**
 * Conditional path analysis.
 *
 * Answers the questions a summary table cannot: given that a butterfly already
 * reached +50%, how often does it go on to +100%, and how often does it hand the
 * gain back and finish a loser? Those conditional probabilities describe what
 * managing the trade is actually worth, which is the point of the whole study.
 *
 * Everything here derives from statistics captured while the path was walked,
 * so no result depends on re-reading bars, and the same numbers hold whichever
 * management rule the trades came from.
 */

/** Wilson score interval, which behaves sensibly at small n and near 0 or 1. */
export function proportionInterval(
  successes: number,
  trials: number,
  z = 1.96
): { low: number; high: number } {
  if (trials === 0) return { low: 0, high: 0 }
  const p = successes / trials
  const denominator = 1 + (z * z) / trials
  const centre = p + (z * z) / (2 * trials)
  const spread = z * Math.sqrt((p * (1 - p) + (z * z) / (4 * trials)) / trials)
  return {
    low: Math.max(0, (centre - spread) / denominator),
    high: Math.min(1, (centre + spread) / denominator)
  }
}

function reached(trade: TradeResult, threshold: number): boolean {
  return trade.firstReached[String(threshold)] != null
}

/**
 * For each threshold, what happened to the trades that got there.
 *
 * A confidence interval accompanies every proportion. With a few hundred trades
 * and conditioning that shrinks the sample further, the difference between 60%
 * and 70% is often not distinguishable, and a bare percentage invites reading
 * more into it than the sample supports.
 */
export function analyzeConditionalPaths(
  trades: readonly TradeResult[],
  thresholds: readonly number[] = [25, 50, 100, 150, 200, 300, 500]
): ConditionalReport {
  const rows: ConditionalRow[] = []

  for (const threshold of thresholds) {
    const cohort = trades.filter((t) => reached(t, threshold))
    if (cohort.length === 0) {
      rows.push({
        threshold,
        cohortSize: 0,
        cohortShare: trades.length > 0 ? 0 : 0,
        wentOnTo: {},
        fellBackToLoss: 0,
        fellBackToLossInterval: { low: 0, high: 0 },
        medianEventualMfe: 0,
        medianFinalReturn: 0,
        endedProfitable: 0
      })
      continue
    }

    const wentOnTo: Record<string, { probability: number; low: number; high: number; count: number }> = {}
    for (const higher of thresholds) {
      if (higher <= threshold) continue
      const count = cohort.filter((t) => reached(t, higher)).length
      const interval = proportionInterval(count, cohort.length)
      wentOnTo[String(higher)] = {
        probability: count / cohort.length,
        low: interval.low,
        high: interval.high,
        count
      }
    }

    // "Fell back to a loss" means the path went negative *after* first touching
    // the threshold, which the final result alone cannot establish.
    const fellBack = cohort.filter((t) => (t.lowestAfterReaching[String(threshold)] ?? 0) < 0).length
    const fellBackInterval = proportionInterval(fellBack, cohort.length)
    const profitable = cohort.filter((t) => t.pnlDollars > 0).length

    rows.push({
      threshold,
      cohortSize: cohort.length,
      cohortShare: trades.length > 0 ? cohort.length / trades.length : 0,
      wentOnTo,
      fellBackToLoss: fellBack / cohort.length,
      fellBackToLossInterval: fellBackInterval,
      medianEventualMfe: median(cohort.map((t) => t.excursions.mfe?.pct ?? 0)),
      medianFinalReturn: median(cohort.map((t) => t.pnlPct)),
      endedProfitable: profitable / cohort.length
    })
  }

  return { totalTrades: trades.length, rows }
}

/**
 * Outcomes conditioned on how close the underlying came to the centre strike.
 *
 * Requires underlying data; trades without it are excluded and counted, rather
 * than silently treated as never having approached the centre.
 */
export function analyzeTentApproach(
  trades: readonly TradeResult[],
  bands: readonly number[] = [1.0, 0.75, 0.5, 0.25, 0]
): TentReport {
  const withDistance = trades.filter((t) => t.minNormalizedDistance !== undefined)

  const rows = bands.map((band) => {
    const cohort = withDistance.filter((t) => (t.minNormalizedDistance ?? Infinity) <= band)
    const profitable = cohort.filter((t) => t.pnlDollars > 0).length
    return {
      band,
      cohortSize: cohort.length,
      cohortShare: withDistance.length > 0 ? cohort.length / withDistance.length : 0,
      medianMfe: median(cohort.map((t) => t.excursions.mfe?.pct ?? 0)),
      medianFinalReturn: median(cohort.map((t) => t.pnlPct)),
      endedProfitable: cohort.length > 0 ? profitable / cohort.length : 0
    }
  })

  return {
    tradesWithUnderlying: withDistance.length,
    tradesWithoutUnderlying: trades.length - withDistance.length,
    rows
  }
}

/**
 * Bins values into a histogram.
 *
 * Edges are chosen from the data unless supplied. Values outside explicit edges
 * are clamped into the end bins rather than dropped, so the counts always sum to
 * the input size.
 */
export function histogram(
  values: readonly number[],
  options: { binCount?: number; min?: number; max?: number } = {}
): Histogram {
  if (values.length === 0) return { bins: [], count: 0, min: 0, max: 0 }

  const binCount = options.binCount ?? 20
  const min = options.min ?? Math.min(...values)
  const max = options.max ?? Math.max(...values)

  if (min === max) {
    return {
      bins: [{ from: min, to: max, count: values.length, share: 1 }],
      count: values.length,
      min,
      max
    }
  }

  const width = (max - min) / binCount
  const counts = new Array<number>(binCount).fill(0)

  for (const value of values) {
    const raw = Math.floor((value - min) / width)
    const index = Math.min(binCount - 1, Math.max(0, raw))
    counts[index]!++
  }

  const bins: HistogramBin[] = counts.map((count, i) => ({
    from: min + i * width,
    to: min + (i + 1) * width,
    count,
    share: count / values.length
  }))

  return { bins, count: values.length, min, max }
}

/** Groups values by a key and reports the median of each group. */
export function medianBy<T>(
  items: readonly T[],
  key: (item: T) => string,
  value: (item: T) => number
): { group: string; count: number; median: number; mean: number }[] {
  const groups = new Map<string, number[]>()
  for (const item of items) {
    const k = key(item)
    const list = groups.get(k)
    if (list) list.push(value(item))
    else groups.set(k, [value(item)])
  }

  return [...groups.entries()]
    .map(([group, values]) => ({
      group,
      count: values.length,
      median: median(values),
      mean: values.reduce((s, v) => s + v, 0) / values.length
    }))
    .sort((a, b) => a.group.localeCompare(b.group))
}

/** Weekday and month labels in Eastern time, for grouped summaries. */
function easternParts(timestamp: number): { weekday: string; month: string } {
  const d = new Date(timestamp)
  const weekdays = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
  // Entry timestamps are session-time instants, so a UTC read of the weekday is
  // safe here: 09:35 ET never crosses a date boundary in UTC.
  return {
    weekday: weekdays[d.getUTCDay()]!,
    month: d.toISOString().slice(0, 7)
  }
}

/**
 * Assembles every aggregate view for one management method.
 *
 * Built in one pass so the charts on screen and the conditional table can never
 * disagree about which trades they describe.
 */
export function buildAnalyticsReport(
  trades: readonly TradeResult[],
  strategyId: string
): AnalyticsReport {
  const cohort = trades.filter((t) => t.strategyId === strategyId)
  const thresholds = cohort.some(isCalendarTrade)
    ? [5, 10, 15, 20, 25, 30, 40, 50, 75, 100]
    : [25, 50, 100, 150, 200, 300, 500]

  return {
    strategyId,
    returnDistribution: histogram(cohort.map((t) => t.pnlPct), { binCount: 24 }),
    mfeDistribution: histogram(cohort.map((t) => t.excursions.mfe?.pct ?? 0), { binCount: 24 }),
    maeDistribution: histogram(cohort.map((t) => t.excursions.mae?.pct ?? 0), { binCount: 24 }),
    captureDistribution: histogram(
      cohort.map((t) => t.mfeCaptureRatio).filter((c): c is number => c !== null),
      { binCount: 20 }
    ),
    dteAtMfe: histogram(cohort.map((t) => t.excursions.mfe?.dte ?? 0), { binCount: 10 }),
    conditional: analyzeConditionalPaths(cohort, thresholds),
    tent: analyzeTentApproach(cohort),
    byWeekday: medianBy(cohort, (t) => easternParts(t.entryTimestamp).weekday, (t) => t.pnlPct),
    byMonth: medianBy(cohort, (t) => easternParts(t.entryTimestamp).month, (t) => t.pnlPct),
    exitVsMfe: cohort.map((t) => ({
      mfe: t.excursions.mfe?.pct ?? 0,
      exit: t.pnlPct,
      capture: t.mfeCaptureRatio
    }))
  }
}
