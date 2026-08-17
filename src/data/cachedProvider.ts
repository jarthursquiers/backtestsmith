import type { BarQuery, OptionBar, UnderlyingBar } from '../domain/bars.js'
import type { ContractQuery, OptionContract } from '../domain/contracts.js'
import type {
  BarFetchResult,
  FetchOptions,
  OptionsHistoricalDataProvider,
  ProviderStatus
} from './provider.js'
import type { ProviderSources } from './provider.js'
import { marketDateOf, tradingDaysBetween, type MarketDate } from '../core/time/marketTime.js'
import type { BarKind, BarShape, MarketDataStore } from '../database/marketDataStore.js'
import { createLogger } from '../services/logger.js'

const log = createLogger('cache.provider')

/**
 * Cache-first decorator over any historical data provider.
 *
 * The research engine talks to `OptionsHistoricalDataProvider` and cannot tell
 * whether a bar came off disk or off the wire. Upstream is consulted only for
 * ranges the cache has never been asked about.
 *
 * This is the difference between a viable and an unusable tool: at five calls
 * per minute, re-fetching a three-leg butterfly on every backtest run would cost
 * ~36 seconds per trade. Cached, it costs nothing and the same data is reused
 * indefinitely.
 */
export class CachedProvider implements OptionsHistoricalDataProvider {
  readonly id: string
  readonly name: string

  constructor(
    private readonly upstream: OptionsHistoricalDataProvider,
    private readonly store: MarketDataStore
  ) {
    this.id = `cached:${upstream.id}`
    this.name = `${upstream.name} (cached)`
  }

  testConnection(options?: FetchOptions): Promise<ProviderStatus> {
    // Connectivity is never cached; it is a live question by definition.
    return this.upstream.testConnection(options)
  }

  private sourceId(capability: 'contracts' | 'option' | 'underlying'): string {
    const aware = this.upstream as OptionsHistoricalDataProvider & Partial<ProviderSources>
    return aware.sourceId?.(capability) ?? this.upstream.id
  }

  async getContracts(query: ContractQuery, options: FetchOptions = {}): Promise<OptionContract[]> {
    // Only exact-expiration lookups are cacheable: for a range query we cannot
    // know which expirations exist without asking, so a "covered" marker would
    // be a lie. Range discovery passes straight through.
    if (!query.expirationDate) {
      log.debug('contract query not cacheable, passing through', {
        underlying: query.underlying,
        gte: query.expirationDateGte,
        lte: query.expirationDateLte
      })
      return this.upstream.getContracts(query, options)
    }

    const type = query.type ?? 'any'
    const source = this.sourceId('contracts')
    const cached = await this.store.hasContractCoverage(query.underlying, query.expirationDate, type, source)

    if (!cached) {
      /*
       * Fetch the whole chain for this expiration, deliberately ignoring the
       * caller's strike filters. Otherwise the coverage marker would claim a
       * complete chain while holding only the strikes one early query happened
       * to want - and butterfly construction needs many strikes anyway.
       */
      const full = await this.upstream.getContracts(
        {
          underlying: query.underlying,
          expirationDate: query.expirationDate,
          ...(query.type ? { type: query.type } : {}),
          expired: query.expired ?? true,
          ...(query.asOf ? { asOf: query.asOf } : {})
        },
        options
      )

      await this.store.putContracts(full, source)
      await this.store.setContractCoverage(
        query.underlying,
        query.expirationDate,
        type,
        full.length,
        source
      )
      log.info('contract chain cached', {
        underlying: query.underlying,
        expiration: query.expirationDate,
        type,
        count: full.length
      })
    }

    const rows = await this.store.getContracts(
      query.underlying,
      query.expirationDate,
      query.type
    )
    return applyContractFilters(rows, query)
  }

  getOptionBars(query: BarQuery, options: FetchOptions = {}): Promise<BarFetchResult<OptionBar>> {
    return this.fetchBars('option', query, options) as Promise<BarFetchResult<OptionBar>>
  }

  getUnderlyingBars(query: BarQuery, options: FetchOptions = {}): Promise<BarFetchResult<UnderlyingBar>> {
    return this.fetchBars('underlying', query, options) as Promise<BarFetchResult<UnderlyingBar>>
  }

