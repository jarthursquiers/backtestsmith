import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BarQuery, OptionBar, UnderlyingBar } from '../domain/bars.js'
import type { ContractQuery, OptionContract } from '../domain/contracts.js'
import type { BarFetchResult, OptionsHistoricalDataProvider, ProviderStatus } from './provider.js'
import { Database } from '../database/duckdb.js'
import { MarketDataStore } from '../database/marketDataStore.js'
import { CachedProvider, contiguousRanges } from './cachedProvider.js'
import { easternToTimestamp } from '../core/time/marketTime.js'

/** Upstream stub that counts calls, so cache hits are provable. */
class FakeUpstream implements OptionsHistoricalDataProvider {
  readonly id = 'fake'
  readonly name = 'Fake'
  contractCalls: ContractQuery[] = []
  barCalls: BarQuery[] = []
  /** Bars to return, keyed by market date. Absent means the day had no trades. */
  barsByDate = new Map<string, OptionBar[]>()
  contracts: OptionContract[] = []

  testConnection(): Promise<ProviderStatus> {
    return Promise.resolve({ ok: true, providerId: this.id, message: 'Connected', checkedAt: Date.now() })
  }

  getContracts(query: ContractQuery): Promise<OptionContract[]> {
    this.contractCalls.push(query)
    return Promise.resolve(this.contracts)
  }

  getOptionBars(query: BarQuery): Promise<BarFetchResult<OptionBar>> {
    this.barCalls.push(query)
    const bars: OptionBar[] = []
    for (const [date, dayBars] of this.barsByDate) {
      if (date >= query.from && date <= query.to) bars.push(...dayBars)
    }
    return Promise.resolve({
      ticker: query.ticker,
      bars,
      requestedFrom: query.from,
      requestedTo: query.to,
      empty: bars.length === 0,
      fetchedAt: Date.now()
    })
  }

  getUnderlyingBars(query: BarQuery): Promise<BarFetchResult<UnderlyingBar>> {
    this.barCalls.push(query)
    return Promise.resolve({
      ticker: query.ticker,
      bars: [],
      requestedFrom: query.from,
      requestedTo: query.to,
      empty: true,
      fetchedAt: Date.now()
    })
  }
}

const TICKER = 'O:SPXW250620P05900000'

function bar(date: string, hour: number, minute: number, close: number): OptionBar {
  return {
    ticker: TICKER,
    timestamp: easternToTimestamp(date, hour, minute),
    open: close,
    high: close + 0.1,
    low: close - 0.1,
    close,
    volume: 10,
    vwap: close,
    transactions: 2
  }
}

