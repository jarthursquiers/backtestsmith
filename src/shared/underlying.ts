import type { UnderlyingBar } from '../domain/bars.js'

/** Where the app can obtain underlying price history. */
export type UnderlyingSource = 'massive' | 'csv-import'

/** Column indices resolved for a CSV file. */
export interface CsvColumnMappingDto {
  datetime?: number
  date?: number
  time?: number
  open: number
  high: number
  low: number
  close: number
  volume?: number
}

export interface CsvRowIssueDto {
  line: number
  reason: string
}

export interface CsvImportOptions {
  ticker: string
  timespan: 'minute' | 'day'
  /** How to read timestamps that carry no explicit UTC offset. */
  timezone: 'market' | 'utc'
}

/**
 * Result of parsing a file without storing it, so the user can confirm the
 * interpretation (especially the timezone) before anything is written.
 */
export interface CsvPreview {
  filePath: string
  fileName: string
  fileBytes: number
  rowsRead: number
  rowsAccepted: number
  distinctDates: number
  mapping: CsvColumnMappingDto
  hasHeader: boolean
  delimiter: string
  warnings: string[]
  skipped: CsvRowIssueDto[]
  dateRange: { from: string; to: string } | null
  /** First few accepted bars, for eyeballing the timezone interpretation. */
  sample: UnderlyingBar[]
}

export interface CsvImportResult {
  imported: number
  distinctDates: number
  dateRange: { from: string; to: string } | null
  warnings: string[]
  skippedCount: number
}

/** One cached session of underlying data. */
export interface UnderlyingCoverageDay {
  marketDate: string
  barCount: number
  source: string
  fetchedAt: number
}
