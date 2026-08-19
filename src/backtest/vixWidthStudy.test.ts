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
import { buildStudyConfig, defaultStrategyParams, requireStrategy } from '../shared/strategyCatalog.js'
import { preflightStudy, runStudy, type StudyDataSource } from './studyRunner.js'

/**
 * End-to-end cover for the VIX-scaled wing width.
 *
 * The SPX side is deliberately flat and fully priced, so the only thing that
 * varies between sessions is the gauge - which makes the width each trade was
 * built with the single observable under test.
 */

const STRIKES = Array.from({ length: 241 }, (_, i) => 5400 + i * 5)
const GAUGE = 'I:VIX'

/** Convex by strike, so every symmetric butterfly has a small positive debit. */
function syntheticPrice(strike: number): number {
  return 40 + ((strike - 6000) ** 2) / 400
}

function tickerFor(expiration: string, type: OptionType, strike: number): string {
  return `O:SPXW${expiration.replace(/-/g, '').slice(2)}${type === 'put' ? 'P' : 'C'}${String(strike * 1000).padStart(8, '0')}`
}

interface MarketOptions {
  /** VIX close per session. Sessions without an entry are absent from the map. */
  vixByDate: Record<string, number>
  /** Sessions for which no intraday gauge bars exist at all. */
  gaugeMinutesMissing?: string[]
  /** Suppresses the gauge entirely, minute and daily. */
  noGaugeAtAll?: boolean
}

