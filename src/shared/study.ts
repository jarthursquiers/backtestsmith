import type { LegPricingModel } from '../domain/butterfly.js'
import type { PositionSizing, StudyMetrics } from './metrics.js'
import type { TradeResult } from './trade.js'

/** How a target DTE resolves against the expirations that actually exist. */
export type ExpirationRule =
  /** Closest to the target in either direction; ties go to the longer-dated. */
  | 'nearest'
  /** Closest expiration at or beyond the target. */
  | 'preferGte'
  /** Closest expiration at or before the target. */
  | 'preferLte'

/** Entry signal configuration. */
export type EntryConfig =
  | { type: 'ema'; period: number; invert?: boolean; minimumDistance?: number }
  | { type: 'fixed'; direction: 'bullish' | 'bearish' }

/** Where the butterfly is centred. */
export type PlacementConfig =
  | { type: 'fixedDistance'; offsetPoints: number }
  | { type: 'wingWidths'; wingsAway: number }
  | { type: 'expectedMove'; buffer?: number }

/**
 * A complete, reproducible study definition.
 *
 * Stored verbatim with every run, so a result can always be traced back to the
 * exact assumptions that produced it.
 */
export interface StudyConfig {
  underlying: string
  from: string
  to: string
  /** Eastern wall-clock entry time, HH:mm. */
  entryTime: string

  entry: EntryConfig
  targetDte: number
  expirationRule: ExpirationRule
  maxDeviation?: number
  /** Disambiguates SPX from SPXW where both list a strike. */
  preferredRoot?: string

  placement: PlacementConfig
  wingWidth: number
  quantity: number

  pricing: {
    model: LegPricingModel
    slippage: number
    missingDataMode: 'strict' | 'carryForward'
    maxStaleMinutes: number
  }

  /** Minimum data coverage a trade must have to be included, 0..1. */
  minimumCoverage: number
  /** Management method ids applied to every entry. */
  managements: string[]
}

export interface SkippedEntry {
  date: string
  reason: string
}

export interface StudyProgress {
  phase: 'entries' | 'metrics' | 'done'
  completed: number
  total: number
  currentDate?: string
  tradesGenerated: number
  skipped: number
}

/** Metrics for one management method within a run. */
export interface ManagementSummary {
  strategyId: string
  strategyLabel: string
  metrics: StudyMetrics
}

/** A stored run, without its trades. */
export interface StudyRunSummary {
  runId: string
  createdAt: number
  label: string | null
  config: StudyConfig
  entryCount: number
  entriesAttempted: number
  tradeCount: number
}

export interface StudyRunResult {
  runId: string
  createdAt: number
  config: StudyConfig
  /** Distinct entries generated, before management is applied. */
  entryCount: number
  entriesAttempted: number
  skipped: SkippedEntry[]
  summaries: ManagementSummary[]
  /** All trades, for export and the inspector. */
  trades: TradeResult[]
  sizing: PositionSizing
  /** Application version and commit, for reproducibility. */
  appVersion: string
  gitCommit?: string
}
