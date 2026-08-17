import { describe, expect, it } from 'vitest'
import type { ButterflyDefinition } from '../domain/butterfly.js'
import type { TradeResult } from '../shared/trade.js'
import {
  buildEquityCurve,
  computeMetrics,
  downsideDeviation,
  longestRun,
  median,
  scaledPnl,
  standardDeviation
} from './metrics.js'

const DEF: ButterflyDefinition = {
  underlying: 'SPX',
  direction: 'bearish',
  optionType: 'put',
  expiration: '2025-06-20',
  lowerStrike: 5850,
  centerStrike: 5875,
  upperStrike: 5900,
  lowerTicker: 'L',
  centerTicker: 'C',
  upperTicker: 'U',
  wingWidth: 25,
  quantity: 1
}

const DAY = 86_400_000
const START = Date.UTC(2025, 5, 2, 20, 0)

/** A trade with only the fields the metrics engine reads. */
function trade(
  index: number,
  pnlDollars: number,
  opts: {
    entryDebit?: number
    mfePct?: number
    maePct?: number
    capture?: number | null
    giveback?: number
    holdingMinutes?: number
    reached?: string[]
    lowAfter?: Record<string, number>
    ambiguous?: boolean
  } = {}
): TradeResult {
  const entryDebit = opts.entryDebit ?? 2
  const pnlPct = (pnlDollars / (entryDebit * 100)) * 100

  const firstReached: Record<string, number | null> = {}
  const lowestAfterReaching: Record<string, number | null> = {}
  for (const t of ['25', '50', '100', '150', '200', '300']) {
    const hit = opts.reached?.includes(t) ?? false
    firstReached[t] = hit ? 10 : null
    lowestAfterReaching[t] = hit ? (opts.lowAfter?.[t] ?? pnlPct) : null
  }

  return {
    definition: DEF,
    strategyId: 'test',
    strategyLabel: 'Test',
    entryTimestamp: START + index * DAY,
    entryDebit,
    exitTimestamp: START + index * DAY + 3600_000,
    exitValue: entryDebit + pnlDollars / 100,
    exitReason: 'expiration',
    ambiguous: opts.ambiguous ?? false,
    pnlDollars,
    pnlPct,
    holdingMinutes: opts.holdingMinutes ?? 120,
    exitDte: 0,
    excursions: {
      mfe: { dollars: 0, pct: opts.mfePct ?? Math.max(0, pnlPct), timestamp: 0, minutesSinceEntry: 0, dte: 3 },
      mae: { dollars: 0, pct: opts.maePct ?? Math.min(0, pnlPct), timestamp: 0, minutesSinceEntry: 0, dte: 3 }
    },
    profitGiveback: opts.giveback ?? 0,
    mfeCaptureRatio: opts.capture === undefined ? 1 : opts.capture,
    firstReached,
    lowestAfterReaching,
    quality: {
      expectedMinutes: 390, pricedMinutes: 390, freshMinutes: 390, staleMinutes: 0,
      unpricedMinutes: 0, longestStaleRunMinutes: 0,
      missingByLeg: { lower: 0, center: 0, upper: 0 }, coverage: 1, freshness: 1
    }
  }
}

describe('statistical helpers', () => {
  it('computes a median for odd and even counts', () => {
    expect(median([3, 1, 2])).toBe(2)
    expect(median([4, 1, 3, 2])).toBe(2.5)
    expect(median([])).toBe(0)
  })

  it('uses the sample standard deviation', () => {
    // n-1 denominator: mean 3, deviations 4+1+0+1+4 = 10, /4 = 2.5.
    expect(standardDeviation([1, 2, 3, 4, 5])).toBeCloseTo(Math.sqrt(2.5), 10)
    expect(standardDeviation([7])).toBe(0)
  })

  it('measures only downside deviation', () => {
    // Upside excursions must not count as risk.
    expect(downsideDeviation([10, 20, 30])).toBe(0)
    expect(downsideDeviation([-3, 4, -4])).toBeCloseTo(Math.sqrt((9 + 16) / 2), 10)
  })

  it('finds the longest qualifying run', () => {
    expect(longestRun([1, 1, -1, 1, 1, 1, -1], (v) => v > 0)).toBe(3)
    expect(longestRun([-1, -1], (v) => v > 0)).toBe(0)
  })
})

describe('position sizing', () => {
  it('reports raw dollars for one contract', () => {
    expect(scaledPnl(trade(0, 250), 'oneContract', 1000)).toBe(250)
  })

  it('normalizes each trade to equal risk', () => {
    // A 2.00 debit risks $200; scaling to $1,000 multiplies the result by 5.
    expect(scaledPnl(trade(0, 250, { entryDebit: 2 }), 'equalRisk', 1000)).toBeCloseTo(1250, 6)
    // A 5.00 debit risks $500, so the same dollar gain scales by only 2.
    expect(scaledPnl(trade(0, 250, { entryDebit: 5 }), 'equalRisk', 1000)).toBeCloseTo(500, 6)
  })

  it('handles a zero debit without dividing by zero', () => {
    expect(scaledPnl(trade(0, 100, { entryDebit: 0 }), 'equalRisk', 1000)).toBe(0)
  })
})

