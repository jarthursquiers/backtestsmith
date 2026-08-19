import { resolveGaugeTicker, type StudyConfig } from '../shared/study.js'
import type { OptionsHistoricalDataProvider } from '../data/provider.js'
import {
  marketDateOf,
  sessionMinuteCount,
  tradingDaysBetween,
  type MarketDate
} from '../core/time/marketTime.js'
import { createLogger } from '../services/logger.js'

const log = createLogger('study.prepare')
const SESSIONS_PER_REQUEST = 21
const MIN_COMPLETE_RATIO = 0.95

export interface StudyPreparationPlan {
  indexTicker: string
  /**
   * Volatility gauge the wing width is banded on, when there is one.
   *
   * Prepared alongside the index because the runner reads it once per session:
   * without a bulk fill first, a year-long study would make one request per day
   * for it, which is the difference between a warm run and an afternoon.
   */
  gaugeTicker: string | null
  dailyFrom: MarketDate
  dailyTo: MarketDate
  minuteChunks: { from: MarketDate; to: MarketDate; dates: MarketDate[] }[]
}

export interface StudyPreparationProgress {
  completed: number
  total: number
  stage: string
  currentDate?: MarketDate
}

export interface StudyPreparationResult {
  dailyBars: number
  minuteBars: number
  minuteSessions: number
  incompleteMinuteSessions: { date: MarketDate; actual: number; expected: number }[]
  /** Gauge bars cached for a banded-width study; zero when there is no gauge. */
  gaugeDailyBars: number
  gaugeMinuteBars: number
}

export interface StudyPreparationHooks {
  signal?: AbortSignal
  onProgress?: (progress: StudyPreparationProgress) => void
}

/** Calendar lead-in used by both preparation and the runner's EMA calculation. */
export function studyWarmupStart(config: StudyConfig): MarketDate {
  const days = (config.entry.type === 'ema' ? config.entry.period * 4 : 10) + 30
  return shiftDays(config.from, -days)
}

/**
 * The last date a study can need underlying data for.
 *
 * A trade entered on the final session still has to be tracked to its own
 * expiration, so the data a study needs runs past the date range it is
 * configured with. Preparing only the entry range left the tail of every run
 * making uncached per-day requests - invisible while they succeeded, and fatal
 * the moment one did not.
 */
export function studyDataEnd(config: StudyConfig, now = Date.now()): MarketDate {
  const furthest = shiftDays(config.to, config.targetDte + (config.maxDeviation ?? 3))
  /*
   * Never past the last completed session. Asking a provider for today or for
   * days that have not happened is how a study that reaches into the present
   * ends up failing on its own tail; the runner skips those sessions instead.
   */
  const lastComplete = shiftDays(marketDateOf(now), -1)
  return furthest < lastComplete ? furthest : lastComplete
}

/** Pure plan kept separate so chunking and requested ranges are testable. */
export function planStudyPreparation(config: StudyConfig, indexTicker: string): StudyPreparationPlan {
  const sessions = tradingDaysBetween(config.from, studyDataEnd(config))
  const minuteChunks: StudyPreparationPlan['minuteChunks'] = []
  for (let i = 0; i < sessions.length; i += SESSIONS_PER_REQUEST) {
    const dates = sessions.slice(i, i + SESSIONS_PER_REQUEST)
    if (dates.length > 0) {
      minuteChunks.push({ from: dates[0]!, to: dates[dates.length - 1]!, dates })
    }
  }
  return {
    indexTicker,
    gaugeTicker: resolveGaugeTicker(config),
    dailyFrom: studyWarmupStart(config),
    dailyTo: studyDataEnd(config),
    minuteChunks
  }
}

/**
 * Cache-fills and verifies the underlying inputs known before option selection.
 * The provider is cache-first, so a warm run performs zero upstream calls.
 */
