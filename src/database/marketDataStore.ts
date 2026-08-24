import type { OptionBar, UnderlyingBar } from '../domain/bars.js'
import type { OptionContract, OptionType } from '../domain/contracts.js'
import type { CacheStats } from '../shared/cache.js'
import { marketDateOf, type MarketDate } from '../core/time/marketTime.js'
import { createLogger } from '../services/logger.js'
import type { AppendType, Database } from './duckdb.js'
import type { ChainQuote } from '../backtest/calendarStrikes.js'
import {
  queryArchivedExpirations,
  queryChainSnapshot,
  queryOptionBarsForTickers
} from '../data/calendarArchiveQueries.js'

const log = createLogger('database.store')

/** What the cache knows about one (ticker, date) pair for a given bar shape. */
export interface BarCoverage {
  ticker: string
  marketDate: MarketDate
  barCount: number
  fetchedAt: number
  provider: string
}

export type BarKind = 'option' | 'underlying'

export interface BarShape {
  timespan: string
  multiplier: number
}

/** Default shape for reads; the research engine works in one-minute bars. */
export const MINUTE_BARS: BarShape = { timespan: 'minute', multiplier: 1 }
export const DAILY_BARS: BarShape = { timespan: 'day', multiplier: 1 }

const BASE_BAR_COLUMNS: readonly AppendType[] = [
  'varchar', // ticker
  'varchar', // timespan
  'integer', // multiplier
  'bigint',  // ts
  'varchar', // market_date
  'double',  // open
  'double',  // high
  'double',  // low
  'double',  // close
  'double',  // volume
  'double',  // vwap
  'integer'  // transactions
]

const OPTION_BAR_COLUMNS: readonly AppendType[] = [
  ...BASE_BAR_COLUMNS,
  'double',  // bid
  'double',  // ask
  'double',  // bid_size
  'double'   // ask_size
]

const BAR_COVERAGE_COLUMNS: readonly AppendType[] = [
  'varchar', 'varchar', 'varchar', 'integer', 'varchar', 'integer', 'varchar', 'bigint'
]

/**
 * Persistent store for downloaded market data.
 *
 * Read paths never touch the network; the decision to fetch lives one layer up
 * in `CachedProvider`. This class only answers "what do we already have, and
 * what have we already asked for".
 */
export class MarketDataStore {
  constructor(private readonly db: Database) {}

  // --- contracts ------------------------------------------------------------

  async putContracts(contracts: readonly OptionContract[], provider: string): Promise<void> {
    if (contracts.length === 0) return
    const fetchedAt = Date.now()

    await this.db.transaction(async () => {
      for (const c of contracts) {
        await this.db.run(
          `INSERT INTO option_contracts
             (ticker, underlying, expiration_date, strike, contract_type, exercise_style,
              shares_per_contract, primary_exchange, root, settlement, provider, fetched_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (ticker) DO UPDATE SET
             underlying = excluded.underlying,
             expiration_date = excluded.expiration_date,
             strike = excluded.strike,
             contract_type = excluded.contract_type,
             exercise_style = excluded.exercise_style,
             shares_per_contract = excluded.shares_per_contract,
             primary_exchange = excluded.primary_exchange,
             root = excluded.root,
             settlement = excluded.settlement,
             provider = excluded.provider,
             fetched_at = excluded.fetched_at`,
          [
            c.ticker,
            c.underlying,
            c.expirationDate,
            c.strike,
            c.type,
            c.exerciseStyle ?? null,
            c.sharesPerContract ?? null,
            c.primaryExchange ?? null,
            c.root ?? null,
            c.settlement ?? null,
            provider,
            fetchedAt
          ]
        )
      }
    })

    log.debug('contracts cached', { count: contracts.length })
  }

  async getContracts(
    underlying: string,
    expirationDate: MarketDate,
    type?: OptionType
  ): Promise<OptionContract[]> {
    const rows = await this.db.query<Record<string, unknown>>(
      `SELECT * FROM option_contracts
        WHERE underlying = ? AND expiration_date = ?
          ${type ? 'AND contract_type = ?' : ''}
        ORDER BY strike ASC`,
      type ? [underlying, expirationDate, type] : [underlying, expirationDate]
    )
    return rows.map(rowToContract)
  }

