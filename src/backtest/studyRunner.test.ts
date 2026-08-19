import { describe, expect, it, vi } from 'vitest'
import type { OptionBar, UnderlyingBar } from '../domain/bars.js'
import type { OptionContract, OptionType } from '../domain/contracts.js'
import type { StudyConfig } from '../shared/study.js'
import {
  easternToTimestamp,
  sessionMinuteCount,
  tradingDaysBetween
} from '../core/time/marketTime.js'
import { preflightStudy, runStudy, type StudyDataSource } from './studyRunner.js'
import { normalizeSkipReason, resolveIndexTicker } from '../shared/study.js'
import { computeMetrics } from './metrics.js'

function syntheticOptionPrice(ticker: string): number {
  const strike = Number(ticker.slice(-8)) / 1000
  const base = ticker.includes('P') ? 12 : 10
  // Positive convexity gives every symmetric butterfly a small valid debit.
  return base + ((strike - 6000) ** 2) / 5000
}

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
      const price = syntheticOptionPrice(ticker)
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
        const price = syntheticOptionPrice(ticker)
        return [
          {
            ticker,
            timestamp: easternToTimestamp(from, 9, 35),
            open: price, high: price, low: price, close: price, volume: 1
          }
        ]
      }
    })

    const permissive = await runStudy({ ...CONFIG, minimumCoverage: 0 }, sparse)
    const strict = await runStudy({ ...CONFIG, minimumCoverage: 0.8 }, sparse)

    expect(permissive.series.length).toBeGreaterThan(0)
    expect(strict.series).toHaveLength(0)
    expect(strict.skipped.some((s) => /data quality .*minutes priced/.test(s.reason))).toBe(true)
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

describe('index ticker resolution', () => {
  it('defaults to the I: convention every download path uses', () => {
    /*
     * Regression. Option chains are keyed by the bare root (SPX) while index
     * bars are stored with an I: prefix (I:SPX). The runner previously asked for
     * underlying bars using the option root, matched nothing, and skipped every
     * session for want of an indicator - while the data sat in the cache under
     * the other key.
     */
    expect(resolveIndexTicker({ underlying: 'SPX' })).toBe('I:SPX')
    expect(resolveIndexTicker({ underlying: 'I:SPX' })).toBe('I:SPX')
    expect(resolveIndexTicker({ underlying: 'SPX', indexTicker: 'SPX-CSV' })).toBe('SPX-CSV')
  })

  it('reads underlying bars under the index ticker, not the option root', async () => {
    const requested: string[] = []
    const source = makeSource({
      async getDailyBars(ticker, from, to) {
        requested.push(ticker)
        // Only serve data for the I: form, as the real cache does.
        if (ticker !== 'I:SPX') return []
        const out = []
        for (let t = new Date(`${from}T00:00:00Z`).getTime(); t <= new Date(`${to}T00:00:00Z`).getTime(); t += 86_400_000) {
          const d = new Date(t)
          if (d.getUTCDay() === 0 || d.getUTCDay() === 6) continue
          const date = d.toISOString().slice(0, 10)
          out.push({
            ticker: 'I:SPX',
            timestamp: easternToTimestamp(date, 16, 0),
            open: 6000, high: 6000, low: 6000, close: 6000
          })
        }
        return out
      }
    })

    const outcome = await runStudy(CONFIG, source)

    expect(requested).toContain('I:SPX')
    expect(requested).not.toContain('SPX')
    // Data was found, so sessions are not skipped for want of an indicator.
    expect(outcome.skipped.some((s) => /no completed daily bar/.test(s.reason))).toBe(false)
    expect(outcome.series.length).toBeGreaterThan(0)
  })
})

