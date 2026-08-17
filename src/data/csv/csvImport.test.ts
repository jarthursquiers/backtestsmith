import { describe, expect, it } from 'vitest'
import { detectDelimiter, detectMapping, parseTimestamp, parseUnderlyingCsv, splitCsvLine } from './csvImport.js'
import { marketDateOf } from '../../core/time/marketTime.js'

const utc = (ms: number): string => new Date(ms).toISOString()

describe('CSV structure detection', () => {
  it('detects common delimiters', () => {
    expect(detectDelimiter(['a,b,c', '1,2,3'])).toBe(',')
    expect(detectDelimiter(['a;b;c', '1;2;3'])).toBe(';')
    expect(detectDelimiter(['a\tb\tc', '1\t2\t3'])).toBe('\t')
  })

  it('honors quoted fields containing the delimiter', () => {
    expect(splitCsvLine('2025-06-17,"6,001.50",6010', ',')).toEqual(['2025-06-17', '6,001.50', '6010'])
    expect(splitCsvLine('a,"say ""hi""",b', ',')).toEqual(['a', 'say "hi"', 'b'])
  })

  it('maps headers regardless of case, spacing, and naming', () => {
    expect(detectMapping(['Date', 'Open', 'High', 'Low', 'Close', 'Volume'])).toEqual({
      date: 0, open: 1, high: 2, low: 3, close: 4, volume: 5
    })
    expect(detectMapping(['Time', 'O', 'H', 'L', 'C'])).toBeNull() // no date column
    expect(detectMapping(['DateTime', 'O', 'H', 'L', 'C', 'Vol'])).toEqual({
      datetime: 0, open: 1, high: 2, low: 3, close: 4, volume: 5
    })
    expect(detectMapping(['Date', 'Close/Last', 'Open', 'High', 'Low'])).toEqual({
      date: 0, close: 1, open: 2, high: 3, low: 4
    })
  })
})

describe('timestamp parsing', () => {
  it('interprets naive values in Eastern market time by default', () => {
    // The load-bearing case: a platform export with no offset.
    expect(utc(parseTimestamp('2025-06-17', '09:35', 'market')!)).toBe('2025-06-17T13:35:00.000Z')
    expect(utc(parseTimestamp('2025-01-06', '09:35', 'market')!)).toBe('2025-01-06T14:35:00.000Z') // EST
  })

  it('can interpret naive values as UTC when told to', () => {
    expect(utc(parseTimestamp('2025-06-17', '13:35', 'utc')!)).toBe('2025-06-17T13:35:00.000Z')
  })

  it('honors an explicit offset over the assumed zone', () => {
    expect(utc(parseTimestamp('2025-06-17T13:35:00Z', undefined, 'market')!)).toBe('2025-06-17T13:35:00.000Z')
    expect(utc(parseTimestamp('2025-06-17T09:35:00-04:00', undefined, 'utc')!)).toBe('2025-06-17T13:35:00.000Z')
  })

  it('accepts US-style and combined formats', () => {
    expect(utc(parseTimestamp('6/17/2025', '9:35', 'market')!)).toBe('2025-06-17T13:35:00.000Z')
    expect(utc(parseTimestamp('06/17/2025 09:35:00', undefined, 'market')!)).toBe('2025-06-17T13:35:00.000Z')
    expect(utc(parseTimestamp('2025-06-17 09:35:00', undefined, 'market')!)).toBe('2025-06-17T13:35:00.000Z')
  })

  it('accepts epoch seconds and milliseconds', () => {
    expect(parseTimestamp('1750167300', undefined, 'market')).toBe(1750167300000)
    expect(parseTimestamp('1750167300000', undefined, 'market')).toBe(1750167300000)
  })

  it('returns null rather than guessing at unparseable input', () => {
    expect(parseTimestamp('not a date', undefined, 'market')).toBeNull()
    expect(parseTimestamp('', undefined, 'market')).toBeNull()
  })
})

