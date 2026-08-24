import { AsyncLocalStorage } from 'node:async_hooks'
import { createReadStream, existsSync, mkdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { createHash } from 'node:crypto'
import { DuckDBConnection, DuckDBInstance } from '@duckdb/node-api'
import { createLogger } from '../services/logger.js'
import type { DatabaseBackupResult } from '../shared/cache.js'

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
const SCHEMA_VERSION = 6

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
  },
  {
    /*
     * Study results.
     *
     * Each run stores its configuration verbatim, so a result can always be
     * traced to the exact assumptions that produced it - including pricing
     * model, missing-data policy, and the application version and commit. That
     * snapshot is the difference between a reproducible study and a number
     * someone once saw.
     *
     * Trades keep the fields worth querying as columns and the whole result as
     * JSON alongside, so summaries stay fast without discarding any detail.
     */
    version: 3,
    statements: [
      `CREATE TABLE IF NOT EXISTS study_runs (
        run_id VARCHAR PRIMARY KEY,
        created_at BIGINT NOT NULL,
        label VARCHAR,
        config_json VARCHAR NOT NULL,
        entry_count INTEGER NOT NULL,
        entries_attempted INTEGER NOT NULL,
        skipped_json VARCHAR NOT NULL,
        app_version VARCHAR NOT NULL,
        git_commit VARCHAR
      )`,

      `CREATE TABLE IF NOT EXISTS study_trades (
        run_id VARCHAR NOT NULL,
        strategy_id VARCHAR NOT NULL,
        entry_timestamp BIGINT NOT NULL,
        exit_timestamp BIGINT NOT NULL,
        expiration VARCHAR NOT NULL,
        center_strike DOUBLE NOT NULL,
        wing_width DOUBLE NOT NULL,
        direction VARCHAR NOT NULL,
        entry_debit DOUBLE NOT NULL,
        exit_value DOUBLE NOT NULL,
        exit_reason VARCHAR NOT NULL,
        ambiguous BOOLEAN NOT NULL,
        pnl_dollars DOUBLE NOT NULL,
        pnl_pct DOUBLE NOT NULL,
        holding_minutes INTEGER NOT NULL,
        exit_dte INTEGER NOT NULL,
        mfe_pct DOUBLE,
        mae_pct DOUBLE,
        mfe_capture DOUBLE,
        profit_giveback DOUBLE NOT NULL,
        coverage DOUBLE NOT NULL,
        payload_json VARCHAR NOT NULL
      )`,

      `CREATE INDEX IF NOT EXISTS idx_study_trades_run ON study_trades (run_id, strategy_id)`
    ]
  },
  {
    version: 4,
    statements: [
      `ALTER TABLE option_bars ADD COLUMN IF NOT EXISTS bid DOUBLE`,
      `ALTER TABLE option_bars ADD COLUMN IF NOT EXISTS ask DOUBLE`,
      `ALTER TABLE option_bars ADD COLUMN IF NOT EXISTS bid_size DOUBLE`,
      `ALTER TABLE option_bars ADD COLUMN IF NOT EXISTS ask_size DOUBLE`
    ]
  },
  {
    /*
     * Prospective tests are immutable configuration locks linked to ordinary
     * study runs. Keeping each batch as a study run preserves all trade-level
     * audit data while this small ledger enforces chronology and continuity.
     */
    version: 5,
    statements: [
      `CREATE TABLE IF NOT EXISTS forward_tests (
        forward_test_id VARCHAR PRIMARY KEY,
        name VARCHAR NOT NULL,
        created_at BIGINT NOT NULL,
        start_date VARCHAR NOT NULL,
        target_sessions INTEGER NOT NULL,
        state VARCHAR NOT NULL,
        config_json VARCHAR NOT NULL,
        config_hash VARCHAR NOT NULL,
        app_version VARCHAR NOT NULL,
        git_commit VARCHAR
      )`,
      `CREATE TABLE IF NOT EXISTS forward_test_runs (
        forward_test_id VARCHAR NOT NULL,
        run_id VARCHAR UNIQUE NOT NULL,
        from_date VARCHAR NOT NULL,
        to_date VARCHAR NOT NULL,
        session_count INTEGER NOT NULL,
        created_at BIGINT NOT NULL,
        PRIMARY KEY (forward_test_id, run_id)
      )`,
      `CREATE INDEX IF NOT EXISTS idx_forward_runs_test ON forward_test_runs (forward_test_id, from_date)`
    ]
  },
  {
    /*
     * A second structure: the double calendar.
     *
     * `study_trades` was built around a butterfly, and three of its columns are
     * meaningless for a four-leg position across two expirations - a calendar
     * has no centre strike, no wing width, and no directional intent. They are
     * relaxed to nullable rather than filled with a plausible-looking substitute
     * (the midpoint between the shorts, say), because a column that quietly
     * means something different per row is worse than one that is honestly
     * empty.
     *
     * `structure` is nullable for the same reason the domain field is optional:
     * every row written before this migration is a butterfly, and backfilling
     * is cheaper and clearer than teaching every reader that NULL means one
     * particular thing. `expiration` stays NOT NULL and holds the calendar's
     * front expiration, which is the date the position is defined by.
     */
    version: 6,
    statements: [
      // DuckDB refuses to alter a column an index depends on, so the run index
      // is dropped and rebuilt around the change rather than the table being
      // copied wholesale - which on a study archive of millions of trades is
      // the difference between a migration and an outage.
      `DROP INDEX IF EXISTS idx_study_trades_run`,
      `ALTER TABLE study_trades ADD COLUMN IF NOT EXISTS structure VARCHAR`,
      `ALTER TABLE study_trades ALTER COLUMN center_strike DROP NOT NULL`,
      `ALTER TABLE study_trades ALTER COLUMN wing_width DROP NOT NULL`,
      `ALTER TABLE study_trades ALTER COLUMN direction DROP NOT NULL`,
      `UPDATE study_trades SET structure = 'butterfly' WHERE structure IS NULL`,
      `CREATE INDEX IF NOT EXISTS idx_study_trades_run ON study_trades (run_id, strategy_id)`
    ]
  }
]

