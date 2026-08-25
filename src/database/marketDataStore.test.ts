import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { OptionBar, UnderlyingBar } from '../domain/bars.js'
import type { OptionContract } from '../domain/contracts.js'
import { easternToTimestamp } from '../core/time/marketTime.js'
import { Database } from './duckdb.js'
import { MarketDataStore } from './marketDataStore.js'

const TICKER = 'O:SPXW250620P05875000'
const SHAPE = { timespan: 'minute', multiplier: 1 }
const MINUTE = { timespan: 'minute', multiplier: 1 }
const DAILY = { timespan: 'day', multiplier: 1 }

function bar(date: string, hour: number, minute: number, close: number): OptionBar {
  return {
    ticker: TICKER,
    timestamp: easternToTimestamp(date, hour, minute),
    open: close - 0.05,
    high: close + 0.15,
    low: close - 0.2,
    close,
    volume: 42,
    vwap: close + 0.01,
    transactions: 3
  }
}

describe('MarketDataStore persistence', () => {
  let dir: string
  let dbPath: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'btsmith-'))
    dbPath = join(dir, 'market-data.duckdb')
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('survives a close and reopen, serving data with no provider present', async () => {
    const contract: OptionContract = {
      ticker: TICKER,
      underlying: 'SPX',
      expirationDate: '2025-06-20',
      strike: 5875,
      type: 'put',
      exerciseStyle: 'european',
      sharesPerContract: 100,
      root: 'SPXW',
      settlement: 'pm'
    }

    const first = new Database(dbPath)
    await first.open()
    const writeStore = new MarketDataStore(first)
    await writeStore.putContracts([contract], 'massive')
    await writeStore.setContractCoverage('SPX', '2025-06-20', 'put', 1, 'massive')
    await writeStore.putBars(
      'option',
      TICKER,
      ['2025-06-17'],
      [bar('2025-06-17', 9, 35, 2.2), bar('2025-06-17', 9, 36, 2.35)],
      SHAPE,
      'massive'
    )
    await first.close()

    // A completely fresh process-equivalent: new handle, no provider anywhere.
    const second = new Database(dbPath)
    await second.open()
    const readStore = new MarketDataStore(second)

    const contracts = await readStore.getContracts('SPX', '2025-06-20', 'put')
    expect(contracts).toHaveLength(1)
    expect(contracts[0]).toMatchObject({ strike: 5875, root: 'SPXW', settlement: 'pm', exerciseStyle: 'european' })

    const bars = await readStore.getOptionBars(TICKER, ['2025-06-17'])
    expect(bars.map((b) => b.close)).toEqual([2.2, 2.35])
    expect(bars[0]).toMatchObject({ volume: 42, transactions: 3 })
    // Doubles round-trip bit-for-bit, including the float dust in 2.2 - 0.05.
    expect(bars[0]?.open).toBe(2.2 - 0.05)
    expect(bars[0]?.vwap).toBe(2.2 + 0.01)

    const coverage = await readStore.getBarCoverage(TICKER, ['2025-06-17'], SHAPE)
    expect(coverage.get('2025-06-17')?.barCount).toBe(2)
    expect(await readStore.hasContractCoverage('SPX', '2025-06-20', 'put')).toBe(true)

    await second.close()
  })

  it('records a confirmed-empty day distinctly from an unknown day', async () => {
    const db = new Database(':memory:')
    await db.open()
    const store = new MarketDataStore(db)

    await store.putBars('option', TICKER, ['2025-06-17'], [], SHAPE, 'massive')

    const coverage = await store.getBarCoverage(TICKER, ['2025-06-17', '2025-06-18'], SHAPE)
    // Asked and empty.
    expect(coverage.get('2025-06-17')?.barCount).toBe(0)
    // Never asked.
    expect(coverage.has('2025-06-18')).toBe(false)

    await db.close()
  })

  it('bulk-archives a full expiration day including contracts with no quotes', async () => {
    const db = new Database(':memory:')
    await db.open()
    const store = new MarketDataStore(db)
    const emptyTicker = 'O:SPXW250620C05875000'
    const contracts: OptionContract[] = [
      { ticker: TICKER, underlying: 'SPX', expirationDate: '2025-06-20', strike: 5875, type: 'put', root: 'SPXW' },
      { ticker: emptyTicker, underlying: 'SPX', expirationDate: '2025-06-20', strike: 5875, type: 'call', root: 'SPXW' }
    ]

    await store.putOptionArchiveDay(contracts, '2025-06-17', [bar('2025-06-17', 9, 35, 2.2)], 'thetadata-nbbo')

    expect(await store.hasOptionArchiveCoverage(contracts, '2025-06-17', 'thetadata-nbbo')).toBe(true)
    expect((await store.getBarCoverage(TICKER, ['2025-06-17'], SHAPE)).get('2025-06-17')?.barCount).toBe(1)
    expect((await store.getBarCoverage(emptyTicker, ['2025-06-17'], SHAPE)).get('2025-06-17')?.barCount).toBe(0)
    expect(await store.hasOptionArchiveCoverage(contracts, '2025-06-18', 'thetadata-nbbo')).toBe(false)

    await db.close()
  })

  it('derives the authoritative date range from actual ThetaData quotes, not empty attempts', async () => {
    const db = new Database(':memory:')
    await db.open()
    const store = new MarketDataStore(db)
    const contracts: OptionContract[] = [
      { ticker: TICKER, underlying: 'SPX', expirationDate: '2025-06-20', strike: 5875, type: 'put', root: 'SPXW' }
    ]

    await store.putOptionArchiveDay(contracts, '2025-06-17', [bar('2025-06-17', 9, 35, 2.2)], 'thetadata-nbbo')
    await store.putOptionArchiveDay(contracts, '2025-06-18', [], 'thetadata-nbbo')
    // A different cache/provider must not stretch the archive boundary.
    await store.putBars('option', TICKER, ['2025-06-20'], [bar('2025-06-20', 9, 35, 2.4)], SHAPE, 'massive')

    expect(await store.optionArchiveDateRange('SPXW')).toEqual({ from: '2025-06-17', to: '2025-06-17' })
    expect(await store.listArchivedExpirations('SPXW', '2025-06-17')).toEqual(['2025-06-20'])
    expect(await store.listArchivedExpirations('SPXW', '2025-06-18')).toEqual([])

    await db.close()
  })

  it('files bars under the Eastern market date, not the UTC date', async () => {
    const db = new Database(':memory:')
    await db.open()
    const store = new MarketDataStore(db)

    // 15:45 ET on 2025-06-17 is 19:45 UTC the same day, but a naive UTC slice of
    // a late-session bar can roll into the next day around the DST boundary.
    const late = bar('2025-06-17', 15, 45, 3.1)
    await store.putBars('option', TICKER, ['2025-06-17'], [late], SHAPE, 'massive')

    expect(await store.getOptionBars(TICKER, ['2025-06-17'])).toHaveLength(1)
    expect(await store.getOptionBars(TICKER, ['2025-06-18'])).toHaveLength(0)

    await db.close()
  })

  it('keeps index volume undefined rather than storing zero', async () => {
    const db = new Database(':memory:')
    await db.open()
    const store = new MarketDataStore(db)

    const indexBar: UnderlyingBar = {
      ticker: 'I:SPX',
      timestamp: easternToTimestamp('2025-06-17', 9, 35),
      open: 6000,
      high: 6005,
      low: 5998,
      close: 6002
      // no volume: index feeds do not report one
    }
    await store.putBars('underlying', 'I:SPX', ['2025-06-17'], [indexBar], SHAPE, 'massive')

    const [read] = await store.getUnderlyingBars('I:SPX', ['2025-06-17'])
    expect(read?.close).toBe(6002)
    expect(read?.volume).toBeUndefined()

    await db.close()
  })

  it('persists NBBO fields on option quote bars', async () => {
    const db = new Database(':memory:')
    await db.open()
    const store = new MarketDataStore(db)
    const quote = { ...bar('2025-06-17', 9, 35, 2.2), bid: 2.1, ask: 2.3, bidSize: 7, askSize: 9 }
    await store.putBars('option', TICKER, ['2025-06-17'], [quote], MINUTE, 'thetadata-nbbo')
    const [saved] = await store.getOptionBars(TICKER, ['2025-06-17'])
    expect(saved).toMatchObject({ bid: 2.1, ask: 2.3, bidSize: 7, askSize: 9 })
    await db.close()
  })

  it('keeps daily and minute bars for the same ticker independent', async () => {
    /*
     * Regression: bars were once keyed without their bar size and replaced by
     * (ticker, market_date), so downloading a two-year daily history silently
     * deleted every minute bar on the same dates while coverage went on
     * reporting them as present. 8,190 real minute bars were lost this way.
     */
    const db = new Database(':memory:')
    await db.open()
    const store = new MarketDataStore(db)

    const minuteBars = [bar('2025-06-17', 9, 35, 2.2), bar('2025-06-17', 9, 36, 2.3)]
    await store.putBars('option', TICKER, ['2025-06-17'], minuteBars, MINUTE, 'massive')

    const dailyBar = bar('2025-06-17', 9, 30, 2.5)
    await store.putBars('option', TICKER, ['2025-06-17'], [dailyBar], DAILY, 'massive')

    // Writing the daily bar must not disturb the minute bars.
    expect(await store.getOptionBars(TICKER, ['2025-06-17'], MINUTE)).toHaveLength(2)
    expect(await store.getOptionBars(TICKER, ['2025-06-17'], DAILY)).toHaveLength(1)

    // And re-writing the minute bars must not disturb the daily bar.
    await store.putBars('option', TICKER, ['2025-06-17'], minuteBars, MINUTE, 'massive')
    expect(await store.getOptionBars(TICKER, ['2025-06-17'], DAILY)).toHaveLength(1)

    await db.close()
  })

  it('keeps underlying daily and minute independent as well', async () => {
    const db = new Database(':memory:')
    await db.open()
    const store = new MarketDataStore(db)
    const mk = (h: number, m: number, c: number): UnderlyingBar => ({
      ticker: 'I:SPX',
      timestamp: easternToTimestamp('2025-06-17', h, m),
      open: c, high: c, low: c, close: c
    })

    await store.putBars('underlying', 'I:SPX', ['2025-06-17'], [mk(9, 35, 6001), mk(9, 36, 6002)], MINUTE, 'schwab')
    await store.putBars('underlying', 'I:SPX', ['2025-06-17'], [mk(9, 30, 6000)], DAILY, 'schwab')

    expect(await store.getUnderlyingBars('I:SPX', ['2025-06-17'], MINUTE)).toHaveLength(2)
    expect(await store.getUnderlyingBars('I:SPX', ['2025-06-17'], DAILY)).toHaveLength(1)

    await db.close()
  })

  it('survives concurrent writes on the single connection', async () => {
    /*
     * Regression: there is one DuckDB connection, so two overlapping
     * transactions failed with "cannot start a transaction within a
     * transaction". Callers fetch in parallel by design - three butterfly legs,
     * or a call and a put for parity - so the database has to serialize the
     * writes itself rather than forbidding the parallelism.
     */
    const db = new Database(':memory:')
    await db.open()
    const store = new MarketDataStore(db)

    const writes = ['2025-06-16', '2025-06-17', '2025-06-18', '2025-06-20'].map((date) =>
      store.putBars('option', TICKER, [date], [bar(date, 9, 35, 2.2), bar(date, 9, 36, 2.3)], MINUTE, 'massive')
    )
    await expect(Promise.all(writes)).resolves.toBeDefined()

    const bars = await store.getOptionBars(
      TICKER,
      ['2025-06-16', '2025-06-17', '2025-06-18', '2025-06-20'],
      MINUTE
    )
    expect(bars).toHaveLength(8)

    await db.close()
  })

  it('interleaves reads and writes without joining an open transaction', async () => {
    const db = new Database(':memory:')
    await db.open()
    const store = new MarketDataStore(db)

    const results = await Promise.all([
      store.putBars('option', TICKER, ['2025-06-17'], [bar('2025-06-17', 9, 35, 2.2)], MINUTE, 'massive'),
      store.getOptionBars(TICKER, ['2025-06-17'], MINUTE),
      store.putContracts(
        [{ ticker: TICKER, underlying: 'SPX', expirationDate: '2025-06-20', strike: 5875, type: 'put' }],
        'massive'
      ),
      store.stats(0)
    ])
    expect(results).toHaveLength(4)

    // Both writes landed despite running concurrently with reads.
    expect(await store.getOptionBars(TICKER, ['2025-06-17'], MINUTE)).toHaveLength(1)
    expect(await store.getContracts('SPX', '2025-06-20', 'put')).toHaveLength(1)

    await db.close()
  })

  it('queues a transaction that arrives while another is already in flight', async () => {
    /*
     * The case a naive "am I in a transaction" flag gets wrong, and the one that
     * actually happened: rate-limited fetches finish at different times, so the
     * second write starts while the first transaction is genuinely open. A
     * global flag makes the newcomer look like a nested statement, it skips the
     * queue, and DuckDB rejects the second BEGIN.
     *
     * Distinguishing them requires knowing whether the caller is running inside
     * the transaction's own async context, not merely at the same time as it.
     */
    const db = new Database(':memory:')
    await db.open()
    await db.run('CREATE TABLE t (a INTEGER)')

    const first = db.transaction(async () => {
      await db.run('INSERT INTO t VALUES (1)')
      // Hold the transaction open across a real tick.
      await new Promise((resolve) => setTimeout(resolve, 40))
      await db.run('INSERT INTO t VALUES (2)')
    })

    // Let the first transaction actually BEGIN before the second arrives.
    await new Promise((resolve) => setTimeout(resolve, 10))
    const second = db.transaction(async () => {
      await db.run('INSERT INTO t VALUES (3)')
    })

    await expect(Promise.all([first, second])).resolves.toBeDefined()
    expect(await db.query('SELECT count(*) AS n FROM t')).toEqual([{ n: 3 }])

    await db.close()
  })

  it('still allows statements nested inside a transaction body', async () => {
    const db = new Database(':memory:')
    await db.open()
    await db.run('CREATE TABLE t (a INTEGER)')

    // Nested statements must not deadlock waiting for a queue they already hold.
    await db.transaction(async () => {
      await db.run('INSERT INTO t VALUES (1)')
      const rows = await db.query('SELECT count(*) AS n FROM t')
      expect(rows).toEqual([{ n: 1 }])
      await db.run('INSERT INTO t VALUES (2)')
    })

    expect(await db.query('SELECT count(*) AS n FROM t')).toEqual([{ n: 2 }])
    await db.close()
  })

  it('rolls back a failed transaction without stalling the queue', async () => {
    const db = new Database(':memory:')
    await db.open()
    await db.run('CREATE TABLE t (a INTEGER)')

    await expect(
      db.transaction(async () => {
        await db.run('INSERT INTO t VALUES (1)')
        throw new Error('boom')
      })
    ).rejects.toThrow('boom')

    // The queue must remain usable after a failure.
    await db.transaction(async () => {
      await db.run('INSERT INTO t VALUES (2)')
    })
    expect(await db.query('SELECT count(*) AS n FROM t')).toEqual([{ n: 1 }])

    await db.close()
  })

  it('reports stats and clears cleanly', async () => {
    const db = new Database(':memory:')
    await db.open()
    const store = new MarketDataStore(db)

    await store.putBars('option', TICKER, ['2025-06-17'], [bar('2025-06-17', 9, 35, 2)], SHAPE, 'massive')
    await store.putBars('option', TICKER, ['2025-06-18'], [], SHAPE, 'massive')

    const stats = await store.stats(1234)
    expect(stats.optionBars).toBe(1)
    expect(stats.coveredOptionDays).toBe(2)
    expect(stats.emptyOptionDays).toBe(1)
    expect(stats.earliestDate).toBe('2025-06-17')
    expect(stats.latestDate).toBe('2025-06-18')
    expect(stats.databaseBytes).toBe(1234)

    await store.clear()
    const cleared = await store.stats(0)
    expect(cleared.optionBars).toBe(0)
    expect(cleared.coveredOptionDays).toBe(0)

    await db.close()
  })
})