  /** Records that a full chain was enumerated, so an empty chain is not re-queried. */
  async setContractCoverage(
    underlying: string,
    expirationDate: MarketDate,
    type: OptionType | 'any',
    contractCount: number,
    provider: string
  ): Promise<void> {
    await this.db.run(
      `INSERT INTO contract_coverage (underlying, expiration_date, contract_type, contract_count, provider, fetched_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (underlying, expiration_date, contract_type) DO UPDATE SET
         contract_count = excluded.contract_count,
         provider = excluded.provider,
         fetched_at = excluded.fetched_at`,
      [underlying, expirationDate, type, contractCount, provider, Date.now()]
    )
  }

  async hasContractCoverage(
    underlying: string,
    expirationDate: MarketDate,
    type: OptionType | 'any',
    provider?: string
  ): Promise<boolean> {
    const row = await this.db.queryOne<{ n: number }>(
      `SELECT count(*) AS n FROM contract_coverage
        WHERE underlying = ? AND expiration_date = ? AND contract_type IN (?, 'any')
          ${provider ? 'AND provider = ?' : ''}`,
      provider ? [underlying, expirationDate, type, provider] : [underlying, expirationDate, type]
    )
    return (row?.n ?? 0) > 0
  }

  // --- bars -----------------------------------------------------------------

  private table(kind: BarKind): string {
    return kind === 'option' ? 'option_bars' : 'underlying_bars'
  }

  /**
   * Replaces all cached bars for the given dates and records coverage.
   *
   * Writing is per-date and destructive-then-insert so a re-download is
   * idempotent: the same day fetched twice yields one copy, not two.
   * `dates` must include every date that was requested, even those with no
   * bars, so their coverage is recorded as a confirmed zero.
   */
  async putBars(
    kind: BarKind,
    ticker: string,
    dates: readonly MarketDate[],
    bars: readonly (OptionBar | UnderlyingBar)[],
    shape: BarShape,
    provider: string
  ): Promise<void> {
    const table = this.table(kind)
    const fetchedAt = Date.now()

    // Bucket by the Eastern market date the bar actually belongs to, which is
    // not always the date implied by the request window.
    const byDate = new Map<MarketDate, (OptionBar | UnderlyingBar)[]>()
    for (const bar of bars) {
      const date = marketDateOf(bar.timestamp)
      const bucket = byDate.get(date)
      if (bucket) bucket.push(bar)
      else byDate.set(date, [bar])
    }

    const allDates = new Set<MarketDate>([...dates, ...byDate.keys()])

    await this.db.transaction(async () => {
      for (const date of allDates) {
        const dayBars = byDate.get(date) ?? []

        // The bar shape must be part of the delete, or replacing minute data
        // would wipe the daily bars for the same ticker and date.
        await this.db.run(
          `DELETE FROM ${table} WHERE ticker = ? AND market_date = ? AND timespan = ? AND multiplier = ?`,
          [ticker, date, shape.timespan, shape.multiplier]
        )

        if (dayBars.length > 0) {
          const baseRows = dayBars.map((b) => [
              ticker,
              shape.timespan,
              shape.multiplier,
              b.timestamp,
              date,
              b.open,
              b.high,
              b.low,
              b.close,
              b.volume ?? null,
              b.vwap ?? null,
              b.transactions ?? null
            ])
          await this.db.append(
            table,
            kind === 'option' ? OPTION_BAR_COLUMNS : BASE_BAR_COLUMNS,
            kind === 'option'
              ? baseRows.map((row, index) => {
                  const b = dayBars[index] as OptionBar
                  return [...row, b.bid ?? null, b.ask ?? null, b.bidSize ?? null, b.askSize ?? null]
                })
              : baseRows
          )
        }

        await this.db.run(
          `INSERT INTO bar_coverage (ticker, market_date, timespan, multiplier, kind, bar_count, provider, fetched_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (ticker, market_date, timespan, multiplier) DO UPDATE SET
             kind = excluded.kind,
             bar_count = excluded.bar_count,
             provider = excluded.provider,
             fetched_at = excluded.fetched_at`,
          [ticker, date, shape.timespan, shape.multiplier, kind, dayBars.length, provider, fetchedAt]
        )
      }
    })

    log.debug('bars cached', { ticker, dates: allDates.size, bars: bars.length })
  }

