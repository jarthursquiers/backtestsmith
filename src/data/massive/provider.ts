import type { BarQuery, OptionBar, UnderlyingBar } from '../../domain/bars.js'
import type { ContractQuery, ExerciseStyle, OptionContract } from '../../domain/contracts.js'
import type {
  BarFetchResult,
  FetchOptions,
  OptionsHistoricalDataProvider,
  ProviderStatus
} from '../provider.js'
import { createLogger } from '../../services/logger.js'
import { MassiveClient } from './client.js'
import { parseOptionTicker, spxSettlementForRoot } from './tickers.js'
import {
  massiveAggregatesResponseSchema,
  massiveContractsResponseSchema,
  type MassiveAggregate,
  type MassiveContract
} from './schemas.js'

const log = createLogger('massive.provider')

/** Documented maximums; requests are clamped so the API never rejects on limit. */
const MAX_CONTRACTS_LIMIT = 1000
const MAX_AGGREGATES_LIMIT = 50_000

export class MassiveProvider implements OptionsHistoricalDataProvider {
  readonly id = 'massive'
  readonly name = 'Massive.com'

  constructor(private readonly client: MassiveClient) {}

  async testConnection(options: FetchOptions = {}): Promise<ProviderStatus> {
    const startedAt = Date.now()
    // Cheapest meaningful probe: a single-row reference lookup.
    const url = this.client.buildUrl('/v3/reference/options/contracts', {
      underlying_ticker: 'SPX',
      limit: 1
    })

    try {
      await this.client.get(url, massiveContractsResponseSchema, {
        label: 'test connection',
        priority: 0,
        ...(options.signal ? { signal: options.signal } : {})
      })
      const latencyMs = Date.now() - startedAt
      log.info('connection ok', { latencyMs })
      return { ok: true, providerId: this.id, message: 'Connected', latencyMs, checkedAt: Date.now() }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      log.warn('connection failed', { message })
      return { ok: false, providerId: this.id, message, checkedAt: Date.now() }
    }
  }

  async getContracts(query: ContractQuery, options: FetchOptions = {}): Promise<OptionContract[]> {
    const limit = Math.min(query.limit ?? MAX_CONTRACTS_LIMIT, MAX_CONTRACTS_LIMIT)
    const maxResults = query.maxResults ?? 10_000

    const url = this.client.buildUrl('/v3/reference/options/contracts', {
      underlying_ticker: query.underlying,
      expiration_date: query.expirationDate,
      'expiration_date.gte': query.expirationDateGte,
      'expiration_date.lte': query.expirationDateLte,
      contract_type: query.type,
      strike_price: query.strike,
      'strike_price.gte': query.strikeGte,
      'strike_price.lte': query.strikeLte,
      // Historical research needs expired contracts; the API defaults to false.
      expired: query.expired ?? true,
      as_of: query.asOf,
      limit,
      sort: 'strike_price',
      order: 'asc'
    })

    const contracts: OptionContract[] = []
    const maxPages = Math.ceil(maxResults / limit) + 1

    for await (const page of this.client.paginate(url, massiveContractsResponseSchema, {
      label: `contracts ${query.underlying}${query.expirationDate ? ` ${query.expirationDate}` : ''}`,
      maxPages,
      ...(options.signal ? { signal: options.signal } : {}),
      ...(options.priority !== undefined ? { priority: options.priority } : {})
    })) {
      for (const raw of page.results ?? []) {
        const normalized = normalizeContract(raw)
        if (normalized) contracts.push(normalized)
      }
      if (contracts.length >= maxResults) break
    }

    log.info('contracts fetched', {
      underlying: query.underlying,
      expiration: query.expirationDate,
      count: contracts.length
    })

    return contracts.slice(0, maxResults)
  }

  async getOptionBars(query: BarQuery, options: FetchOptions = {}): Promise<BarFetchResult<OptionBar>> {
    const { bars, reportedCount } = await this.fetchAggregates(query, options)
    return {
      ticker: query.ticker,
      bars: bars.map((b) => toOptionBar(query.ticker, b)),
      requestedFrom: query.from,
      requestedTo: query.to,
      empty: bars.length === 0,
      fetchedAt: Date.now(),
      ...(reportedCount !== undefined ? { reportedCount } : {})
    }
  }

  async getUnderlyingBars(query: BarQuery, options: FetchOptions = {}): Promise<BarFetchResult<UnderlyingBar>> {
    const { bars, reportedCount } = await this.fetchAggregates(query, options)
    return {
      ticker: query.ticker,
      bars: bars.map((b) => toUnderlyingBar(query.ticker, b)),
      requestedFrom: query.from,
      requestedTo: query.to,
      empty: bars.length === 0,
      fetchedAt: Date.now(),
      ...(reportedCount !== undefined ? { reportedCount } : {})
    }
  }