function makeSource(options: MarketOptions): StudyDataSource {
  const { vixByDate, gaugeMinutesMissing = [], noGaugeAtAll = false } = options

  return {
    async getDailyBars(ticker, from, to) {
      const out: UnderlyingBar[] = []
      for (const date of tradingDaysBetween(from, to)) {
        if (ticker === GAUGE) {
          if (noGaugeAtAll) continue
          const level = vixByDate[date]
          if (level === undefined) continue
          out.push({
            ticker,
            timestamp: easternToTimestamp(date, 16, 0),
            open: level, high: level, low: level, close: level
          })
          continue
        }
        // SPX sits above its own 9 EMA throughout, so the side is always bullish
        // and the direction rule is not what this file is testing.
        out.push({
          ticker,
          timestamp: easternToTimestamp(date, 16, 0),
          open: 6000, high: 6000, low: 6000, close: 6000
        })
      }
      return out
    },

    async getUnderlyingMinutes(ticker, date) {
      const open = easternToTimestamp(date, 9, 30)
      const count = sessionMinuteCount(date)

      if (ticker === GAUGE) {
        if (noGaugeAtAll || gaugeMinutesMissing.includes(date)) return []
        const level = vixByDate[date]
        if (level === undefined) return []
        return Array.from({ length: count }, (_, i) => ({
          ticker,
          timestamp: open + i * 60_000,
          open: level, high: level, low: level, close: level
        }))
      }

      return Array.from({ length: count }, (_, i) => ({
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
      const price = syntheticPrice(strike)
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

function vixConfig(
  params: Record<string, string | number | boolean> = {},
  overrides: Partial<StudyConfig> = {}
): StudyConfig {
  const strategy = requireStrategy('ema-swing-vix-width-butterfly')
  return {
    ...buildStudyConfig({
      strategyId: strategy.id,
      params: { ...defaultStrategyParams(strategy), ...params },
      from: '2025-06-02',
      to: '2025-06-06',
      managements: ['hold'],
      pricing: { model: 'close', slippage: 0, missingDataMode: 'carryForward', maxStaleMinutes: 5 },
      minimumCoverage: 0
    }),
    // Fixed-distance placement keeps the structure in a known place while the
    // width varies; expected-move placement would move it too.
    placement: { type: 'fixedDistance', offsetPoints: 100 },
    ...overrides
  }
}

describe('the VIX-scaled wing width study', () => {
  it('defaults to the requested bands', () => {
    const config = vixConfig()
    expect(config.wingWidthRule).toEqual({
      type: 'volatilityBands',
      ticker: 'I:VIX',
      bands: [
        { below: 17, wingWidth: 20 },
        { below: 32, wingWidth: 30 },
        { wingWidth: 45 }
      ]
    })
  })

  it('builds a different width on each session according to the gauge', async () => {
    const outcome = await runStudy(
      vixConfig({}, { from: '2025-06-02', to: '2025-06-06' }),
      makeSource({
        vixByDate: {
          '2025-06-02': 12,  // quiet   -> 20 wide
          '2025-06-03': 16.9, // still under the threshold
          '2025-06-04': 17,  // exactly on it -> 30 wide
          '2025-06-05': 25,  // middle band
          '2025-06-06': 40   // stressed -> 45 wide
        }
      })
    )

    const widthByDate = Object.fromEntries(
      outcome.series.map((s) => [marketDateOf(s.entryTimestamp), s.definition.wingWidth])
    )
    expect(widthByDate).toEqual({
      '2025-06-02': 20,
      '2025-06-03': 20,
      '2025-06-04': 30,
      '2025-06-05': 30,
      '2025-06-06': 45
    })
  })

  it('records the gauge level beside the width it produced', async () => {
    const outcome = await runStudy(
      vixConfig({}, { from: '2025-06-04', to: '2025-06-04' }),
      makeSource({ vixByDate: { '2025-06-04': 25.5 } })
    )

    const trade = outcome.trades[0]!
    expect(trade.entryIndicators).toMatchObject({ gaugeLevel: 25.5, gaugeAgeMinutes: 0 })
    expect(trade.definition.wingWidth).toBe(30)
  })

  it('honours custom thresholds and widths', async () => {
    const outcome = await runStudy(
      vixConfig(
        { vixLowThreshold: 20, vixLowWidth: 10, vixHighThreshold: 40, vixMidWidth: 50, vixHighWidth: 75 },
        { from: '2025-06-04', to: '2025-06-04' }
      ),
      makeSource({ vixByDate: { '2025-06-04': 19 } })
    )

    expect(outcome.series[0]!.definition.wingWidth).toBe(10)
  })

  it('falls back to the previous session close when intraday gauge bars are missing', async () => {
    const outcome = await runStudy(
      vixConfig({}, { from: '2025-06-04', to: '2025-06-04' }),
      makeSource({
        vixByDate: { '2025-06-02': 12, '2025-06-03': 12, '2025-06-04': 40 },
        gaugeMinutesMissing: ['2025-06-04']
      })
    )

    // The entry day's own close of 40 is not knowable at 09:35; the previous
    // session's 12 is, and it must be what sizes the trade.
    expect(outcome.series[0]!.definition.wingWidth).toBe(20)
    expect(outcome.trades[0]!.entryIndicators).toMatchObject({ gaugeLevel: 12 })
  })

  it('skips a session rather than trading it at a nominal width', async () => {
    const outcome = await runStudy(
      vixConfig({}, { from: '2025-06-02', to: '2025-06-02' }),
      makeSource({ vixByDate: {}, noGaugeAtAll: true })
    )

    expect(outcome.series).toHaveLength(0)
    expect(outcome.skipped[0]!.reason).toContain('I:VIX')
    expect(outcome.skipped[0]!.reason).toContain('banded wing width')
  })

  it('refuses an invalid band list outright instead of running', async () => {
    const config = vixConfig()
    const broken: StudyConfig = {
      ...config,
      wingWidthRule: {
        type: 'volatilityBands',
        ticker: GAUGE,
        bands: [{ below: 32, wingWidth: 20 }, { below: 17, wingWidth: 30 }, { wingWidth: 45 }]
      }
    }
    await expect(runStudy(broken, makeSource({ vixByDate: { '2025-06-02': 12 } }))).rejects.toThrow(
      /must increase/
    )
  })

  it('blocks the run in preflight when no gauge history is cached at all', async () => {
    const preflight = await preflightStudy(
      vixConfig(),
      makeSource({ vixByDate: {}, noGaugeAtAll: true })
    )
    expect(preflight.blockers.join(' ')).toContain('No I:VIX history is cached')
  })

  it('passes preflight when the gauge is present', async () => {
    const preflight = await preflightStudy(
      vixConfig(),
      makeSource({
        vixByDate: Object.fromEntries(
          tradingDaysBetween('2025-04-01', '2025-06-06').map((d) => [d, 18])
        )
      })
    )
    expect(preflight.blockers).toEqual([])
  })
})
