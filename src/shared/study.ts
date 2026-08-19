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
  | {
      type: 'ema'
      period: number
      invert?: boolean
      minimumDistance?: number
      /** Previous-close EMA direction with a symmetric two-candle reversal override. */
      meanReversionOverride?: boolean
    }
  | { type: 'fixed'; direction: 'bullish' | 'bearish' }
  | {
      /**
       * Opening range breakout. Both the direction and the entry minute come
       * from the first confirmation candle to close outside the range, so this
       * entry ignores `entryTime` beyond using it as a nominal display value.
       */
      type: 'orb'
      openingRangeMinutes: number
      confirmationMinutes: number
      /** Latest Eastern wall-clock time a breakout may be confirmed, HH:mm. */
      cutoffTime: string
      /** Trades against the breakout rather than with it. */
      invert?: boolean
    }

/**
 * How an expected-move placement snaps to listed strikes.
 *
 * The two are genuinely different structures. `nearestCenter` rounds the centre
 * to the closest strike, which can leave the near wing a few points inside the
 * expected move. `nearWingOutside` snaps the near wing itself to the first
 * listed strike at or beyond the expected move, so the wing is never inside it -
 * which is what "the near wing just touches the expected move line" means.
 */
export type ExpectedMoveAnchor = 'nearestCenter' | 'nearWingOutside'

/**
 * One band of a volatility-scaled wing width.
 *
 * `below` is the exclusive upper bound of the band. The final band omits it and
 * is open-ended, so every possible reading lands in exactly one band and there
 * is no gauge level the rule has no answer for.
 */
export interface WingWidthBand {
  below?: number
  wingWidth: number
}

/**
 * How a study decides how wide each butterfly is.
 *
 * A fixed width is one decision applied to every market. Scaling by a
 * volatility gauge makes the structure's risk proportional to how much room the
 * market is pricing - which is a different trade, not a tuned version of the
 * same one, so it is expressed as a rule rather than as a swept parameter.
 */
export type WingWidthConfig =
  | { type: 'fixed' }
  | {
      type: 'volatilityBands'
      /**
       * Ticker the gauge is cached under, e.g. I:VIX.
       *
       * Explicit rather than derived, because the cache is keyed by whatever
       * name the data was imported under and guessing wrong would skip every
       * session for a reason that looks like missing history.
       */
      ticker: string
      /** Ascending by `below`; the last band must be open-ended. */
      bands: WingWidthBand[]
    }

/** Human description of a band list, e.g. "20 under 17, 30 17-32, 45 at 32+". */
export function describeBands(bands: readonly WingWidthBand[]): string {
  return bands
    .map((band, index) => {
      const lower = index === 0 ? null : (bands[index - 1]?.below ?? null)
      if (band.below === undefined) return `${band.wingWidth} at ${lower}+`
      if (lower === null) return `${band.wingWidth} under ${band.below}`
      return `${band.wingWidth} ${lower}-${band.below}`
    })
    .join(', ')
}

/** How wide a study's structures are, naming the rule when the width varies. */
export function describeWingWidth(config: Pick<StudyConfig, 'wingWidth' | 'wingWidthRule'>): string {
  const rule = config.wingWidthRule
  if (!rule || rule.type === 'fixed') return `${config.wingWidth}-wide`
  return `${rule.ticker}-scaled (${describeBands(rule.bands)})`
}

/** Where the butterfly is centred. */
export type PlacementConfig =
  | { type: 'fixedDistance'; offsetPoints: number }
  | { type: 'wingWidths'; wingsAway: number }
  | { type: 'expectedMove'; buffer?: number; anchor?: ExpectedMoveAnchor }

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
  /**
   * Weekdays (1 = Monday .. 5 = Friday) that may list an expiration.
   *
   * SPX weeklies were Monday/Wednesday/Friday for most of the history this app
   * studies, and probing every weekday costs a chain request per day per
   * session. Daily-expiry studies need the full week, so the set is explicit
   * rather than assumed. Defaults via `resolveExpirationWeekdays`.
   */
  expirationWeekdays?: number[]
  /** Disambiguates SPX from SPXW where both list a strike. */
  preferredRoot?: string

  placement: PlacementConfig
  /**
   * Wing width in underlying points.
   *
   * Used directly when `wingWidthRule` is absent or fixed, and as the recorded
   * nominal width otherwise. The width each trade was actually built with is
   * always recoverable from its own definition.
   */
  wingWidth: number
  /** Optional rule that resolves the wing width per entry. Fixed when absent. */
  wingWidthRule?: WingWidthConfig
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

  /** Refuse every provider fallback and prove that this run is fully reproducible offline. */
  offlineOnly?: boolean

  /**
   * The named strategy this configuration was generated from, when one was.
   *
   * Provenance only: the engine reads the resolved fields above, never this. It
   * exists so a stored run can say which strategy produced it and reopen with
   * the same form filled in, rather than leaving a reader to infer the intent
   * from a scattering of numbers.
   */
  strategyId?: string
  /** The parameter values the named strategy was built from. */
  strategyParams?: Record<string, string | number | boolean>
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
  if (reason.startsWith('invalid butterfly entry')) return 'invalid butterfly entry price'
  if (reason.startsWith('expected move unavailable:')) return 'expected move could not be measured'
  return reason
    .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z/g, 'TIMESTAMP')
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

/**
 * The volatility gauge a study needs cached, if any.
 *
 * Returned separately from the index ticker because preparation, preflight, and
 * the runner all need to know about it, and each deriving it from the placement
 * rule independently is how the three end up disagreeing.
 */
export function resolveGaugeTicker(config: Pick<StudyConfig, 'wingWidthRule'>): string | null {
  const rule = config.wingWidthRule
  if (!rule || rule.type !== 'volatilityBands') return null
  const ticker = rule.ticker.trim().toUpperCase()
  return ticker === '' ? null : ticker
}

/** True when a study trades the session it enters on. */
export function isZeroDteStudy(config: Pick<StudyConfig, 'targetDte'>): boolean {
  return config.targetDte === 0
}

/**
 * Weekdays worth probing for a listed expiration.
 *
 * A 0DTE study must consider every weekday, since the expiration it needs is
 * whichever day it happens to be. Longer-dated studies keep the historic
 * Monday/Wednesday/Friday set, which is three chain requests per session
 * instead of five.
 */
export function resolveExpirationWeekdays(
  config: Pick<StudyConfig, 'targetDte' | 'expirationWeekdays'>
): number[] {
  if (config.expirationWeekdays && config.expirationWeekdays.length > 0) {
    return [...config.expirationWeekdays]
  }
  return isZeroDteStudy(config) ? [1, 2, 3, 4, 5] : [1, 3, 5]
}
