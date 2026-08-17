import { describe, expect, it } from 'vitest'
import type { ButterflyDefinition, ButterflyObservation, ButterflySeries } from '../domain/butterfly.js'
import { DEFAULT_PRICING } from '../domain/butterfly.js'
import {
  centerTouch,
  combine,
  holdToExpiration,
  profitTarget,
  stopLoss,
  targetWithStop,
  tentEntry,
  timeExit,
  trailingProfit
} from './exits.js'
import { simulateAll, simulateTrade } from './simulate.js'

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

const ENTRY_DEBIT = 2
const START = Date.UTC(2025, 5, 17, 13, 35)

interface PointSpec {
  value: number
  dte?: number
  tradingDte?: number
  underlying?: number
  /** Explicit intra-minute bounds, for ambiguity tests. */
  bounds?: { low: number; high: number }
  stale?: boolean
}

/** Builds a series from explicit butterfly values, one per minute. */
function makeSeries(points: readonly (number | PointSpec)[]): ButterflySeries {
  const observations: ButterflyObservation[] = points.map((raw, i) => {
    const spec: PointSpec = typeof raw === 'number' ? { value: raw } : raw
    const observation: ButterflyObservation = {
      timestamp: START + i * 60_000,
      butterflyValue: spec.value,
      pnlDollars: (spec.value - ENTRY_DEBIT) * 100,
      pnlPct: ((spec.value - ENTRY_DEBIT) / ENTRY_DEBIT) * 100,
      dte: spec.dte ?? 3,
      tradingDte: spec.tradingDte ?? 2,
      minutesSinceEntry: i,
      stale: spec.stale ?? false,
      maxLegAgeMs: spec.stale ? 60_000 : 0
    }
    if (spec.underlying !== undefined) {
      observation.underlyingPrice = spec.underlying
      const distance = Math.abs(spec.underlying - DEF.centerStrike)
      observation.distanceToCenter = distance
      observation.normalizedDistanceToCenter = distance / DEF.wingWidth
    }
    if (spec.bounds) {
      observation.valueLowerBound = spec.bounds.low
      observation.valueUpperBound = spec.bounds.high
    }
    return observation
  })

  return {
    definition: DEF,
    entryDebit: ENTRY_DEBIT,
    entryTimestamp: START,
    observations,
    quality: {
      expectedMinutes: observations.length,
      pricedMinutes: observations.length,
      freshMinutes: observations.length,
      staleMinutes: 0,
      unpricedMinutes: 0,
      longestStaleRunMinutes: 0,
      missingByLeg: { lower: 0, center: 0, upper: 0 },
      coverage: 1,
      freshness: 1
    },
    pricing: { ...DEFAULT_PRICING, slippage: 0 },
    warnings: []
  }
}

/** The path from the project spec: 2.00 entry, then 2.20, 3.00, 4.00, 3.20. */
const SPEC_PATH = makeSeries([2.0, 2.2, 3.0, 4.0, 3.2])

