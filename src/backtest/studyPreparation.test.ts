import { describe, expect, it } from 'vitest'
import type { OptionsHistoricalDataProvider } from '../data/provider.js'
import type { BarQuery, UnderlyingBar } from '../domain/bars.js'
import type { StudyConfig } from '../shared/study.js'
import { easternToTimestamp, sessionMinuteCount, tradingDaysBetween } from '../core/time/marketTime.js'
import { planStudyPreparation, prepareStudyData } from './studyPreparation.js'

const CONFIG: StudyConfig = {
  underlying: 'SPX',
  from: '2025-06-02',
  to: '2025-07-15',
  entryTime: '09:35',
  entry: { type: 'ema', period: 9 },
  targetDte: 7,
  expirationRule: 'nearest',
  placement: { type: 'fixedDistance', offsetPoints: 100 },
  wingWidth: 25,
  quantity: 1,
  pricing: { model: 'close', slippage: 0, missingDataMode: 'carryForward', maxStaleMinutes: 5 },
  minimumCoverage: 0.5,
  managements: ['hold']
}

function bar(ticker: string, timestamp: number): UnderlyingBar {
  return { ticker, timestamp, open: 6000, high: 6000, low: 6000, close: 6000 }
}

function providerFor(makeBars: (query: BarQuery) => UnderlyingBar[]): OptionsHistoricalDataProvider {
  return {
    id: 'fake',
    name: 'Fake',
    async testConnection() {
      return { ok: true, providerId: 'fake', message: 'ok', checkedAt: Date.now() }
    },
    async getContracts() {
      return []
    },
    async getOptionBars(query) {
      return { ticker: query.ticker, bars: [], requestedFrom: query.from, requestedTo: query.to, empty: true, fetchedAt: Date.now() }
    },
    async getUnderlyingBars(query) {
      const bars = makeBars(query)
      return {
        ticker: query.ticker,
        bars,
        requestedFrom: query.from,
        requestedTo: query.to,
        empty: bars.length === 0,
        fetchedAt: Date.now()
      }
    }
  }
}

describe('study data preparation', () => {
  it('plans bounded minute chunks and an EMA warm-up range', () => {
    const plan = planStudyPreparation(CONFIG, 'I:SPX')
    const sessions = tradingDaysBetween(CONFIG.from, CONFIG.to)

    expect(plan.dailyFrom).toBe('2025-03-28')
    expect(plan.dailyTo).toBe(CONFIG.to)
    expect(plan.minuteChunks.length).toBe(Math.ceil(sessions.length / 21))
    expect(plan.minuteChunks.flatMap((chunk) => chunk.dates)).toEqual(sessions)
  })

  it('accepts complete underlying sessions and reports progress', async () => {
    const short = { ...CONFIG, from: '2025-06-16', to: '2025-06-18' }
    const updates: string[] = []
    const provider = providerFor((query) => {
      if (query.timespan === 'day') {
        return tradingDaysBetween(query.from, query.to).map((date) => bar(query.ticker, easternToTimestamp(date, 16, 0)))
      }
      return tradingDaysBetween(query.from, query.to).flatMap((date) =>
        Array.from({ length: sessionMinuteCount(date) }, (_, i) =>
          bar(query.ticker, easternToTimestamp(date, 9, 30) + i * 60_000)
        )
      )
    })

    const result = await prepareStudyData(short, 'I:SPX', provider, {
      onProgress: (progress) => updates.push(progress.stage)
    })

    expect(result.minuteSessions).toBe(3)
    expect(result.incompleteMinuteSessions).toEqual([])
    expect(updates.at(-1)).toMatch(/verified SPX minutes/)
  })

  it('refuses to start when an underlying minute session is incomplete', async () => {
    const short = { ...CONFIG, from: '2025-06-17', to: '2025-06-17' }
    const provider = providerFor((query) =>
      query.timespan === 'day'
        ? [bar(query.ticker, easternToTimestamp('2025-06-16', 16, 0))]
        : [bar(query.ticker, easternToTimestamp('2025-06-17', 9, 30))]
    )

    await expect(prepareStudyData(short, 'I:SPX', provider)).rejects.toThrow(
      /SPX minute verification failed.*2025-06-17/s
    )
  })
})
