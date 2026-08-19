import { describe, expect, it } from 'vitest'
import type { UnderlyingBar } from '../domain/bars.js'
import type { WingWidthBand } from '../shared/study.js'
import { describeBands } from '../shared/study.js'
import { easternToTimestamp } from '../core/time/marketTime.js'
import { previousGaugeClose, readGauge, validateBands, wingWidthForLevel } from './wingWidth.js'

/** The bands from the study request: 20 under 17, 30 from 17 to 32, 45 above. */
const BANDS: WingWidthBand[] = [
  { below: 17, wingWidth: 20 },
  { below: 32, wingWidth: 30 },
  { wingWidth: 45 }
]

const DATE = '2025-06-02'
const ENTRY = easternToTimestamp(DATE, 9, 35)

function bar(timestamp: number, close: number): UnderlyingBar {
  return { ticker: 'I:VIX', timestamp, open: close, high: close, low: close, close }
}

describe('wingWidthForLevel', () => {
  it('takes the band the level falls in', () => {
    expect(wingWidthForLevel(BANDS, 12)).toBe(20)
    expect(wingWidthForLevel(BANDS, 25)).toBe(30)
    expect(wingWidthForLevel(BANDS, 40)).toBe(45)
  })

  it('treats each bound as the exclusive top of its band', () => {
    // 17 belongs to the 17-32 band, not to the one below it. Getting this
    // backwards would silently shift every trade on a threshold day.
    expect(wingWidthForLevel(BANDS, 16.99)).toBe(20)
    expect(wingWidthForLevel(BANDS, 17)).toBe(30)
    expect(wingWidthForLevel(BANDS, 31.99)).toBe(30)
    expect(wingWidthForLevel(BANDS, 32)).toBe(45)
  })

  it('has an answer for extreme readings, since the last band is open-ended', () => {
    expect(wingWidthForLevel(BANDS, 0)).toBe(20)
    expect(wingWidthForLevel(BANDS, 90)).toBe(45)
  })
})

describe('validateBands', () => {
  it('accepts a well-formed list', () => {
    expect(validateBands(BANDS)).toEqual([])
  })

  it('rejects a list whose last band is bounded, which would leave a gap', () => {
    expect(validateBands([{ below: 17, wingWidth: 20 }, { below: 32, wingWidth: 30 }])).toEqual([
      'The last band must be open-ended so that every gauge level falls inside a band.'
    ])
  })

  it('rejects bounds that do not increase', () => {
    const problems = validateBands([
      { below: 32, wingWidth: 20 },
      { below: 17, wingWidth: 30 },
      { wingWidth: 45 }
    ])
    expect(problems.join(' ')).toContain('must increase')
  })

  it('rejects a non-positive width', () => {
    expect(validateBands([{ below: 17, wingWidth: 0 }, { wingWidth: 45 }]).join(' ')).toContain(
      'must be positive'
    )
  })

  it('rejects an empty list rather than defaulting to something', () => {
    expect(validateBands([])).toHaveLength(1)
  })
})

describe('describeBands', () => {
  it('reads back as the rule was stated', () => {
    expect(describeBands(BANDS)).toBe('20 under 17, 30 17-32, 45 at 32+')
  })
})

describe('readGauge', () => {
  it('prefers the reading in the entry minute itself', () => {
    const reading = readGauge({
      entryTimestamp: ENTRY,
      minutes: [bar(ENTRY - 60_000, 14), bar(ENTRY, 18), bar(ENTRY + 60_000, 40)]
    })
    expect(reading).toEqual({ level: 18, source: 'entryMinute', ageMinutes: 0 })
  })

  it('never reads a bar after the entry minute', () => {
    // The 40 print is two minutes into the future and would change the width.
    const reading = readGauge({
      entryTimestamp: ENTRY,
      minutes: [bar(ENTRY - 120_000, 14), bar(ENTRY + 120_000, 40)]
    })
    expect(reading!.level).toBe(14)
    expect(reading!.source).toBe('carriedForward')
    expect(reading!.ageMinutes).toBe(2)
  })

  it('falls back to the previous session close when the session has no usable bar', () => {
    const reading = readGauge({
      entryTimestamp: ENTRY,
      minutes: [],
      previousDaily: bar(easternToTimestamp('2025-05-30', 16, 0), 21)
    })
    expect(reading).toMatchObject({ level: 21, source: 'previousClose' })
  })

  it('prefers the previous close over a within-session bar that is too stale', () => {
    const reading = readGauge({
      entryTimestamp: ENTRY,
      minutes: [bar(ENTRY - 120 * 60_000, 14)],
      previousDaily: bar(easternToTimestamp('2025-05-30', 16, 0), 21),
      maxCarryMinutes: 30
    })
    expect(reading).toMatchObject({ level: 21, source: 'previousClose' })
  })

  it('returns null when there is nothing knowable at entry', () => {
    expect(readGauge({ entryTimestamp: ENTRY, minutes: [] })).toBeNull()
  })
})

describe('previousGaugeClose', () => {
  it('ignores the entry day, whose close is hours of hindsight', () => {
    const bars = [
      bar(easternToTimestamp('2025-05-30', 16, 0), 21),
      bar(easternToTimestamp(DATE, 16, 0), 35)
    ]
    expect(previousGaugeClose(bars, DATE)!.close).toBe(21)
  })

  it('is undefined when no earlier session exists', () => {
    expect(previousGaugeClose([bar(easternToTimestamp(DATE, 16, 0), 35)], DATE)).toBeUndefined()
  })
})
