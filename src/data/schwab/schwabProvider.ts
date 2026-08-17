import { z } from 'zod'
import type { BarQuery, UnderlyingBar } from '../../domain/bars.js'
import type { BarFetchResult, FetchOptions, ProviderStatus, UnderlyingHistoricalDataProvider } from '../provider.js'
import { HttpError, RequestQueue } from '../requestQueue.js'
import { addCalendarDays, easternToTimestamp, sessionClose, type MarketDate } from '../../core/time/marketTime.js'
import { createLogger } from '../../services/logger.js'
import {
  SchwabAuthError,
  isAccessTokenExpired,
  isRefreshTokenExpired,
  refreshAccessToken,
  type SchwabCredentials,
  type SchwabTokens
} from './auth.js'

const log = createLogger('schwab.provider')

export const SCHWAB_PRICE_HISTORY_URL = 'https://api.schwabapi.com/marketdata/v1/pricehistory'

/**
 * Schwab market-data provider for underlying/index history.
 *
 * Supplies SPX because Massive's Options plans do not include index data. It
 * implements only `UnderlyingHistoricalDataProvider`: Schwab is not used for
 * option history here, so it deliberately cannot be mistaken for an options
 * source.
 *
 * Endpoint and parameter semantics verified from the working Optionsmith
 * implementation in ../kingarthurtrader.
 */

/** Schwab index symbols carry a `$` prefix: SPX/SPXW/SPXQ/SPXPM all map to $SPX. */
export function schwabSymbol(ticker: string): string {
  const bare = ticker.trim().toUpperCase().replace(/^I:/, '')
  if (bare.startsWith('$')) return bare
  if (['SPX', 'SPXW', 'SPXQ', 'SPXPM'].includes(bare)) return '$SPX'
  if (['NDX', 'NDXP'].includes(bare)) return '$NDX'
  if (['VIX', 'VIXW'].includes(bare)) return '$VIX'
  if (['RUT', 'RUTW'].includes(bare)) return '$RUT'
  return bare
}

const candleSchema = z.looseObject({
  datetime: z.number(),
  open: z.number(),
  high: z.number(),
  low: z.number(),
  close: z.number(),
  volume: z.number().optional()
})

const priceHistorySchema = z.looseObject({
  candles: z.array(candleSchema).optional(),
  symbol: z.string().optional(),
  empty: z.boolean().optional()
})

/**
 * Maximum span of a single minute-frequency request.
 *
 * Schwab pairs `periodType=day` with `frequencyType=minute`, and `day` supports
 * at most 10 days. Longer ranges are therefore chunked rather than issued as one
 * oversized request that would be silently truncated.
 */
export const MAX_MINUTE_SPAN_DAYS = 10

/** Splits an inclusive date range into windows no longer than `maxDays`. */
export function chunkDateRange(
  from: MarketDate,
  to: MarketDate,
  maxDays: number
): { from: MarketDate; to: MarketDate }[] {
  const chunks: { from: MarketDate; to: MarketDate }[] = []
  let cursor = from
  // Guard against a pathological loop on inverted input.
  let guard = 0
  while (cursor <= to && guard++ < 10_000) {
    const end = addCalendarDays(cursor, maxDays - 1)
    const chunkEnd = end > to ? to : end
    chunks.push({ from: cursor, to: chunkEnd })
    if (chunkEnd >= to) break
    cursor = addCalendarDays(chunkEnd, 1)
  }
  return chunks
}

export interface SchwabProviderOptions {
  /**
   * Read lazily rather than captured once: credentials can be entered or
   * changed after the provider is constructed, and a snapshot would silently
   * keep using the old app registration.
   */
  getCredentials: () => SchwabCredentials
  queue: RequestQueue
  /** Reads the currently stored tokens, or null when not connected. */
  getTokens: () => SchwabTokens | null
  /** Persists tokens after a refresh. */
  saveTokens: (tokens: SchwabTokens) => void
  fetchImpl?: typeof fetch
  timeoutMs?: number
}

export class SchwabProvider implements UnderlyingHistoricalDataProvider {
  readonly id = 'schwab'
  readonly name = 'Schwab'

  private readonly fetchImpl: typeof fetch
  private readonly timeoutMs: number
  private refreshInFlight: Promise<SchwabTokens> | null = null

  constructor(private readonly options: SchwabProviderOptions) {
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch
    this.timeoutMs = options.timeoutMs ?? 30_000
  }

  isConnected(): boolean {
    const tokens = this.options.getTokens()
    return tokens !== null && !isRefreshTokenExpired(tokens)
  }

  /**
   * Returns a usable access token, refreshing if needed.
   *
   * Concurrent callers share one in-flight refresh. Schwab does not rotate
   * refresh tokens, so this is not about losing a rotation race; it is to avoid
   * minting several access tokens at once when a backfill starts and many
   * chunked requests wake up together.
   */
  private async accessToken(): Promise<string> {
    const tokens = this.options.getTokens()
    if (!tokens) {
      throw new SchwabAuthError('Schwab is not connected. Authorize it on the SPX Underlying screen.', {
        requiresReauthorization: true
      })
    }

    if (isRefreshTokenExpired(tokens)) {
      throw new SchwabAuthError(
        'The Schwab authorization has expired (Schwab refresh tokens last 7 days). Reconnect to continue.',
        { requiresReauthorization: true }
      )
    }

    if (!isAccessTokenExpired(tokens)) return tokens.accessToken

    if (!this.refreshInFlight) {
      this.refreshInFlight = refreshAccessToken(this.options.getCredentials(), tokens, this.fetchImpl)
        .then((next) => {
          this.options.saveTokens(next)
          log.info('access token refreshed')
          return next
        })
        .finally(() => {
          this.refreshInFlight = null
        })
    }

    return (await this.refreshInFlight).accessToken
  }

