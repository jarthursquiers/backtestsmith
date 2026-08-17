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
  /** Option underlying root, e.g. SPX. Used for chain lookups. */
  underlying: string
  /**
   * Ticker the *index bars* are cached under, e.g. I:SPX.
   *
   * Separate from `underlying` because they genuinely differ: option chains are
   * keyed by root while index history uses the `I:` prefix. Conflating them made
   * a study look for SPX bars that were stored as I:SPX and skip every session.
   * Defaults via `resolveIndexTicker`.
   */
  indexTicker?: string
  from: string
  to: string
  /** Eastern wall-clock entry time, HH:mm. */
  entryTime: string
  /**
   * Minutes after `entryTime` in which a fill may occur.
   *
   * The index level and the expected move both need option prints, and demanding
   * them in one exact minute discards sessions whose prints land moments later -
   * on sparse data, most of them. A trader entering "around 9:35" would have
   * filled anyway, so the window is honest as well as far more productive. The
   * minute actually used is recorded as the entry timestamp. Zero restores
   * single-minute behaviour.
   */
  entryWindowMinutes?: number

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
  phase: 'preparing' | 'preflight' | 'entries' | 'saving' | 'done' | 'cancelled' | 'failed'
  completed: number
  total: number
  currentDate?: string
  /** What the runner is doing right now, e.g. "fetching legs". */
  stage?: string
  /** Entries accepted so far. */
  tradesGenerated: number
  skipped: number
  /**
   * Live tally of why sessions were skipped, grouped by normalized reason.
   *
   * Surfaced during the run rather than after it: a study that skips everything
   * should be obvious in the first few seconds, not an hour later.
   */
  skipReasons?: Record<string, number>
  /** Most recent raw skip records, including data-quality evidence. */
  recentSkips?: SkippedEntry[]
  elapsedMs?: number
  estimatedRemainingMs?: number
  /** Upstream requests spent so far, so rate-limit waiting is visible. */
  apiRequests?: number
  /** Set when the run failed outright. */
  error?: string
}

/** Whether a study can produce anything, checked before it runs. */
export interface StudyPreflight {
  sessions: number
  dailyBars: number
  /** Sessions sampled from the start of the range that have intraday data. */
  underlyingMinuteSessions: number
  /** Blocking problems: the run would produce nothing. */
  blockers: string[]
  /** Non-blocking concerns worth knowing before committing an hour. */
  warnings: string[]
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

/**
 * Collapses a skip reason to a stable category for grouping.
 *
 * Reasons embed specifics - dates, strikes, percentages - which would make every
 * skip its own group and obscure that fifty sessions failed for one shared
 * cause. Stripping the specifics is what turns a list into a diagnosis.
 *
 * Lives in shared because both the runner (which tallies live) and the results
 * screen (which groups a stored run) must agree on the categories.
 */
export function normalizeSkipReason(reason: string): string {
  if (reason.startsWith('data quality ')) return 'option data quality below threshold'
  if (reason.startsWith('expected move unavailable:')) return 'expected move could not be measured'
  return reason
    .replace(/\d{4}-\d{2}-\d{2}/g, 'DATE')
    .replace(/\d+(\.\d+)?%/g, 'N%')
    .replace(/\b\d+(\.\d+)?\b/g, 'N')
    .trim()
}

/**
 * The ticker index bars are stored under for a study.
 *
 * Defaults to the `I:` convention used by every download path, so a config that
 * omits it still finds the data rather than silently matching nothing.
 */
export function resolveIndexTicker(config: Pick<StudyConfig, 'underlying' | 'indexTicker'>): string {
  if (config.indexTicker && config.indexTicker.trim()) return config.indexTicker.trim().toUpperCase()
  const root = config.underlying.trim().toUpperCase()
  return root.startsWith('I:') ? root : `I:${root}`
}
