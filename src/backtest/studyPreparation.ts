import type { StudyConfig } from '../shared/study.js'
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

/** Pure plan kept separate so chunking and requested ranges are testable. */
export function planStudyPreparation(config: StudyConfig, indexTicker: string): StudyPreparationPlan {
  const sessions = tradingDaysBetween(config.from, config.to)
  const minuteChunks: StudyPreparationPlan['minuteChunks'] = []
  for (let i = 0; i < sessions.length; i += SESSIONS_PER_REQUEST) {
    const dates = sessions.slice(i, i + SESSIONS_PER_REQUEST)
    if (dates.length > 0) {
      minuteChunks.push({ from: dates[0]!, to: dates[dates.length - 1]!, dates })
    }
  }
  return {
    indexTicker,
    dailyFrom: studyWarmupStart(config),
    dailyTo: config.to,
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
  const total = 1 + plan.minuteChunks.length
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
    const result = await provider.getUnderlyingBars(
      { ticker: indexTicker, from: chunk.from, to: chunk.to, timespan: 'minute' },
      { ...(hooks.signal ? { signal: hooks.signal } : {}), priority: 10 }
    )
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

  const sessions = plan.minuteChunks.flatMap((chunk) => chunk.dates)
  const incompleteMinuteSessions = sessions.flatMap((date) => {
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
    incompleteMinuteSessions
  }
}

function shiftDays(date: MarketDate, days: number): MarketDate {
  const shifted = new Date(`${date}T00:00:00Z`).getTime() + days * 86_400_000
  return new Date(shifted).toISOString().slice(0, 10)
}