export async function prepareStudyData(
  config: StudyConfig,
  indexTicker: string,
  provider: OptionsHistoricalDataProvider,
  hooks: StudyPreparationHooks = {}
): Promise<StudyPreparationResult> {
  const plan = planStudyPreparation(config, indexTicker)
  const gaugeSteps = plan.gaugeTicker ? 1 + plan.minuteChunks.length : 0
  const total = 1 + plan.minuteChunks.length + gaugeSteps
  hooks.onProgress?.({ completed: 0, total, stage: 'checking daily SPX history' })

  log.info('preparing study data', {
    ticker: indexTicker,
    dailyFrom: plan.dailyFrom,
    dailyTo: plan.dailyTo,
    minuteChunks: plan.minuteChunks.length
  })

  const daily = await provider.getUnderlyingBars(
    { ticker: indexTicker, from: plan.dailyFrom, to: plan.dailyTo, timespan: 'day' },
    { ...(hooks.signal ? { signal: hooks.signal } : {}), priority: 10 }
  )
  hooks.onProgress?.({ completed: 1, total, stage: `verified ${daily.bars.length} daily bars` })

  let minuteBars = 0
  const barsPerDate = new Map<MarketDate, number>()
  for (const [index, chunk] of plan.minuteChunks.entries()) {
    /*
     * A refused chunk is recorded, not fatal. Bulk pre-filling is an
     * optimisation; the completeness check below still fails the run if an
     * entry session ended up with no data, and the runner skips any session it
     * cannot serve. Aborting here instead meant one unavailable range at the
     * tail of a year-long study prevented the whole thing from starting.
     */
    let result: Awaited<ReturnType<typeof provider.getUnderlyingBars>>
    try {
      result = await provider.getUnderlyingBars(
        { ticker: indexTicker, from: chunk.from, to: chunk.to, timespan: 'minute' },
        { ...(hooks.signal ? { signal: hooks.signal } : {}), priority: 10 }
      )
    } catch (error) {
      if (hooks.signal?.aborted) throw error
      log.warn('minute range unavailable', {
        ticker: indexTicker,
        from: chunk.from,
        to: chunk.to,
        error: error instanceof Error ? error.message : String(error)
      })
      continue
    }
    minuteBars += result.bars.length
    for (const bar of result.bars) {
      const date = marketDateOf(bar.timestamp)
      barsPerDate.set(date, (barsPerDate.get(date) ?? 0) + 1)
    }
    hooks.onProgress?.({
      completed: index + 2,
      total,
      currentDate: chunk.to,
      stage: `verified SPX minutes ${chunk.from} through ${chunk.to}`
    })
  }

  /*
   * The gauge is filled but not verified for completeness. A missing minute
   * there costs one carried-forward reading, where a missing index minute would
   * corrupt the entry level itself - so the two do not warrant the same
   * strictness, and failing a study over a gap in a volatility feed would be
   * disproportionate.
   */
  let gaugeDailyBars = 0
  let gaugeMinuteBars = 0
  if (plan.gaugeTicker) {
    const step = 1 + plan.minuteChunks.length
    try {
      const gaugeDaily = await provider.getUnderlyingBars(
        { ticker: plan.gaugeTicker, from: plan.dailyFrom, to: plan.dailyTo, timespan: 'day' },
        { ...(hooks.signal ? { signal: hooks.signal } : {}), priority: 10 }
      )
      gaugeDailyBars = gaugeDaily.bars.length
    } catch (error) {
      if (hooks.signal?.aborted) throw error
      log.warn('gauge daily history unavailable', {
        ticker: plan.gaugeTicker,
        error: error instanceof Error ? error.message : String(error)
      })
    }
    hooks.onProgress?.({
      completed: step + 1,
      total,
      stage: `verified ${gaugeDailyBars} daily ${plan.gaugeTicker} bars`
    })

    for (const [index, chunk] of plan.minuteChunks.entries()) {
      let result: Awaited<ReturnType<typeof provider.getUnderlyingBars>> | null = null
      try {
        result = await provider.getUnderlyingBars(
          { ticker: plan.gaugeTicker, from: chunk.from, to: chunk.to, timespan: 'minute' },
          { ...(hooks.signal ? { signal: hooks.signal } : {}), priority: 10 }
        )
      } catch (error) {
        if (hooks.signal?.aborted) throw error
        log.warn('gauge minute range unavailable', {
          ticker: plan.gaugeTicker,
          from: chunk.from,
          to: chunk.to,
          error: error instanceof Error ? error.message : String(error)
        })
      }
      gaugeMinuteBars += result?.bars.length ?? 0
      hooks.onProgress?.({
        completed: step + index + 2,
        total,
        currentDate: chunk.to,
        stage: `verified ${plan.gaugeTicker} minutes ${chunk.from} through ${chunk.to}`
      })
    }

    log.info('gauge data prepared', {
      ticker: plan.gaugeTicker,
      dailyBars: gaugeDailyBars,
      minuteBars: gaugeMinuteBars
    })
  }

  const sessions = plan.minuteChunks.flatMap((chunk) => chunk.dates)
  /*
   * Only entry sessions must be complete. The tail beyond `config.to` is there
   * to track trades that are already open, and demanding the same completeness
   * of it would fail a study over sessions it never enters on - including days
   * that have not happened yet.
   */
  const incompleteMinuteSessions = sessions
    .filter((date) => date <= config.to)
    .flatMap((date) => {
      const actual = barsPerDate.get(date) ?? 0
      const expected = sessionMinuteCount(date)
      return actual < expected * MIN_COMPLETE_RATIO ? [{ date, actual, expected }] : []
    })

  log.info('study data prepared', {
    ticker: indexTicker,
    dailyBars: daily.bars.length,
    minuteBars,
    minuteSessions: sessions.length,
    incompleteMinuteSessions: incompleteMinuteSessions.length
  })

  if (incompleteMinuteSessions.length > 0) {
    const examples = incompleteMinuteSessions
      .slice(0, 5)
      .map((item) => `${item.date} (${item.actual}/${item.expected})`)
      .join(', ')
    throw new Error(
      `SPX minute verification failed for ${incompleteMinuteSessions.length} session(s): ${examples}. ` +
        'The study was not started. Re-run after the provider data is available.'
    )
  }

  return {
    dailyBars: daily.bars.length,
    minuteBars,
    minuteSessions: sessions.length,
    incompleteMinuteSessions,
    gaugeDailyBars,
    gaugeMinuteBars
  }
}

function shiftDays(date: MarketDate, days: number): MarketDate {
  const shifted = new Date(`${date}T00:00:00Z`).getTime() + days * 86_400_000
  return new Date(shifted).toISOString().slice(0, 10)
}