  async testConnection(options: FetchOptions = {}): Promise<ProviderStatus> {
    const startedAt = Date.now()
    try {
      // One cheap daily request is enough to prove credentials and entitlement.
      const result = await this.getUnderlyingBars(
        { ticker: '$SPX', from: recentDate(10), to: recentDate(0), timespan: 'day' },
        options
      )
      const latencyMs = Date.now() - startedAt
      return {
        ok: true,
        providerId: this.id,
        message: `Connected (${result.bars.length} daily bars)`,
        latencyMs,
        checkedAt: Date.now()
      }
    } catch (error) {
      return {
        ok: false,
        providerId: this.id,
        message: error instanceof Error ? error.message : String(error),
        checkedAt: Date.now()
      }
    }
  }

  async getUnderlyingBars(query: BarQuery, options: FetchOptions = {}): Promise<BarFetchResult<UnderlyingBar>> {
    const timespan = query.timespan ?? 'minute'
    const symbol = schwabSymbol(query.ticker)
    const bars: UnderlyingBar[] = []

    const chunks =
      timespan === 'minute'
        ? chunkDateRange(query.from, query.to, MAX_MINUTE_SPAN_DAYS)
        : [{ from: query.from, to: query.to }]

    for (const chunk of chunks) {
      const candles = await this.fetchChunk(symbol, chunk.from, chunk.to, timespan, query.multiplier ?? 1, options)
      for (const candle of candles) {
        bars.push({
          // Store under the caller's ticker, not Schwab's, so the cache is keyed
          // consistently regardless of which provider supplied the data.
          ticker: query.ticker,
          timestamp: candle.datetime,
          open: candle.open,
          high: candle.high,
          low: candle.low,
          close: candle.close,
          // Index feeds report 0 volume; absent is more truthful than a fake zero.
          ...(candle.volume !== undefined && candle.volume > 0 ? { volume: candle.volume } : {})
        })
      }
    }

    bars.sort((a, b) => a.timestamp - b.timestamp)

    log.info('schwab bars fetched', {
      ticker: query.ticker,
      symbol,
      timespan,
      chunks: chunks.length,
      bars: bars.length,
      from: query.from,
      to: query.to
    })

    return {
      ticker: query.ticker,
      bars,
      requestedFrom: query.from,
      requestedTo: query.to,
      empty: bars.length === 0,
      fetchedAt: Date.now(),
      reportedCount: bars.length
    }
  }

  private async fetchChunk(
    symbol: string,
    from: MarketDate,
    to: MarketDate,
    timespan: string,
    multiplier: number,
    options: FetchOptions
  ): Promise<z.infer<typeof candleSchema>[]> {
    const params = new URLSearchParams({ symbol })

    if (timespan === 'minute') {
      // periodType 'day' is the only one Schwab pairs with minute frequency.
      params.set('periodType', 'day')
      params.set('frequencyType', 'minute')
      params.set('frequency', String(multiplier))
    } else {
      params.set('periodType', 'year')
      params.set('frequencyType', timespan === 'day' ? 'daily' : timespan)
      params.set('frequency', '1')
    }

    // Bound the window to the actual session edges in Eastern time.
    params.set('startDate', String(easternToTimestamp(from, 0, 0)))
    params.set('endDate', String(sessionClose(to)))
    params.set('needExtendedHoursData', 'false')

    const url = `${SCHWAB_PRICE_HISTORY_URL}?${params.toString()}`

    return this.options.queue.enqueue(
      async (queueSignal) => {
        const token = await this.accessToken()
        const timeoutSignal = AbortSignal.timeout(this.timeoutMs)
        const signal = AbortSignal.any([queueSignal, timeoutSignal])

        const response = await this.fetchImpl(url, {
          method: 'GET',
          headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
          signal
        })

        const text = await response.text()

        if (!response.ok) {
          const snippet = text.replace(/\s+/g, ' ').slice(0, 240)
          if (response.status === 401) {
            throw new SchwabAuthError(`Schwab rejected the access token: ${snippet}`, {
              status: 401,
              requiresReauthorization: false
            })
          }
          throw new HttpError(response.status, `Schwab price history failed (HTTP ${response.status}): ${snippet}`)
        }

        let json: unknown
        try {
          json = JSON.parse(text)
        } catch {
          throw new Error('Schwab returned a price history response that was not valid JSON')
        }

        const parsed = priceHistorySchema.safeParse(json)
        if (!parsed.success) {
          log.error('price history schema mismatch', { issues: parsed.error.issues.slice(0, 5) })
          throw new Error('Schwab price history response did not match the expected shape')
        }

        return parsed.data.candles ?? []
      },
      {
        label: `schwab ${symbol} ${from}..${to}`,
        ...(options.signal ? { signal: options.signal } : {}),
        ...(options.priority !== undefined ? { priority: options.priority } : {})
      }
    )
  }
}

function recentDate(daysAgo: number): MarketDate {
  const d = new Date(Date.now() - daysAgo * 86_400_000)
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`
}
