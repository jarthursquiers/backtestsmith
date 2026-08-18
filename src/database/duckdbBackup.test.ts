import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Database } from './duckdb.js'

describe('Database backup', () => {
  let dir: string
  let db: Database

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'btsmith-backup-'))
    db = new Database(join(dir, 'live.duckdb'))
    await db.open()
  })

  afterEach(async () => {
    await db.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('copies and independently verifies an open database', async () => {
    await db.run(
      `INSERT INTO option_contracts
       VALUES ('O:TEST', 'SPX', '2026-08-21', 6500, 'call', 'european', 100, NULL, 'SPXW', 'pm', 'theta', 1)`
    )
    await db.run(
      `INSERT INTO option_bars
       (ticker, timespan, multiplier, ts, market_date, open, high, low, close, volume, vwap, transactions)
       VALUES ('O:TEST', 'minute', 1, 1, '2026-08-17', 1, 1, 1, 1, 1, 1, 1)`
    )
    await db.run(
      `INSERT INTO underlying_bars
       (ticker, timespan, multiplier, ts, market_date, open, high, low, close, volume, vwap, transactions)
       VALUES ('I:SPX', 'minute', 1, 1, '2026-08-17', 6500, 6500, 6500, 6500, 1, 6500, 1)`
    )
    await db.run(
      `INSERT INTO bar_coverage
       VALUES ('O:TEST', '2026-08-17', 'minute', 1, 'option', 1, 'theta', 1)`
    )
    await db.run(
      `INSERT INTO study_runs
       VALUES ('run-1', 1, NULL, '{"from":"2026-08-17","to":"2026-08-17"}', 1, 1, '[]', 'test', NULL)`
    )
    await db.run(
      `INSERT INTO study_trades
       VALUES ('run-1', 'tp200', 1, 2, '2026-08-21', 6500, 30, 'bullish', 1, 3, 'profitTarget', false,
               200, 200, 1, 7, 200, -10, 1, 0, 1,
               '{"definition":{"lowerTicker":"O:TEST","centerTicker":"O:TEST","upperTicker":"O:TEST"}}')`
    )

    const destination = join(dir, 'backup.duckdb')
    const result = await db.backupTo(destination)

    expect(result.path).toBe(destination)
    expect(existsSync(result.manifestPath)).toBe(true)
    expect(JSON.parse(readFileSync(result.manifestPath, 'utf8')).sha256).toBe(result.sha256)
    expect(result.bytes).toBeGreaterThan(0)
    expect(result.sha256).toMatch(/^[a-f0-9]{64}$/)
    expect(result.optionContracts).toBe(1)
    expect(result.optionBars).toBe(1)
    expect(result.underlyingBars).toBe(1)
    expect(result.coveredOptionDays).toBe(1)
    expect(result.optionEarliestDate).toBe('2026-08-17')
    expect(result.optionLatestDate).toBe('2026-08-17')
    expect(result.underlyingEarliestDate).toBe('2026-08-17')
    expect(result.underlyingLatestDate).toBe('2026-08-17')
    expect(result.studyRuns).toBe(1)
    expect(result.studyEarliestDate).toBe('2026-08-17')
    expect(result.studyLatestDate).toBe('2026-08-17')
    expect(result.referencedOptionTickers).toBe(1)
    expect(result.referencedTickersMissingContracts).toBe(0)
    expect(result.referencedTickersMissingBars).toBe(0)
  })
})
