import { DateTime } from 'luxon'
import type { UnderlyingBar } from '../../domain/bars.js'
import { MARKET_ZONE, assertMarketDate, marketDateOf, type MarketDate } from '../../core/time/marketTime.js'

/**
 * CSV import for underlying price history.
 *
 * This is the primary acquisition path for SPX, because index data (`I:SPX`) is
 * not included in the Massive Options plans - a request returns HTTP 403 "not
 * entitled". The importer is therefore held to the same standard as the API
 * provider: it validates, reports what it rejected and why, and never invents a
 * value it did not read.
 *
 * The single most dangerous assumption here is the timezone. Exports from
 * charting platforms almost always carry naive local timestamps with no offset,
 * so this parser requires the caller to state how naive values should be read
 * rather than silently guessing.
 */

export type CsvTimezone = 'market' | 'utc'

export interface CsvColumnMapping {
  /** Combined date+time column. Mutually exclusive with `date`/`time`. */
  datetime?: number
  date?: number
  time?: number
  open: number
  high: number
  low: number
  close: number
  volume?: number
}

export interface CsvParseOptions {
  ticker: string
  timespan: 'minute' | 'day'
  /** How to interpret timestamps that carry no explicit UTC offset. */
  timezone?: CsvTimezone
  /** Overrides header auto-detection. */
  mapping?: CsvColumnMapping
  /** Rows to skip beyond the detected header, for files with preamble text. */
  skipRows?: number
}

export interface CsvRowIssue {
  /** 1-based line number in the source file, for pointing the user at it. */
  line: number
  reason: string
}

export interface CsvParseResult {
  bars: UnderlyingBar[]
  mapping: CsvColumnMapping
  hasHeader: boolean
  delimiter: string
  /** Data rows examined, excluding the header. */
  rowsRead: number
  rowsAccepted: number
  skipped: CsvRowIssue[]
  warnings: string[]
  dateRange: { from: MarketDate; to: MarketDate } | null
  /** Distinct Eastern market dates represented. */
  marketDates: MarketDate[]
}

const HEADER_ALIASES: Record<keyof CsvColumnMapping, string[]> = {
  datetime: ['datetime', 'date time', 'date_time', 'timestamp', 'time stamp', 'datetimeet'],
  date: ['date', 'day', 'trade date', 'tradedate'],
  time: ['time', 'bar time', 'bartime'],
  open: ['open', 'o', 'open price'],
  high: ['high', 'h', 'high price'],
  low: ['low', 'l', 'low price'],
  close: ['close', 'c', 'last', 'close price', 'close/last'],
  volume: ['volume', 'vol', 'v', 'total volume']
}

const DELIMITERS = [',', ';', '\t', '|']

/** Picks the delimiter that yields the most consistent column count. */
export function detectDelimiter(lines: readonly string[]): string {
  let best = ','
  let bestScore = -1
  for (const delimiter of DELIMITERS) {
    const counts = lines.slice(0, 10).map((l) => splitCsvLine(l, delimiter).length)
    const max = Math.max(...counts)
    if (max < 2) continue
    const consistent = counts.filter((c) => c === max).length
    const score = consistent * 100 + max
    if (score > bestScore) {
      bestScore = score
      best = delimiter
    }
  }
  return best
}

/** Splits one CSV line, honoring double-quoted fields. */
export function splitCsvLine(line: string, delimiter: string): string[] {
  const out: string[] = []
  let field = ''
  let inQuotes = false

  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          field += '"'
          i++
        } else {
          inQuotes = false
        }
      } else {
        field += ch
      }
    } else if (ch === '"') {
      inQuotes = true
    } else if (ch === delimiter) {
      out.push(field.trim())
      field = ''
    } else {
      field += ch
    }
  }
  out.push(field.trim())
  return out
}

function normalizeHeader(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9 _/]/g, '').trim()
}

