import { describe, expect, it } from 'vitest'
import type { ButterflyDefinition } from '../domain/butterfly.js'
import type { TradeResult } from '../shared/trade.js'
import type { StudyConfig } from '../shared/study.js'
import { valuesFromRange } from '../shared/sweep.js'
import {
  analyzeConditionalPaths,
  analyzeTentApproach,
  histogram,
  medianBy,
  proportionInterval
} from './conditionalPaths.js'
import {
  axisKind,
  estimateSweepCost,
  expandSweep,
  parseValueList
} from './parameterSweep.js'
import { seriesToCsv, studyJsonFilename, studyToJson, toCsv, tradesToCsv } from './exports.js'

const DEF: ButterflyDefinition = {
  underlying: 'SPX', direction: 'bearish', optionType: 'put', expiration: '2025-06-20',
  lowerStrike: 5850, centerStrike: 5875, upperStrike: 5900,
  lowerTicker: 'L', centerTicker: 'C', upperTicker: 'U', wingWidth: 25, quantity: 1
}

/**
 * A trade described by the path facts the analytics actually read: which
 * thresholds it reached, how low it went afterwards, and how close the
 * underlying came to the centre.
 */
function trade(opts: {
  reached?: number[]
  lowAfter?: Record<number, number>
  finalPct?: number
  mfePct?: number
  maePct?: number
  minDistance?: number
  entryTimestamp?: number
  capture?: number | null
  mfeDte?: number
}): TradeResult {
  const finalPct = opts.finalPct ?? 0
  const firstReached: Record<string, number | null> = {}
  const lowestAfterReaching: Record<string, number | null> = {}
  for (const t of [25, 50, 75, 100, 150, 200, 300]) {
    const hit = opts.reached?.includes(t) ?? false
    firstReached[String(t)] = hit ? 10 : null
    lowestAfterReaching[String(t)] = hit ? (opts.lowAfter?.[t] ?? finalPct) : null
  }

  return {
    definition: DEF,
    strategyId: 'hold', strategyLabel: 'Hold to expiration',
    entryTimestamp: opts.entryTimestamp ?? Date.UTC(2025, 5, 2, 13, 35),
    entryDebit: 2,
    exitTimestamp: (opts.entryTimestamp ?? Date.UTC(2025, 5, 2, 13, 35)) + 3600_000,
    exitValue: 2 * (1 + finalPct / 100),
    exitReason: 'expiration', ambiguous: false,
    pnlDollars: finalPct * 2, pnlPct: finalPct,
    holdingMinutes: 120, exitDte: 0,
    excursions: {
      mfe: { dollars: (opts.mfePct ?? Math.max(0, finalPct)) * 2, pct: opts.mfePct ?? Math.max(0, finalPct), timestamp: 0, minutesSinceEntry: 5, dte: opts.mfeDte ?? 3 },
      mae: { dollars: (opts.maePct ?? Math.min(0, finalPct)) * 2, pct: opts.maePct ?? Math.min(0, finalPct), timestamp: 0, minutesSinceEntry: 8, dte: 2 }
    },
    profitGiveback: 0,
    mfeCaptureRatio: opts.capture === undefined ? null : opts.capture,
    firstReached,
    lowestAfterReaching,
    ...(opts.minDistance !== undefined ? { minNormalizedDistance: opts.minDistance } : {}),
    quality: {
      expectedMinutes: 390, pricedMinutes: 390, freshMinutes: 390, staleMinutes: 0,
      unpricedMinutes: 0, longestStaleRunMinutes: 0,
      missingByLeg: { lower: 0, center: 0, upper: 0 }, coverage: 1, freshness: 1
    }
  }
}

describe('proportion intervals', () => {
  it('widens as the sample shrinks', () => {
    const small = proportionInterval(1, 2)
    const large = proportionInterval(500, 1000)
    expect(small.high - small.low).toBeGreaterThan(large.high - large.low)
  })

  it('stays inside zero and one at the extremes', () => {
    const none = proportionInterval(0, 10)
    const all = proportionInterval(10, 10)
    expect(none.low).toBeGreaterThanOrEqual(0)
    expect(all.high).toBeLessThanOrEqual(1)
    // Never claims certainty from a finite sample.
    expect(all.low).toBeLessThan(1)
  })

  it('handles an empty sample', () => {
    expect(proportionInterval(0, 0)).toEqual({ low: 0, high: 0 })
  })
})

