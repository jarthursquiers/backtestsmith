import { describe, expect, it } from 'vitest'
import type { OptionBar, UnderlyingBar } from '../domain/bars.js'
import type { OptionContract, OptionType } from '../domain/contracts.js'
import type { StudyConfig } from '../shared/study.js'
import {
  easternToTimestamp,
  marketDateOf,
  sessionMinuteCount,
  toEastern,
  tradingDaysBetween
} from '../core/time/marketTime.js'
import {
  buildStudyConfig,
  defaultStrategyParams,
  requireStrategy
} from '../shared/strategyCatalog.js'
import { preflightStudy, runStudy, type StudyDataSource } from './studyRunner.js'

/**
 * End-to-end cover for the 0DTE opening range strategy.
 *
 * The synthetic market is deliberately generous - every minute of every leg is
 * priced - so that anything the study skips is a decision the *rules* made,
 * not an artefact of missing data.
 */

const STRIKES = Array.from({ length: 121 }, (_, i) => 5700 + i * 5)

/** Convex by strike, so every symmetric butterfly has a small positive debit. */
function syntheticPrice(strike: number): number {
  return 20 + ((strike - 6000) ** 2) / 400
}

function tickerFor(expiration: string, type: OptionType, strike: number): string {
  return `O:SPXW${expiration.replace(/-/g, '').slice(2)}${type === 'put' ? 'P' : 'C'}${String(strike * 1000).padStart(8, '0')}`
}

/** The intraday shape of one session, as a close for each minute from 09:30. */
type SessionShape = (minuteIndex: number) => number

/** Opening range 5995-6005, then a 09:45-09:49 candle closing below it. */
const BEARISH_BREAK: SessionShape = (i) => {
  if (i < 15) return i % 2 === 0 ? 6005 : 5995
  return 5990
}

/** Opening range 5995-6005 that is never left. */
const NO_BREAK: SessionShape = (i) => (i % 2 === 0 ? 6005 : 5995)

function makeSource(shapes: Record<string, SessionShape>, fallback: SessionShape = NO_BREAK): StudyDataSource {
  return {
    async getDailyBars(_ticker, from, to) {
      const out: UnderlyingBar[] = []
      for (const date of tradingDaysBetween(from, to)) {
        out.push({
          ticker: 'I:SPX',
          timestamp: easternToTimestamp(date, 16, 0),
          open: 6000, high: 6010, low: 5990, close: 6000
        })
      }
      return out
    },

    async getUnderlyingMinutes(_ticker, date) {
      const shape = shapes[date] ?? fallback
      const open = easternToTimestamp(date, 9, 30)
      return Array.from({ length: sessionMinuteCount(date) }, (_, i) => {
        const price = shape(i)
        return {
          ticker: 'I:SPX',
          timestamp: open + i * 60_000,
          open: price, high: price, low: price, close: price
        }
      })
    },

    // Every weekday lists a chain, as SPX has since daily expirations arrived.
    async getChain(_underlying, expiration, type) {
      const dow = new Date(`${expiration}T00:00:00Z`).getUTCDay()
      if (dow === 0 || dow === 6) return []
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
            ticker,
            timestamp: open + i * 60_000,
            open: price, high: price, low: price, close: price,
            volume: 5
          })
        }
      }
      return out
    }
  }
}

function orbConfig(overrides: Partial<StudyConfig> = {}): StudyConfig {
  const strategy = requireStrategy('orb-0dte-butterfly')
  return {
    ...buildStudyConfig({
      strategyId: strategy.id,
      params: defaultStrategyParams(strategy),
      from: '2025-06-02',
      to: '2025-06-06',
      managements: ['hold', 'at1545', 'tp50', 'elapsed60m'],
      pricing: { model: 'close', slippage: 0, missingDataMode: 'carryForward', maxStaleMinutes: 5 },
      minimumCoverage: 0
    }),
    ...overrides
  }
}

