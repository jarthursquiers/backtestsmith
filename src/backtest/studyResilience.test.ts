import { describe, expect, it } from 'vitest'
import type { OptionBar, UnderlyingBar } from '../domain/bars.js'
import type { OptionContract, OptionType } from '../domain/contracts.js'
import type { StudyConfig } from '../shared/study.js'
import {
  easternToTimestamp,
  marketDateOf,
  sessionMinuteCount,
  tradingDaysBetween
} from '../core/time/marketTime.js'
import { preflightStudy, runStudy, type StudyDataSource } from './studyRunner.js'
import { planStudyPreparation, studyDataEnd } from './studyPreparation.js'

/**
 * What a study does when the provider will not serve part of what it asks for.
 *
 * The tail of a DTE-targeted study reaches past its own end date, so these are
 * not exotic conditions: they are what every run meets on its last few sessions.
 */

const STRIKES = Array.from({ length: 241 }, (_, i) => 5400 + i * 5)

function tickerFor(expiration: string, type: OptionType, strike: number): string {
  return `O:SPXW${expiration.replace(/-/g, '').slice(2)}${type === 'put' ? 'P' : 'C'}${String(strike * 1000).padStart(8, '0')}`
}

/** Every day this source will refuse to serve, as the real provider would. */
function makeSource(unavailableFrom?: string): StudyDataSource {
  const refuse = (date: string): void => {
    if (unavailableFrom && date >= unavailableFrom) {
      throw new Error(
        'Your Massive plan does not include this data (HTTP 403). Your plan does not include this data timeframe.'
      )
    }
  }

  return {
    async getDailyBars(ticker, from, to) {
      const out: UnderlyingBar[] = []
      for (const date of tradingDaysBetween(from, to)) {
        if (unavailableFrom && date >= unavailableFrom) continue
        out.push({
          ticker,
          timestamp: easternToTimestamp(date, 16, 0),
          open: 6000, high: 6000, low: 6000, close: 6000
        })
      }
      return out
    },

    async getUnderlyingMinutes(ticker, date) {
      refuse(date)
      const open = easternToTimestamp(date, 9, 30)
      return Array.from({ length: sessionMinuteCount(date) }, (_, i) => ({
        ticker,
        timestamp: open + i * 60_000,
        open: 6000, high: 6000, low: 6000, close: 6000
      }))
    },

    async getChain(_underlying, expiration, type) {
      const dow = new Date(`${expiration}T00:00:00Z`).getUTCDay()
      if (![1, 3, 5].includes(dow)) return []
      return STRIKES.map((strike) => ({
        ticker: tickerFor(expiration, type, strike),
        underlying: 'SPX',
        expirationDate: expiration,
        strike,
        type,
        root: 'SPXW',
        settlement: 'pm' as const
      })) satisfies OptionContract[]
    },

    async getOptionBars(ticker, from, to) {
      const strike = Number(ticker.slice(-8)) / 1000
      const price = 40 + ((strike - 6000) ** 2) / 400
      const out: OptionBar[] = []
      for (const date of tradingDaysBetween(from, to)) {
        const open = easternToTimestamp(date, 9, 30)
        for (let i = 0; i < sessionMinuteCount(date); i++) {
          out.push({
            ticker, timestamp: open + i * 60_000,
            open: price, high: price, low: price, close: price, volume: 5
          })
        }
      }
      return out
    }
  }
}

const CONFIG: StudyConfig = {
  underlying: 'SPX',
  from: '2025-06-02',
  to: '2025-06-20',
  entryTime: '09:35',
  entryWindowMinutes: 15,
  entry: { type: 'fixed', direction: 'bullish' },
  targetDte: 7,
  expirationRule: 'nearest',
  maxDeviation: 2,
  preferredRoot: 'SPXW',
  placement: { type: 'fixedDistance', offsetPoints: 100 },
  wingWidth: 25,
  quantity: 1,
  pricing: { model: 'close', slippage: 0, missingDataMode: 'carryForward', maxStaleMinutes: 5 },
  minimumCoverage: 0,
  managements: ['hold']
}

