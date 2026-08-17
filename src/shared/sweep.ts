import type { StudyConfig } from './study.js'
import type { StudyMetrics } from './metrics.js'

/** One dimension of a parameter sweep. */
export interface SweepAxis {
  /** Axis name, e.g. targetDte or profitTarget. */
  name: string
  values: number[]
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