describe('conditional path analysis', () => {
  /*
   * Ten trades:
   *   4 never reach +50%
   *   6 reach +50%, of which 3 go on to +100%
   *   of the 6, 2 later fall back to a loss
   */
  const trades = [
    trade({ finalPct: -100 }),
    trade({ finalPct: -100 }),
    trade({ finalPct: -80 }),
    trade({ reached: [25], finalPct: -50 }),
    trade({ reached: [25, 50], finalPct: 60, lowAfter: { 50: 10 } }),
    trade({ reached: [25, 50], finalPct: 55, lowAfter: { 50: 20 } }),
    trade({ reached: [25, 50], finalPct: -70, lowAfter: { 50: -70 } }),
    trade({ reached: [25, 50, 100], finalPct: 120, lowAfter: { 50: 40, 100: 90 } }),
    trade({ reached: [25, 50, 100], finalPct: 150, lowAfter: { 50: 60, 100: 100 } }),
    trade({ reached: [25, 50, 100], finalPct: -90, lowAfter: { 50: -90, 100: -90 } })
  ]

  it('reports the conditional probability of going further', () => {
    const report = analyzeConditionalPaths(trades, [50, 100, 200])
    const row = report.rows.find((r) => r.threshold === 50)!

    expect(row.cohortSize).toBe(6)
    expect(row.cohortShare).toBeCloseTo(0.6, 6)
    // Half of those that reached +50% went on to +100%.
    expect(row.wentOnTo['100']!.count).toBe(3)
    expect(row.wentOnTo['100']!.probability).toBeCloseTo(0.5, 6)
  })

  it('accompanies every probability with an interval', () => {
    const report = analyzeConditionalPaths(trades, [50, 100])
    const estimate = report.rows.find((r) => r.threshold === 50)!.wentOnTo['100']!
    // With n = 6 the interval must be wide enough to discourage over-reading.
    expect(estimate.low).toBeLessThan(0.3)
    expect(estimate.high).toBeGreaterThan(0.7)
  })

  it('detects give-back to a loss after the threshold, not before it', () => {
    const report = analyzeConditionalPaths(trades, [50])
    const row = report.rows.find((r) => r.threshold === 50)!
    // Two of the six went negative after first touching +50%.
    expect(row.fellBackToLoss).toBeCloseTo(2 / 6, 6)
  })

  it('does not count a dip that happened before the threshold', () => {
    // Deeply negative early, then rallies and holds the gain.
    const recovered = trade({ reached: [50], finalPct: 80, maePct: -60, lowAfter: { 50: 30 } })
    const report = analyzeConditionalPaths([recovered], [50])
    expect(report.rows[0]!.fellBackToLoss).toBe(0)
  })

  it('summarizes eventual outcomes for the cohort', () => {
    const report = analyzeConditionalPaths(trades, [50])
    const row = report.rows.find((r) => r.threshold === 50)!
    expect(row.endedProfitable).toBeCloseTo(4 / 6, 6)
    expect(row.medianFinalReturn).toBeGreaterThan(0)
  })

  it('handles a threshold nothing reached', () => {
    const report = analyzeConditionalPaths(trades, [300])
    const row = report.rows.find((r) => r.threshold === 300)!
    expect(row.cohortSize).toBe(0)
    expect(row.fellBackToLoss).toBe(0)
  })
})

describe('tent approach analysis', () => {
  const trades = [
    trade({ minDistance: 1.4, finalPct: 40 }),
    trade({ minDistance: 0.9, finalPct: 80 }),
    trade({ minDistance: 0.4, finalPct: 150, mfePct: 200 }),
    trade({ minDistance: 0.1, finalPct: -60, mfePct: 220 }),
    trade({ finalPct: 10 }) // no underlying data
  ]

  it('conditions outcomes on how close the underlying came', () => {
    const report = analyzeTentApproach(trades, [1.0, 0.5])
    expect(report.tradesWithUnderlying).toBe(4)
    expect(report.tradesWithoutUnderlying).toBe(1)

    const within1 = report.rows.find((r) => r.band === 1.0)!
    expect(within1.cohortSize).toBe(3)
    const within05 = report.rows.find((r) => r.band === 0.5)!
    expect(within05.cohortSize).toBe(2)
    // Approaching the centre raises the peak but not necessarily the outcome.
    expect(within05.medianMfe).toBeGreaterThan(within1.medianMfe)
  })

  it('excludes trades without underlying rather than assuming they never approached', () => {
    const report = analyzeTentApproach([trade({ finalPct: 10 })], [0.5])
    expect(report.tradesWithUnderlying).toBe(0)
    expect(report.rows[0]!.cohortSize).toBe(0)
  })
})

describe('histograms', () => {
  it('bins values and preserves the total count', () => {
    const h = histogram([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], { binCount: 5 })
    expect(h.bins).toHaveLength(5)
    expect(h.bins.reduce((s, b) => s + b.count, 0)).toBe(10)
    expect(h.bins.reduce((s, b) => s + b.share, 0)).toBeCloseTo(1, 10)
  })

  it('clamps values outside explicit bounds instead of dropping them', () => {
    // Counts must always sum to the input size, or a distribution silently lies.
    const h = histogram([-100, 5, 500], { binCount: 4, min: 0, max: 10 })
    expect(h.bins.reduce((s, b) => s + b.count, 0)).toBe(3)
  })

  it('handles a single repeated value', () => {
    const h = histogram([7, 7, 7])
    expect(h.bins).toHaveLength(1)
    expect(h.bins[0]!.count).toBe(3)
  })

  it('handles an empty sample', () => {
    expect(histogram([]).bins).toEqual([])
  })
})

