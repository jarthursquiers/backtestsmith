import type { UnderlyingBar } from '../domain/bars.js'
import type { ParityAccuracyReport, ParityErrorBucket } from '../shared/parity.js'
import { fitCarryRate, type ParityEstimate } from './putCallParity.js'

/**
 * Measures how closely parity-derived index levels track real ones.
 *
 * The point is to replace an argument with a measurement. Parity is cheap and
 * uses data already owned, but its accuracy depends on inputs that are hard to
 * reason about in the abstract - bid-ask placement, and above all how far apart
 * in time the two legs actually printed. Comparing against a real index series
 * over the same minutes answers it directly.
 */

export interface ParitySample {
  timestamp: number
  estimate: ParityEstimate
  /** Real index level for the same minute. */
  actual: number
  yearsToExpiry: number
}

/** Staleness buckets, chosen because error is expected to scale with them. */
const AGE_BUCKETS: { label: string; maxAgeMs: number }[] = [
  { label: 'same minute', maxAgeMs: 0 },
  { label: '1 min stale', maxAgeMs: 60_000 },
  { label: '2-5 min stale', maxAgeMs: 5 * 60_000 },
  { label: '> 5 min stale', maxAgeMs: Number.POSITIVE_INFINITY }
]

function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return 0
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))
  return sorted[index]!
}

function summarize(errors: readonly number[]): {
  count: number
  bias: number
  rms: number
  medianAbs: number
  p95Abs: number
  maxAbs: number
} {
  if (errors.length === 0) {
    return { count: 0, bias: 0, rms: 0, medianAbs: 0, p95Abs: 0, maxAbs: 0 }
  }
  const bias = errors.reduce((s, e) => s + e, 0) / errors.length
  const rms = Math.sqrt(errors.reduce((s, e) => s + e * e, 0) / errors.length)
  const abs = errors.map(Math.abs).sort((a, b) => a - b)
  return {
    count: errors.length,
    bias,
    rms,
    medianAbs: percentile(abs, 50),
    p95Abs: percentile(abs, 95),
    maxAbs: abs[abs.length - 1]!
  }
}

/**
 * Builds the accuracy report.
 *
 * Two errors are reported per sample. The *raw* error uses whatever carry the
 * estimates were built with; the *calibrated* error re-derives the carry from
 * the samples themselves and re-applies it. The difference separates a fixable
 * systematic bias from irreducible noise, which is the distinction that decides
 * whether parity is usable.
 */
export function buildParityReport(
  samples: readonly ParitySample[],
  expectedMinutes: number
): ParityAccuracyReport {
  const rawErrors: number[] = []
  const byBucket = new Map<string, number[]>()

  for (const sample of samples) {
    const error = sample.estimate.spot - sample.actual
    rawErrors.push(error)

    const bucket =
      AGE_BUCKETS.find((b) => sample.estimate.maxAgeMs <= b.maxAgeMs) ?? AGE_BUCKETS[AGE_BUCKETS.length - 1]!
    const list = byBucket.get(bucket.label)
    if (list) list.push(error)
    else byBucket.set(bucket.label, [error])
  }

  // Calibrate carry from the forwards against the known spots, then re-measure.
  const carry = fitCarryRate(
    samples.map((s) => ({ forward: s.estimate.forward, spot: s.actual, yearsToExpiry: s.yearsToExpiry }))
  )

  const calibratedErrors = carry
    ? samples.map(
        (s) => s.estimate.forward * Math.exp(-carry.carryRate * s.yearsToExpiry) - s.actual
      )
    : []

  const buckets: ParityErrorBucket[] = AGE_BUCKETS.filter((b) => byBucket.has(b.label)).map((b) => ({
    label: b.label,
    ...summarize(byBucket.get(b.label)!)
  }))

  return {
    sampleCount: samples.length,
    expectedMinutes,
    coverage: expectedMinutes > 0 ? samples.length / expectedMinutes : 0,
    raw: summarize(rawErrors),
    calibrated: carry ? summarize(calibratedErrors) : null,
    fittedCarryRate: carry?.carryRate ?? null,
    buckets,
    // A single strike cannot separate the discount factor; note which was used.
    method: samples[0]?.estimate.method ?? 'singleStrike'
  }
}

/** Indexes real index bars by minute for comparison. */
export function indexUnderlyingByMinute(bars: readonly UnderlyingBar[]): Map<number, number> {
  const index = new Map<number, number>()
  for (const bar of bars) {
    index.set(Math.floor(bar.timestamp / 60_000) * 60_000, bar.close)
  }
  return index
}
