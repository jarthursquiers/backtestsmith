import { describe, expect, it } from 'vitest'
import {
  DEFAULT_CARRY_RATE,
  estimateFromParity,
  fitCarryRate,
  yearsBetween,
  type ParityQuote
} from './putCallParity.js'
import { buildParityReport, type ParitySample } from './parityValidation.js'

const T = 7 / 365 // seven days to expiration

/**
 * Builds parity-consistent quotes for a known spot, so the estimator can be
 * checked against ground truth rather than against itself.
 */
function syntheticQuotes(
  spot: number,
  strikes: readonly number[],
  opts: { carryRate?: number; discountRate?: number; callBias?: number; yearsToExpiry?: number } = {}
): ParityQuote[] {
  const carry = opts.carryRate ?? 0.03
  const r = opts.discountRate ?? 0.043
  const t = opts.yearsToExpiry ?? T
  const forward = spot * Math.exp(carry * t)
  const D = Math.exp(-r * t)

  return strikes.map((strike) => {
    // Only C - P is pinned by parity; the split between them is arbitrary here.
    const difference = D * (forward - strike)
    const putPrice = 20
    return {
      strike,
      callPrice: putPrice + difference + (opts.callBias ?? 0),
      putPrice,
      callAgeMs: 0,
      putAgeMs: 0
    }
  })
}

describe('single-strike parity', () => {
  it('recovers spot from a parity-consistent quote', () => {
    const spot = 6000
    const [quote] = syntheticQuotes(spot, [6000])
    const estimate = estimateFromParity([quote!], { yearsToExpiry: T, carryRate: 0.03 })

    expect(estimate).not.toBeNull()
    expect(estimate!.method).toBe('singleStrike')
    // Taking D as 1 costs a fraction of a point at this horizon.
    expect(estimate!.spot).toBeCloseTo(spot, 1)
  })

  it('returns the forward, which sits above spot before expiration', () => {
    const spot = 6000
    const [quote] = syntheticQuotes(spot, [6000])
    const estimate = estimateFromParity([quote!], { yearsToExpiry: T, carryRate: 0.03 })!
    expect(estimate.forward).toBeGreaterThan(spot)
    // ~3.5 points at 6000 with 3% carry over 7 days.
    expect(estimate.forward - spot).toBeCloseTo(spot * 0.03 * T, 0)
  })

  it('drifts if the carry adjustment is skipped', () => {
    /*
     * Treating the forward as spot does not merely offset the series: the gap
     * decays to zero at expiration, so an uncorrected estimate slopes downward
     * over a trade's life and imitates real market movement.
     */
    const spot = 6000
    const sevenDays = estimateFromParity(
      syntheticQuotes(spot, [6000], { yearsToExpiry: 7 / 365 }),
      { yearsToExpiry: 7 / 365, carryRate: 0 }
    )!
    const oneDay = estimateFromParity(
      syntheticQuotes(spot, [6000], { yearsToExpiry: 1 / 365 }),
      { yearsToExpiry: 1 / 365, carryRate: 0 }
    )!

    const errorAtSeven = sevenDays.spot - spot
    const errorAtOne = oneDay.spot - spot
    expect(errorAtSeven).toBeGreaterThan(errorAtOne)
    // Roughly 3.5 points at 7 DTE, shrinking to about 0.5 at 1 DTE.
    expect(errorAtSeven).toBeCloseTo(spot * 0.03 * (7 / 365), 0)
    expect(errorAtOne).toBeCloseTo(spot * 0.03 * (1 / 365), 1)

    // Applying the correct carry removes it at both horizons.
    const corrected = estimateFromParity(
      syntheticQuotes(spot, [6000], { yearsToExpiry: 7 / 365 }),
      { yearsToExpiry: 7 / 365, carryRate: 0.03 }
    )!
    expect(corrected.spot).toBeCloseTo(spot, 1)
  })

  it('is exact when strike equals the forward', () => {
    const spot = 6000
    const forward = spot * Math.exp(0.03 * T)
    const quotes = syntheticQuotes(spot, [forward])
    const estimate = estimateFromParity(quotes, { yearsToExpiry: T, carryRate: 0.03 })!
    expect(estimate.spot).toBeCloseTo(spot, 2)
  })

  it('returns null with no quotes', () => {
    expect(estimateFromParity([], { yearsToExpiry: T })).toBeNull()
  })
})