describe('the specification example', () => {
  it('exits a 100% target at 4.00', () => {
    const result = simulateTrade(SPEC_PATH, profitTarget(100))
    expect(result.exitValue).toBeCloseTo(4.0, 10)
    expect(result.exitReason).toBe('profitTarget')
    expect(result.pnlPct).toBeCloseTo(100, 6)
    expect(result.pnlDollars).toBeCloseTo(200, 6)
    expect(result.holdingMinutes).toBe(3)
    expect(result.ambiguous).toBe(false)
  })

  it('holds to the end for the same path', () => {
    const result = simulateTrade(SPEC_PATH, holdToExpiration())
    expect(result.exitValue).toBeCloseTo(3.2, 10)
    expect(result.exitReason).toBe('expiration')
    expect(result.pnlPct).toBeCloseTo(60, 6)
    // Held to the end, so the peak of +100% was given back down to +60%.
    expect(result.excursions.mfe?.pct).toBeCloseTo(100, 6)
    expect(result.profitGiveback).toBeCloseTo(80, 6)
    expect(result.mfeCaptureRatio).toBeCloseTo(0.6, 6)
  })

  it('exits a 50% target at the threshold, not at the overshoot', () => {
    // The mark jumps 2.20 -> 3.00, straddling the 3.00 threshold exactly.
    const result = simulateTrade(SPEC_PATH, profitTarget(50))
    expect(result.exitValue).toBeCloseTo(3.0, 10)
    expect(result.pnlPct).toBeCloseTo(50, 6)
    expect(result.holdingMinutes).toBe(2)
  })

  it('does not credit a gap through the target', () => {
    // Value leaps from 2.20 straight to 5.00, well past a +100% target of 4.00.
    const gapped = makeSeries([2.0, 2.2, 5.0])
    const result = simulateTrade(gapped, profitTarget(100))
    // Filling at 5.00 would hand the strategy a gain it never had to earn.
    expect(result.exitValue).toBeCloseTo(4.0, 10)
    expect(result.pnlPct).toBeCloseTo(100, 6)
  })

  it('never reaches a 200% target and falls through to the end', () => {
    const result = simulateTrade(SPEC_PATH, profitTarget(200))
    expect(result.exitReason).toBe('expiration')
    expect(result.pnlPct).toBeCloseTo(60, 6)
  })

  it('cannot fill a target above the butterfly wing width', () => {
    const series = makeSeries([
      { value: 2, bounds: { low: -50, high: 100 } },
      { value: 3, bounds: { low: -50, high: 100 } }
    ])
    const result = simulateTrade(series, profitTarget(1500))
    expect(result.exitReason).toBe('expiration')
    expect(result.exitValue).toBe(3)
  })
})

describe('stop loss', () => {
  it('exits at the stop threshold', () => {
    // 2.00 -> 1.50 -> 0.90; a 50% stop sits at 1.00.
    const result = simulateTrade(makeSeries([2.0, 1.5, 0.9]), stopLoss(50))
    expect(result.exitReason).toBe('stopLoss')
    expect(result.exitValue).toBeCloseTo(1.0, 10)
    expect(result.pnlPct).toBeCloseTo(-50, 6)
  })

  it('cannot exit below zero on a 100% stop', () => {
    const result = simulateTrade(makeSeries([2.0, 1.0, 0.0]), stopLoss(100))
    expect(result.exitValue).toBe(0)
    expect(result.pnlPct).toBeCloseTo(-100, 6)
  })

  it('does not fire while the trade stays above the stop', () => {
    const result = simulateTrade(makeSeries([2.0, 1.9, 2.5]), stopLoss(50))
    expect(result.exitReason).toBe('expiration')
  })
})

describe('time exit', () => {
  it('closes at the configured DTE', () => {
    const series = makeSeries([
      { value: 2.0, dte: 5 },
      { value: 2.5, dte: 4 },
      { value: 3.0, dte: 2 },
      { value: 3.5, dte: 1 }
    ])
    const result = simulateTrade(series, timeExit({ atDte: 2 }))
    expect(result.exitReason).toBe('timeExit')
    expect(result.exitDte).toBe(2)
    expect(result.exitValue).toBeCloseTo(3.0, 10)
  })

  it('can key off trading DTE instead of calendar DTE', () => {
    const series = makeSeries([
      { value: 2.0, dte: 4, tradingDte: 3 },
      { value: 2.5, dte: 3, tradingDte: 1 }
    ])
    const result = simulateTrade(series, timeExit({ atDte: 1, useTradingDte: true }))
    expect(result.exitReason).toBe('timeExit')
    expect(result.holdingMinutes).toBe(1)
  })

  it('waits for a fresh mark when the scheduled DTE first arrives stale', () => {
    const series = makeSeries([
      { value: 2.0, dte: 3 },
      { value: 8.0, dte: 2, stale: true },
      { value: 3.0, dte: 2 }
    ])
    const result = simulateTrade(series, timeExit({ atDte: 2 }))
    expect(result.holdingMinutes).toBe(2)
    expect(result.exitValue).toBe(3)
  })
})