describe('the 0DTE opening range study', () => {
  it('enters on the bar after the confirming candle, in the breakout direction', async () => {
    const config = orbConfig({ from: '2025-06-02', to: '2025-06-02' })
    const outcome = await runStudy(config, makeSource({ '2025-06-02': BEARISH_BREAK }))

    expect(outcome.skipped).toEqual([])
    expect(outcome.series).toHaveLength(1)

    const series = outcome.series[0]!
    expect(series.definition.direction).toBe('bearish')
    expect(series.definition.optionType).toBe('put')
    // 09:30 open, 15-minute range, 5-minute confirmation: 09:50 is the first
    // minute a trader could have acted on.
    expect(toEastern(series.entryTimestamp).toFormat('HH:mm')).toBe('09:50')
  })

  it('trades the entry session itself, not the next listed expiration', async () => {
    const outcome = await runStudy(
      orbConfig({ from: '2025-06-03', to: '2025-06-03' }),
      makeSource({ '2025-06-03': BEARISH_BREAK })
    )

    expect(outcome.series).toHaveLength(1)
    // 2025-06-03 is a Tuesday, which the Mon/Wed/Fri default would have missed.
    expect(outcome.series[0]!.definition.expiration).toBe('2025-06-03')
    expect(marketDateOf(outcome.series[0]!.entryTimestamp)).toBe('2025-06-03')
  })

  it('places the near wing at or outside the expected move, and the far wing beyond it', async () => {
    const outcome = await runStudy(
      orbConfig({ from: '2025-06-02', to: '2025-06-02' }),
      makeSource({ '2025-06-02': BEARISH_BREAK })
    )

    const { definition, entryUnderlying } = outcome.series[0]!
    expect(entryUnderlying).toBe(5990)

    // The straddle at the 5990 strike prices both legs at 20.25, so the
    // expected move is 40.5 points and the near wing must sit at or below
    // 5949.5. For a downside butterfly the near wing is the upper strike.
    expect(definition.upperStrike).toBeLessThanOrEqual(5990 - 40.5)
    expect(definition.upperStrike).toBeGreaterThan(5990 - 40.5 - 5)
    expect(definition.centerStrike).toBe(definition.upperStrike - 25)
    expect(definition.lowerStrike).toBe(definition.centerStrike - 25)
  })

  it('closes the trade the same session it opened', async () => {
    const outcome = await runStudy(
      orbConfig({ from: '2025-06-02', to: '2025-06-02' }),
      makeSource({ '2025-06-02': BEARISH_BREAK })
    )

    for (const trade of outcome.trades) {
      expect(marketDateOf(trade.exitTimestamp)).toBe('2025-06-02')
      expect(trade.exitDte).toBe(0)
    }
  })

  it('runs every selected management method against the one entry', async () => {
    const outcome = await runStudy(
      orbConfig({ from: '2025-06-02', to: '2025-06-02' }),
      makeSource({ '2025-06-02': BEARISH_BREAK })
    )

    expect(outcome.trades.map((t) => t.strategyId).sort()).toEqual([
      'at1545',
      'elapsed60m',
      'hold',
      'tp50'
    ])
    // The wall-clock rule is the one that can only mean something intraday.
    const timed = outcome.trades.find((t) => t.strategyId === 'at1545')!
    expect(toEastern(timed.exitTimestamp).toFormat('HH:mm')).toBe('15:45')
  })

  it('skips a session whose candles never close outside the range, and says why', async () => {
    const outcome = await runStudy(
      orbConfig({ from: '2025-06-02', to: '2025-06-02' }),
      makeSource({ '2025-06-02': NO_BREAK })
    )

    expect(outcome.series).toHaveLength(0)
    expect(outcome.skipped[0]!.reason).toContain('closed outside')
  })

  it('skips a session with no intraday bars rather than inventing a range', async () => {
    const source = makeSource({ '2025-06-02': BEARISH_BREAK })
    const outcome = await runStudy(orbConfig({ from: '2025-06-02', to: '2025-06-02' }), {
      ...source,
      getUnderlyingMinutes: async () => []
    })

    expect(outcome.series).toHaveLength(0)
    expect(outcome.skipped[0]!.reason).toContain('no intraday index bars')
  })

  it('takes the other side when the breakout is faded', async () => {
    const config = orbConfig({ from: '2025-06-02', to: '2025-06-02' })
    const faded: StudyConfig = {
      ...config,
      entry: { ...(config.entry as Extract<StudyConfig['entry'], { type: 'orb' }>), invert: true }
    }
    const outcome = await runStudy(faded, makeSource({ '2025-06-02': BEARISH_BREAK }))

    expect(outcome.series[0]!.definition.direction).toBe('bullish')
    expect(outcome.series[0]!.definition.optionType).toBe('call')
    expect(outcome.series[0]!.definition.lowerStrike).toBeGreaterThan(5990)
  })

  it('never generates an entry earlier than the range plus one confirmation candle', async () => {
    const outcome = await runStudy(
      orbConfig({ from: '2025-06-02', to: '2025-06-06' }),
      makeSource({}, BEARISH_BREAK)
    )

    expect(outcome.series.length).toBeGreaterThan(1)
    for (const series of outcome.series) {
      const entry = toEastern(series.entryTimestamp)
      expect(entry.hour * 60 + entry.minute).toBeGreaterThanOrEqual(9 * 60 + 50)
    }
  })
})

describe('the 0DTE opening range preflight', () => {
  it('blocks the run outright when no intraday index history is cached', async () => {
    const source = makeSource({}, BEARISH_BREAK)
    const preflight = await preflightStudy(orbConfig(), {
      ...source,
      getUnderlyingMinutes: async () => []
    })

    expect(preflight.blockers.join(' ')).toContain('opening range breakout')
  })

  it('passes when the minute history is there', async () => {
    const preflight = await preflightStudy(orbConfig(), makeSource({}, BEARISH_BREAK))
    expect(preflight.blockers).toEqual([])
  })
})
