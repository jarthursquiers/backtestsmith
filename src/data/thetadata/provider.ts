import { DateTime } from 'luxon'
import type { BarQuery, OptionBar, UnderlyingBar } from '../../domain/bars.js'
import type { ContractQuery, OptionContract } from '../../domain/contracts.js'
import { MARKET_ZONE, tradingDaysBetween } from '../../core/time/marketTime.js'
import { parseOptionTicker } from '../massive/tickers.js'
import { formatOptionTicker, spxSettlementForRoot } from '../massive/tickers.js'
import type { BarFetchResult, FetchOptions, OptionsHistoricalDataProvider, ProviderSources, ProviderStatus } from '../provider.js'
import { createLogger } from '../../services/logger.js'
import { ThetaDataClient } from './client.js'

const log = createLogger('thetadata.provider')

interface ThetaQuote {
  timestamp: string
  bid: number
  ask: number
  bid_size?: number
  ask_size?: number
}

/** Uses ThetaData for every option capability and Massive only for the cash index. */
export class ThetaHybridProvider implements OptionsHistoricalDataProvider, ProviderSources {
  readonly id = 'theta-massive'
  readonly name = 'ThetaData options + Massive index'

  constructor(
    private readonly theta: ThetaDataClient,
    private readonly massive: OptionsHistoricalDataProvider
  ) {}

  sourceId(capability: 'contracts' | 'option' | 'underlying'): string {
    return capability === 'underlying' ? this.massive.id : capability === 'option' ? 'thetadata-nbbo' : 'thetadata'
  }

  async testConnection(options: FetchOptions = {}): Promise<ProviderStatus> {
    const startedAt = Date.now()
    try {
      const result = await this.theta.request<{ expirations: number }>('test', {}, options.signal)
      return {
        ok: true,
        providerId: 'thetadata',
        message: `Connected; ${result.expirations} SPX expirations available`,
        latencyMs: Date.now() - startedAt,
        checkedAt: Date.now()
      }
    } catch (error) {
      return {
        ok: false,
        providerId: 'thetadata',
        message: error instanceof Error ? error.message : String(error),
        checkedAt: Date.now()
      }
    }
  }

  async getContracts(query: ContractQuery, options: FetchOptions = {}): Promise<OptionContract[]> {
    if (!query.expirationDate) {
      throw new Error('ThetaData contract discovery requires an exact expiration date.')
    }
    const rows = await this.theta.request<{ symbol: string; expiration: string; strike: number }[]>('contracts', {
      underlying: query.underlying,
      expiration: query.expirationDate
    }, options.signal)
    const types = query.type ? [query.type] : ['call', 'put'] as const
    const contracts: OptionContract[] = []
    for (const row of rows) {
      for (const type of types) {
        const root = row.symbol.toUpperCase()
        contracts.push({
          ticker: formatOptionTicker({ root, expirationDate: row.expiration, type, strike: Number(row.strike) }),
          underlying: query.underlying.toUpperCase(),
          expirationDate: row.expiration,
          strike: Number(row.strike),
          type,
          exerciseStyle: query.underlying.toUpperCase() === 'SPX' ? 'european' : undefined,
          sharesPerContract: 100,
          root,
          ...(spxSettlementForRoot(root) ? { settlement: spxSettlementForRoot(root)! } : {})
        })
      }
    }
    return contracts
  }

  getUnderlyingBars(query: BarQuery, options?: FetchOptions): Promise<BarFetchResult<UnderlyingBar>> {
    return this.massive.getUnderlyingBars(query, options)
  }

  async getOptionBars(query: BarQuery, options: FetchOptions = {}): Promise<BarFetchResult<OptionBar>> {
    if ((query.timespan ?? 'minute') !== 'minute' || (query.multiplier ?? 1) !== 1) {
      throw new Error('ThetaData Options Value supports this application at one-minute resolution only.')
    }
    const contract = parseOptionTicker(query.ticker)
    if (!contract) throw new Error(`Cannot translate option ticker ${query.ticker} for ThetaData`)

    const dates = tradingDaysBetween(query.from, query.to)
    const raw: ThetaQuote[] = []
    // ThetaData documents month-sized requests, but its direct gRPC client can
    // leave a large response stream open indefinitely. Day-sized requests are
    // bounded, independently retryable, and the Value tier permits two active
    // requests. Process the days in pairs to honor that entitlement exactly.
    for (let offset = 0; offset < dates.length; offset += 2) {
      const batch = dates.slice(offset, offset + 2)
      const results = await Promise.all(batch.map((date) =>
        this.theta.request<ThetaQuote[]>('quotes', {
          symbol: contract.root,
          expiration: contract.expirationDate,
          strike: contract.strike,
          right: contract.type,
          from: date,
          to: date
        }, options.signal).catch((error) => {
          throw new Error(
            `ThetaData quote download failed for ${query.ticker} on ${date}: ` +
            (error instanceof Error ? error.message : String(error))
          )
        })
      ))
      for (const rows of results) raw.push(...rows)
      log.info('NBBO quote days fetched', {
        ticker: query.ticker,
        completedDays: Math.min(offset + batch.length, dates.length),
        totalDays: dates.length,
        quotes: raw.length
      })
    }

    const bars = raw.flatMap((quote): OptionBar[] => {
      const bid = Number(quote.bid)
      const ask = Number(quote.ask)
      const dt = DateTime.fromISO(String(quote.timestamp), { zone: MARKET_ZONE })
      if (!dt.isValid || !Number.isFinite(bid) || !Number.isFinite(ask) || bid < 0 || ask < bid) return []
      const midpoint = (bid + ask) / 2
      return [{
        ticker: query.ticker,
        timestamp: dt.toMillis(),
        open: midpoint,
        high: midpoint,
        low: midpoint,
        close: midpoint,
        volume: 0,
        bid,
        ask,
        ...(quote.bid_size !== undefined ? { bidSize: Number(quote.bid_size) } : {}),
        ...(quote.ask_size !== undefined ? { askSize: Number(quote.ask_size) } : {})
      }]
    })

    log.info('NBBO quotes fetched', { ticker: query.ticker, from: query.from, to: query.to, quotes: bars.length })
    return {
      ticker: query.ticker,
      bars,
      requestedFrom: query.from,
      requestedTo: query.to,
      empty: bars.length === 0,
      fetchedAt: Date.now(),
      reportedCount: raw.length
    }
  }
}
