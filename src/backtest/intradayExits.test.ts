import { describe, expect, it } from 'vitest'
import type { ButterflyDefinition, ButterflyObservation, ButterflySeries } from '../domain/butterfly.js'
import { DEFAULT_PRICING } from '../domain/butterfly.js'
import { easternToTimestamp, toEastern } from '../core/time/marketTime.js'
import { elapsedExit, timeOfDayExit } from './exits.js'
import { simulateTrade } from './simulate.js'

const DEF: ButterflyDefinition = {
  underlying: 'SPX',
  direction: 'bearish',
  optionType: 'put',
  expiration: '2025-06-17',
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
const ENTRY = easternToTimestamp('2025-06-17', 9, 50)

interface Minute {
  value: number
  stale?: boolean
}

/** One observation per minute from 09:50 ET on a single 0DTE session. */
function intradaySeries(minutes: readonly (number | Minute)[]): ButterflySeries {
  const observations: ButterflyObservation[] = minutes.map((raw, i) => {
    const spec: Minute = typeof raw === 'number' ? { value: raw } : raw
    return {
      timestamp: ENTRY + i * 60_000,
      butterflyValue: spec.value,
      pnlDollars: (spec.value - ENTRY_DEBIT) * 100,
      pnlPct: ((spec.value - ENTRY_DEBIT) / ENTRY_DEBIT) * 100,
      dte: 0,
      tradingDte: 0,
      minutesSinceEntry: i,
      stale: spec.stale ?? false,
      maxLegAgeMs: spec.stale ? 60_000 : 0
    }
  })

  return {
    definition: DEF,
    entryDebit: ENTRY_DEBIT,
    entryTimestamp: ENTRY,
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

/** A rising path across the whole session, one minute apart. */
const SESSION = intradaySeries(Array.from({ length: 370 }, (_, i) => 2 + i * 0.01))

describe('timeOfDayExit', () => {
  it('closes on the first minute at or after the Eastern wall-clock time', () => {
    const result = simulateTrade(SESSION, timeOfDayExit('15:45'))

    expect(result.exitReason).toBe('timeExit')
    expect(toEastern(result.exitTimestamp).toFormat('HH:mm')).toBe('15:45')
  })

  it('holds past the time rather than filling on a carried-forward mark', () => {
    // 09:50 entry, so index 10 is 10:00 - the minute the rule wants.
    const stale = Array.from({ length: 20 }, (_, i) => ({ value: 2 + i * 0.1, stale: i >= 10 && i < 13 }))
    const result = simulateTrade(intradaySeries(stale), timeOfDayExit('10:00'))

    expect(result.exitReason).toBe('timeExit')
    expect(toEastern(result.exitTimestamp).toFormat('HH:mm')).toBe('10:03')
  })

  it('runs to the end when the time never arrives', () => {
    const result = simulateTrade(intradaySeries([2, 2.1, 2.2]), timeOfDayExit('15:45'))
    expect(result.exitReason).toBe('expiration')
  })

  it('is named by the time it fires, so a study can configure it by id', () => {
    expect(timeOfDayExit('15:45').id).toBe('at1545')
    expect(timeOfDayExit('9:30').id).toBe('at0930')
  })
})

describe('elapsedExit', () => {
  it('closes once the trade has been held for the configured minutes', () => {
    const result = simulateTrade(SESSION, elapsedExit(60))

    expect(result.exitReason).toBe('timeExit')
    expect(result.holdingMinutes).toBe(60)
    expect(toEastern(result.exitTimestamp).toFormat('HH:mm')).toBe('10:50')
  })

  it('measures from entry, not from the clock', () => {
    const result = simulateTrade(SESSION, elapsedExit(30))
    expect(result.holdingMinutes).toBe(30)
  })

  it('refuses a non-positive duration rather than exiting immediately', () => {
    expect(() => elapsedExit(0)).toThrow(/positive/)
  })
})
