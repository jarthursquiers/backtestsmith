import { describe, expect, it, vi } from 'vitest'
import type { OptionBar, UnderlyingBar } from '../domain/bars.js'
import type { OptionContract, OptionType } from '../domain/contracts.js'
import type { StudyConfig } from '../shared/study.js'
import {
  easternToTimestamp,
  sessionMinuteCount,
  tradingDaysBetween
} from '../core/time/marketTime.js'
import { runStudy, type StudyDataSource } from './studyRunner.js'
import { computeMetrics } from './metrics.js'

/**
 * A synthetic market with full data everywhere, so the orchestration can be
 * tested without a provider and without the sparsity that dominates real runs.
 */
function makeSource(overrides: Partial<StudyDataSource> = {}): StudyDataSource & { calls: string[] } {
  const calls: string[] = []

  const dailyClose = (date: string): number => {
    // Gentle uptrend so the EMA rule produces a stable bullish signal.
    const day = Math.floor(new Date(`${date}T00:00:00Z`).getTime() / 86_400_000)
    return 6000 + (day % 50)
  }

  const chainFor = (expiration: string, type: OptionType): OptionContract[] =>
    Array.from({ length: 121 }, (_, i) => 5700 + i * 5).map((strike) => ({
      ticker: `O:SPXW${expiration.replace(/-/g, '').slice(2)}${type === 'put' ? 'P' : 'C'}${String(strike * 1000).padStart(8, '0')}`,
      underlying: 'SPX',
      expirationDate: expiration,
      strike,
      type,
      root: 'SPXW',
      settlement: 'pm' as const
    }))

  const base: StudyDataSource = {
    async getDailyBars(_ticker, from, to) {
      calls.push('daily')
      const out: UnderlyingBar[] = []
      for (let t = new Date(`${from}T00:00:00Z`).getTime(); t <= new Date(`${to}T00:00:00Z`).getTime(); t += 86_400_000) {
        const date = new Date(t).toISOString().slice(0, 10)
        const dow = new Date(t).getUTCDay()
        if (dow === 0 || dow === 6) continue
        const close = dailyClose(date)
        out.push({
          ticker: 'I:SPX',
          timestamp: easternToTimestamp(date, 16, 0),
          open: close, high: close, low: close, close
        })
      }
      return out
    },

    async getUnderlyingMinutes(_ticker, date) {
      calls.push(`minutes:${date}`)
      const close = dailyClose(date)
      const count = sessionMinuteCount(date)
      return Array.from({ length: count }, (_, i) => ({
        ticker: 'I:SPX',
        timestamp: easternToTimestamp(date, 9, 30) + i * 60_000,
        open: close, high: close, low: close, close
      }))
    },

    async getChain(_underlying, expiration, type) {
      calls.push(`chain:${expiration}:${type}`)
      // Mon/Wed/Fri only, mirroring the real listing schedule.
      const dow = new Date(`${expiration}T00:00:00Z`).getUTCDay()
      return [1, 3, 5].includes(dow) ? chainFor(expiration, type) : []
    },

    async getOptionBars(ticker, from, to) {
      calls.push(`bars:${ticker}`)
      const out: OptionBar[] = []
      // Session minutes only. Emitting overnight and weekend minutes would be
      // both unrealistic and needlessly slow.
      const price = ticker.includes('P') ? 12 : 10
      for (const date of tradingDaysBetween(from, to)) {
        const open = easternToTimestamp(date, 9, 30)
        for (let i = 0; i < sessionMinuteCount(date); i++) {
          const t = open + i * 60_000
          out.push({ ticker, timestamp: t, open: price, high: price, low: price, close: price, volume: 5 })
        }
      }
      return out
    }
  }

  return { ...base, ...overrides, calls }
}

const CONFIG: StudyConfig = {
  underlying: 'SPX',
  from: '2025-06-02',
  to: '2025-06-13',
  entryTime: '09:35',
  entry: { type: 'ema', period: 9 },
  targetDte: 7,
  expirationRule: 'nearest',
  maxDeviation: 3,
  preferredRoot: 'SPXW',
  placement: { type: 'fixedDistance', offsetPoints: 100 },
  wingWidth: 25,
  quantity: 1,
  pricing: { model: 'close', slippage: 0, missingDataMode: 'carryForward', maxStaleMinutes: 5 },
  minimumCoverage: 0,
  managements: ['hold', 'tp50', 'tp100']
}