  /**
   * Atomically replaces one full root/expiration quote snapshot and marks every
   * listed contract covered, including contracts for which ThetaData returned
   * no quote. Bulk writes make full-chain archival practical.
   */
  async putOptionArchiveDay(
    contracts: readonly OptionContract[],
    date: MarketDate,
    bars: readonly OptionBar[],
    provider: string
  ): Promise<void> {
    const tickers = [...new Set(contracts.map((contract) => contract.ticker))]
    if (tickers.length === 0) return
    const allowed = new Set(tickers)
    const accepted = bars.filter((bar) => allowed.has(bar.ticker) && marketDateOf(bar.timestamp) === date)
    const counts = new Map<string, number>()
    for (const bar of accepted) counts.set(bar.ticker, (counts.get(bar.ticker) ?? 0) + 1)
    const fetchedAt = Date.now()

    await this.db.transaction(async () => {
      for (let offset = 0; offset < tickers.length; offset += 500) {
        const chunk = tickers.slice(offset, offset + 500)
        const placeholders = chunk.map(() => '?').join(', ')
        await this.db.run(
          `DELETE FROM option_bars
            WHERE market_date = ? AND timespan = 'minute' AND multiplier = 1
              AND ticker IN (${placeholders})`,
          [date, ...chunk]
        )
        await this.db.run(
          `DELETE FROM bar_coverage
            WHERE market_date = ? AND timespan = 'minute' AND multiplier = 1
              AND ticker IN (${placeholders})`,
          [date, ...chunk]
        )
      }

      if (accepted.length > 0) {
        await this.db.append('option_bars', OPTION_BAR_COLUMNS, accepted.map((bar) => [
          bar.ticker, 'minute', 1, bar.timestamp, date,
          bar.open, bar.high, bar.low, bar.close,
          bar.volume ?? null, bar.vwap ?? null, bar.transactions ?? null,
          bar.bid ?? null, bar.ask ?? null, bar.bidSize ?? null, bar.askSize ?? null
        ]))
      }

      await this.db.append('bar_coverage', BAR_COVERAGE_COLUMNS, tickers.map((ticker) => [
        ticker, date, 'minute', 1, 'option', counts.get(ticker) ?? 0, provider, fetchedAt
      ]))
    })
    log.info('option archive day cached', { date, contracts: tickers.length, bars: accepted.length })
  }

  async hasOptionArchiveCoverage(
    contracts: readonly OptionContract[],
    date: MarketDate,
    provider: string
  ): Promise<boolean> {
    const expected = new Set(contracts.map((contract) => contract.ticker))
    if (expected.size === 0) return true
    const rows = await this.db.query<{ ticker: string }>(
      `SELECT ticker FROM bar_coverage
        WHERE market_date = ? AND timespan = 'minute' AND multiplier = 1
          AND kind = 'option' AND provider = ?`,
      [date, provider]
    )
    const covered = new Set(rows.map((row) => row.ticker))
    return [...expected].every((ticker) => covered.has(ticker))
  }

  async getOptionBars(
    ticker: string,
    dates: readonly MarketDate[],
    shape: BarShape = MINUTE_BARS
  ): Promise<OptionBar[]> {
    if (dates.length === 0) return []
    const placeholders = dates.map(() => '?').join(', ')
    const rows = await this.db.query<Record<string, unknown>>(
      `SELECT * FROM option_bars
        WHERE ticker = ? AND timespan = ? AND multiplier = ? AND market_date IN (${placeholders})
        ORDER BY ts ASC`,
      [ticker, shape.timespan, shape.multiplier, ...dates]
    )
    return rows.map((r) => rowToOptionBar(r))
  }