/** Maps header names onto column indices; returns null when required fields are absent. */
export function detectMapping(header: readonly string[]): CsvColumnMapping | null {
  const normalized = header.map(normalizeHeader)
  const find = (key: keyof CsvColumnMapping): number | undefined => {
    const aliases = HEADER_ALIASES[key]
    for (const alias of aliases) {
      const index = normalized.indexOf(alias)
      if (index >= 0) return index
    }
    return undefined
  }

  const open = find('open')
  const high = find('high')
  const low = find('low')
  const close = find('close')
  if (open === undefined || high === undefined || low === undefined || close === undefined) return null

  const datetime = find('datetime')
  const date = find('date')
  const time = find('time')
  if (datetime === undefined && date === undefined) return null

  const volume = find('volume')

  return {
    ...(datetime !== undefined ? { datetime } : {}),
    ...(date !== undefined ? { date } : {}),
    ...(time !== undefined ? { time } : {}),
    open,
    high,
    low,
    close,
    ...(volume !== undefined ? { volume } : {})
  }
}

/**
 * Parses a date/time pair into a UTC epoch millisecond timestamp.
 *
 * Accepts ISO, US-style, and epoch inputs. A value carrying an explicit offset
 * or trailing Z is honored as-is; anything naive is interpreted in `zone`.
 */
export function parseTimestamp(
  dateText: string,
  timeText: string | undefined,
  zone: CsvTimezone
): number | null {
  const raw = (timeText ? `${dateText} ${timeText}` : dateText).trim()
  if (!raw) return null

  // Bare epoch values: seconds if 10 digits, milliseconds if 13.
  if (/^\d{10}$/.test(raw)) return Number(raw) * 1000
  if (/^\d{13}$/.test(raw)) return Number(raw)

  const luxonZone = zone === 'market' ? MARKET_ZONE : 'utc'
  const hasExplicitOffset = /(?:Z|[+-]\d{2}:?\d{2})$/.test(raw)

  // ISO-ish first, since it is unambiguous.
  const iso = DateTime.fromISO(raw.replace(' ', 'T'), {
    zone: hasExplicitOffset ? undefined : luxonZone,
    setZone: hasExplicitOffset
  })
  if (iso.isValid) return iso.toMillis()

  const formats = [
    'M/d/yyyy H:mm:ss',
    'M/d/yyyy H:mm',
    'M/d/yyyy',
    'd/M/yyyy H:mm',
    'yyyy/M/d H:mm:ss',
    'yyyy/M/d H:mm',
    'yyyy/M/d',
    'yyyyMMdd HH:mm:ss',
    'yyyyMMdd',
    'M-d-yyyy H:mm',
    'dd-MMM-yyyy',
    'MMM d, yyyy'
  ]
  for (const format of formats) {
    const parsed = DateTime.fromFormat(raw, format, { zone: luxonZone })
    if (parsed.isValid) return parsed.toMillis()
  }

  return null
}

function parseNumber(text: string | undefined): number | null {
  if (text === undefined) return null
  // Tolerate thousands separators, currency symbols, and parenthesized negatives.
  const cleaned = text.replace(/[$,\s]/g, '').replace(/^\((.*)\)$/, '-$1')
  if (cleaned === '' || cleaned === '-' || cleaned.toLowerCase() === 'null' || cleaned.toLowerCase() === 'n/a') {
    return null
  }
  const value = Number(cleaned)
  return Number.isFinite(value) ? value : null
}

/**
 * Parses CSV text into underlying bars.
 *
 * Rows that fail validation are skipped and reported rather than silently
 * dropped or repaired, so an import that quietly loses half a file is visible.
 */
