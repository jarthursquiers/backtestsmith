import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DuckDBConnection, DuckDBInstance } from '@duckdb/node-api'
import { createLogger } from '../services/logger.js'

const log = createLogger('database')

/**
 * DuckDB connection and schema management.
 *
 * Two storage conventions hold throughout this database, both chosen to make
 * timezone bugs impossible rather than merely unlikely:
 *
 *  - **Market dates are ISO 'YYYY-MM-DD' strings**, always Eastern. They are not
 *    DATE columns, because every DATE round-trip is an opportunity for an
 *    implicit UTC conversion to shift a session by a day. ISO strings also sort
 *    and range-compare correctly as text.
 *  - **Timestamps are BIGINT epoch milliseconds, UTC.** Conversion to Eastern
 *    happens exactly once, in `core/time`, never in SQL.
 */

/** Bumped whenever the schema changes; migrations run in order on open. */
const SCHEMA_VERSION = 2

const MIGRATIONS: { version: number; statements: string[] }[] = [
  {
    version: 1,
    statements: [
      `CREATE TABLE IF NOT EXISTS option_contracts (
        ticker VARCHAR PRIMARY KEY,
        underlying VARCHAR NOT NULL,
        expiration_date VARCHAR NOT NULL,
        strike DOUBLE NOT NULL,
        contract_type VARCHAR NOT NULL,
        exercise_style VARCHAR,
        shares_per_contract INTEGER,
        primary_exchange VARCHAR,
        root VARCHAR,
        settlement VARCHAR,
        provider VARCHAR NOT NULL,
        fetched_at BIGINT NOT NULL
      )`,

      `CREATE TABLE IF NOT EXISTS option_bars (
        ticker VARCHAR NOT NULL,
        ts BIGINT NOT NULL,
        market_date VARCHAR NOT NULL,
        open DOUBLE NOT NULL,
        high DOUBLE NOT NULL,
        low DOUBLE NOT NULL,
        close DOUBLE NOT NULL,
        volume DOUBLE,
        vwap DOUBLE,
        transactions INTEGER,
        PRIMARY KEY (ticker, ts)
      )`,

      `CREATE TABLE IF NOT EXISTS underlying_bars (
        ticker VARCHAR NOT NULL,
        ts BIGINT NOT NULL,
        market_date VARCHAR NOT NULL,
        open DOUBLE NOT NULL,
        high DOUBLE NOT NULL,
        low DOUBLE NOT NULL,
        close DOUBLE NOT NULL,
        volume DOUBLE,
        vwap DOUBLE,
        transactions INTEGER,
        PRIMARY KEY (ticker, ts)
      )`,

      /*
       * The coverage ledger is the heart of the cache.
       *
       * Without it there is no way to tell "we never requested this day" from
       * "we requested it and the contract genuinely had no qualifying trades".
       * Those look identical in a bars table - both are zero rows - so an
       * absent day would be re-requested forever, which at 5 calls/minute is
       * ruinous. A row here with bar_count = 0 is a positive assertion that the
       * provider was asked and returned nothing.
       */
      `CREATE TABLE IF NOT EXISTS bar_coverage (
        ticker VARCHAR NOT NULL,
        market_date VARCHAR NOT NULL,
        timespan VARCHAR NOT NULL,
        multiplier INTEGER NOT NULL,
        kind VARCHAR NOT NULL,
        bar_count INTEGER NOT NULL,
        provider VARCHAR NOT NULL,
        fetched_at BIGINT NOT NULL,
        PRIMARY KEY (ticker, market_date, timespan, multiplier)
      )`,

      /*
       * Same idea for contract discovery: records that a full option chain was
       * enumerated for an (underlying, expiration, type), so an expiration with
       * no contracts is not re-queried on every run.
       */
      `CREATE TABLE IF NOT EXISTS contract_coverage (
        underlying VARCHAR NOT NULL,
        expiration_date VARCHAR NOT NULL,
        contract_type VARCHAR NOT NULL,
        contract_count INTEGER NOT NULL,
        provider VARCHAR NOT NULL,
        fetched_at BIGINT NOT NULL,
        PRIMARY KEY (underlying, expiration_date, contract_type)
      )`,

      `CREATE INDEX IF NOT EXISTS idx_option_bars_date ON option_bars (market_date)`,
      `CREATE INDEX IF NOT EXISTS idx_option_bars_ticker_date ON option_bars (ticker, market_date)`,
      `CREATE INDEX IF NOT EXISTS idx_underlying_bars_ticker_date ON underlying_bars (ticker, market_date)`,
      `CREATE INDEX IF NOT EXISTS idx_contracts_lookup ON option_contracts (underlying, expiration_date, contract_type)`
    ]
  },
  {
    /*
     * v1 stored bars keyed by (ticker, ts) with no record of their bar size, and
     * replaced them by (ticker, market_date). Daily and minute bars for one
     * ticker therefore occupied the same rows: downloading daily history
     * silently deleted the minute bars for every overlapping date, while
     * bar_coverage went on reporting them as present.
     *
     * The tables are rebuilt with the bar shape in the key. Existing rows cannot
     * be migrated because their shape was never recorded, and guessing it would
     * be exactly the kind of invention this codebase avoids - so the bar tables
     * and the coverage ledger are cleared and re-downloaded. Contracts, which
     * have no bar shape, are unaffected.
     */
    version: 2,
    statements: [
      `DROP TABLE IF EXISTS option_bars`,
      `DROP TABLE IF EXISTS underlying_bars`,

      `CREATE TABLE option_bars (
        ticker VARCHAR NOT NULL,
        timespan VARCHAR NOT NULL,
        multiplier INTEGER NOT NULL,
        ts BIGINT NOT NULL,
        market_date VARCHAR NOT NULL,
        open DOUBLE NOT NULL,
        high DOUBLE NOT NULL,
        low DOUBLE NOT NULL,
        close DOUBLE NOT NULL,
        volume DOUBLE,
        vwap DOUBLE,
        transactions INTEGER,
        PRIMARY KEY (ticker, timespan, multiplier, ts)
      )`,

      `CREATE TABLE underlying_bars (
        ticker VARCHAR NOT NULL,
        timespan VARCHAR NOT NULL,
        multiplier INTEGER NOT NULL,
        ts BIGINT NOT NULL,
        market_date VARCHAR NOT NULL,
        open DOUBLE NOT NULL,
        high DOUBLE NOT NULL,
        low DOUBLE NOT NULL,
        close DOUBLE NOT NULL,
        volume DOUBLE,
        vwap DOUBLE,
        transactions INTEGER,
        PRIMARY KEY (ticker, timespan, multiplier, ts)
      )`,

      // Coverage described rows that no longer exist, so it must go too.
      `DELETE FROM bar_coverage`,

      `CREATE INDEX IF NOT EXISTS idx_option_bars_lookup ON option_bars (ticker, timespan, multiplier, market_date)`,
      `CREATE INDEX IF NOT EXISTS idx_underlying_bars_lookup ON underlying_bars (ticker, timespan, multiplier, market_date)`
    ]
  }
]