describe('a study whose tail cannot be served', () => {
  it('keeps every entry it already built instead of failing the whole run', async () => {
    // Data stops partway through, as it does when a range reaches the present.
    const outcome = await runStudy(CONFIG, makeSource('2025-06-16'))

    expect(outcome.series.length).toBeGreaterThan(0)
    expect(outcome.trades.length).toBe(outcome.series.length)
    // Every session was attempted; the unusable ones became skips.
    expect(outcome.entriesAttempted).toBe(tradingDaysBetween(CONFIG.from, CONFIG.to).length)
    expect(outcome.skipped.length).toBeGreaterThan(0)
  })

  it('records the provider message so the cause is visible, not just a count', async () => {
    const outcome = await runStudy(CONFIG, makeSource('2025-06-16'))

    const reasons = outcome.skipped.map((s) => s.reason).join(' ')
    expect(reasons).toContain('data request failed')
    expect(reasons).toContain('HTTP 403')
  })

  it('groups a systematic failure under one heading rather than scattering it', async () => {
    const outcome = await runStudy(CONFIG, makeSource('2025-06-16'))

    const failureGroups = Object.entries(outcome.skipReasons).filter(([reason]) =>
      reason.startsWith('data request failed')
    )
    expect(failureGroups).toHaveLength(1)
    expect(failureGroups[0]![1]).toBeGreaterThan(1)
  })

  it('still fails loudly when nothing at all can be served', async () => {
    // Not a silent empty run, and not a crash either: preflight reports the
    // provider's own words as a blocker before any work is done.
    const preflight = await preflightStudy(CONFIG, makeSource('2000-01-01'))
    expect(preflight.blockers.length).toBeGreaterThan(0)
    expect(preflight.blockers.join(' ')).toContain('HTTP 403')
  })

  it('runs clean when everything is available', async () => {
    const outcome = await runStudy(CONFIG, makeSource())
    expect(outcome.skipped).toEqual([])
  })
})

describe('the data range a study prepares', () => {
  it('reaches past the entry range, far enough for the last trade to expire', () => {
    // A trade entered on 2025-06-20 can expire as late as 7 + 2 days later, and
    // has to be tracked to that day. Preparing only through 06-20 left those
    // sessions to be fetched one at a time during the run.
    expect(studyDataEnd(CONFIG)).toBe('2025-06-29')

    const plan = planStudyPreparation(CONFIG, 'I:SPX')
    const prepared = plan.minuteChunks.flatMap((chunk) => chunk.dates)
    expect(prepared).toContain('2025-06-20')
    expect(prepared.at(-1)! > CONFIG.to).toBe(true)
    expect(plan.dailyTo).toBe('2025-06-29')
  })

  it('scales the tail with the target DTE rather than assuming a week', () => {
    expect(studyDataEnd({ ...CONFIG, targetDte: 45, maxDeviation: 5 })).toBe('2025-08-09')
    // A 0DTE study needs nothing past its own last session.
    expect(studyDataEnd({ ...CONFIG, targetDte: 0, maxDeviation: 0 })).toBe('2025-06-20')
  })
})

describe('what preflight reads', () => {
  it('asks for no more daily history than preparation caches', async () => {
    const asked: { ticker: string; from: string; to: string }[] = []
    const base = makeSource()
    await preflightStudy(CONFIG, {
      ...base,
      getDailyBars: async (ticker, from, to) => {
        asked.push({ ticker, from, to })
        return base.getDailyBars(ticker, from, to)
      }
    })

    // A wider lookback than the warm-up guarantees a cache miss on every run,
    // which is how preflight ended up making slow upstream requests.
    const plan = planStudyPreparation(CONFIG, 'I:SPX')
    for (const request of asked) {
      expect(request.from >= plan.dailyFrom).toBe(true)
    }
  })

  it('samples a bounded number of sessions rather than the whole range', async () => {
    let minuteReads = 0
    const base = makeSource()
    await preflightStudy(CONFIG, {
      ...base,
      getUnderlyingMinutes: async (ticker, date) => {
        minuteReads++
        return base.getUnderlyingMinutes(ticker, date)
      }
    })

    // Ten per ticker; preflight is a check, not a scan.
    expect(minuteReads).toBeLessThanOrEqual(10)
  })
})

describe('preflight on a range that reaches the present', () => {
  it('warns, with the last date entries could still mature on', async () => {
    const today = marketDateOf(Date.now())
    const recent: StudyConfig = {
      ...CONFIG,
      from: '2026-01-02',
      to: today,
      targetDte: 7,
      maxDeviation: 2
    }
    const preflight = await preflightStudy(recent, makeSource())
    const warning = preflight.warnings.find((w) => w.includes('not in the past'))

    expect(warning).toBeDefined()
    expect(warning).toContain('End the range at')
  })

  it('stays quiet on a range that is comfortably historic', async () => {
    const preflight = await preflightStudy(CONFIG, makeSource())
    expect(preflight.warnings.filter((w) => w.includes('not in the past'))).toEqual([])
  })
})
