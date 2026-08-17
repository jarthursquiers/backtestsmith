import type { TradeResult } from '../shared/trade.js'
import type { StudyConfig, StudyRunResult, StudyRunSummary, SkippedEntry } from '../shared/study.js'
import type { AppendType, Database } from './duckdb.js'
import { createLogger } from '../services/logger.js'

const log = createLogger('database.studies')

/**
 * Persistence for completed studies.
 *
 * Every run keeps an immutable copy of the configuration that produced it. A
 * result that cannot be traced back to its pricing model, missing-data policy,
 * date range, and application version is not reproducible, and this project
 * expects its numbers to be discussed publicly.
 */

const TRADE_COLUMNS: readonly AppendType[] = [
  'varchar', // run_id
  'varchar', // strategy_id
  'bigint',  // entry_timestamp
  'bigint',  // exit_timestamp
  'varchar', // expiration
  'double',  // center_strike
  'double',  // wing_width
  'varchar', // direction
  'double',  // entry_debit
  'double',  // exit_value
  'varchar', // exit_reason
  'integer', // ambiguous (stored 0/1; DuckDB accepts an integer for BOOLEAN)
  'double',  // pnl_dollars
  'double',  // pnl_pct
  'integer', // holding_minutes
  'integer', // exit_dte
  'double',  // mfe_pct
  'double',  // mae_pct
  'double',  // mfe_capture
  'double',  // profit_giveback
  'double',  // coverage
  'varchar'  // payload_json
]

export class StudyStore {
  constructor(private readonly db: Database) {}

  async save(run: StudyRunResult, label?: string): Promise<void> {
    await this.db.transaction(async () => {
      await this.db.run(
        `INSERT INTO study_runs
           (run_id, created_at, label, config_json, entry_count, entries_attempted, skipped_json, app_version, git_commit)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (run_id) DO UPDATE SET
           label = excluded.label,
           config_json = excluded.config_json,
           entry_count = excluded.entry_count,
           entries_attempted = excluded.entries_attempted,
           skipped_json = excluded.skipped_json`,
        [
          run.runId,
          run.createdAt,
          label ?? null,
          JSON.stringify(run.config),
          run.entryCount,
          run.entriesAttempted,
          JSON.stringify(run.skipped),
          run.appVersion,
          run.gitCommit ?? null
        ]
      )

      await this.db.run('DELETE FROM study_trades WHERE run_id = ?', [run.runId])

      await this.db.append(
        'study_trades',
        TRADE_COLUMNS,
        run.trades.map((t) => [
          run.runId,
          t.strategyId,
          t.entryTimestamp,
          t.exitTimestamp,
          t.definition.expiration,
          t.definition.centerStrike,
          t.definition.wingWidth,
          t.definition.direction,
          t.entryDebit,
          t.exitValue,
          t.exitReason,
          t.ambiguous ? 1 : 0,
          t.pnlDollars,
          t.pnlPct,
          Math.round(t.holdingMinutes),
          Math.round(t.exitDte),
          t.excursions.mfe?.pct ?? null,
          t.excursions.mae?.pct ?? null,
          t.mfeCaptureRatio,
          t.profitGiveback,
          t.quality.coverage,
          JSON.stringify(t)
        ])
      )
    })

    log.info('study saved', { runId: run.runId, trades: run.trades.length })
  }

  /** Recent runs, newest first, without loading their trades. */
  async list(limit = 50): Promise<StudyRunSummary[]> {
    const rows = await this.db.query<{
      run_id: string
      created_at: number
      label: string | null
      config_json: string
      entry_count: number
      entries_attempted: number
      trade_count: number
    }>(
      `SELECT r.run_id, r.created_at, r.label, r.config_json, r.entry_count, r.entries_attempted,
              (SELECT count(*) FROM study_trades t WHERE t.run_id = r.run_id) AS trade_count
         FROM study_runs r
        ORDER BY r.created_at DESC
        LIMIT ?`,
      [limit]
    )

    return rows.map((row) => ({
      runId: row.run_id,
      createdAt: row.created_at,
      label: row.label,
      config: JSON.parse(row.config_json) as StudyConfig,
      entryCount: row.entry_count,
      entriesAttempted: row.entries_attempted,
      tradeCount: row.trade_count
    }))
  }

  /** Loads a run in full, including every trade. */
  async load(runId: string): Promise<StudyRunResult | null> {
    const run = await this.db.queryOne<{
      run_id: string
      created_at: number
      config_json: string
      entry_count: number
      entries_attempted: number
      skipped_json: string
      app_version: string
      git_commit: string | null
    }>('SELECT * FROM study_runs WHERE run_id = ?', [runId])

    if (!run) return null

    const rows = await this.db.query<{ payload_json: string }>(
      'SELECT payload_json FROM study_trades WHERE run_id = ? ORDER BY entry_timestamp ASC',
      [runId]
    )

    return {
      runId: run.run_id,
      createdAt: run.created_at,
      config: JSON.parse(run.config_json) as StudyConfig,
      entryCount: run.entry_count,
      entriesAttempted: run.entries_attempted,
      skipped: JSON.parse(run.skipped_json) as SkippedEntry[],
      // Summaries are recomputed from the trades rather than stored, so a
      // change to the metrics definitions applies to historic runs too.
      summaries: [],
      trades: rows.map((r) => JSON.parse(r.payload_json) as TradeResult),
      sizing: 'oneContract',
      appVersion: run.app_version,
      ...(run.git_commit ? { gitCommit: run.git_commit } : {})
    }
  }

  async remove(runId: string): Promise<void> {
    await this.db.transaction(async () => {
      await this.db.run('DELETE FROM study_trades WHERE run_id = ?', [runId])
      await this.db.run('DELETE FROM study_runs WHERE run_id = ?', [runId])
    })
    log.warn('study deleted', { runId })
  }
}