describe('underlying-based exits', () => {
  it('exits when the underlying reaches the center strike', () => {
    const series = makeSeries([
      { value: 2.0, underlying: 5900 },
      { value: 3.0, underlying: 5885 },
      { value: 4.0, underlying: 5875 }
    ])
    const result = simulateTrade(series, centerTouch())
    expect(result.exitReason).toBe('centerTouch')
    expect(result.exitUnderlying).toBe(5875)
  })

  it('exits when the underlying enters the tent', () => {
    const series = makeSeries([
      { value: 2.0, underlying: 5910 }, // 1.4 wings away
      { value: 2.5, underlying: 5890 }, // 0.6 wings away
      { value: 3.0, underlying: 5880 }
    ])
    const result = simulateTrade(series, tentEntry(0.75))
    expect(result.exitReason).toBe('tentEntry')
    expect(result.holdingMinutes).toBe(1)
  })

  it('cannot fire without underlying data, and says so by holding', () => {
    // No underlying on any observation: the rule must not silently behave like
    // a different strategy.
    const result = simulateTrade(makeSeries([2.0, 3.0, 4.0]), centerTouch())
    expect(result.exitReason).toBe('expiration')
  })
})

describe('trailing profit', () => {
  it('trails as a fraction of the peak', () => {
    // Peak +100% at 4.00; giving back 30% of the peak exits at +70% => 3.40.
    const series = makeSeries([2.0, 3.0, 4.0, 3.5, 3.3])
    const result = simulateTrade(series, trailingProfit({ triggerPct: 100, givebackFractionOfPeak: 0.3 }))
    expect(result.exitReason).toBe('trailingProfit')
    expect(result.pnlPct).toBeCloseTo(65, 6) // 3.30 against a 2.00 debit
  })

  it('trails in percentage points, which is a different rule', () => {
    /*
     * Peak is +150% (5.00) against a 2.00 debit.
     *   30 points back      -> exit at +120%, so 4.30 (+115%) triggers
     *   30% of peak back    -> exit at +105%, so 4.30 does NOT trigger
     * The two rules therefore part company on the same path, which is exactly
     * why both are supported rather than treated as interchangeable.
     */
    const series = makeSeries([2.0, 5.0, 4.3, 3.0])

    const points = simulateTrade(series, trailingProfit({ triggerPct: 100, givebackPoints: 30 }))
    expect(points.exitReason).toBe('trailingProfit')
    expect(points.pnlPct).toBeCloseTo(115, 6)
    expect(points.holdingMinutes).toBe(2)

    const fraction = simulateTrade(series, trailingProfit({ triggerPct: 100, givebackFractionOfPeak: 0.3 }))
    expect(fraction.exitReason).toBe('trailingProfit')
    // Held one minute longer and gave back far more.
    expect(fraction.pnlPct).toBeCloseTo(50, 6)
    expect(fraction.holdingMinutes).toBe(3)
  })

  it('stays inactive until the trigger is reached', () => {
    // Peaks at +40%, never arming a +100% trigger, then fades.
    const series = makeSeries([2.0, 2.8, 2.1, 1.9])
    const result = simulateTrade(series, trailingProfit({ triggerPct: 100, givebackFractionOfPeak: 0.3 }))
    expect(result.exitReason).toBe('expiration')
    expect(result.pnlPct).toBeCloseTo(-5, 6)
  })

  it('rejects a configuration with no give-back defined', () => {
    expect(() => trailingProfit({ triggerPct: 100 })).toThrow(/givebackFractionOfPeak or givebackPoints/)
  })
})

describe('execution ambiguity', () => {
  it('flags a target reachable intra-minute but unconfirmed by the mark', () => {
    // Mark only 3.00, but the legs' bounds allow up to 4.50, past a 4.00 target.
    const series = makeSeries([2.0, { value: 3.0, bounds: { low: 2.5, high: 4.5 } }])
    const result = simulateTrade(series, profitTarget(100))
    expect(result.exitReason).toBe('profitTarget')
    expect(result.ambiguous).toBe(true)
    expect(result.note).toMatch(/did not confirm/)
  })

  it('does not flag ambiguity when bounds stay clear of the threshold', () => {
    const series = makeSeries([2.0, { value: 3.0, bounds: { low: 2.9, high: 3.2 } }, 4.0])
    const result = simulateTrade(series, profitTarget(100))
    expect(result.ambiguous).toBe(false)
    expect(result.holdingMinutes).toBe(2)
  })

  it('assumes the adverse outcome when target and stop both trigger', () => {
    // Mark collapses to 1.00 (the -50% stop) while bounds also reach the
    // +100% target at 4.00. The order inside the minute is unknowable.
    const series = makeSeries([2.0, { value: 1.0, bounds: { low: 0.8, high: 4.2 } }])
    const result = simulateTrade(series, targetWithStop(100, 50))
    expect(result.exitReason).toBe('stopLoss')
    expect(result.ambiguous).toBe(true)
    expect(result.note).toMatch(/adverse outcome was assumed/)
    expect(result.pnlPct).toBeCloseTo(-50, 6)
  })

  it('takes the target cleanly when no stop is reachable', () => {
    const series = makeSeries([2.0, { value: 4.0, bounds: { low: 3.8, high: 4.2 } }])
    const result = simulateTrade(series, targetWithStop(100, 50))
    expect(result.exitReason).toBe('profitTarget')
    expect(result.ambiguous).toBe(false)
  })
})

