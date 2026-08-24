import { randomBytes } from 'node:crypto'
import { computeMetrics } from '../../backtest/metrics.js'
import {
  runDoubleCalendarStudy,
  entrySessions,
  type CalendarDataSource,
  type DoubleCalendarStudyConfig
} from '../../backtest/calendarStudy.js'
import { DEFAULT_CALENDAR_EXECUTION } from '../../domain/doubleCalendar.js'
import type { MarketDataStore } from '../../database/marketDataStore.js'
import { tradingDaysBetween, type MarketDate } from '../../core/time/marketTime.js'
import {
  resolveIndexTicker,
  type CalendarConfig,
  type ManagementSummary,
  type StudyConfig,
  type StudyPreflight,
  type StudyProgress,
  type StudyRunResult
} from '../../shared/study.js'

/**
 * Running a double calendar study from the application.
 *
 * A separate module from `ipc.ts` rather than another branch inside its study
 * handler, which is already long. What it does is narrower than the butterfly
 * path in one important way: it never touches the provider.
 *
 * The butterfly runner prepares data first, fetching whatever the cache lacks.
 * A calendar study cannot work that way. It needs a whole option chain at the
 * entry minute to find a delta, and four contracts across every session of
 * their lives - which for a year of weekly entries is tens of thousands of
 * contract-days. At the provider's rate limit that is days of requests, so the
 * archive is a precondition rather than something to top up, and a gap in it is
 * reported as a blocker instead of quietly triggering an enormous download.
 */

export interface CalendarStudyRunHooks {
  signal?: AbortSignal
  onProgress?: (progress: StudyProgress) => void
  onSkip?: (skip: { date: string; reason: string }) => void
}

/** The calendar parameters, with defaults for a config that predates a field. */
function calendarConfig(config: StudyConfig): CalendarConfig {
  const calendar = config.calendar
  if (!calendar) {
    throw new Error('This study is configured as a double calendar but carries no calendar settings.')
  }
  return calendar
}

/** Translates the stored configuration into the engine's own shape. */
export function toCalendarStudyConfig(config: StudyConfig): DoubleCalendarStudyConfig {
  const calendar = calendarConfig(config)
  return {
    underlying: config.underlying,
    root: calendar.root,
    from: config.from,
    to: config.to,
    entryWeekdays: calendar.entryWeekdays,
    entryTime: config.entryTime,
    entryWindowMinutes: config.entryWindowMinutes ?? 30,
    frontTargetDte: calendar.frontTargetDte,
    backTargetDte: calendar.backTargetDte,
    maxDteDeviation: calendar.maxDteDeviation,
    targetDelta: calendar.targetDelta,
    horizonTime: calendar.horizonTime,
    quantity: config.quantity,
    execution: {
      spreadFraction: calendar.spreadFraction,
      commissionPerContract: calendar.commissionPerContract,
      missingData:
        config.pricing.missingDataMode === 'strict'
          ? { mode: 'strict' }
          : { mode: 'carryForward', maxStaleMinutes: config.pricing.maxStaleMinutes }
    },
    minimumCoverage: config.minimumCoverage,
    managements: config.managements
  }
}

/**
 * A data source backed entirely by the local archive.
 *
 * Per-session lookups are memoized for the life of one run: weekly entries with
 * a two-week horizon overlap by about ten sessions, so the index minutes for
 * each session would otherwise be read once per overlapping trade.
 */
export function calendarSourceFromStore(store: MarketDataStore, carryMinutes: number): CalendarDataSource {
  const expirations = new Map<string, Promise<MarketDate[]>>()
  const underlying = new Map<string, Promise<Awaited<ReturnType<MarketDataStore['getUnderlyingBars']>>>>()

  return {
    listExpirations: (root, onDate) => {
      const key = `${root}|${onDate}`
      let pending = expirations.get(key)
      if (!pending) {
        pending = store.listArchivedExpirations(root, onDate)
        expirations.set(key, pending)
      }
      return pending
    },
    chainSnapshot: (root, expiration, onDate, minute) =>
      store.chainSnapshot(root, expiration, onDate, minute, carryMinutes),
    getOptionBars: (tickers, from, to) => store.getOptionBarsForTickers(tickers, from, to),
    getUnderlyingMinutes: (ticker, date) => {
      const key = `${ticker}|${date}`
      let pending = underlying.get(key)
      if (!pending) {
        pending = store.getUnderlyingBars(ticker, [date])
        underlying.set(key, pending)
      }
      return pending
    }
  }
}

/**
 * Whether a calendar study can produce anything, before it runs.
 *
 * Samples the front of the range rather than checking every session: the
 * question is whether the archive holds whole chains and index minutes at all,
 * not exactly how many. A study that would skip every session should say so in
 * seconds.
 */