export function parseUnderlyingCsv(text: string, options: CsvParseOptions): CsvParseResult {
  const zone = options.timezone ?? 'market'
  const warnings: string[] = []
  const skipped: CsvRowIssue[] = []

  const rawLines = text.split(/\r\n|\n|\r/)
  const lines: { text: string; line: number }[] = []
  rawLines.forEach((value, index) => {
    if (value.trim().length > 0) lines.push({ text: value, line: index + 1 })
  })

  if (lines.length === 0) {
    return emptyResult(options, ',', warnings, skipped)
  }

  const delimiter = detectDelimiter(lines.map((l) => l.text))
  const firstCells = splitCsvLine(lines[0]!.text, delimiter)

  let mapping = options.mapping ?? null
  let hasHeader = false

  if (!mapping) {
    const detected = detectMapping(firstCells)
    if (detected) {
      mapping = detected
      hasHeader = true
    } else {
      throw new Error(
        'Could not identify the columns in this file. Expected headers for date (or datetime) plus open, high, low, and close.'
      )
    }
  } else {
    // With an explicit mapping, treat a non-numeric first row as a header.
    hasHeader = parseNumber(firstCells[mapping.close]) === null
  }

  const dataLines = lines.slice((hasHeader ? 1 : 0) + (options.skipRows ?? 0))
  const bars: UnderlyingBar[] = []
  const seenTimestamps = new Set<number>()
  const marketDates = new Set<MarketDate>()
  let duplicates = 0

  for (const { text: lineText, line } of dataLines) {
    const cells = splitCsvLine(lineText, delimiter)

    const dateCell = mapping.datetime !== undefined ? cells[mapping.datetime] : cells[mapping.date!]
    const timeCell = mapping.datetime !== undefined ? undefined : mapping.time !== undefined ? cells[mapping.time] : undefined

    if (dateCell === undefined || dateCell === '') {
      skipped.push({ line, reason: 'missing date' })
      continue
    }

    const timestamp = parseTimestamp(dateCell, timeCell, zone)
    if (timestamp === null) {
      skipped.push({ line, reason: `unrecognized date/time "${[dateCell, timeCell].filter(Boolean).join(' ')}"` })
      continue
    }

    const open = parseNumber(cells[mapping.open])
    const high = parseNumber(cells[mapping.high])
    const low = parseNumber(cells[mapping.low])
    const close = parseNumber(cells[mapping.close])

    if (open === null || high === null || low === null || close === null) {
      skipped.push({ line, reason: 'missing or non-numeric OHLC value' })
      continue
    }
    if (open <= 0 || high <= 0 || low <= 0 || close <= 0) {
      skipped.push({ line, reason: 'non-positive price' })
      continue
    }
    // An index level cannot trade outside its own range; such a row is corrupt,
    // and repairing it would fabricate data.
    if (high < low || high < Math.max(open, close) || low > Math.min(open, close)) {
      skipped.push({ line, reason: `inconsistent OHLC (o=${open} h=${high} l=${low} c=${close})` })
      continue
    }

    if (seenTimestamps.has(timestamp)) {
      duplicates++
      continue
    }
    seenTimestamps.add(timestamp)

    const volume = mapping.volume !== undefined ? parseNumber(cells[mapping.volume]) : null

    bars.push({
      ticker: options.ticker,
      timestamp,
      open,
      high,
      low,
      close,
      // Index feeds report no volume; absent must stay absent, not become zero.
      ...(volume !== null ? { volume } : {})
    })
    marketDates.add(marketDateOf(timestamp))
  }

  bars.sort((a, b) => a.timestamp - b.timestamp)

  if (duplicates > 0) {
    warnings.push(`${duplicates} duplicate timestamps were ignored; the first occurrence of each was kept.`)
  }
  if (skipped.length > 0) {
    warnings.push(`${skipped.length} of ${dataLines.length} rows were skipped and not imported.`)
  }

  const sortedDates = [...marketDates].sort()
  if (options.timespan === 'minute' && bars.length > 0) {
    const perDay = bars.length / Math.max(1, sortedDates.length)
    if (perDay < 100) {
      warnings.push(
        `This file averages ${perDay.toFixed(0)} bars per day, which is sparse for minute data (a full session is 390).`
      )
    }
  }
  if (options.timespan === 'day' && bars.length > sortedDates.length) {
    warnings.push('Multiple bars share a market date, which is unexpected for daily data.')
  }

  return {
    bars,
    mapping,
    hasHeader,
    delimiter,
    rowsRead: dataLines.length,
    rowsAccepted: bars.length,
    skipped: skipped.slice(0, 100),
    warnings,
    dateRange:
      sortedDates.length > 0
        ? { from: assertMarketDate(sortedDates[0]!), to: assertMarketDate(sortedDates[sortedDates.length - 1]!) }
        : null,
    marketDates: sortedDates
  }
}

function emptyResult(
  options: CsvParseOptions,
  delimiter: string,
  warnings: string[],
  skipped: CsvRowIssue[]
): CsvParseResult {
  return {
    bars: [],
    mapping: { open: -1, high: -1, low: -1, close: -1 },
    hasHeader: false,
    delimiter,
    rowsRead: 0,
    rowsAccepted: 0,
    skipped,
    warnings: [...warnings, 'The file contained no data rows.'],
    dateRange: null,
    marketDates: []
  }
}
