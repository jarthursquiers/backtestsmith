import { describe, expect, it } from 'vitest'
import {
  formatOptionTicker,
  indexTicker,
  isIndexTicker,
  parseOptionTicker,
  spxSettlementForRoot
} from './tickers.js'

describe('parseOptionTicker', () => {
  it('parses the documented Massive example', () => {
    // From massive-com/client-python examples/rest/options-aggregates_bars.py
    expect(parseOptionTicker('O:SPY251219C00650000')).toEqual({
      root: 'SPY',
      expirationDate: '2025-12-19',
      type: 'call',
      strike: 650
    })
  })

  it('parses SPXW puts at index-scale strikes', () => {
    expect(parseOptionTicker('O:SPXW250620P05900000')).toEqual({
      root: 'SPXW',
      expirationDate: '2025-06-20',
      type: 'put',
      strike: 5900
    })
  })

  it('preserves fractional strikes without floating point dust', () => {
    const parsed = parseOptionTicker('O:SPXW250620C06002500')
    expect(parsed?.strike).toBe(6002.5)
  })

  it('rejects malformed tickers rather than guessing', () => {
    expect(parseOptionTicker('SPY251219C00650000')).toBeNull() // missing O: prefix
    expect(parseOptionTicker('O:SPY251219X00650000')).toBeNull() // bad type
    expect(parseOptionTicker('O:SPY251319C00650000')).toBeNull() // month 13
    expect(parseOptionTicker('')).toBeNull()
  })
})

describe('formatOptionTicker', () => {
  it('round-trips through the parser', () => {
    const ticker = formatOptionTicker({
      root: 'SPXW',
      expirationDate: '2025-06-20',
      type: 'put',
      strike: 5900
    })
    expect(ticker).toBe('O:SPXW250620P05900000')
    expect(parseOptionTicker(ticker)).toEqual({
      root: 'SPXW',
      expirationDate: '2025-06-20',
      type: 'put',
      strike: 5900
    })
  })

  it('encodes fractional strikes', () => {
    expect(
      formatOptionTicker({ root: 'SPXW', expirationDate: '2025-06-20', type: 'call', strike: 6002.5 })
    ).toBe('O:SPXW250620C06002500')
  })

  it('rejects invalid inputs', () => {
    expect(() =>
      formatOptionTicker({ root: 'SPX', expirationDate: '06/20/2025', type: 'call', strike: 6000 })
    ).toThrow(/YYYY-MM-DD/)
    expect(() =>
      formatOptionTicker({ root: 'SPX', expirationDate: '2025-06-20', type: 'call', strike: 0 })
    ).toThrow(/Invalid strike/)
  })
})

describe('SPX settlement roots', () => {
  it('distinguishes AM-settled SPX from PM-settled SPXW', () => {
    // This drives whether a hold-to-expiration trade has a final Friday session.
    expect(spxSettlementForRoot('SPX')).toBe('am')
    expect(spxSettlementForRoot('SPXW')).toBe('pm')
    expect(spxSettlementForRoot('spxw')).toBe('pm')
    expect(spxSettlementForRoot('SPY')).toBeNull()
  })
})

describe('index tickers', () => {
  it('applies the I: prefix idempotently', () => {
    expect(indexTicker('SPX')).toBe('I:SPX')
    expect(indexTicker('I:SPX')).toBe('I:SPX')
    expect(indexTicker('spx')).toBe('I:SPX')
  })

  it('detects index tickers', () => {
    expect(isIndexTicker('I:SPX')).toBe(true)
    expect(isIndexTicker('O:SPXW250620P05900000')).toBe(false)
  })
})