/** Column types supported by the bulk appender. */
export type AppendType = 'varchar' | 'double' | 'bigint' | 'integer'

export class Database {
  private instance: DuckDBInstance | null = null
  private connection: DuckDBConnection | null = null

  constructor(private readonly filePath: string) {}

  get path(): string {
    return this.filePath
  }

  async open(): Promise<void> {
    if (this.connection) return

    if (this.filePath !== ':memory:') {
      mkdirSync(dirname(this.filePath), { recursive: true })
    }

    this.instance = await DuckDBInstance.create(this.filePath)
    this.connection = await this.instance.connect()
    await this.migrate()

    log.info('database opened', { path: this.filePath, schemaVersion: SCHEMA_VERSION })
  }

  private conn(): DuckDBConnection {
    if (!this.connection) throw new Error('Database is not open')
    return this.connection
  }

  private async migrate(): Promise<void> {
    const conn = this.conn()
    await conn.run('CREATE TABLE IF NOT EXISTS schema_meta (version INTEGER NOT NULL, applied_at BIGINT NOT NULL)')

    const current = await this.queryOne<{ version: number | null }>(
      'SELECT max(version) AS version FROM schema_meta'
    )
    const from = current?.version ?? 0

    for (const migration of MIGRATIONS) {
      if (migration.version <= from) continue
      log.info('applying migration', { version: migration.version })
      for (const statement of migration.statements) {
        await conn.run(statement)
      }
      await conn.run('INSERT INTO schema_meta VALUES (?, ?)', [migration.version, Date.now()])
    }
  }