describe('CachedProvider', () => {
  let db: Database
  let store: MarketDataStore
  let upstream: FakeUpstream
  let provider: CachedProvider

  beforeEach(async () => {
    db = new Database(':memory:')
    await db.open()
    store = new MarketDataStore(db)
    upstream = new FakeUpstream()
    provider = new CachedProvider(upstream, store)
  })

  afterEach(async () => {
    await db.close()
  })

  it('fetches once, then serves from cache', async () => {
    upstream.barsByDate.set('2025-06-17', [bar('2025-06-17', 9, 35, 2.2), bar('2025-06-17', 9, 36, 2.4)])

    const first = await provider.getOptionBars({ ticker: TICKER, from: '2025-06-17', to: '2025-06-17' })
    expect(first.bars).toHaveLength(2)
    expect(upstream.barCalls).toHaveLength(1)

    const second = await provider.getOptionBars({ ticker: TICKER, from: '2025-06-17', to: '2025-06-17' })
    expect(second.bars).toHaveLength(2)
    // The whole point: no second network call.
    expect(upstream.barCalls).toHaveLength(1)
    expect(second.bars.map((b) => b.close)).toEqual([2.2, 2.4])
  })

  it('never re-fetches a day that was confirmed empty', async () => {
    // No bars registered: the contract genuinely did not trade that day.
    const first = await provider.getOptionBars({ ticker: TICKER, from: '2025-06-17', to: '2025-06-17' })
    expect(first.bars).toHaveLength(0)
    expect(first.empty).toBe(true)
    expect(upstream.barCalls).toHaveLength(1)

    const second = await provider.getOptionBars({ ticker: TICKER, from: '2025-06-17', to: '2025-06-17' })
    expect(second.bars).toHaveLength(0)
    // Without a coverage ledger this would call upstream forever.
    expect(upstream.barCalls).toHaveLength(1)
  })

  it('fetches only the missing days on a widened range', async () => {
    upstream.barsByDate.set('2025-06-18', [bar('2025-06-18', 10, 0, 3.0)])
    await provider.getOptionBars({ ticker: TICKER, from: '2025-06-18', to: '2025-06-18' })
    expect(upstream.barCalls).toHaveLength(1)

    upstream.barsByDate.set('2025-06-17', [bar('2025-06-17', 10, 0, 2.0)])
    upstream.barsByDate.set('2025-06-20', [bar('2025-06-20', 10, 0, 4.0)])

    const widened = await provider.getOptionBars({ ticker: TICKER, from: '2025-06-17', to: '2025-06-20' })

    // 06-19 is Juneteenth, so the trading days are 17, 18, 20. Day 18 is cached,
    // leaving two non-adjacent gaps: [17] and [20].
    const followUp = upstream.barCalls.slice(1)
    expect(followUp).toHaveLength(2)
    expect(followUp.map((c) => `${c.from}..${c.to}`)).toEqual(['2025-06-17..2025-06-17', '2025-06-20..2025-06-20'])
    expect(widened.bars.map((b) => b.close)).toEqual([2.0, 3.0, 4.0])
  })

  it('batches a contiguous gap into one request', async () => {
    for (const d of ['2025-06-16', '2025-06-17', '2025-06-18']) {
      upstream.barsByDate.set(d, [bar(d, 10, 0, 1)])
    }
    await provider.getOptionBars({ ticker: TICKER, from: '2025-06-16', to: '2025-06-18' })

    expect(upstream.barCalls).toHaveLength(1)
    expect(upstream.barCalls[0]).toMatchObject({ from: '2025-06-16', to: '2025-06-18' })
  })

  it('ignores weekends and holidays entirely', async () => {
    // 2025-06-21/22 is a weekend; there is nothing to fetch or record.
    const result = await provider.getOptionBars({ ticker: TICKER, from: '2025-06-21', to: '2025-06-22' })
    expect(result.bars).toHaveLength(0)
    expect(upstream.barCalls).toHaveLength(0)
  })

  it('is idempotent when the same day is re-downloaded', async () => {
    upstream.barsByDate.set('2025-06-17', [bar('2025-06-17', 9, 35, 2.2)])
    await provider.getOptionBars({ ticker: TICKER, from: '2025-06-17', to: '2025-06-17' })

    // Force a second write of the same day directly through the store.
    await store.putBars(
      'option',
      TICKER,
      ['2025-06-17'],
      [bar('2025-06-17', 9, 35, 2.2)],
      { timespan: 'minute', multiplier: 1 },
      'fake'
    )

    const bars = await store.getOptionBars(TICKER, ['2025-06-17'])
    expect(bars).toHaveLength(1) // not duplicated
  })

  it('separates cached data by bar shape', async () => {
    upstream.barsByDate.set('2025-06-17', [bar('2025-06-17', 9, 35, 2.2)])
    await provider.getOptionBars({ ticker: TICKER, from: '2025-06-17', to: '2025-06-17', timespan: 'minute' })
    expect(upstream.barCalls).toHaveLength(1)

    // A daily request is a different shape and must not be served by minute coverage.
    await provider.getOptionBars({ ticker: TICKER, from: '2025-06-17', to: '2025-06-17', timespan: 'day' })
    expect(upstream.barCalls).toHaveLength(2)
  })
})

describe('empty responses by instrument kind', () => {
  let db: Database
  let store: MarketDataStore
  let upstream: FakeUpstream
  let provider: CachedProvider

  beforeEach(async () => {
    db = new Database(':memory:')
    await db.open()
    store = new MarketDataStore(db)
    upstream = new FakeUpstream()
    provider = new CachedProvider(upstream, store)
  })

  afterEach(async () => {
    await db.close()
  })

  it('does not record an empty underlying response as confirmed', async () => {
    /*
     * Regression: an index always has a value while the market is open, so an
     * empty response means unavailable - entitlement, retention, an outage -
     * not "it did not trade". Recording it as a confirmed zero permanently
     * suppressed the retry, which is what happened to a year of I:SPX minutes.
     */
    const first = await provider.getUnderlyingBars({ ticker: 'I:SPX', from: '2025-06-17', to: '2025-06-17' })
    expect(first.bars).toHaveLength(0)
    expect(upstream.barCalls).toHaveLength(1)

    // The provider gains access later; the retry must actually happen.
    const second = await provider.getUnderlyingBars({ ticker: 'I:SPX', from: '2025-06-17', to: '2025-06-17' })
    expect(upstream.barCalls).toHaveLength(2)
    expect(second.bars).toHaveLength(0)
  })

  it('still records an empty option response as confirmed', async () => {
    // For an option, "no bars" is real information and must not be re-asked.
    await provider.getOptionBars({ ticker: TICKER, from: '2025-06-17', to: '2025-06-17' })
    await provider.getOptionBars({ ticker: TICKER, from: '2025-06-17', to: '2025-06-17' })
    expect(upstream.barCalls).toHaveLength(1)
  })
})