describe('preflight', () => {
  it('blocks a run that has no daily bars, naming the ticker it looked for', async () => {
    const empty = makeSource({ getDailyBars: async () => [], getUnderlyingMinutes: async () => [] })
    const report = await preflightStudy(CONFIG, empty)

    expect(report.dailyBars).toBe(0)
    expect(report.blockers).toHaveLength(1)
    // Naming the ticker is what makes a key mismatch diagnosable rather than
    // mysterious.
    expect(report.blockers[0]).toContain('I:SPX')
    expect(report.warnings.join(' ')).toContain('I:SPX')
  })

  it('blocks when there is history but not enough for the EMA warm-up', async () => {
    const source = makeSource({
      async getDailyBars() {
        return [
          {
            ticker: 'I:SPX',
            timestamp: easternToTimestamp('2025-06-02', 16, 0),
            open: 6000, high: 6000, low: 6000, close: 6000
          }
        ]
      }
    })
    const report = await preflightStudy(CONFIG, source)
    expect(report.blockers[0]).toMatch(/needs at least 10/)
  })

  it('blocks when cached daily bars cannot precede any study session', async () => {
    const source = makeSource({
      async getDailyBars() {
        return Array.from({ length: 10 }, (_, i) => ({
          ticker: 'I:SPX',
          timestamp: easternToTimestamp(CONFIG.to, 16, i),
          open: 6000,
          high: 6000,
          low: 6000,
          close: 6000
        }))
      }
    })

    const report = await preflightStudy(CONFIG, source)
    expect(report.blockers.join(' ')).toMatch(/none is dated before the first study session/)
    expect(report.blockers.join(' ')).toContain('I:SPX')
  })

  it('passes cleanly when the data is present', async () => {
    const report = await preflightStudy(CONFIG, makeSource({
      async getDailyBars(_t, from, to) {
        const out = []
        for (let t = new Date(`${from}T00:00:00Z`).getTime(); t <= new Date(`${to}T00:00:00Z`).getTime(); t += 86_400_000) {
          const d = new Date(t)
          if (d.getUTCDay() === 0 || d.getUTCDay() === 6) continue
          out.push({
            ticker: 'I:SPX',
            timestamp: easternToTimestamp(d.toISOString().slice(0, 10), 16, 0),
            open: 6000, high: 6000, low: 6000, close: 6000
          })
        }
        return out
      }
    }))
    expect(report.blockers).toEqual([])
    expect(report.sessions).toBeGreaterThan(0)
  })
})

describe('skip reason grouping', () => {
  it('keeps ISO timestamps readable when normalizing detailed reasons', () => {
    expect(normalizeSkipReason(
      'The butterfly could not be priced at any minute by 2026-06-15T13:50:00.000Z: all three legs require fresh prices'
    )).toContain('TIMESTAMP')
  })

  it('collapses one shared cause into a single tally entry', async () => {
    const source = makeSource({ getChain: async () => [] })
    const outcome = await runStudy(CONFIG, source)

    const entries = Object.entries(outcome.skipReasons)
    // Fifty sessions failing for one reason must read as one line, not fifty.
    expect(entries).toHaveLength(1)
    expect(entries[0]![1]).toBe(outcome.skipped.length)
    // Specifics such as the DTE number are stripped from the category.
    expect(entries[0]![0]).toMatch(/no listed expiration within tolerance of N DTE/)
  })
})