  /**
   * Shared aggregates fetch. Options and indices use the identical
   * /v2/aggs/ticker/... route, differing only in ticker prefix (O: vs I:).
   */
  private async fetchAggregates(
    query: BarQuery,
    options: FetchOptions
  ): Promise<{ bars: MassiveAggregate[]; reportedCount: number | undefined }> {
    const multiplier = query.multiplier ?? 1
    const timespan = query.timespan ?? 'minute'
    const limit = Math.min(query.limit ?? MAX_AGGREGATES_LIMIT, MAX_AGGREGATES_LIMIT)

    const path = `/v2/aggs/ticker/${encodeURIComponent(query.ticker)}/range/${multiplier}/${timespan}/${query.from}/${query.to}`
    const url = this.client.buildUrl(path, {
      adjusted: true,
      sort: 'asc',
      limit
    })

    const bars: MassiveAggregate[] = []
    let reportedCount: number | undefined

    // Aggregates are documented without pagination, but Polygon-lineage APIs do
    // emit next_url once `limit` is saturated. Following it when present is
    // harmless and prevents silent truncation; the maxPages cap bounds it.
    for await (const page of this.client.paginate(url, massiveAggregatesResponseSchema, {
      label: `bars ${query.ticker} ${query.from}`,
      maxPages: 10,
      ...(options.signal ? { signal: options.signal } : {}),
      ...(options.priority !== undefined ? { priority: options.priority } : {})
    })) {
      if (reportedCount === undefined) reportedCount = page.resultsCount
      // `results` is omitted rather than empty when nothing traded.
      if (page.results) bars.push(...page.results)
    }

    if (bars.length === 0) {
      log.info('no bars returned', {
        ticker: query.ticker,
        from: query.from,
        to: query.to,
        note: 'absent bars mean no qualifying trades, not a zero price'
      })
    }

    return { bars, reportedCount }
  }
}

const EXERCISE_STYLES: readonly string[] = ['american', 'european', 'bermudan']

/** Massive contract -> internal model. Unknown contract types are dropped, not guessed. */
export function normalizeContract(raw: MassiveContract): OptionContract | null {
  if (raw.contract_type !== 'call' && raw.contract_type !== 'put') {
    log.debug('skipping non-standard contract type', { ticker: raw.ticker, type: raw.contract_type })
    return null
  }

  const style = raw.exercise_style?.toLowerCase()
  // Decode the root so downstream code can reason about AM vs PM settlement
  // without re-parsing vendor symbols.
  const parsed = parseOptionTicker(raw.ticker)
  const settlement = parsed ? spxSettlementForRoot(parsed.root) : null

  return {
    ticker: raw.ticker,
    underlying: raw.underlying_ticker,
    expirationDate: raw.expiration_date,
    strike: raw.strike_price,
    type: raw.contract_type,
    ...(style && EXERCISE_STYLES.includes(style) ? { exerciseStyle: style as ExerciseStyle } : {}),
    ...(raw.shares_per_contract !== undefined ? { sharesPerContract: raw.shares_per_contract } : {}),
    ...(raw.primary_exchange !== undefined ? { primaryExchange: raw.primary_exchange } : {}),
    ...(parsed ? { root: parsed.root } : {}),
    ...(settlement ? { settlement } : {})
  }
}

export function toOptionBar(ticker: string, raw: MassiveAggregate): OptionBar {
  return {
    ticker,
    timestamp: raw.t,
    open: raw.o,
    high: raw.h,
    low: raw.l,
    close: raw.c,
    volume: raw.v ?? 0,
    ...(raw.vw !== undefined ? { vwap: raw.vw } : {}),
    ...(raw.n !== undefined ? { transactions: raw.n } : {})
  }
}

export function toUnderlyingBar(ticker: string, raw: MassiveAggregate): UnderlyingBar {
  return {
    ticker,
    timestamp: raw.t,
    open: raw.o,
    high: raw.h,
    low: raw.l,
    close: raw.c,
    // Index feeds report no volume; leaving it undefined is meaningfully
    // different from reporting zero.
    ...(raw.v !== undefined ? { volume: raw.v } : {}),
    ...(raw.vw !== undefined ? { vwap: raw.vw } : {}),
    ...(raw.n !== undefined ? { transactions: raw.n } : {})
  }
}