describe('parseUnderlyingCsv', () => {
  const dailyCsv = [
    'Date,Open,High,Low,Close,Volume',
    '2025-06-16,5980.10,6005.40,5975.00,6001.20,2500000',
    '2025-06-17,6001.50,6020.00,5990.30,6010.75,2610000',
    '2025-06-18,6010.00,6015.00,5960.10,5970.40,2700000'
  ].join('\n')

  it('parses a daily file and anchors bars to the Eastern market date', () => {
    const result = parseUnderlyingCsv(dailyCsv, { ticker: 'I:SPX', timespan: 'day' })

    expect(result.rowsAccepted).toBe(3)
    expect(result.hasHeader).toBe(true)
    expect(result.dateRange).toEqual({ from: '2025-06-16', to: '2025-06-18' })
    expect(result.bars.map((b) => b.close)).toEqual([6001.2, 6010.75, 5970.4])
    expect(result.bars.map((b) => marketDateOf(b.timestamp))).toEqual([
      '2025-06-16',
      '2025-06-17',
      '2025-06-18'
    ])
    expect(result.skipped).toEqual([])
  })

  it('parses a minute file with separate date and time columns', () => {
    const csv = [
      'Date,Time,Open,High,Low,Close',
      '2025-06-17,09:35,6001.50,6003.00,6000.10,6002.20',
      '2025-06-17,09:36,6002.20,6004.50,6001.80,6004.10'
    ].join('\n')

    const result = parseUnderlyingCsv(csv, { ticker: 'I:SPX', timespan: 'minute' })
    expect(result.rowsAccepted).toBe(2)
    expect(utc(result.bars[0]!.timestamp)).toBe('2025-06-17T13:35:00.000Z')
    expect(result.bars[0]?.volume).toBeUndefined() // absent stays absent
  })

  it('rejects rows whose OHLC cannot be true, rather than repairing them', () => {
    const csv = [
      'Date,Open,High,Low,Close',
      '2025-06-16,5980,6005,5975,6001',
      '2025-06-17,6001,5990,5995,6010', // high below low and below close
      '2025-06-18,6010,6015,5960,5970'
    ].join('\n')

    const result = parseUnderlyingCsv(csv, { ticker: 'I:SPX', timespan: 'day' })
    expect(result.rowsAccepted).toBe(2)
    expect(result.skipped).toHaveLength(1)
    expect(result.skipped[0]?.line).toBe(3) // 1-based, includes the header line
    expect(result.skipped[0]?.reason).toMatch(/inconsistent OHLC/)
    expect(result.warnings.join(' ')).toMatch(/1 of 3 rows were skipped/)
  })

  it('reports unparseable and non-numeric rows with their line numbers', () => {
    const csv = [
      'Date,Open,High,Low,Close',
      '2025-06-16,5980,6005,5975,6001',
      'garbage,1,2,3,4',
      '2025-06-18,,6015,5960,5970'
    ].join('\n')

    const result = parseUnderlyingCsv(csv, { ticker: 'I:SPX', timespan: 'day' })
    expect(result.rowsAccepted).toBe(1)
    expect(result.skipped.map((s) => s.line)).toEqual([3, 4])
    expect(result.skipped[0]?.reason).toMatch(/unrecognized date/)
    expect(result.skipped[1]?.reason).toMatch(/non-numeric/)
  })

  it('tolerates thousands separators and currency formatting', () => {
    const csv = [
      'Date,Open,High,Low,Close,Volume',
      '2025-06-16,"5,980.10","6,005.40","5,975.00","$6,001.20","2,500,000"'
    ].join('\n')

    const result = parseUnderlyingCsv(csv, { ticker: 'I:SPX', timespan: 'day' })
    expect(result.bars[0]).toMatchObject({ open: 5980.1, close: 6001.2, volume: 2500000 })
  })

  it('drops duplicate timestamps and says so', () => {
    const csv = [
      'Date,Open,High,Low,Close',
      '2025-06-16,5980,6005,5975,6001',
      '2025-06-16,5980,6005,5975,6001'
    ].join('\n')

    const result = parseUnderlyingCsv(csv, { ticker: 'I:SPX', timespan: 'day' })
    expect(result.rowsAccepted).toBe(1)
    expect(result.warnings.join(' ')).toMatch(/duplicate timestamps/)
  })

  it('sorts out-of-order rows', () => {
    const csv = [
      'Date,Open,High,Low,Close',
      '2025-06-18,6010,6015,5960,5970',
      '2025-06-16,5980,6005,5975,6001'
    ].join('\n')

    const result = parseUnderlyingCsv(csv, { ticker: 'I:SPX', timespan: 'day' })
    expect(result.bars.map((b) => marketDateOf(b.timestamp))).toEqual(['2025-06-16', '2025-06-18'])
  })

  it('warns when a minute file is implausibly sparse', () => {
    const csv = [
      'Date,Time,Open,High,Low,Close',
      '2025-06-17,09:35,6001,6003,6000,6002',
      '2025-06-17,09:36,6002,6004,6001,6004'
    ].join('\n')

    const result = parseUnderlyingCsv(csv, { ticker: 'I:SPX', timespan: 'minute' })
    expect(result.warnings.join(' ')).toMatch(/sparse for minute data/)
  })

  it('fails loudly when the columns cannot be identified', () => {
    expect(() =>
      parseUnderlyingCsv('foo,bar,baz\n1,2,3', { ticker: 'I:SPX', timespan: 'day' })
    ).toThrow(/Could not identify the columns/)
  })

  it('handles a headerless file given an explicit mapping', () => {
    const csv = '2025-06-16,5980,6005,5975,6001\n2025-06-17,6001,6020,5990,6010'
    const result = parseUnderlyingCsv(csv, {
      ticker: 'I:SPX',
      timespan: 'day',
      mapping: { date: 0, open: 1, high: 2, low: 3, close: 4 }
    })
    expect(result.hasHeader).toBe(false)
    expect(result.rowsAccepted).toBe(2)
  })

  it('handles CRLF line endings and a trailing newline', () => {
    const result = parseUnderlyingCsv(dailyCsv.replace(/\n/g, '\r\n') + '\r\n', {
      ticker: 'I:SPX',
      timespan: 'day'
    })
    expect(result.rowsAccepted).toBe(3)
  })
})