/** Column types supported by the bulk appender. */
export type AppendType = 'varchar' | 'double' | 'bigint' | 'integer'

export class Database {
  private instance: DuckDBInstance | null = null
  private connection: DuckDBConnection | null = null
  /** Tail of the serialized operation queue. */
  private queue: Promise<unknown> = Promise.resolve()
  /** Identifies the transaction currently holding the queue, if any. */
  private activeTransaction: symbol | null = null
  /** Carries the transaction token into everything its body awaits. */
  private readonly transactionScope = new AsyncLocalStorage<symbol>()

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

  /**
   * Serializes database work onto a single queue.
   *
   * There is one DuckDB connection, so a statement issued while another
   * operation's transaction is open would join that transaction, and two
   * overlapping BEGINs fail outright with "cannot start a transaction within a
   * transaction". Callers legitimately fetch in parallel - three butterfly legs,
   * or a call and a put - so the parallelism has to be allowed at the network
   * layer and removed here.
   *
   * The lock is re-entrant: statements issued from inside a transaction body are
   * already within the critical section, since the transaction holds the queue
   * for its whole duration and nothing else can interleave.
   */
  private serialize<T>(work: () => Promise<T>): Promise<T> {
    /*
     * Re-entrancy must be scoped to the running transaction's own body, not to
     * "a transaction is open somewhere". A boolean flag cannot tell those apart:
     * an unrelated operation arriving mid-transaction would take the shortcut
     * and issue a second BEGIN, which is the very error this exists to prevent.
     * AsyncLocalStorage propagates the token across awaits inside the body, so
     * only genuinely nested statements bypass the queue.
     */
    if (this.activeTransaction !== null && this.transactionScope.getStore() === this.activeTransaction) {
      return work()
    }
    // Chain on both settle paths so one failure cannot stall the queue.
    const result = this.queue.then(work, work)
    this.queue = result.then(
      () => undefined,
      () => undefined
    )
    return result
  }

  /** Runs a statement with optional positional (`?`) parameters. */
  run(sql: string, params: unknown[] = []): Promise<void> {
    return this.serialize(async () => {
      await this.conn().run(sql, params as never)
    })
  }

