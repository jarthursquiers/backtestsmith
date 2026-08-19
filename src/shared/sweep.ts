import type { StudyConfig } from './study.js'
import type { StudyMetrics } from './metrics.js'

/** One dimension of a parameter sweep. */
export interface SweepAxis {
  /** Axis name, e.g. targetDte or profitTarget. */
  name: string
  values: number[]
}

/** Inclusive numeric range entered through the sweep UI. */
export interface SweepRange {
  start: number
  end: number
  increment: number
}

/**
 * Expands an inclusive range without accumulating floating-point noise.
 *
 * The end is included only when the increment lands on it. For example,
 * 3..10 by 2 produces 3,5,7,9. A hard cap prevents an accidental tiny
 * increment from freezing the renderer or queuing an unbounded sweep.
 */
export function valuesFromRange(range: SweepRange, maximumValues = 10_000): number[] {
  const { start, end, increment } = range
  if (![start, end, increment].every(Number.isFinite)) {
    throw new Error('Range start, end, and increment must be numbers.')
  }
  if (increment <= 0) throw new Error('Range increment must be greater than zero.')
  if (end < start) throw new Error('Range end must be greater than or equal to its start.')

  const count = Math.floor((end - start) / increment + 1e-9) + 1
  if (count > maximumValues) {
    throw new Error(`Range produces ${count} values; the maximum is ${maximumValues}.`)
  }

  return Array.from({ length: count }, (_, index) =>
    Number((start + index * increment).toFixed(6))
  )
}

/** One configuration produced by expanding the sweep. */
export interface SweepPoint {
  index: number
  /** The axis values that produced this point. */
  values: Record<string, number>
  config: StudyConfig
}

/** Result for one point of a completed sweep. */
export interface SweepResult {
  index: number
  values: Record<string, number>
  runId: string
  entryCount: number
  /** Best management method at this point, by the chosen objective. */
  best: { strategyId: string; strategyLabel: string; metrics: StudyMetrics } | null
  /** Every method's metrics, so the table can be re-sorted without re-running. */
  all: { strategyId: string; strategyLabel: string; metrics: StudyMetrics }[]
}
