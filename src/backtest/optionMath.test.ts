import { describe, expect, it } from 'vitest'
import {
  blackDelta,
  blackPrice,
  blackVega,
  impliedVolatility,
  normalCdf,
  normalPdf
} from './optionMath.js'

describe('normalCdf', () => {
  it('matches published values to double precision', () => {
    expect(normalCdf(0)).toBeCloseTo(0.5, 15)
    expect(normalCdf(1)).toBeCloseTo(0.841344746068543, 12)
    expect(normalCdf(-1)).toBeCloseTo(0.158655253931457, 12)
    expect(normalCdf(1.959963984540054)).toBeCloseTo(0.975, 12)
    expect(normalCdf(-2.5)).toBeCloseTo(0.006209665325776, 12)
  })

  it('is symmetric about zero across the tails', () => {
    for (const x of [0.1, 0.7, 1.3, 3.4, 6.2, 8.5, 12]) {
      expect(normalCdf(x) + normalCdf(-x)).toBeCloseTo(1, 14)
    }
  })

  it('saturates rather than returning values outside 0..1', () => {
    expect(normalCdf(50)).toBe(1)
    expect(normalCdf(-50)).toBe(0)
  })

  it('has the pdf as its derivative', () => {
    const h = 1e-5
    for (const x of [-1.5, -0.4, 0.9, 2.2]) {
      const slope = (normalCdf(x + h) - normalCdf(x - h)) / (2 * h)
      expect(slope).toBeCloseTo(normalPdf(x), 8)
    }
  })
})

describe('blackPrice', () => {
  const base = { forward: 6800, years: 14 / 365, volatility: 0.16, discountFactor: 0.9984 }

  it('satisfies put-call parity at every strike', () => {
    for (const strike of [6400, 6700, 6800, 6900, 7200]) {
      const call = blackPrice({ ...base, strike, right: 'call' })
      const put = blackPrice({ ...base, strike, right: 'put' })
      expect(call - put).toBeCloseTo(base.discountFactor * (base.forward - strike), 8)
    }
  })

  it('collapses to discounted intrinsic value at zero volatility', () => {
    const call = blackPrice({ ...base, strike: 6700, volatility: 0, right: 'call' })
    expect(call).toBeCloseTo(base.discountFactor * 100, 8)

    const put = blackPrice({ ...base, strike: 6700, volatility: 0, right: 'put' })
    expect(put).toBe(0)
  })

  it('stays inside the no-arbitrage band', () => {
    const call = blackPrice({ ...base, strike: 6800, right: 'call' })
    expect(call).toBeGreaterThan(0)
    expect(call).toBeLessThan(base.discountFactor * base.forward)
  })
})

describe('blackDelta', () => {
  const forward = 6800
  const years = 14 / 365
  const volatility = 0.16

  it('is about half at the money and opposite in sign by right', () => {
    const call = blackDelta(forward, forward, years, volatility, 'call')!
    const put = blackDelta(forward, forward, years, volatility, 'put')!
    expect(call).toBeGreaterThan(0.5)
    expect(call).toBeLessThan(0.52)
    expect(call - put).toBeCloseTo(1, 12)
  })

  it('matches the numerical derivative of price with respect to the forward', () => {
    const discountFactor = 1
    const strike = 6700
    const h = 0.01
    const up = blackPrice({ forward: forward + h, strike, years, volatility, discountFactor, right: 'call' })
    const down = blackPrice({ forward: forward - h, strike, years, volatility, discountFactor, right: 'call' })
    expect((up - down) / (2 * h)).toBeCloseTo(blackDelta(forward, strike, years, volatility, 'call')!, 6)
  })

  it('falls monotonically as a call strike rises', () => {
    const deltas = [6600, 6700, 6800, 6900, 7000].map(
      (strike) => blackDelta(forward, strike, years, volatility, 'call')!
    )
    for (let i = 1; i < deltas.length; i++) expect(deltas[i]!).toBeLessThan(deltas[i - 1]!)
  })
})

describe('blackVega', () => {
  it('matches the numerical derivative of price with respect to volatility', () => {
    const h = 1e-6
    const args = { forward: 6800, strike: 6700, years: 21 / 365, discountFactor: 0.998 }
    const up = blackPrice({ ...args, volatility: 0.18 + h, right: 'put' })
    const down = blackPrice({ ...args, volatility: 0.18 - h, right: 'put' })
    expect((up - down) / (2 * h)).toBeCloseTo(blackVega(args.forward, args.strike, args.years, 0.18, args.discountFactor), 4)
  })
})

describe('impliedVolatility', () => {
  const forward = 6800
  const discountFactor = 0.9984

  it('recovers the volatility a price was generated from', () => {
    for (const strike of [6300, 6600, 6800, 7000, 7400]) {
      for (const volatility of [0.08, 0.16, 0.35, 0.9]) {
        for (const right of ['call', 'put'] as const) {
          const years = 21 / 365
          const price = blackPrice({ forward, strike, years, volatility, discountFactor, right })
          const solved = impliedVolatility(price, forward, strike, years, discountFactor, right)
          expect(solved).not.toBeNull()
          expect(solved!).toBeCloseTo(volatility, 6)
        }
      }
    }
  })

  it('refuses a price at or below discounted intrinsic value', () => {
    const intrinsic = discountFactor * 100
    expect(impliedVolatility(intrinsic, forward, 6700, 14 / 365, discountFactor, 'call')).toBeNull()
    expect(impliedVolatility(intrinsic - 1, forward, 6700, 14 / 365, discountFactor, 'call')).toBeNull()
  })

  it('refuses a price above the payoff ceiling', () => {
    expect(impliedVolatility(6800, forward, 6700, 14 / 365, discountFactor, 'call')).toBeNull()
    expect(impliedVolatility(7000, forward, 6900, 14 / 365, discountFactor, 'put')).toBeNull()
  })

  it('refuses degenerate inputs rather than guessing', () => {
    expect(impliedVolatility(10, forward, 6700, 0, discountFactor, 'call')).toBeNull()
    expect(impliedVolatility(0, forward, 6700, 14 / 365, discountFactor, 'call')).toBeNull()
    expect(impliedVolatility(10, forward, 6700, 14 / 365, 0, 'call')).toBeNull()
  })
})