describe('equity curve', () => {
  it('accumulates in exit order and tracks drawdown from the peak', () => {
    const curve = buildEquityCurve(
      [trade(0, 100), trade(1, -50), trade(2, -30), trade(3, 200)],
      'oneContract',
      1000
    )

    expect(curve.map((p) => p.equity)).toEqual([100, 50, 20, 220])
    expect(curve.map((p) => p.peak)).toEqual([100, 100, 100, 220])
    // Drawdown is measured against the running peak, so the trough is -80.
    expect(curve.map((p) => p.drawdown)).toEqual([0, -50, -80, 0])
  })

  it('orders by exit rather than entry', () => {
    // A trade entered first but exited last must land last on the curve.
    const early = trade(0, 100)
    const late = { ...trade(1, -40), exitTimestamp: early.exitTimestamp - 1000 }
    const curve = buildEquityCurve([early, late], 'oneContract', 1000)
    expect(curve.map((p) => p.equity)).toEqual([-40, 60])
  })
})

describe('summary metrics', () => {
  const trades = [
    trade(0, 200, { reached: ['25', '50', '100'], capture: 1 }),
    trade(1, -100, { capture: null }),
    trade(2, -100, { capture: null }),
    trade(3, 400, { reached: ['25', '50', '100', '150', '200'], capture: 0.5, giveback: 400 }),
    trade(4, -200, { capture: null })
  ]

  it('counts outcomes and win rate', () => {
    const m = computeMetrics(trades)
    expect(m.totalTrades).toBe(5)
    expect(m.winningTrades).toBe(2)
    expect(m.losingTrades).toBe(3)
    expect(m.winRate).toBeCloseTo(40, 6)
  })

  it('summarizes P/L with medians alongside means', () => {
    const m = computeMetrics(trades)
    expect(m.totalPnl).toBe(200)
    expect(m.averageTrade).toBeCloseTo(40, 6)
    // The median is negative while the mean is positive: exactly the skew that
    // makes reporting only an average misleading.
    expect(m.medianTrade).toBe(-100)
    expect(m.averageWinner).toBe(300)
    expect(m.averageLoser).toBeCloseTo(-133.333, 3)
    expect(m.largestWinner).toBe(400)
    expect(m.largestLoser).toBe(-200)
  })

  it('computes profit factor and expectancy', () => {
    const m = computeMetrics(trades)
    // 600 gross profit over 400 gross loss.
    expect(m.profitFactor).toBeCloseTo(1.5, 6)
    expect(m.expectancy).toBeCloseTo(40, 6)
  })

  it('returns null profit factor when nothing lost', () => {
    // Not Infinity: with no losses the ratio is unanswerable, not enormous.
    expect(computeMetrics([trade(0, 100), trade(1, 50)]).profitFactor).toBeNull()
  })

  it('measures drawdown across the curve', () => {
    const m = computeMetrics(trades)
    // 200, 100, 0, 400, 200: the trough is 0 against a peak of 200.
    expect(m.maxDrawdown).toBe(-200)
    expect(m.averageDrawdown).toBeLessThan(0)
  })

  it('tracks consecutive runs', () => {
    const m = computeMetrics(trades)
    expect(m.maxConsecutiveLosses).toBe(2)
    expect(m.maxConsecutiveWins).toBe(1)
  })

  it('reports how often each threshold was reached', () => {
    const m = computeMetrics(trades)
    expect(m.reachedPct['25']).toBeCloseTo(40, 6)
    expect(m.reachedPct['100']).toBeCloseTo(40, 6)
    expect(m.reachedPct['200']).toBeCloseTo(20, 6)
    expect(m.reachedPct['300']).toBe(0)
  })

  it('excludes trades with no capture ratio from the capture average', () => {
    const m = computeMetrics(trades)
    // Only the two winners have a defined ratio: 1.0 and 0.5.
    expect(m.averageMfeCapture).toBeCloseTo(0.75, 6)
    expect(m.medianMfeCapture).toBeCloseTo(0.75, 6)
  })

  it('labels risk-adjusted figures as per-trade ratios', () => {
    const m = computeMetrics(trades)
    expect(m.returnStdDev).toBeGreaterThan(0)
    expect(m.returnPerUnitRisk).not.toBeNull()
    expect(m.returnPerUnitDownside).not.toBeNull()
  })

  it('handles an empty trade set without dividing by zero', () => {
    const m = computeMetrics([])
    expect(m.totalTrades).toBe(0)
    expect(m.winRate).toBe(0)
    expect(m.totalPnl).toBe(0)
    expect(m.profitFactor).toBeNull()
    expect(m.maxDrawdown).toBe(0)
    expect(m.averageMfeCapture).toBeNull()
    expect(m.returnPerUnitRisk).toBeNull()
  })

  it('counts ambiguous exits so they cannot be overlooked', () => {
    const m = computeMetrics([trade(0, 100, { ambiguous: true }), trade(1, -50)])
    expect(m.ambiguousExits).toBe(1)
  })

  it('changes totals under equal-risk sizing but not the win rate', () => {
    const mixed = [
      trade(0, 200, { entryDebit: 2 }), // risks $200
      trade(1, -200, { entryDebit: 8 }) // risks $800
    ]
    const raw = computeMetrics(mixed, { sizing: 'oneContract' })
    const equal = computeMetrics(mixed, { sizing: 'equalRisk', riskPerTrade: 1000 })

    expect(raw.totalPnl).toBe(0)
    // Normalized, the cheap winner scales up 5x and the costly loser only 1.25x.
    expect(equal.totalPnl).toBeCloseTo(1000 - 250, 6)
    expect(equal.winRate).toBeCloseTo(raw.winRate, 6)
    expect(equal.riskPerTrade).toBe(1000)
    expect(raw.riskPerTrade).toBeNull()
  })
})