  /**
   * Expirations of one root with cached minute bars on a session.
   *
   * Cache-only, like the two reads below it: a double calendar study needs a
   * whole chain at the entry minute and four contracts across every session of
   * their lives, which over a rate-limited API is days of requests. A gap here
   * is reported as a gap rather than fetched.
   */
  listArchivedExpirations(root: string, onDate: MarketDate): Promise<MarketDate[]> {
    return queryArchivedExpirations(this.query, root, onDate)
  }

  /** Every two-sided quote for one expiration at one minute. */
  chainSnapshot(
    root: string,
    expiration: MarketDate,
    onDate: MarketDate,
    minute: number,
    carryMinutes = 5
  ): Promise<ChainQuote[]> {
    return queryChainSnapshot(this.query, root, expiration, onDate, minute, carryMinutes * 60_000)
  }

  /** Minute bars for several contracts at once, keyed by ticker. */
  getOptionBarsForTickers(
    tickers: readonly string[],
    from: MarketDate,
    to: MarketDate
  ): Promise<Record<string, OptionBar[]>> {
    return queryOptionBarsForTickers(this.query, tickers, from, to)
  }

  /** Passes the database through to the shared calendar query builders. */
  private readonly query = <T>(sql: string, params: unknown[]): Promise<T[]> =>
    this.db.query<T>(sql, params) as Promise<T[]>

  async getUnderlyingBars(
    ticker: string,
    dates: readonly MarketDate[],
    shape: BarShape = MINUTE_BARS
  ): Promise<UnderlyingBar[]> {
    if (dates.length === 0) return []
    const placeholders = dates.map(() => '?').join(', ')
    const rows = await this.db.query<Record<string, unknown>>(
      `SELECT * FROM underlying_bars
        WHERE ticker = ? AND timespan = ? AND multiplier = ? AND market_date IN (${placeholders})
        ORDER BY ts ASC`,
      [ticker, shape.timespan, shape.multiplier, ...dates]
    )
    return rows.map((r) => rowToUnderlyingBar(r))
  }

  /** Coverage rows for the given dates, keyed by market date. */
  async getBarCoverage(
    ticker: string,
    dates: readonly MarketDate[],
    shape: BarShape
  ): Promise<Map<MarketDate, BarCoverage>> {
    const result = new Map<MarketDate, BarCoverage>()
    if (dates.length === 0) return result

    const placeholders = dates.map(() => '?').join(', ')
    const rows = await this.db.query<{
      ticker: string
      market_date: string
      bar_count: number
      fetched_at: number
      provider: string
    }>(
      `SELECT ticker, market_date, bar_count, fetched_at, provider
         FROM bar_coverage
        WHERE ticker = ? AND timespan = ? AND multiplier = ? AND market_date IN (${placeholders})`,
      [ticker, shape.timespan, shape.multiplier, ...dates]
    )

    for (const row of rows) {
      result.set(row.market_date, {
        ticker: row.ticker,
        marketDate: row.market_date,
        barCount: row.bar_count,
        fetchedAt: row.fetched_at,
        provider: row.provider
      })
    }
    return result
  }

  /** Per-session coverage for an underlying, used by the SPX data screen. */
  async getUnderlyingCoverage(
    ticker: string,
    from: MarketDate,
    to: MarketDate,
    shape?: BarShape
  ): Promise<{ marketDate: string; barCount: number; source: string; fetchedAt: number }[]> {
    return this.db.query(
      `SELECT market_date AS "marketDate", bar_count AS "barCount",
              provider AS source, fetched_at AS "fetchedAt"
         FROM bar_coverage
        WHERE ticker = ? AND kind = 'underlying' AND market_date BETWEEN ? AND ?
          ${shape ? 'AND timespan = ? AND multiplier = ?' : ''}
        ORDER BY market_date ASC`,
      shape ? [ticker, from, to, shape.timespan, shape.multiplier] : [ticker, from, to]
    )
  }

