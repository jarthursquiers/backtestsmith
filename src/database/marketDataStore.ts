import type { OptionBar, UnderlyingBar } from '../domain/bars.js'
import type { OptionContract, OptionType } from '../domain/contracts.js'
import type { CacheStats } from '../shared/cache.js'
import { marketDateOf, type MarketDate } from '../core/time/marketTime.js'
import { createLogger } from '../services/logger.js'
import type { AppendType, Database } from './duckdb.js'

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

const OPTION_BAR_COLUMNS: readonly AppendType[] = [
  'varchar', // ticker
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
    type: OptionType | 'any'
  ): Promise<boolean> {
    const row = await this.db.queryOne<{ n: number }>(
      `SELECT count(*) AS n FROM contract_coverage
        WHERE underlying = ? AND expiration_date = ? AND contract_type IN (?, 'any')`,
      [underlying, expirationDate, type]
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

        await this.db.run(`DELETE FROM ${table} WHERE ticker = ? AND market_date = ?`, [ticker, date])

        if (dayBars.length > 0) {
          await this.db.append(
            table,
            OPTION_BAR_COLUMNS,
            dayBars.map((b) => [
              ticker,
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

  async getOptionBars(
    ticker: string,
    dates: readonly MarketDate[]
  ): Promise<OptionBar[]> {
    if (dates.length === 0) return []
    const placeholders = dates.map(() => '?').join(', ')
    const rows = await this.db.query<Record<string, unknown>>(
      `SELECT * FROM option_bars WHERE ticker = ? AND market_date IN (${placeholders}) ORDER BY ts ASC`,
      [ticker, ...dates]
    )
    return rows.map((r) => rowToOptionBar(r))
  }

  async getUnderlyingBars(
    ticker: string,
    dates: readonly MarketDate[]
  ): Promise<UnderlyingBar[]> {
    if (dates.length === 0) return []
    const placeholders = dates.map(() => '?').join(', ')
    const rows = await this.db.query<Record<string, unknown>>(
      `SELECT * FROM underlying_bars WHERE ticker = ? AND market_date IN (${placeholders}) ORDER BY ts ASC`,
      [ticker, ...dates]
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
    to: MarketDate
  ): Promise<{ marketDate: string; barCount: number; source: string; fetchedAt: number }[]> {
    return this.db.query(
      `SELECT market_date AS "marketDate", bar_count AS "barCount",
              provider AS source, fetched_at AS "fetchedAt"
         FROM bar_coverage
        WHERE ticker = ? AND kind = 'underlying' AND market_date BETWEEN ? AND ?
        ORDER BY market_date ASC`,
      [ticker, from, to]
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
    ...(row.transactions != null ? { transactions: row.transactions as number } : {})
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