  /** Runs a statement with optional positional (`?`) parameters. */
  async run(sql: string, params: unknown[] = []): Promise<void> {
    await this.conn().run(sql, params as never)
  }

  /**
   * Runs a query and returns plain JS objects.
   *
   * DuckDB returns BIGINT columns as JS `bigint`; those are converted to
   * `number` here because every bigint in this schema is an epoch millisecond
   * or a count, both far inside Number.MAX_SAFE_INTEGER.
   */
  async query<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
    const reader = await this.conn().runAndReadAll(sql, params as never)
    return reader.getRowObjects().map((row) => {
      const out: Record<string, unknown> = {}
      for (const [key, value] of Object.entries(row)) {
        out[key] = typeof value === 'bigint' ? Number(value) : value
      }
      return out as T
    })
  }

  async queryOne<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T | null> {
    const rows = await this.query<T>(sql, params)
    return rows[0] ?? null
  }

  /** Runs work inside a transaction, rolling back on any failure. */
  async transaction<T>(work: () => Promise<T>): Promise<T> {
    const conn = this.conn()
    await conn.run('BEGIN TRANSACTION')
    try {
      const result = await work()
      await conn.run('COMMIT')
      return result
    } catch (error) {
      await conn.run('ROLLBACK')
      throw error
    }
  }

  /**
   * Bulk row insertion via the native appender, far faster than INSERT.
   *
   * Column types must be declared rather than inferred from the JS values: the
   * appender is strict per column, so a DOUBLE column handed an integer-valued
   * price like 2.0 would be appended as BIGINT and rejected.
   */
  async append(table: string, columnTypes: readonly AppendType[], rows: readonly unknown[][]): Promise<void> {
    if (rows.length === 0) return
    const appender = await this.conn().createAppender(table)
    try {
      for (const row of rows) {
        if (row.length !== columnTypes.length) {
          throw new Error(`append: expected ${columnTypes.length} values, received ${row.length}`)
        }
        for (let i = 0; i < row.length; i++) {
          const value = row[i]
          if (value === null || value === undefined) {
            appender.appendNull()
            continue
          }
          switch (columnTypes[i]) {
            case 'varchar':
              appender.appendVarchar(String(value))
              break
            case 'double':
              appender.appendDouble(Number(value))
              break
            case 'bigint':
              appender.appendBigInt(BigInt(value as number))
              break
            case 'integer':
              appender.appendInteger(Number(value))
              break
          }
        }
        appender.endRow()
      }
    } finally {
      appender.closeSync()
    }
  }

  /**
   * Closes the connection and the instance.
   *
   * Both are required: the instance owns the file handle, so dropping only the
   * connection leaves the database file locked. On Windows that lock is
   * mandatory, and a subsequent open of the same path fails outright.
   */
  async close(): Promise<void> {
    this.connection?.closeSync()
    this.connection = null
    this.instance?.closeSync()
    this.instance = null
    log.info('database closed')
  }
}
