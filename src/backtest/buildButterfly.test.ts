import { describe, expect, it } from 'vitest'
import type { OptionContract } from '../domain/contracts.js'
import { ButterflyBuildError, availableRoots, buildButterfly, selectContract } from './buildButterfly.js'

function contract(
  strike: number,
  root: 'SPX' | 'SPXW',
  type: 'put' | 'call' = 'put'
): OptionContract {
  const cp = type === 'put' ? 'P' : 'C'
  return {
    ticker: `O:${root}250620${cp}0${strike}000`,
    underlying: 'SPX',
    expirationDate: '2025-06-20',
    strike,
    type,
    root,
    settlement: root === 'SPX' ? 'am' : 'pm'
  }
}

/** A third-Friday chain, where both roots exist at every strike. */
const MONTHLY_CHAIN: OptionContract[] = [5850, 5875, 5900].flatMap((k) => [
  contract(k, 'SPX'),
  contract(k, 'SPXW')
])

/** A mid-week weekly expiration, where only SPXW exists. */
const WEEKLY_CHAIN: OptionContract[] = [5850, 5875, 5900].map((k) => contract(k, 'SPXW'))

const REQUEST = {
  underlying: 'SPX',
  expiration: '2025-06-20',
  optionType: 'put' as const,
  lowerStrike: 5850,
  centerStrike: 5875,
  upperStrike: 5900
}

describe('selectContract', () => {
  it('returns the only contract at a strike without needing a root', () => {
    expect(selectContract(WEEKLY_CHAIN, 5875, 'put').ticker).toBe('O:SPXW250620P05875000')
  })

  it('refuses to guess when both roots exist at a strike', () => {
    // This is the case that would otherwise silently pick an AM-settled monthly.
    expect(() => selectContract(MONTHLY_CHAIN, 5875, 'put')).toThrow(/ambiguous/)
    expect(() => selectContract(MONTHLY_CHAIN, 5875, 'put')).toThrow(/SPX, SPXW/)
  })

  it('disambiguates by the requested root', () => {
    expect(selectContract(MONTHLY_CHAIN, 5875, 'put', 'SPXW').settlement).toBe('pm')
    expect(selectContract(MONTHLY_CHAIN, 5875, 'put', 'SPX').settlement).toBe('am')
  })

  it('reports what is available when the requested root is absent', () => {
    expect(() => selectContract(WEEKLY_CHAIN, 5875, 'put', 'SPXQ')).toThrow(/available roots: SPXW/)
  })

  it('reports a missing strike distinctly from an ambiguous one', () => {
    expect(() => selectContract(WEEKLY_CHAIN, 5860, 'put')).toThrow(/No put contract found at strike 5860/)
  })

  it('does not cross option types', () => {
    expect(() => selectContract(WEEKLY_CHAIN, 5875, 'call')).toThrow(/No call contract/)
  })
})

describe('buildButterfly', () => {
  it('builds a symmetrical put butterfly from a weekly chain', () => {
    const fly = buildButterfly(REQUEST, WEEKLY_CHAIN)
    expect(fly).toMatchObject({
      direction: 'bearish',
      optionType: 'put',
      wingWidth: 25,
      quantity: 1,
      lowerTicker: 'O:SPXW250620P05850000',
      centerTicker: 'O:SPXW250620P05875000',
      upperTicker: 'O:SPXW250620P05900000'
    })
  })

  it('treats calls as the bullish/upside variant', () => {
    const calls = [5850, 5875, 5900].map((k) => contract(k, 'SPXW', 'call'))
    expect(buildButterfly({ ...REQUEST, optionType: 'call' }, calls).direction).toBe('bullish')
  })

  it('requires a root on an ambiguous monthly chain', () => {
    expect(() => buildButterfly(REQUEST, MONTHLY_CHAIN)).toThrow(ButterflyBuildError)
    const fly = buildButterfly({ ...REQUEST, preferredRoot: 'SPXW' }, MONTHLY_CHAIN)
    expect(fly.centerTicker).toBe('O:SPXW250620P05875000')
  })

  it('rejects asymmetrical wings', () => {
    expect(() =>
      buildButterfly({ ...REQUEST, upperStrike: 5925 }, [
        ...WEEKLY_CHAIN,
        contract(5925, 'SPXW')
      ])
    ).toThrow(/wings are 25 and 50/)
  })

  it('rejects strikes that are not strictly increasing', () => {
    expect(() =>
      buildButterfly({ ...REQUEST, lowerStrike: 5900, upperStrike: 5850 }, WEEKLY_CHAIN)
    ).toThrow(/strictly increasing/)
  })

  it('rejects a mix of settlement styles across legs', () => {
    // A chain where one strike only lists the AM-settled root.
    const mixed: OptionContract[] = [
      contract(5850, 'SPXW'),
      contract(5875, 'SPX'),
      contract(5900, 'SPXW')
    ]
    expect(() => buildButterfly(REQUEST, mixed)).toThrow(/settlement style/)
  })

  it('carries the requested quantity through', () => {
    expect(buildButterfly({ ...REQUEST, quantity: 5 }, WEEKLY_CHAIN).quantity).toBe(5)
  })
})

describe('availableRoots', () => {
  it('summarizes the roots in a chain, most common first', () => {
    expect(availableRoots(MONTHLY_CHAIN)).toEqual([
      { root: 'SPX', settlement: 'am', count: 3 },
      { root: 'SPXW', settlement: 'pm', count: 3 }
    ])
    expect(availableRoots(WEEKLY_CHAIN)).toEqual([{ root: 'SPXW', settlement: 'pm', count: 3 }])
  })
})