describe('multi-strike regression', () => {
  it('recovers both the discount factor and the forward with no rate assumption', () => {
    const spot = 6000
    const r = 0.043
    const quotes = syntheticQuotes(spot, [5950, 5975, 6000, 6025, 6050], { discountRate: r })
    const estimate = estimateFromParity(quotes, { yearsToExpiry: T, carryRate: 0.03 })!

    expect(estimate.method).toBe('regression')
    expect(estimate.strikesUsed).toBe(5)
    expect(estimate.discountFactor).toBeCloseTo(Math.exp(-r * T), 6)
    expect(estimate.spot).toBeCloseTo(spot, 3)
    // A perfectly consistent chain fits exactly.
    expect(estimate.residualRms).toBeCloseTo(0, 8)
  })

  it('reports fit residual when quotes are not parity-consistent', () => {
    const quotes = syntheticQuotes(6000, [5950, 5975, 6000, 6025, 6050])
    // Perturb one strike, as a wide spread or a stale print would.
    quotes[2]!.callPrice += 2
    const estimate = estimateFromParity(quotes, { yearsToExpiry: T })!
    expect(estimate.residualRms).toBeGreaterThan(0.5)
  })

  it('rejects data whose slope is not a valid discount factor', () => {
    // Slope must be negative; an increasing (C - P) in K is impossible.
    const broken: ParityQuote[] = [5950, 6000, 6050].map((strike) => ({
      strike,
      callPrice: strike / 100,
      putPrice: 0,
      callAgeMs: 0,
      putAgeMs: 0
    }))
    expect(estimateFromParity(broken, { yearsToExpiry: T })).toBeNull()
  })
})

describe('error transfer from stale legs', () => {
  it('moves roughly one for one with index movement between prints', () => {
    /*
     * The dominant error source. At the money the call and put deltas are about
     * +0.5 and -0.5, so a stale leg transfers index movement into the estimate
     * almost one for one. This is why estimates carry their staleness.
     */
    const quotes = syntheticQuotes(6000, [6000])
    const baseline = estimateFromParity(quotes, { yearsToExpiry: T })!

    // The call printed while the index was 5 points higher; the put is current.
    const staleCall = syntheticQuotes(6000, [6000])
    staleCall[0]!.callPrice += 0.5 * 5
    staleCall[0]!.putPrice -= -0.5 * 5 * 0 // put unchanged, kept explicit
    staleCall[0]!.callAgeMs = 120_000

    const skewed = estimateFromParity(staleCall, { yearsToExpiry: T })!
    expect(skewed.spot - baseline.spot).toBeCloseTo(2.5, 1)
    expect(skewed.maxAgeMs).toBe(120_000)
  })

  it('surfaces the worst leg age across all quotes', () => {
    const quotes = syntheticQuotes(6000, [5975, 6000, 6025])
    quotes[1]!.putAgeMs = 180_000
    expect(estimateFromParity(quotes, { yearsToExpiry: T })!.maxAgeMs).toBe(180_000)
  })
})