  private async fetchBars(
    kind: BarKind,
    query: BarQuery,
    options: FetchOptions
  ): Promise<BarFetchResult<OptionBar | UnderlyingBar>> {
    const shape: BarShape = { timespan: query.timespan ?? 'minute', multiplier: query.multiplier ?? 1 }

    // Only trading days can hold data, so weekends and holidays are neither
    // fetched nor recorded as gaps.
    const dates = tradingDaysBetween(query.from, query.to)

    if (dates.length === 0) {
      log.debug('range contains no trading days', { ticker: query.ticker, from: query.from, to: query.to })
      return {
        ticker: query.ticker,
        bars: [],
        requestedFrom: query.from,
        requestedTo: query.to,
        empty: true,
        fetchedAt: Date.now()
      }
    }

    const coverage = await this.store.getBarCoverage(query.ticker, dates, shape)
    const source = this.sourceId(kind)
    const missing = dates.filter((d) => coverage.get(d)?.provider !== source)

    if (missing.length > 0) {
      for (const range of contiguousRanges(dates, missing)) {
        /*
         * One upstream request per contiguous gap rather than one per day.
         * A 7-DTE contract's whole life is ~2,700 minute bars, far under the
         * documented 50,000 limit, so its entire history costs a single call.
         */
        const result = await this.upstream[kind === 'option' ? 'getOptionBars' : 'getUnderlyingBars'](
          { ...query, from: range.from, to: range.to },
          options
        )

        /*
         * What an empty response means depends on the instrument.
         *
         * For an option, "no bars" is real information: the contract did not
         * trade, and recording that prevents re-asking forever. For an index it
         * is not - an index always has a value while the market is open, so an
         * empty response means the data was unavailable (entitlement, retention,
         * an outage). Recording that as a confirmed zero would permanently
         * suppress a later, successful download.
         *
         * So for underlying data, only days that actually returned bars are
         * marked covered.
         */
        const datesToRecord =
          kind === 'option'
            ? range.dates
            : [...new Set(result.bars.map((b) => marketDateOf(b.timestamp)))].sort()

        if (kind === 'underlying' && datesToRecord.length === 0) {
          log.warn('underlying range returned no data; not recording coverage', {
            ticker: query.ticker,
            from: range.from,
            to: range.to,
            note: 'an empty index response means unavailable, not "did not trade"'
          })
          continue
        }

        await this.store.putBars(kind, query.ticker, datesToRecord, result.bars, shape, source)

        log.info('cached upstream bars', {
          ticker: query.ticker,
          from: range.from,
          to: range.to,
          days: range.dates.length,
          bars: result.bars.length
        })
      }
    } else {
      log.debug('cache hit', { ticker: query.ticker, from: query.from, to: query.to, days: dates.length })
    }

    const bars =
      kind === 'option'
        ? await this.store.getOptionBars(query.ticker, dates)
        : await this.store.getUnderlyingBars(query.ticker, dates)

    return {
      ticker: query.ticker,
      bars,
      requestedFrom: query.from,
      requestedTo: query.to,
      // Still "empty" in the same sense as upstream: asked, and nothing traded.
      empty: bars.length === 0,
      fetchedAt: Date.now(),
      reportedCount: bars.length
    }
  }
}

/** Applies the caller's client-side filters to a full cached chain. */
export function applyContractFilters(
  contracts: readonly OptionContract[],
  query: ContractQuery
): OptionContract[] {
  let out = contracts.slice()
  if (query.type) out = out.filter((c) => c.type === query.type)
  if (query.strike !== undefined) out = out.filter((c) => c.strike === query.strike)
  if (query.strikeGte !== undefined) out = out.filter((c) => c.strike >= query.strikeGte!)
  if (query.strikeLte !== undefined) out = out.filter((c) => c.strike <= query.strikeLte!)
  if (query.maxResults !== undefined) out = out.slice(0, query.maxResults)
  return out
}

/**
 * Groups missing dates into contiguous runs, where adjacency means "the next
 * trading day, and also missing".
 *
 * Measuring over the trading-day sequence rather than the calendar keeps a
 * weekend from splitting one run into two. Conversely, a day that is already
 * cached does split the run, since spanning it would re-request data we hold.
 */
export function contiguousRanges(
  allDates: readonly MarketDate[],
  missing: readonly MarketDate[]
): { from: MarketDate; to: MarketDate; dates: MarketDate[] }[] {
  const index = new Map(allDates.map((d, i) => [d, i]))
  const sorted = [...missing].sort()
  const ranges: { from: MarketDate; to: MarketDate; dates: MarketDate[] }[] = []

  let current: MarketDate[] = []
  for (const date of sorted) {
    if (current.length === 0) {
      current = [date]
      continue
    }
    const previous = current[current.length - 1]!
    const adjacent = (index.get(date) ?? -1) === (index.get(previous) ?? -2) + 1
    if (adjacent) {
      current.push(date)
    } else {
      ranges.push({ from: current[0]!, to: previous, dates: current })
      current = [date]
    }
  }
  if (current.length > 0) {
    ranges.push({ from: current[0]!, to: current[current.length - 1]!, dates: current })
  }

  return ranges
}