export async function preflightCalendarStudy(
  config: StudyConfig,
  store: MarketDataStore
): Promise<StudyPreflight> {
  const calendar = config.calendar
  const blockers: string[] = []
  const warnings: string[] = []
  const indexTicker = resolveIndexTicker(config)

  if (!calendar) {
    return {
      sessions: 0,
      dailyBars: 0,
      underlyingMinuteSessions: 0,
      blockers: ['This study is configured as a double calendar but carries no calendar settings.'],
      warnings: []
    }
  }

  const sessions = entrySessions(toCalendarStudyConfig(config))
  const sampled = sessions.slice(0, 10)

  let sessionsWithChains = 0
  let sessionsWithIndex = 0
  for (const date of sampled) {
    const [expirations, index] = await Promise.all([
      store.listArchivedExpirations(calendar.root, date),
      store.getUnderlyingBars(indexTicker, [date])
    ])
    if (expirations.length > 0) sessionsWithChains++
    if (index.length > 0) sessionsWithIndex++
  }

  if (sessions.length === 0) {
    blockers.push(`No trading days between ${config.from} and ${config.to} match the entry schedule.`)
  }
  if (calendar.backTargetDte <= calendar.frontTargetDte) {
    blockers.push('The long expiration must be later than the short one.')
  }
  if (sampled.length > 0 && sessionsWithChains === 0) {
    blockers.push(
      `No ${calendar.root} option chains are cached for the first ${sampled.length} sessions of the ` +
        'range. A double calendar study reads whole chains from the local archive and never fetches ' +
        'them, because doing so would be tens of thousands of requests. Import the option archive for ' +
        'this period first.'
    )
  } else if (sessionsWithChains < sampled.length) {
    warnings.push(
      `${sampled.length - sessionsWithChains} of the first ${sampled.length} sessions have no cached ` +
        `${calendar.root} chain and will be skipped.`
    )
  }
  if (sampled.length > 0 && sessionsWithIndex === 0) {
    blockers.push(
      `No intraday ${indexTicker} history is cached. The index level anchors the strike search at ` +
        'entry and drives every strike-breach rule, so a calendar study cannot run without it.'
    )
  } else if (sessionsWithIndex < sampled.length) {
    warnings.push(
      `${sampled.length - sessionsWithIndex} of the first ${sampled.length} sessions have no intraday ` +
        `${indexTicker} bars and will be skipped.`
    )
  }

  return {
    sessions: sessions.length,
    // A calendar study reads no daily history at all; reporting the count of
    // cached index sessions keeps the field meaningful rather than zero.
    dailyBars: sessionsWithIndex,
    underlyingMinuteSessions: sessionsWithIndex,
    blockers,
    warnings
  }
}

/** Runs a calendar study and shapes it into the same result every screen reads. */
export async function runCalendarStudyForConfig(
  config: StudyConfig,
  store: MarketDataStore,
  appVersion: string,
  gitCommit: string | undefined,
  hooks: CalendarStudyRunHooks = {}
): Promise<StudyRunResult> {
  const studyConfig = toCalendarStudyConfig(config)
  const source = calendarSourceFromStore(store, config.pricing.maxStaleMinutes)
  const startedAt = Date.now()

  const outcome = await runDoubleCalendarStudy(studyConfig, source, {
    ...(hooks.signal ? { signal: hooks.signal } : {}),
    onProgress: ({ completed, total, date, entries }) => {
      const elapsedMs = Date.now() - startedAt
      hooks.onProgress?.({
        phase: 'entries',
        completed,
        total,
        currentDate: date,
        stage: 'reconstructing',
        tradesGenerated: entries,
        skipped: 0,
        elapsedMs,
        ...(completed > 0 ? { estimatedRemainingMs: (elapsedMs / completed) * (total - completed) } : {})
      })
    }
  })

  for (const skip of outcome.skipped) hooks.onSkip?.(skip)

  const summaries: ManagementSummary[] = config.managements.map((id) => {
    const trades = outcome.trades.filter((t) => t.strategyId === id)
    return {
      strategyId: id,
      strategyLabel: trades[0]?.strategyLabel ?? id,
      metrics: computeMetrics(trades)
    }
  })

  return {
    runId: randomBytes(8).toString('hex'),
    createdAt: Date.now(),
    config,
    entryCount: outcome.series.length,
    entriesAttempted: outcome.sessionsConsidered,
    skipped: outcome.skipped,
    summaries,
    trades: outcome.trades,
    sizing: 'oneContract',
    appVersion,
    ...(gitCommit ? { gitCommit } : {})
  }
}

/** Trading sessions the entry schedule would consider, for a dry description. */
export function calendarSessionCount(config: StudyConfig): number {
  if (!config.calendar) return 0
  return config.calendar.entryWeekdays.length === 0
    ? tradingDaysBetween(config.from, config.to).length
    : entrySessions(toCalendarStudyConfig(config)).length
}

export { DEFAULT_CALENDAR_EXECUTION }