describe('entry window', () => {
  /**
   * Options printing only every 20 minutes. With a 5-minute carry-forward that
   * leaves most minutes unpriceable, which is what sparse at-the-money data
   * looks like once the carry tolerance is exhausted.
   */
  function sparseSource(everyMinutes = 20) {
    return makeSource({
      // No intraday index data, so the level must come from parity.
      getUnderlyingMinutes: async () => [],
      async getOptionBars(ticker, from, to) {
        const out = []
        const price = syntheticOptionPrice(ticker)
        for (const date of tradingDaysBetween(from, to)) {
          const open = easternToTimestamp(date, 9, 30)
          for (let i = 0; i < sessionMinuteCount(date); i += everyMinutes) {
            const t = open + i * 60_000
            out.push({ ticker, timestamp: t, open: price, high: price, low: price, close: price, volume: 5 })
          }
        }
        return out
      }
    })
  }

  const sparseConfig = {
    ...CONFIG,
    // 09:36 is six minutes past the last print at 09:30, so a 5-minute
    // carry-forward cannot reach it.
    entryTime: '09:36',
    placement: { type: 'fixedDistance' as const, offsetPoints: 100 },
    pricing: { ...CONFIG.pricing, maxStaleMinutes: 5 }
  }

  it('recovers sessions the carry-forward tolerance alone cannot reach', async () => {
    const strict = await runStudy({ ...sparseConfig, entryWindowMinutes: 0 }, sparseSource())
    expect(strict.series).toHaveLength(0)
    expect(strict.skipped.some((s) => /could not establish the index level/.test(s.reason))).toBe(true)

    // The window scans forward to the next print at 09:50.
    const windowed = await runStudy({ ...sparseConfig, entryWindowMinutes: 20 }, sparseSource())
    expect(windowed.series.length).toBeGreaterThan(0)
  })

  it('keeps scanning when SPX is known but the ATM straddle prints later', async () => {
    const delayedStraddle = makeSource({
      async getOptionBars(ticker, from, to) {
        const out: OptionBar[] = []
        const price = syntheticOptionPrice(ticker)
        for (const date of tradingDaysBetween(from, to)) {
          const first = easternToTimestamp(date, 9, 50)
          const count = sessionMinuteCount(date) - 20
          for (let i = 0; i < count; i++) {
            const timestamp = first + i * 60_000
            out.push({ ticker, timestamp, open: price, high: price, low: price, close: price, volume: 1 })
          }
        }
        return out
      }
    })
    const config = {
      ...CONFIG,
      from: '2025-06-02',
      to: '2025-06-02',
      placement: { type: 'expectedMove' as const, buffer: 0 }
    }

    const exactOnly = await runStudy({ ...config, entryWindowMinutes: 0 }, delayedStraddle)
    expect(exactOnly.series).toHaveLength(0)
    expect(exactOnly.skipped[0]?.reason).toMatch(/expected move unavailable.*call bars.*first 09:50/)

    const windowed = await runStudy({ ...config, entryWindowMinutes: 20 }, delayedStraddle)
    expect(windowed.series).toHaveLength(1)
    expect(windowed.series[0]?.entryTimestamp).toBe(easternToTimestamp('2025-06-02', 9, 50))
  })

  it('records the minute actually filled, never earlier than requested', async () => {
    const outcome = await runStudy({ ...sparseConfig, entryWindowMinutes: 20 }, sparseSource())
    expect(outcome.series.length).toBeGreaterThan(0)

    for (const s of outcome.series) {
      const date = new Date(s.entryTimestamp)
      const requested = easternToTimestamp(
        date.toISOString().slice(0, 10),
        9,
        36
      )
      // A fill may trail the request but must never precede it, and must fall
      // inside the declared window.
      expect(s.entryTimestamp).toBeGreaterThanOrEqual(requested)
      expect(s.entryTimestamp - requested).toBeLessThanOrEqual(20 * 60_000)
    }
  })

  it('uses short carried-forward quotes at entry when that policy is configured', async () => {
    // Prints every 5 minutes. At the requested 09:36 entry, the most recent
    // quotes are from 09:35 and remain admissible under the 5-minute policy.
    const outcome = await runStudy({ ...sparseConfig, entryWindowMinutes: 0 }, sparseSource(5))
    expect(outcome.series.length).toBeGreaterThan(0)

    for (const series of outcome.series) {
      expect(series.entryAudit?.stale).toBe(true)
      expect(series.entryAudit?.maxLegAgeMs).toBe(60_000)
      expect(series.warnings.join(' ')).toMatch(/carried-forward leg/)
    }
  })

  it('still requires same-minute entry quotes in strict mode', async () => {
    const sparse = sparseSource(5)
    // Keep real index minutes available so this test reaches butterfly entry
    // reconstruction rather than failing earlier during parity estimation.
    const source = makeSource({ getOptionBars: sparse.getOptionBars })
    const outcome = await runStudy({
      ...sparseConfig,
      from: '2025-06-02',
      to: '2025-06-02',
      entryWindowMinutes: 0,
      pricing: { ...sparseConfig.pricing, missingDataMode: 'strict' }
    }, source)

    expect(outcome.series).toHaveLength(0)
    expect(outcome.skipped.some((s) => /fresh same-minute prices/.test(s.reason))).toBe(true)
  })

  it('does not let the window run past its bound', async () => {
    const late = makeSource({
      getUnderlyingMinutes: async () => [],
      async getOptionBars(ticker, from) {
        const price = syntheticOptionPrice(ticker)
        return [{
          ticker, timestamp: easternToTimestamp(from, 9, 30),
          open: price, high: price, low: price, close: price, volume: 1
        }]
      }
    })
    const outcome = await runStudy(
      { ...sparseConfig, entryWindowMinutes: 2, pricing: { ...CONFIG.pricing, maxStaleMinutes: 1 } },
      late
    )
    expect(outcome.series).toHaveLength(0)
    expect(outcome.skipped.some((s) => /within 2 minutes/.test(s.reason))).toBe(true)
  })
})