  /**
   * Runs a query and returns plain JS objects.
   *
   * DuckDB returns BIGINT columns as JS `bigint`; those are converted to
   * `number` here because every bigint in this schema is an epoch millisecond
   * or a count, both far inside Number.MAX_SAFE_INTEGER.
   */
  query<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
    return this.serialize(async () => {
      const reader = await this.conn().runAndReadAll(sql, params as never)
      return reader.getRowObjects().map((row) => {
        const out: Record<string, unknown> = {}
        for (const [key, value] of Object.entries(row)) {
          out[key] = typeof value === 'bigint' ? Number(value) : value
        }
        return out as T
      })
    })
  }

  async queryOne<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T | null> {
    const rows = await this.query<T>(sql, params)
    return rows[0] ?? null
  }

  /**
   * Runs work inside a transaction, rolling back on any failure.
   *
   * Holds the operation queue for its whole duration, so concurrent callers wait
   * rather than colliding on the single connection.
   */
  transaction<T>(work: () => Promise<T>): Promise<T> {
    return this.serialize(async () => {
      const token = Symbol('transaction')
      const conn = this.conn()

      // BEGIN and COMMIT bypass serialize deliberately: this call already owns
      // the queue, and routing them back through it would deadlock.
      await conn.run('BEGIN TRANSACTION')
      this.activeTransaction = token
      try {
        const result = await this.transactionScope.run(token, work)
        await conn.run('COMMIT')
        return result
      } catch (error) {
        await conn.run('ROLLBACK')
        throw error
      } finally {
        this.activeTransaction = null
      }
    })
  }

  /**
   * Bulk row insertion via the native appender, far faster than INSERT.
   *
   * Column types must be declared rather than inferred from the JS values: the
   * appender is strict per column, so a DOUBLE column handed an integer-valued
   * price like 2.0 would be appended as BIGINT and rejected.
   */
  append(table: string, columnTypes: readonly AppendType[], rows: readonly unknown[][]): Promise<void> {
    if (rows.length === 0) return Promise.resolve()
    return this.serialize(() => this.appendRaw(table, columnTypes, rows))
  }

  private async appendRaw(
    table: string,
    columnTypes: readonly AppendType[],
    rows: readonly unknown[][]
  ): Promise<void> {
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
   * Creates a standalone, internally consistent copy while this database stays
   * open. DuckDB performs the copy through its own connection, so Windows file
   * locks and an outstanding WAL cannot produce a half-backup.
   */
  async backupTo(destination: string): Promise<DatabaseBackupResult> {
    if (this.filePath === ':memory:') throw new Error('An in-memory database cannot be backed up this way.')
    if (!destination.trim()) throw new Error('Choose a backup destination.')

    const partial = `${destination}.partial`
    if (existsSync(partial)) rmSync(partial, { force: true })
    if (existsSync(`${partial}.wal`)) rmSync(`${partial}.wal`, { force: true })
    mkdirSync(dirname(destination), { recursive: true })

    try {
      await this.serialize(async () => {
        const conn = this.conn()
        await conn.run('CHECKPOINT')
        const reader = await conn.runAndReadAll('SELECT current_database() AS name')
        const sourceName = String(reader.getRowObjects()[0]?.name ?? '')
        if (!sourceName) throw new Error('Could not identify the live DuckDB catalog.')
        const quotedSource = `"${sourceName.replaceAll('"', '""')}"`
        const quotedDestination = `'${partial.replaceAll("'", "''")}'`

        await conn.run(`ATTACH ${quotedDestination} AS bts_backup`)
        try {
          await conn.run(`COPY FROM DATABASE ${quotedSource} TO bts_backup`)
        } finally {
          await conn.run('DETACH bts_backup')
        }
      })

      const verification = await inspectDatabaseFile(partial)
      const sha256 = await sha256File(partial)
      if (existsSync(destination)) rmSync(destination, { force: true })
      renameSync(partial, destination)

      const result: DatabaseBackupResult = {
        path: destination,
        manifestPath: `${destination}.manifest.json`,
        createdAt: Date.now(),
        bytes: statSync(destination).size,
        sha256,
        ...verification
      }
      writeFileSync(
        result.manifestPath,
        JSON.stringify({
          ...result,
          format: 'Backtestsmith verified DuckDB backup',
          note: 'The SHA-256 applies to the adjacent .duckdb file. API keys and broker credentials are not included.'
        }, null, 2),
        'utf8'
      )
      log.info('database backup verified', { ...result })
      return result
    } catch (error) {
      if (existsSync(partial)) rmSync(partial, { force: true })
      if (existsSync(`${partial}.wal`)) rmSync(`${partial}.wal`, { force: true })
      throw error
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

async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256')
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(path)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('end', resolve)
    stream.on('error', reject)
  })
  return hash.digest('hex')
}

