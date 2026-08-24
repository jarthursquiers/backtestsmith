import { DuckDBConnection, DuckDBInstance } from '@duckdb/node-api'
import type { OptionBar, UnderlyingBar } from '../domain/bars.js'
import type { MarketDate } from '../core/time/marketTime.js'
import type { CalendarDataSource } from '../backtest/calendarStudy.js'
import type { ChainQuote } from '../backtest/calendarStrikes.js'
import {
  queryArchivedExpirations,
  queryChainSnapshot,
  queryOptionBarsForTickers,
  type QueryFn
} from './calendarArchiveQueries.js'

/**
 * Read-only access to the cached market-data database.
 *
 * The application's `Database` class opens the file read-write and runs
 * migrations on open. That is right for the app and wrong for a study: the
 * archive is a hundred gigabytes that nothing here needs to change, and taking
 * a write lock on it means a research run cannot share the machine with the
 * running application. This opens the same file in read-only mode and asks it
 * questions.
 *
 * It is also the first data source in the codebase that never falls back to a
 * provider. A double calendar study touches four contracts per trade across
 * every session of their lives; served over an API at five calls a minute, one
 * year of weekly entries would take days. Everything it needs is already
 * cached, so a cache miss here is a genuine finding - a gap in the archive -
 * rather than a cue to go and fetch.
 */

export interface ArchiveOptions {
  /** Absolute path to `market-data.duckdb`. */
  path: string
  /**
   * How far back a quote may be carried when the exact minute is absent, in
   * minutes. Applies to chain snapshots only; leg series return raw bars and
   * let the reconstruction apply its own policy.
   */
  snapshotCarryMinutes?: number
}


export class MarketArchive {
  private instance: DuckDBInstance | null = null
  private connection: DuckDBConnection | null = null
  private readonly snapshotCarryMs: number

  constructor(private readonly options: ArchiveOptions) {
    this.snapshotCarryMs = (options.snapshotCarryMinutes ?? 5) * 60_000
  }

  async open(): Promise<void> {
    if (this.connection) return
    this.instance = await DuckDBInstance.create(this.options.path, { access_mode: 'READ_ONLY' })
    this.connection = await this.instance.connect()
  }

  async close(): Promise<void> {
    this.connection?.closeSync()
    this.connection = null
    this.instance = null
  }

  private conn(): DuckDBConnection {
    if (!this.connection) throw new Error('The market archive is not open')
    return this.connection
  }

  /**
   * Arrow property rather than a method so it can be handed to the shared
   * query builders directly, without a bound wrapper at every call site.
   */
  private readonly query: QueryFn = async <T>(sql: string, params: unknown[] = []): Promise<T[]> => {
    const reader = await this.conn().runAndReadAll(sql, params as never)
    return reader.getRowObjects().map((row) => {
      const out: Record<string, unknown> = {}
      for (const [key, value] of Object.entries(row)) {
        out[key] = typeof value === 'bigint' ? Number(value) : value
      }
      return out as T
    })
  }

  /** Expirations of the given root quoted on a session. */
  listExpirations(root: string, onDate: MarketDate): Promise<MarketDate[]> {
    return queryArchivedExpirations(this.query, root, onDate)
  }

  /** Every two-sided quote for one expiration at one minute. */
  chainSnapshot(
    root: string,
    expiration: MarketDate,
    onDate: MarketDate,
    minute: number
  ): Promise<ChainQuote[]> {
    return queryChainSnapshot(this.query, root, expiration, onDate, minute, this.snapshotCarryMs)
  }

  /** Minute bars for several contracts at once, keyed by ticker. */
  getOptionBars(
    tickers: readonly string[],
    from: MarketDate,
    to: MarketDate
  ): Promise<Record<string, OptionBar[]>> {
    return queryOptionBarsForTickers(this.query, tickers, from, to)
  }

  async getUnderlyingMinutes(ticker: string, date: MarketDate): Promise<UnderlyingBar[]> {
    const rows = await this.query<{
      ts: number
      open: number
      high: number
      low: number
      close: number
      volume: number | null
    }>(
      `SELECT ts, open, high, low, close, volume
         FROM underlying_bars
        WHERE timespan = 'minute' AND multiplier = 1 AND ticker = ? AND market_date = ?
        ORDER BY ts`,
      [ticker, date]
    )
    return rows.map((row) => ({
      ticker,
      timestamp: row.ts,
      open: row.open,
      high: row.high,
      low: row.low,
      close: row.close,
      ...(row.volume !== null ? { volume: row.volume } : {})
    }))
  }
}

/**
 * A data source that caches per-session lookups for the duration of a study.
 *
 * Weekly entries with a two-week horizon means consecutive trades overlap by
 * ten sessions, and the index minutes for each of those are otherwise read once
 * per trade. Caching them turns roughly ten reads per session into one.
 */
export function calendarSourceFrom(archive: MarketArchive): CalendarDataSource {
  const expirations = new Map<string, Promise<MarketDate[]>>()
  const underlying = new Map<string, Promise<UnderlyingBar[]>>()

  return {
    listExpirations: (root, onDate) => {
      const key = `${root}|${onDate}`
      let pending = expirations.get(key)
      if (!pending) {
        pending = archive.listExpirations(root, onDate)
        expirations.set(key, pending)
      }
      return pending
    },
    chainSnapshot: (root, expiration, onDate, minute) =>
      archive.chainSnapshot(root, expiration, onDate, minute),
    getOptionBars: (tickers, from, to) => archive.getOptionBars(tickers, from, to),
    getUnderlyingMinutes: (ticker, date) => {
      const key = `${ticker}|${date}`
      let pending = underlying.get(key)
      if (!pending) {
        pending = archive.getUnderlyingMinutes(ticker, date)
        underlying.set(key, pending)
      }
      return pending
    }
  }
}

export { parseOptionTicker } from './calendarArchiveQueries.js'