describe('grouped medians', () => {
  it('groups and summarizes', () => {
    const groups = medianBy(
      [{ g: 'a', v: 1 }, { g: 'a', v: 3 }, { g: 'b', v: 10 }],
      (x) => x.g,
      (x) => x.v
    )
    expect(groups).toEqual([
      { group: 'a', count: 2, median: 2, mean: 2 },
      { group: 'b', count: 1, median: 10, mean: 10 }
    ])
  })
})

// --- parameter sweep --------------------------------------------------------

const BASE: StudyConfig = {
  underlying: 'SPX', from: '2025-06-02', to: '2025-06-30', entryTime: '09:35',
  entry: { type: 'ema', period: 9 },
  targetDte: 7, expirationRule: 'nearest', maxDeviation: 2, preferredRoot: 'SPXW',
  placement: { type: 'fixedDistance', offsetPoints: 100 },
  wingWidth: 25, quantity: 1,
  pricing: { model: 'close', slippage: 0, missingDataMode: 'carryForward', maxStaleMinutes: 5 },
  minimumCoverage: 0.5,
  managements: ['hold']
}

describe('parameter sweep', () => {
  it('classifies axes by whether they force a refetch', () => {
    expect(axisKind('targetDte')).toBe('entry')
    expect(axisKind('wingWidth')).toBe('entry')
    expect(axisKind('profitTarget')).toBe('management')
    expect(axisKind('nonsense')).toBeNull()
  })

  it('produces the cartesian product of entry axes', () => {
    const points = expandSweep(BASE, [
      { name: 'targetDte', values: [5, 7] },
      { name: 'wingWidth', values: [25, 50] }
    ])
    expect(points).toHaveLength(4)
    expect(points.map((p) => `${p.values.targetDte}/${p.values.wingWidth}`)).toEqual([
      '5/25', '5/50', '7/25', '7/50'
    ])
    expect(points[3]!.config.targetDte).toBe(7)
    expect(points[3]!.config.wingWidth).toBe(50)
  })

  it('folds management axes into the management set rather than multiplying points', () => {
    /*
     * The efficiency that makes sweeps practical: eight profit targets run
     * against one reconstruction, so they cost one study rather than eight.
     */
    const points = expandSweep(BASE, [
      { name: 'profitTarget', values: [25, 50, 100, 200] }
    ])
    expect(points).toHaveLength(1)
    expect(points[0]!.config.managements).toEqual(
      expect.arrayContaining(['hold', 'tp25', 'tp50', 'tp100', 'tp200'])
    )
  })

  it('combines both kinds correctly', () => {
    const points = expandSweep(BASE, [
      { name: 'targetDte', values: [5, 7, 10] },
      { name: 'profitTarget', values: [50, 100] }
    ])
    // Three entry combinations, each carrying both targets.
    expect(points).toHaveLength(3)
    for (const point of points) {
      expect(point.config.managements).toEqual(expect.arrayContaining(['tp50', 'tp100']))
    }
  })

  it('applies double-calendar entry axes to the nested calendar configuration', () => {
    const calendar: StudyConfig = {
      ...BASE,
      structure: 'doubleCalendar',
      calendar: {
        root: 'SPXW', targetDelta: 0.3, frontTargetDte: 14, backTargetDte: 21,
        maxDteDeviation: 3, entryWeekdays: [1], horizonTime: '15:45',
        spreadFraction: 0.5, commissionPerContract: 1.3
      }
    }
    const points = expandSweep(calendar, [
      { name: 'targetDelta', values: [20, 30] },
      { name: 'frontDte', values: [7, 14] },
      { name: 'backDte', values: [21] },
      { name: 'spreadFraction', values: [0, 1] }
    ])

    expect(points).toHaveLength(8)
    expect(points[0]!.config.calendar).toMatchObject({
      targetDelta: 0.2,
      frontTargetDte: 7,
      backTargetDte: 21,
      spreadFraction: 0
    })
    expect(points[0]!.config.targetDte).toBe(7)
    expect(points.at(-1)!.config.calendar).toMatchObject({
      targetDelta: 0.3,
      frontTargetDte: 14,
      backTargetDte: 21,
      spreadFraction: 1
    })
  })

  it('estimates cost so an overnight sweep is not started by accident', () => {
    const cheap = estimateSweepCost([{ name: 'profitTarget', values: [25, 50, 100] }])
    expect(cheap.entryCombinations).toBe(1)
    expect(cheap.requiresRefetch).toBe(false)

    const expensive = estimateSweepCost([
      { name: 'targetDte', values: [3, 5, 7, 10] },
      { name: 'wingWidth', values: [10, 25, 50] }
    ])
    expect(expensive.entryCombinations).toBe(12)
    expect(expensive.requiresRefetch).toBe(true)
  })

  it('rejects unknown or empty axes rather than silently ignoring them', () => {
    expect(() => expandSweep(BASE, [{ name: 'nope', values: [1] }])).toThrow(/Unknown sweep axis/)
    expect(() => expandSweep(BASE, [{ name: 'targetDte', values: [] }])).toThrow(/no values/)
  })

  it('parses value lists and ranges', () => {
    expect(parseValueList('25, 50, 100')).toEqual([25, 50, 100])
    expect(parseValueList('25-100:25')).toEqual([25, 50, 75, 100])
    expect(parseValueList('1-3')).toEqual([1, 2, 3])
    expect(parseValueList('5, 5, 5')).toEqual([5])
    expect(() => parseValueList('abc')).toThrow(/not a number/)
    expect(() => parseValueList('1-5:0')).toThrow(/Step must be positive/)
  })

  it('expands explicit start/end/increment ranges for the sweep form', () => {
    expect(valuesFromRange({ start: 3, end: 10, increment: 2 })).toEqual([3, 5, 7, 9])
    expect(valuesFromRange({ start: 10, end: 20, increment: 2.5 })).toEqual([10, 12.5, 15, 17.5, 20])
    expect(() => valuesFromRange({ start: 10, end: 5, increment: 1 })).toThrow(/end/)
    expect(() => valuesFromRange({ start: 1, end: 5, increment: 0 })).toThrow(/increment/)
  })
})

