import { describe, expect, it } from 'vitest'
import type { OptionBar } from '../domain/bars.js'
import type {
  CalendarEntryContext,
  CalendarExecutionAssumptions,
  CalendarLegRole,
  DoubleCalendarDefinition
} from '../domain/doubleCalendar.js'
import { easternToTimestamp } from '../core/time/marketTime.js'
import {
  CalendarReconstructionError,
  commissionPoints,
  packageMid,
  packageQuotedSpread,
  packageSpread,
  reconstructDoubleCalendar
} from './reconstructCalendar.js'

const FRONT = '2026-03-16'
const BACK = '2026-03-23'
const ENTRY_DATE = '2026-03-12'

const DEFINITION: DoubleCalendarDefinition = {
  structure: 'doubleCalendar',
  underlying: 'SPX',
  root: 'SPXW',
  frontExpiration: FRONT,
  backExpiration: BACK,
  putStrike: 6700,
  callStrike: 6900,
  tickers: {
    putShort: 'O:SPXW260316P06700000',
    putLong: 'O:SPXW260323P06700000',
    callShort: 'O:SPXW260316C06900000',
    callLong: 'O:SPXW260323C06900000'
  },
  quantity: 1
}

const CONTEXT: CalendarEntryContext = {
  spot: 6800,
  forward: 6810,
  discountFactor: 0.998,
  putDelta: -0.3,
  callDelta: 0.3,
  putIv: 0.19,
  callIv: 0.14,
  frontDte: 4,
  backDte: 11,
  tentWidth: 200
}

const FRICTIONLESS: CalendarExecutionAssumptions = {
  spreadFraction: 0,
  commissionPerContract: 0,
  missingData: { mode: 'carryForward', maxStaleMinutes: 5 }
}

function bar(ticker: string, timestamp: number, bid: number, ask: number): OptionBar {
  const mid = (bid + ask) / 2
  return { ticker, timestamp, open: mid, high: mid, low: mid, close: mid, volume: 0, bid, ask }
}

/** A flat quote for every minute of the grid, for each of the four legs. */
function flatLegs(
  minutes: readonly number[],
  quotes: Record<CalendarLegRole, { bid: number; ask: number }>
): Record<CalendarLegRole, OptionBar[]> {
  const legs = {} as Record<CalendarLegRole, OptionBar[]>
  for (const role of Object.keys(quotes) as CalendarLegRole[]) {
    legs[role] = minutes.map((minute) =>
      bar(DEFINITION.tickers[role], minute, quotes[role].bid, quotes[role].ask)
    )
  }
  return legs
}

function minuteRange(from: number, count: number): number[] {
  return Array.from({ length: count }, (_, i) => from + i * 60_000)
}

const ENTRY = easternToTimestamp(ENTRY_DATE, 10, 0)
const HORIZON = easternToTimestamp(FRONT, 15, 45)

/** Wide-but-symmetric quotes: package mid 20.00, package spread 4.00. */
const QUOTES = {
  putShort: { bid: 39, ask: 40 },
  putLong: { bid: 48, ask: 49 },
  callShort: { bid: 29, ask: 30 },
  callLong: { bid: 39, ask: 40 }
} as const

describe('package arithmetic', () => {
  const legs = {
    putShort: { ticker: 'a', bid: 39, ask: 40, mid: 39.5, typicalSpread: 1, observedAt: 0, ageMs: 0 },
    putLong: { ticker: 'b', bid: 48, ask: 49, mid: 48.5, typicalSpread: 1, observedAt: 0, ageMs: 0 },
    callShort: { ticker: 'c', bid: 29, ask: 30, mid: 29.5, typicalSpread: 1, observedAt: 0, ageMs: 0 },
    callLong: { ticker: 'd', bid: 39, ask: 40, mid: 39.5, typicalSpread: 1, observedAt: 0, ageMs: 0 }
  }

  it('nets the longs against the shorts', () => {
    expect(packageMid(legs)).toBeCloseTo(48.5 - 39.5 + 39.5 - 29.5, 10)
  })

  it('adds every leg spread, because signs never cancel in the cost of crossing', () => {
    expect(packageSpread(legs)).toBeCloseTo(4, 10)
    expect(packageQuotedSpread(legs)).toBeCloseTo(4, 10)
  })

  it('converts a per-contract commission into points for four contracts', () => {
    expect(commissionPoints(1.3)).toBeCloseTo(0.052, 10)
  })
})

