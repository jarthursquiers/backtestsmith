import type { StudyConfig } from '../shared/study.js'
import type { ForwardTestRunSummary, ForwardTestState } from '../shared/forwardTest.js'
import type { Database } from './duckdb.js'
import { createLogger } from '../services/logger.js'

const log = createLogger('database.forward-tests')

export interface ForwardTestRecord {
  forwardTestId: string
  name: string
  createdAt: number
  startDate: string
  targetSessions: number
  state: ForwardTestState
  config: StudyConfig
  configHash: string
  appVersion: string
  gitCommit?: string
}

export class ForwardTestStore {
  constructor(private readonly db: Database) {}

  async create(record: ForwardTestRecord): Promise<void> {
    await this.db.run(
      `INSERT INTO forward_tests
         (forward_test_id, name, created_at, start_date, target_sessions, state, config_json, config_hash,
          app_version, git_commit)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        record.forwardTestId,
        record.name,
        record.createdAt,
        record.startDate,
        record.targetSessions,
        record.state,
        JSON.stringify(record.config),
        record.configHash,
        record.appVersion,
        record.gitCommit ?? null
      ]
    )
    log.info('forward test locked', {
      forwardTestId: record.forwardTestId,
      startDate: record.startDate,
      targetSessions: record.targetSessions
    })
  }

  async list(): Promise<ForwardTestRecord[]> {
    const rows = await this.db.query<{
      forward_test_id: string
      name: string
      created_at: number
      start_date: string
      target_sessions: number
      state: ForwardTestState
      config_json: string
      config_hash: string
      app_version: string
      git_commit: string | null
    }>('SELECT * FROM forward_tests ORDER BY created_at DESC')
    return rows.map((row) => ({
      forwardTestId: row.forward_test_id,
      name: row.name,
      createdAt: row.created_at,
      startDate: row.start_date,
      targetSessions: row.target_sessions,
      state: row.state,
      config: JSON.parse(row.config_json) as StudyConfig,
      configHash: row.config_hash,
      appVersion: row.app_version,
      ...(row.git_commit ? { gitCommit: row.git_commit } : {})
    }))
  }

  async load(forwardTestId: string): Promise<ForwardTestRecord | null> {
    const row = await this.db.queryOne<{
      forward_test_id: string
      name: string
      created_at: number
      start_date: string
      target_sessions: number
      state: ForwardTestState
      config_json: string
      config_hash: string
      app_version: string
      git_commit: string | null
    }>('SELECT * FROM forward_tests WHERE forward_test_id = ?', [forwardTestId])
    if (!row) return null
    return {
      forwardTestId: row.forward_test_id,
      name: row.name,
      createdAt: row.created_at,
      startDate: row.start_date,
      targetSessions: row.target_sessions,
      state: row.state,
      config: JSON.parse(row.config_json) as StudyConfig,
      configHash: row.config_hash,
      appVersion: row.app_version,
      ...(row.git_commit ? { gitCommit: row.git_commit } : {})
    }
  }

  async runs(forwardTestId: string): Promise<ForwardTestRunSummary[]> {
    const rows = await this.db.query<{
      run_id: string
      from_date: string
      to_date: string
      session_count: number
      created_at: number
      accepted_entries: number
      skipped_sessions: number
    }>(
      `SELECT fr.run_id, fr.from_date, fr.to_date,
              fr.session_count, fr.created_at,
              sr.entry_count AS accepted_entries,
              sr.entries_attempted - sr.entry_count AS skipped_sessions
         FROM forward_test_runs fr
         JOIN study_runs sr ON sr.run_id = fr.run_id
        WHERE fr.forward_test_id = ?
        ORDER BY fr.from_date ASC`,
      [forwardTestId]
    )
    return rows.map((row) => ({
      runId: row.run_id,
      from: row.from_date,
      to: row.to_date,
      sessions: row.session_count,
      createdAt: row.created_at,
      acceptedEntries: row.accepted_entries,
      skippedSessions: row.skipped_sessions
    }))
  }

  async attachRun(
    forwardTestId: string,
    runId: string,
    from: string,
    to: string,
    sessions: number,
    completed: boolean
  ): Promise<void> {
    await this.db.transaction(async () => {
      await this.db.run(
        `INSERT INTO forward_test_runs
           (forward_test_id, run_id, from_date, to_date, session_count, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [forwardTestId, runId, from, to, sessions, Date.now()]
      )
      if (completed) {
        await this.db.run("UPDATE forward_tests SET state = 'complete' WHERE forward_test_id = ?", [forwardTestId])
      }
    })
    log.info('forward run attached', { forwardTestId, runId, from, to, sessions, completed })
  }
}
