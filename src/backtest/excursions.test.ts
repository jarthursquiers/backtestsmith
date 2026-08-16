import { describe, expect, it } from 'vitest'
import type { ButterflyObservation } from '../domain/butterfly.js'
import { computeExcursions, firstReachedTimes } from './excursions.js'

/** Builds a path from percentage returns against a 2.00 debit, 1 contract. */
function path(pcts: readonly number[]): ButterflyObservation[] {
  const debit = 2
  return pcts.map((pct, i) => ({
    timestamp: 1_750_000_000_000 + i * 60_000,
    butterflyValue: debit * (1 + pct / 100),
    pnlDollars: debit * (pct / 100) * 100,
    pnlPct: pct,
    dte: 7 - Math.floor(i / 3),
    tradingDte: 5,
    minutesSinceEntry: i,
    stale: false,
    maxLegAgeMs: 0
  }))
}

describe('computeExcursions', () => {
  it('finds the best and worst points of a path', () => {
    // 0%, +10%, +100%, +60%, -25%
    const observations = path([0, 10, 100, 60, -25])
    const { mfe, mae } = computeExcursions(observations)

    expect(mfe?.pct).toBe(100)
    expect(mfe?.dollars).toBeCloseTo(200, 6)
    expect(mfe?.minutesSinceEntry).toBe(2)

    expect(mae?.pct).toBe(-25)
    expect(mae?.dollars).toBeCloseTo(-50, 6)
    expect(mae?.minutesSinceEntry).toBe(4)
  })

  it('does not invent a positive MFE for a trade that never went green', () => {
    const { mfe, mae } = computeExcursions(path([0, -10, -40, -80]))
    expect(mfe?.pct).toBe(0)
    expect(mae?.pct).toBe(-80)
  })

  it('keeps the first occurrence of a repeated extreme', () => {
    const { mfe } = computeExcursions(path([0, 50, 20, 50]))
    expect(mfe?.minutesSinceEntry).toBe(1)
  })

  it('handles an empty path', () => {
    expect(computeExcursions([])).toEqual({ mfe: null, mae: null })
  })

  it('carries underlying context when present', () => {
    const observations = path([0, 80])
    observations[1]!.underlyingPrice = 5880
    observations[1]!.normalizedDistanceToCenter = 0.2
    const { mfe } = computeExcursions(observations)
    expect(mfe?.underlyingPrice).toBe(5880)
    expect(mfe?.normalizedDistanceToCenter).toBe(0.2)
  })
})

describe('firstReachedTimes', () => {
  it('records when each threshold was first crossed', () => {
    const observations = path([0, 30, 60, 120, 90])
    const reached = firstReachedTimes(observations, [25, 50, 100, 200])

    expect(reached.get(25)?.minutesSinceEntry).toBe(1)
    expect(reached.get(50)?.minutesSinceEntry).toBe(2)
    expect(reached.get(100)?.minutesSinceEntry).toBe(3)
    // Never reached is null, distinct from being absent from the map.
    expect(reached.get(200)).toBeNull()
    expect(reached.has(200)).toBe(true)
  })

  it('reports nothing reached on a losing path', () => {
    const reached = firstReachedTimes(path([0, -20, -50]), [25, 50])
    expect(reached.get(25)).toBeNull()
    expect(reached.get(50)).toBeNull()
  })
})