describe('reconstructDoubleCalendar', () => {
  it('prices the entry at the midpoint when nothing is assumed about friction', () => {
    const minutes = minuteRange(ENTRY, 60)
    const series = reconstructDoubleCalendar({
      definition: DEFINITION,
      legBars: flatLegs(minutes, QUOTES),
      entryContext: CONTEXT,
      entryTimestamp: ENTRY,
      exitHorizonTimestamp: ENTRY + 59 * 60_000,
      execution: FRICTIONLESS
    })

    expect(series.entryMid).toBeCloseTo(19, 10)
    expect(series.entryCost).toBeCloseTo(19, 10)
    expect(series.entryTimestamp).toBe(ENTRY)
    expect(series.observations).toHaveLength(60)
    expect(series.observations[0]!.pnlPct).toBeCloseTo(0, 10)
  })

  it('charges the spread and the commission on both sides of the trade', () => {
    const minutes = minuteRange(ENTRY, 10)
    const execution: CalendarExecutionAssumptions = {
      spreadFraction: 0.5,
      commissionPerContract: 1.3,
      missingData: { mode: 'carryForward', maxStaleMinutes: 5 }
    }
    const series = reconstructDoubleCalendar({
      definition: DEFINITION,
      legBars: flatLegs(minutes, QUOTES),
      entryContext: CONTEXT,
      entryTimestamp: ENTRY,
      exitHorizonTimestamp: ENTRY + 9 * 60_000,
      execution
    })

    // Mid 19.00, package spread 4.00, half of it given up on each side, plus
    // 4 contracts at $1.30 = 0.052 points per side.
    expect(series.entryCost).toBeCloseTo(19 + 1 + 0.052, 10)
    expect(series.observations[0]!.netValue).toBeCloseTo(19 - 1 - 0.052, 10)

    // Opening and closing immediately costs the full round trip, and the loss
    // is exactly that: nothing about the position changed.
    const roundTrip = 2 * (1 + 0.052)
    expect(series.observations[0]!.pnlDollars).toBeCloseTo(-roundTrip * 100, 8)
  })

  it('scales P/L by quantity', () => {
    const minutes = minuteRange(ENTRY, 5)
    const series = reconstructDoubleCalendar({
      definition: { ...DEFINITION, quantity: 3 },
      legBars: flatLegs(minutes, {
        ...QUOTES,
        putLong: { bid: 50, ask: 51 }
      }),
      entryContext: CONTEXT,
      entryTimestamp: ENTRY,
      exitHorizonTimestamp: ENTRY + 4 * 60_000,
      execution: FRICTIONLESS
    })
    // Mid is 21.00; entered at 21.00, so P/L is zero regardless of quantity,
    // but the observation still reports three lots' worth of nothing.
    expect(series.observations[0]!.pnlDollars).toBe(0)
    expect(series.definition.quantity).toBe(3)
  })

  it('rejects minutes where one side of the calendar prices below zero', () => {
    const minutes = minuteRange(ENTRY, 6)
    const legs = flatLegs(minutes, QUOTES)
    // Make the long put worth less than the short put in the fourth minute.
    legs.putLong[3] = bar(DEFINITION.tickers.putLong, minutes[3]!, 10, 11)

    const series = reconstructDoubleCalendar({
      definition: DEFINITION,
      legBars: legs,
      entryContext: CONTEXT,
      entryTimestamp: ENTRY,
      exitHorizonTimestamp: ENTRY + 5 * 60_000,
      execution: FRICTIONLESS
    })

    expect(series.observations).toHaveLength(5)
    expect(series.observations.map((o) => o.timestamp)).not.toContain(minutes[3])
    expect(series.quality.invalidPriceMinutes).toBe(1)
    expect(series.invalidPriceSamples?.[0]?.reason).toMatch(/put calendar/)
  })

  it('refuses to enter on a minute where a leg has no two-sided quote', () => {
    const minutes = minuteRange(ENTRY, 6)
    const legs = flatLegs(minutes, QUOTES)
    // Remove the first two minutes of one leg entirely; the entry must wait.
    legs.callLong = legs.callLong.slice(2)

    const series = reconstructDoubleCalendar({
      definition: DEFINITION,
      legBars: legs,
      entryContext: CONTEXT,
      entryTimestamp: ENTRY,
      exitHorizonTimestamp: ENTRY + 5 * 60_000,
      execution: { ...FRICTIONLESS, missingData: { mode: 'strict' } }
    })

    expect(series.entryTimestamp).toBe(minutes[2])
    expect(series.warnings.join(' ')).toMatch(/2 minute\(s\) later/)
  })

  it('does not enter after the deadline', () => {
    const minutes = minuteRange(ENTRY, 30)
    const legs = flatLegs(minutes, QUOTES)
    legs.callLong = legs.callLong.slice(20)

    expect(() =>
      reconstructDoubleCalendar({
        definition: DEFINITION,
        legBars: legs,
        entryContext: CONTEXT,
        entryTimestamp: ENTRY,
        entryDeadlineTimestamp: ENTRY + 5 * 60_000,
        exitHorizonTimestamp: ENTRY + 29 * 60_000,
        execution: { ...FRICTIONLESS, missingData: { mode: 'strict' } }
      })
    ).toThrow(CalendarReconstructionError)
  })

  it('carries a quote forward only within the configured age', () => {
    const minutes = minuteRange(ENTRY, 10)
    const legs = flatLegs(minutes, QUOTES)
    // The call long stops quoting after minute 2 and returns at minute 9.
    legs.callLong = [legs.callLong[0]!, legs.callLong[1]!, legs.callLong[2]!, legs.callLong[9]!]

    const series = reconstructDoubleCalendar({
      definition: DEFINITION,
      legBars: legs,
      entryContext: CONTEXT,
      entryTimestamp: ENTRY,
      exitHorizonTimestamp: ENTRY + 9 * 60_000,
      execution: { ...FRICTIONLESS, missingData: { mode: 'carryForward', maxStaleMinutes: 3 } }
    })

    // Minutes 3, 4 and 5 carry the minute-2 quote; 6, 7 and 8 are too old.
    const stamps = series.observations.map((o) => o.timestamp)
    expect(stamps).toContain(minutes[5])
    expect(stamps).not.toContain(minutes[6])
    expect(series.observations.find((o) => o.timestamp === minutes[5])!.stale).toBe(true)
    expect(series.quality.staleMinutes).toBe(3)
  })

  it('measures how far the index sits outside the short strikes', () => {
    const minutes = minuteRange(ENTRY, 3)
    const series = reconstructDoubleCalendar({
      definition: DEFINITION,
      legBars: flatLegs(minutes, QUOTES),
      underlyingBars: [
        { ticker: 'I:SPX', timestamp: minutes[0]!, open: 6800, high: 6800, low: 6800, close: 6800 },
        { ticker: 'I:SPX', timestamp: minutes[1]!, open: 6950, high: 6950, low: 6950, close: 6950 },
        { ticker: 'I:SPX', timestamp: minutes[2]!, open: 6650, high: 6650, low: 6650, close: 6650 }
      ],
      entryContext: CONTEXT,
      entryTimestamp: ENTRY,
      exitHorizonTimestamp: ENTRY + 2 * 60_000,
      execution: FRICTIONLESS
    })

    // Inside the tent is negative; the nearer strike is 100 points away.
    expect(series.observations[0]!.breachPoints).toBeCloseTo(-100, 10)
    // 50 points above the 6900 call strike, and 50 below the 6700 put strike.
    expect(series.observations[1]!.breachPoints).toBeCloseTo(50, 10)
    expect(series.observations[2]!.breachPoints).toBeCloseTo(50, 10)
  })

  it('counts front DTE down across sessions', () => {
    const minutes = [
      ...minuteRange(easternToTimestamp('2026-03-12', 10, 0), 3),
      ...minuteRange(easternToTimestamp('2026-03-13', 10, 0), 3),
      ...minuteRange(easternToTimestamp('2026-03-16', 10, 0), 3)
    ]
    const series = reconstructDoubleCalendar({
      definition: DEFINITION,
      legBars: flatLegs(minutes, QUOTES),
      entryContext: CONTEXT,
      entryTimestamp: minutes[0]!,
      exitHorizonTimestamp: HORIZON,
      execution: FRICTIONLESS
    })

    const first = series.observations[0]!
    const last = series.observations.at(-1)!
    expect(first.frontDte).toBe(4)
    expect(first.sessionsSinceEntry).toBe(0)
    expect(last.frontDte).toBe(0)
    expect(last.sessionsSinceEntry).toBe(2)
  })

  it('treats a zero offer as no quote at all, not as a worthless package', () => {
    /*
     * The archive stores the 09:30 pre-open state as 0.00 bid / 0.00 offer on
     * every contract. Read as a price it makes the package worth nothing, which
     * is an instant total loss and fires every stop in the study on the first
     * morning after entry.
     */
    const minutes = minuteRange(ENTRY, 6)
    const legs = flatLegs(minutes, QUOTES)
    for (const role of Object.keys(legs) as CalendarLegRole[]) {
      legs[role][2] = bar(DEFINITION.tickers[role], minutes[2]!, 0, 0)
    }

    const series = reconstructDoubleCalendar({
      definition: DEFINITION,
      legBars: legs,
      entryContext: CONTEXT,
      entryTimestamp: ENTRY,
      exitHorizonTimestamp: ENTRY + 5 * 60_000,
      execution: { ...FRICTIONLESS, missingData: { mode: 'strict' } }
    })

    expect(series.observations.map((o) => o.timestamp)).not.toContain(minutes[2])
    expect(Math.min(...series.observations.map((o) => o.pnlPct))).toBeGreaterThan(-1)
    expect(series.quality.unpricedMinutes).toBe(1)
  })

  it('rejects a snapshot far wider than the running width of its legs', () => {
    // A market maker mid-reprice: momentarily wide, and its midpoint is wrong.
    const minutes = minuteRange(ENTRY, 30)
    const legs = flatLegs(minutes, QUOTES)
    legs.putLong[20] = bar(DEFINITION.tickers.putLong, minutes[20]!, 20, 140)

    const series = reconstructDoubleCalendar({
      definition: DEFINITION,
      legBars: legs,
      entryContext: CONTEXT,
      entryTimestamp: ENTRY,
      exitHorizonTimestamp: ENTRY + 29 * 60_000,
      execution: FRICTIONLESS
    })

    expect(series.observations.map((o) => o.timestamp)).not.toContain(minutes[20])
    expect(series.invalidPriceSamples?.some((s) => /reprice/.test(s.reason))).toBe(true)
  })

  it('estimates the fill width from a trailing window, never a later minute', () => {
    /*
     * One wide sample must not set the friction for the minutes around it, and
     * the estimate must not consult quotes from after the minute it prices.
     */
    const minutes = minuteRange(ENTRY, 40)
    const legs = flatLegs(minutes, QUOTES)
    // A sustained widening from minute 20 onward, on one leg.
    for (let i = 20; i < 40; i++) {
      legs.callLong[i] = bar(DEFINITION.tickers.callLong, minutes[i]!, 38, 42)
    }

    const series = reconstructDoubleCalendar({
      definition: DEFINITION,
      legBars: legs,
      entryContext: CONTEXT,
      entryTimestamp: ENTRY,
      exitHorizonTimestamp: ENTRY + 39 * 60_000,
      execution: FRICTIONLESS
    })

    const spreadAt = (index: number): number =>
      series.observations.find((o) => o.timestamp === minutes[index])!.spread

    // Before the widening the estimate knows nothing of it: four one-point legs.
    expect(spreadAt(19)).toBeCloseTo(4, 10)
    // It has not fully caught up one minute in, and has by the end.
    expect(spreadAt(21)).toBeLessThan(7)
    expect(spreadAt(39)).toBeCloseTo(7, 10)
  })

  it('refuses a horizon before the entry', () => {
    expect(() =>
      reconstructDoubleCalendar({
        definition: DEFINITION,
        legBars: flatLegs(minuteRange(ENTRY, 3), QUOTES),
        entryContext: CONTEXT,
        entryTimestamp: ENTRY,
        exitHorizonTimestamp: ENTRY - 60_000,
        execution: FRICTIONLESS
      })
    ).toThrow(/before the entry/)
  })
})
