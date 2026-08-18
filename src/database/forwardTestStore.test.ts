import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { StudyConfig, StudyRunResult } from '../shared/study.js'
import { Database } from './duckdb.js'
import { ForwardTestStore, type ForwardTestRecord } from './forwardTestStore.js'
import { StudyStore } from './studyStore.js'

const CONFIG: StudyConfig = {
  underlying: 'SPX',
  from: '2026-08-18',
  to: '2026-08-18',
  entryTime: '09:35',
  entry: { type: 'ema', period: 9 },
  targetDte: 7,
  expirationRule: 'nearest',
  placement: { type: 'expectedMove', buffer: 0 },
  wingWidth: 30,
  quantity: 1,
  pricing: { model: 'close', slippage: 0.05, missingDataMode: 'carryForward', maxStaleMinutes: 1 },
  minimumCoverage: 0.8,
  managements: ['tp200']
}

const RECORD: ForwardTestRecord = {
  forwardTestId: 'forward-1',
  name: 'Original EMA +200%',
  createdAt: 1_787_000_000_000,
  startDate: '2026-08-18',
  targetSessions: 60,
  state: 'active',
  config: CONFIG,
  configHash: 'abc123',
  appVersion: 'test'
}

describe('ForwardTestStore', () => {
  let dir: string
  let db: Database

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'btsmith-forward-'))
    db = new Database(join(dir, 'market-data.duckdb'))
    await db.open()
  })

  afterEach(async () => {
    await db.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('persists the immutable lock definition', async () => {
    const store = new ForwardTestStore(db)
    await store.create(RECORD)
    expect(await store.load(RECORD.forwardTestId)).toEqual(RECORD)
  })

  it('links auditable study batches and seals a completed test', async () => {
    const forward = new ForwardTestStore(db)
    const studies = new StudyStore(db)
    await forward.create({ ...RECORD, targetSessions: 5 })

    const run: StudyRunResult = {
      runId: 'run-1',
      createdAt: 1_787_100_000_000,
      config: { ...CONFIG, from: '2026-08-18', to: '2026-08-24' },
      entryCount: 4,
      entriesAttempted: 5,
      skipped: [{ date: '2026-08-20', reason: 'no price' }],
      summaries: [],
      trades: [],
      sizing: 'oneContract',
      appVersion: 'test'
    }
    await studies.save(run)
    await forward.attachRun(RECORD.forwardTestId, run.runId, run.config.from, run.config.to, 5, true)

    expect(await forward.runs(RECORD.forwardTestId)).toEqual([{
      runId: 'run-1',
      from: '2026-08-18',
      to: '2026-08-24',
      sessions: 5,
      createdAt: expect.any(Number),
      acceptedEntries: 4,
      skippedSessions: 1
    }])
    expect((await forward.load(RECORD.forwardTestId))?.state).toBe('complete')
  })
})