async function inspectDatabaseFile(path: string): Promise<Omit<DatabaseBackupResult, 'path' | 'manifestPath' | 'createdAt' | 'bytes' | 'sha256'>> {
  const instance = await DuckDBInstance.create(path)
  const connection = await instance.connect()
  try {
    const reader = await connection.runAndReadAll(`
      -- Every contract any stored trade rests on, across both structures: a
      -- butterfly's three legs and a double calendar's four. A backup that
      -- reported only the butterfly legs would call a calendar-only archive
      -- complete while none of its contracts were present.
      WITH referenced AS (
        SELECT DISTINCT json_extract_string(payload_json, '$.definition.lowerTicker') AS ticker FROM study_trades
        UNION
        SELECT DISTINCT json_extract_string(payload_json, '$.definition.centerTicker') AS ticker FROM study_trades
        UNION
        SELECT DISTINCT json_extract_string(payload_json, '$.definition.upperTicker') AS ticker FROM study_trades
        UNION
        SELECT DISTINCT json_extract_string(payload_json, '$.definition.tickers.putShort') AS ticker FROM study_trades
        UNION
        SELECT DISTINCT json_extract_string(payload_json, '$.definition.tickers.putLong') AS ticker FROM study_trades
        UNION
        SELECT DISTINCT json_extract_string(payload_json, '$.definition.tickers.callShort') AS ticker FROM study_trades
        UNION
        SELECT DISTINCT json_extract_string(payload_json, '$.definition.tickers.callLong') AS ticker FROM study_trades
      )
      SELECT
        (SELECT count(*) FROM option_contracts) AS option_contracts,
        (SELECT count(*) FROM option_bars) AS option_bars,
        (SELECT count(*) FROM underlying_bars) AS underlying_bars,
        (SELECT count(*) FROM bar_coverage WHERE kind = 'option') AS covered_option_days,
        (SELECT min(market_date) FROM option_bars) AS option_earliest_date,
        (SELECT max(market_date) FROM option_bars) AS option_latest_date,
        (SELECT min(market_date) FROM underlying_bars) AS underlying_earliest_date,
        (SELECT max(market_date) FROM underlying_bars) AS underlying_latest_date,
        (SELECT count(*) FROM study_runs) AS study_runs,
        (SELECT count(*) FROM forward_tests) AS forward_tests,
        (SELECT min(json_extract_string(config_json, '$.from')) FROM study_runs) AS study_earliest_date,
        (SELECT max(json_extract_string(config_json, '$.to')) FROM study_runs) AS study_latest_date,
        (SELECT count(*) FROM referenced WHERE ticker IS NOT NULL) AS referenced_option_tickers,
        (SELECT count(*) FROM referenced r
          WHERE r.ticker IS NOT NULL
            AND NOT EXISTS (SELECT 1 FROM option_contracts c WHERE c.ticker = r.ticker)) AS missing_contracts,
        (SELECT count(*) FROM referenced r
          WHERE r.ticker IS NOT NULL
            AND NOT EXISTS (SELECT 1 FROM option_bars b WHERE b.ticker = r.ticker)) AS missing_bars
    `)
    const row = reader.getRowObjects()[0]!
    const number = (value: unknown): number => Number(value ?? 0)
    const nullable = (value: unknown): string | null => value === null || value === undefined ? null : String(value)
    return {
      optionContracts: number(row.option_contracts),
      optionBars: number(row.option_bars),
      underlyingBars: number(row.underlying_bars),
      coveredOptionDays: number(row.covered_option_days),
      optionEarliestDate: nullable(row.option_earliest_date),
      optionLatestDate: nullable(row.option_latest_date),
      underlyingEarliestDate: nullable(row.underlying_earliest_date),
      underlyingLatestDate: nullable(row.underlying_latest_date),
      studyRuns: number(row.study_runs),
      forwardTests: number(row.forward_tests),
      studyEarliestDate: nullable(row.study_earliest_date),
      studyLatestDate: nullable(row.study_latest_date),
      referencedOptionTickers: number(row.referenced_option_tickers),
      referencedTickersMissingContracts: number(row.missing_contracts),
      referencedTickersMissingBars: number(row.missing_bars)
    }
  } finally {
    connection.closeSync()
    instance.closeSync()
  }
}