  // --- stats and maintenance ------------------------------------------------

  async stats(databaseBytes: number): Promise<CacheStats> {
    const [contracts, optionBars, underlyingBars, coverage, range, tickers] = await Promise.all([
      this.db.queryOne<{ n: number }>('SELECT count(*) AS n FROM option_contracts'),
      this.db.queryOne<{ n: number }>('SELECT count(*) AS n FROM option_bars'),
      this.db.queryOne<{ n: number }>('SELECT count(*) AS n FROM underlying_bars'),
      this.db.queryOne<{ covered: number; empty: number }>(
        `SELECT count(*) AS covered, count(*) FILTER (WHERE bar_count = 0) AS empty
           FROM bar_coverage WHERE kind = 'option'`
      ),
      this.db.queryOne<{ lo: string | null; hi: string | null }>(
        'SELECT min(market_date) AS lo, max(market_date) AS hi FROM bar_coverage'
      ),
      this.db.queryOne<{ n: number }>('SELECT count(DISTINCT ticker) AS n FROM option_bars')
    ])

    return {
      optionContracts: contracts?.n ?? 0,
      optionBars: optionBars?.n ?? 0,
      underlyingBars: underlyingBars?.n ?? 0,
      coveredOptionDays: coverage?.covered ?? 0,
      emptyOptionDays: coverage?.empty ?? 0,
      distinctOptionTickers: tickers?.n ?? 0,
      earliestDate: range?.lo ?? null,
      latestDate: range?.hi ?? null,
      databaseBytes,
      databasePath: this.db.path
    }
  }

  /** Wipes cached market data. Schema and migrations are preserved. */
  async clear(): Promise<void> {
    await this.db.transaction(async () => {
      for (const table of ['option_bars', 'underlying_bars', 'bar_coverage', 'option_contracts', 'contract_coverage']) {
        await this.db.run(`DELETE FROM ${table}`)
      }
    })
    log.warn('cache cleared')
  }
}

function rowToContract(row: Record<string, unknown>): OptionContract {
  return {
    ticker: row.ticker as string,
    underlying: row.underlying as string,
    expirationDate: row.expiration_date as string,
    strike: row.strike as number,
    type: row.contract_type as OptionType,
    ...(row.exercise_style ? { exerciseStyle: row.exercise_style as OptionContract['exerciseStyle'] } : {}),
    ...(row.shares_per_contract != null ? { sharesPerContract: row.shares_per_contract as number } : {}),
    ...(row.primary_exchange ? { primaryExchange: row.primary_exchange as string } : {}),
    ...(row.root ? { root: row.root as string } : {}),
    ...(row.settlement ? { settlement: row.settlement as OptionContract['settlement'] } : {})
  }
}

function rowToOptionBar(row: Record<string, unknown>): OptionBar {
  return {
    ticker: row.ticker as string,
    timestamp: row.ts as number,
    open: row.open as number,
    high: row.high as number,
    low: row.low as number,
    close: row.close as number,
    volume: (row.volume as number | null) ?? 0,
    ...(row.vwap != null ? { vwap: row.vwap as number } : {}),
    ...(row.transactions != null ? { transactions: row.transactions as number } : {}),
    ...(row.bid != null ? { bid: row.bid as number } : {}),
    ...(row.ask != null ? { ask: row.ask as number } : {}),
    ...(row.bid_size != null ? { bidSize: row.bid_size as number } : {}),
    ...(row.ask_size != null ? { askSize: row.ask_size as number } : {})
  }
}

function rowToUnderlyingBar(row: Record<string, unknown>): UnderlyingBar {
  return {
    ticker: row.ticker as string,
    timestamp: row.ts as number,
    open: row.open as number,
    high: row.high as number,
    low: row.low as number,
    close: row.close as number,
    // Index feeds report no volume; null must stay undefined, not become 0.
    ...(row.volume != null ? { volume: row.volume as number } : {}),
    ...(row.vwap != null ? { vwap: row.vwap as number } : {}),
    ...(row.transactions != null ? { transactions: row.transactions as number } : {})
  }
}