describe('carry calibration', () => {
  it('recovers the carry rate used to build the samples', () => {
    const carry = 0.028
    const samples = [6000, 6010, 5990, 6100].map((spot) => ({
      spot,
      forward: spot * Math.exp(carry * T),
      yearsToExpiry: T
    }))
    const fit = fitCarryRate(samples)
    expect(fit).not.toBeNull()
    expect(fit!.carryRate).toBeCloseTo(carry, 6)
    expect(fit!.samples).toBe(4)
  })

  it('ignores unusable samples', () => {
    expect(fitCarryRate([{ forward: 0, spot: 6000, yearsToExpiry: T }])).toBeNull()
    expect(fitCarryRate([{ forward: 6000, spot: 6000, yearsToExpiry: 0 }])).toBeNull()
    expect(fitCarryRate([])).toBeNull()
  })
})

describe('accuracy report', () => {
  function sample(spotEstimate: number, actual: number, ageMs: number): ParitySample {
    return {
      timestamp: 0,
      actual,
      yearsToExpiry: T,
      estimate: {
        forward: spotEstimate * Math.exp(0.03 * T),
        spot: spotEstimate,
        discountFactor: null,
        strikesUsed: 1,
        maxAgeMs: ageMs,
        residualRms: null,
        method: 'singleStrike'
      }
    }
  }

  it('reports bias, dispersion, and coverage', () => {
    const samples = [
      sample(6001, 6000, 0),
      sample(5999, 6000, 0),
      sample(6002, 6000, 0),
      sample(5998, 6000, 0)
    ]
    const report = buildParityReport(samples, 8)

    expect(report.sampleCount).toBe(4)
    expect(report.coverage).toBeCloseTo(0.5, 6)
    expect(report.raw.bias).toBeCloseTo(0, 6) // symmetric errors cancel
    expect(report.raw.rms).toBeCloseTo(Math.sqrt((1 + 1 + 4 + 4) / 4), 6)
    expect(report.raw.maxAbs).toBeCloseTo(2, 6)
  })

  it('separates fixable bias from irreducible noise', () => {
    // A pure carry misestimate shows as bias and should shrink after calibration.
    const actual = 6000
    const samples = [0, 0, 0, 0].map(() => sample(actual + 4, actual, 0))
    const report = buildParityReport(samples, 4)

    expect(report.raw.bias).toBeCloseTo(4, 6)
    expect(report.calibrated).not.toBeNull()
    // Calibrating the carry removes a systematic offset entirely.
    expect(Math.abs(report.calibrated!.bias)).toBeLessThan(0.01)
    expect(report.fittedCarryRate).not.toBeNull()
  })

  it('groups error by leg staleness', () => {
    const report = buildParityReport(
      [
        sample(6000.5, 6000, 0),
        sample(6000.5, 6000, 0),
        sample(6003, 6000, 60_000),
        sample(6008, 6000, 4 * 60_000)
      ],
      4
    )

    const labels = report.buckets.map((b) => b.label)
    expect(labels).toContain('same minute')
    expect(labels).toContain('1 min stale')
    expect(labels).toContain('2-5 min stale')

    const fresh = report.buckets.find((b) => b.label === 'same minute')!
    const stale = report.buckets.find((b) => b.label === '2-5 min stale')!
    // The whole hypothesis: staleness dominates the error.
    expect(stale.rms).toBeGreaterThan(fresh.rms)
  })

  it('handles an empty sample set without dividing by zero', () => {
    const report = buildParityReport([], 100)
    expect(report.sampleCount).toBe(0)
    expect(report.coverage).toBe(0)
    expect(report.raw.rms).toBe(0)
    expect(report.calibrated).toBeNull()
  })
})

describe('yearsBetween', () => {
  it('measures a fraction of a year on a 365-day basis', () => {
    const start = Date.UTC(2025, 5, 13)
    const end = Date.UTC(2025, 5, 20)
    expect(yearsBetween(start, end)).toBeCloseTo(7 / 365, 10)
    expect(yearsBetween(end, start)).toBe(0)
  })

  it('exposes a sane default carry', () => {
    expect(DEFAULT_CARRY_RATE).toBeGreaterThan(0)
    expect(DEFAULT_CARRY_RATE).toBeLessThan(0.1)
  })
})