// --- exports ----------------------------------------------------------------

describe('exports', () => {
  it('timestamps study JSON filenames in sortable UTC form', () => {
    expect(studyJsonFilename('abc123', Date.parse('2026-08-17T21:11:28.645Z'))).toBe(
      'study-20260817-211128Z-abc123.json'
    )
  })

  it('escapes CSV cells that would break the format', () => {
    expect(toCsv([['plain', 'has,comma', 'has"quote', 'has\nnewline']])).toBe(
      'plain,"has,comma","has""quote","has\nnewline"'
    )
  })

  it('writes one trade row per trade with a stable header', () => {
    const csv = tradesToCsv('run1', [trade({ finalPct: 50, reached: [25, 50] })])
    const lines = csv.split('\n')
    expect(lines).toHaveLength(2)
    expect(lines[0]).toContain('pnl_pct')
    expect(lines[0]).toContain('min_normalized_distance')
    expect(lines[1]).toContain('run1')
  })

  it('includes caveats in the JSON export', () => {
    const exportedTrade = trade({ finalPct: 50, reached: [25, 50] })
    const json = JSON.parse(
      studyToJson({
        runId: 'r1', createdAt: Date.now(), config: BASE,
        entryCount: 10, entriesAttempted: 20, skipped: [],
        summaries: [], trades: [exportedTrade], sizing: 'oneContract', appVersion: '0.1.0'
      })
    )
    // A result shipped without its assumptions cannot be checked by anyone else.
    expect(json.config).toBeDefined()
    expect(json.caveats.join(' ')).toMatch(/one-minute OPRA NBBO quote snapshots/)
    expect(json.caveats.join(' ')).toMatch(/configured slippage applied/)
    expect(json.caveats.join(' ')).toMatch(/may not be distinguishable from chance/)
    expect(json.trades).toHaveLength(1)
    expect(json.trades[0].entryDebit).toBe(exportedTrade.entryDebit)
  })

  it('exports a minute lifecycle', () => {
    const csv = seriesToCsv({
      definition: DEF, entryDebit: 2, entryTimestamp: 0,
      observations: [
        {
          timestamp: 1_750_000_000_000, butterflyValue: 2.2, pnlDollars: 20, pnlPct: 10,
          dte: 5, tradingDte: 4, minutesSinceEntry: 1, stale: false, maxLegAgeMs: 0
        }
      ],
      quality: {
        expectedMinutes: 1, pricedMinutes: 1, freshMinutes: 1, staleMinutes: 0,
        unpricedMinutes: 0, longestStaleRunMinutes: 0,
        missingByLeg: { lower: 0, center: 0, upper: 0 }, coverage: 1, freshness: 1
      },
      pricing: { model: 'close', slippage: 0, missingData: { mode: 'strict' } },
      warnings: []
    })
    expect(csv.split('\n')).toHaveLength(2)
    expect(csv).toContain('normalized_distance')
  })
})