describe('CachedProvider contract chains', () => {
  let db: Database
  let store: MarketDataStore
  let upstream: FakeUpstream
  let provider: CachedProvider

  const chain: OptionContract[] = [5850, 5875, 5900, 5925].map((strike) => ({
    ticker: `O:SPXW250620P0${strike}000`,
    underlying: 'SPX',
    expirationDate: '2025-06-20',
    strike,
    type: 'put' as const,
    root: 'SPXW',
    settlement: 'pm' as const
  }))

  beforeEach(async () => {
    db = new Database(':memory:')
    await db.open()
    store = new MarketDataStore(db)
    upstream = new FakeUpstream()
    upstream.contracts = chain
    provider = new CachedProvider(upstream, store)
  })

  afterEach(async () => {
    await db.close()
  })

  it('caches the full chain and filters strikes locally afterwards', async () => {
    const narrow = await provider.getContracts({
      underlying: 'SPX',
      expirationDate: '2025-06-20',
      type: 'put',
      strikeGte: 5875,
      strikeLte: 5900
    })
    expect(narrow.map((c) => c.strike)).toEqual([5875, 5900])

    // Upstream was asked for the whole chain, not the narrow slice, so a later
    // query for different strikes is a cache hit rather than a refetch.
    expect(upstream.contractCalls).toHaveLength(1)
    expect(upstream.contractCalls[0]?.strikeGte).toBeUndefined()

    const wider = await provider.getContracts({
      underlying: 'SPX',
      expirationDate: '2025-06-20',
      type: 'put',
      strikeGte: 5850
    })
    expect(wider.map((c) => c.strike)).toEqual([5850, 5875, 5900, 5925])
    expect(upstream.contractCalls).toHaveLength(1)
  })

  it('preserves settlement metadata through the cache round-trip', async () => {
    const [first] = await provider.getContracts({ underlying: 'SPX', expirationDate: '2025-06-20', type: 'put' })
    expect(first?.root).toBe('SPXW')
    expect(first?.settlement).toBe('pm')
  })

  it('does not re-query an expiration with no contracts', async () => {
    upstream.contracts = []
    const a = await provider.getContracts({ underlying: 'SPX', expirationDate: '2025-06-19', type: 'put' })
    const b = await provider.getContracts({ underlying: 'SPX', expirationDate: '2025-06-19', type: 'put' })
    expect(a).toEqual([])
    expect(b).toEqual([])
    expect(upstream.contractCalls).toHaveLength(1)
  })

  it('passes range queries straight through, since coverage cannot be asserted', async () => {
    await provider.getContracts({
      underlying: 'SPX',
      expirationDateGte: '2025-06-16',
      expirationDateLte: '2025-06-27'
    })
    expect(upstream.contractCalls).toHaveLength(1)
    expect(upstream.contractCalls[0]?.expirationDateGte).toBe('2025-06-16')
  })
})

describe('contiguousRanges', () => {
  const week = ['2025-06-16', '2025-06-17', '2025-06-18', '2025-06-20']

  it('merges adjacent trading days', () => {
    expect(contiguousRanges(week, week)).toEqual([
      { from: '2025-06-16', to: '2025-06-20', dates: week }
    ])
  })

  it('splits around an already-cached day', () => {
    const ranges = contiguousRanges(week, ['2025-06-16', '2025-06-20'])
    expect(ranges.map((r) => `${r.from}..${r.to}`)).toEqual([
      '2025-06-16..2025-06-16',
      '2025-06-20..2025-06-20'
    ])
  })

  it('treats a weekend gap as contiguous', () => {
    // Fri 06-20 and Mon 06-23 are adjacent trading days despite the calendar gap.
    const dates = ['2025-06-20', '2025-06-23']
    expect(contiguousRanges(dates, dates)).toEqual([
      { from: '2025-06-20', to: '2025-06-23', dates }
    ])
  })

  it('returns nothing when nothing is missing', () => {
    expect(contiguousRanges(week, [])).toEqual([])
  })
})