describe('study runner', () => {
  it('generates one entry per eligible session and applies every management method', async () => {
    const source = makeSource()
    const outcome = await runStudy(CONFIG, source)

    expect(outcome.series.length).toBeGreaterThan(0)
    // Every entry is run through all three methods, on the identical series.
    expect(outcome.trades).toHaveLength(outcome.series.length * 3)

    const byStrategy = new Map<string, number>()
    for (const t of outcome.trades) byStrategy.set(t.strategyId, (byStrategy.get(t.strategyId) ?? 0) + 1)
    expect([...byStrategy.values()]).toEqual([
      outcome.series.length,
      outcome.series.length,
      outcome.series.length
    ])
  })

  it('gives every management method the identical entry population', async () => {
    const outcome = await runStudy(CONFIG, makeSource())

    const entriesFor = (id: string): number[] =>
      outcome.trades.filter((t) => t.strategyId === id).map((t) => t.entryTimestamp).sort()

    // This is the guarantee that makes a comparison meaningful.
    expect(entriesFor('tp50')).toEqual(entriesFor('hold'))
    expect(entriesFor('tp100')).toEqual(entriesFor('hold'))

    const debits = new Set(outcome.trades.map((t) => t.entryDebit.toFixed(6)))
    expect(debits.size).toBe(1) // one flat market, so one debit
  })

  it('places the butterfly on the correct side of the market', async () => {
    const outcome = await runStudy(CONFIG, makeSource())
    for (const s of outcome.series) {
      const spot = s.entryUnderlying ?? 0
      if (s.definition.direction === 'bearish') {
        expect(s.definition.centerStrike).toBeLessThan(spot)
        expect(s.definition.optionType).toBe('put')
      } else {
        expect(s.definition.centerStrike).toBeGreaterThan(spot)
        expect(s.definition.optionType).toBe('call')
      }
    }
  })

  it('targets the requested DTE within tolerance', async () => {
    const outcome = await runStudy(CONFIG, makeSource())
    for (const s of outcome.series) {
      const dte = s.observations[0]!.dte
      expect(Math.abs(dte - 7)).toBeLessThanOrEqual(3)
    }
  })

  it('records a reason for every session it skips', async () => {
    // No chains listed at all, so nothing can be traded.
    const source = makeSource({ getChain: async () => [] })
    const outcome = await runStudy(CONFIG, source)

    expect(outcome.series).toHaveLength(0)
    expect(outcome.skipped.length).toBeGreaterThan(0)
    for (const s of outcome.skipped) {
      expect(s.reason).toBeTruthy()
      expect(s.date).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    }
    expect(outcome.skipped[0]!.reason).toMatch(/no listed expiration/)
  })

  it('excludes trades below the data-quality threshold', async () => {
    // Only the entry minute is ever priced, so coverage is near zero.
    const sparse = makeSource({
      async getOptionBars(ticker, from) {
        return [
          {
            ticker,
            timestamp: easternToTimestamp(from, 9, 35),
            open: 10, high: 10, low: 10, close: 10, volume: 1
          }
        ]
      }
    })

    const permissive = await runStudy({ ...CONFIG, minimumCoverage: 0 }, sparse)
    const strict = await runStudy({ ...CONFIG, minimumCoverage: 0.8 }, sparse)

    expect(permissive.series.length).toBeGreaterThan(0)
    expect(strict.series).toHaveLength(0)
    expect(strict.skipped.some((s) => /data quality below threshold/.test(s.reason))).toBe(true)
  })

  it('reports progress and can be cancelled', async () => {
    const updates: number[] = []
    const controller = new AbortController()

    const outcome = await runStudy(CONFIG, makeSource(), {
      onProgress: (p) => {
        updates.push(p.completed)
        // Stop after the first two sessions.
        if (p.completed >= 2) controller.abort()
      },
      signal: controller.signal
    })

    expect(updates.length).toBeGreaterThan(0)
    expect(outcome.entriesAttempted).toBeLessThan(10)
  })

  it('feeds metrics that describe the whole population', async () => {
    const outcome = await runStudy(CONFIG, makeSource())
    const hold = outcome.trades.filter((t) => t.strategyId === 'hold')
    const metrics = computeMetrics(hold)

    expect(metrics.totalTrades).toBe(hold.length)
    expect(metrics.winningTrades + metrics.losingTrades).toBeLessThanOrEqual(metrics.totalTrades)
  })

  it('rejects an unknown management id rather than silently dropping it', async () => {
    await expect(
      runStudy({ ...CONFIG, managements: ['hold', 'nonsense'] }, makeSource())
    ).rejects.toThrow(/Unknown management method "nonsense"/)
  })
})

describe('warm-up handling', () => {
  it('requests daily history from before the study range', async () => {
    const source = makeSource()
    const spy = vi.spyOn(source, 'getDailyBars')
    await runStudy(CONFIG, source)

    const [, from] = spy.mock.calls[0]!
    // The EMA needs history before the first entry, or early trades would be
    // dropped for want of an indicator and bias the sample toward later dates.
    expect(from < CONFIG.from).toBe(true)
  })
})