describe('combined strategies', () => {
  it('prefers the adverse rule when several fire together', () => {
    const series = makeSeries([
      { value: 2.0, underlying: 5910, dte: 3 },
      { value: 4.0, underlying: 5875, dte: 3 }
    ])
    const strategy = combine('mix', 'target or center touch', [profitTarget(100), centerTouch()])
    const result = simulateTrade(series, strategy)
    // Center touch is treated as adverse: reaching the center is where a
    // butterfly's risk of decay reversal concentrates.
    expect(result.exitReason).toBe('centerTouch')
    expect(result.ambiguous).toBe(true)
  })

  it('does not mark ambiguity when only one rule fires', () => {
    const series = makeSeries([2.0, 4.0])
    const result = simulateTrade(series, targetWithStop(100, 50))
    expect(result.ambiguous).toBe(false)
  })
})

describe('excursions and capture', () => {
  it('measures excursions only over the held portion of the path', () => {
    // Exits at +50% on minute 2, after which the path soars to +300%.
    const series = makeSeries([2.0, 2.5, 3.0, 8.0])
    const result = simulateTrade(series, profitTarget(50))
    // The unheld spike must not appear in this trade's MFE.
    expect(result.excursions.mfe?.pct).toBeCloseTo(50, 6)
    expect(result.mfeCaptureRatio).toBeCloseTo(1, 6)
    expect(result.profitGiveback).toBeCloseTo(0, 6)
  })

  it('reports no capture ratio for a trade that never went positive', () => {
    const result = simulateTrade(makeSeries([2.0, 1.5, 1.0]), holdToExpiration())
    expect(result.mfeCaptureRatio).toBeNull()
    expect(result.profitGiveback).toBe(0)
  })

  it('records when each threshold was first reached', () => {
    const result = simulateTrade(makeSeries([2.0, 2.5, 3.0, 4.0]), holdToExpiration())
    expect(result.firstReached['25']).toBe(1)
    expect(result.firstReached['50']).toBe(2)
    expect(result.firstReached['100']).toBe(3)
    expect(result.firstReached['200']).toBeNull()
  })
})

describe('exit slippage', () => {
  it('reduces the realized exit value', () => {
    const result = simulateTrade(SPEC_PATH, profitTarget(100), { exitSlippage: 0.1 })
    expect(result.exitValue).toBeCloseTo(3.9, 10)
    expect(result.pnlPct).toBeCloseTo(95, 6)
  })
})

describe('simulateAll', () => {
  it('runs every strategy against the identical observation series', () => {
    const strategies = [
      holdToExpiration(),
      profitTarget(50),
      profitTarget(100),
      profitTarget(200),
      stopLoss(50),
      targetWithStop(100, 50),
      timeExit({ atDte: 1 })
    ]
    const results = simulateAll(SPEC_PATH, strategies)

    expect(results).toHaveLength(strategies.length)
    // Every result describes the same entry: same timestamp and same debit.
    expect(new Set(results.map((r) => r.entryTimestamp)).size).toBe(1)
    expect(new Set(results.map((r) => r.entryDebit)).size).toBe(1)

    const byId = new Map(results.map((r) => [r.strategyId, r]))
    expect(byId.get('hold')?.pnlPct).toBeCloseTo(60, 6)
    expect(byId.get('tp50')?.pnlPct).toBeCloseTo(50, 6)
    expect(byId.get('tp100')?.pnlPct).toBeCloseTo(100, 6)
    expect(byId.get('tp200')?.pnlPct).toBeCloseTo(60, 6) // never reached
  })
})
