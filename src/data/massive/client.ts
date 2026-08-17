import type { z } from 'zod'
import { HttpError, RequestQueue } from '../requestQueue.js'
import { createLogger } from '../../services/logger.js'
import { describeMassiveError } from './schemas.js'

/**
 * Low-level Massive REST transport.
 *
 * Verified from official documentation:
 *   base URL : https://api.massive.com
 *   auth     : Authorization: Bearer <key>   (massive-com/client-python)
 *   paging   : `next_url` absolute URL on the response body
 *
 * Everything here is Massive-specific. Higher layers talk to the
 * OptionsHistoricalDataProvider interface instead, so no other part of the app
 * imports this file.
 */

export const MASSIVE_BASE_URL = 'https://api.massive.com'

const log = createLogger('massive.client')

export interface MassiveClientOptions {
  apiKey: string
  baseUrl?: string
  queue: RequestQueue
  /** Per-request network timeout. */
  timeoutMs?: number
  /** Injectable for tests. */
  fetchImpl?: typeof fetch
}

export interface RequestOptions {
  label?: string
  priority?: number
  signal?: AbortSignal
}

/** Raised when a response does not match the documented schema. */
export class MassiveSchemaError extends Error {
  readonly url: string
  readonly issues: unknown

  constructor(url: string, issues: unknown) {
    super(`Massive response did not match the expected schema for ${url}`)
    this.name = 'MassiveSchemaError'
    this.url = url
    this.issues = issues
  }
}

/** Parses Retry-After, which may be seconds or an HTTP date. */
function parseRetryAfter(header: string | null): number | null {
  if (!header) return null
  const seconds = Number(header)
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000)
  const date = Date.parse(header)
  if (Number.isFinite(date)) return Math.max(0, date - Date.now())
  return null
}

/** Strips the API key from anything that might reach a log or the UI. */
export function redact(value: string): string {
  return value.replace(/(apiKey=)[^&]+/gi, '$1***').replace(/Bearer\s+\S+/gi, 'Bearer ***')
}

export class MassiveClient {
  private readonly baseUrl: string
  private readonly timeoutMs: number
  private readonly fetchImpl: typeof fetch
  private apiKey: string
  readonly queue: RequestQueue

  constructor(options: MassiveClientOptions) {
    this.apiKey = options.apiKey
    this.baseUrl = (options.baseUrl ?? MASSIVE_BASE_URL).replace(/\/+$/, '')
    this.queue = options.queue
    this.timeoutMs = options.timeoutMs ?? 30_000
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch
  }

  setApiKey(apiKey: string): void {
    this.apiKey = apiKey
  }

  hasApiKey(): boolean {
    return this.apiKey.trim().length > 0
  }

  /** Builds an absolute URL from a path plus query parameters. */
  buildUrl(path: string, params: Record<string, string | number | boolean | undefined> = {}): string {
    const url = new URL(path.startsWith('http') ? path : `${this.baseUrl}${path}`)
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== null && value !== '') {
        url.searchParams.set(key, String(value))
      }
    }
    return url.toString()
  }

  /**
   * Performs a rate-limited, retried, schema-validated GET.
   *
   * Retry/backoff/429 handling lives in the queue; this method's job is to turn
   * a non-2xx response into an HttpError carrying enough context for the queue
   * to classify it.
   */
  async get<T>(url: string, schema: z.ZodType<T>, options: RequestOptions = {}): Promise<T> {
    if (!this.hasApiKey()) {
      throw new HttpError(401, 'No Massive API key configured. Add one in Settings.')
    }

    return this.queue.enqueue(async (queueSignal) => {
      const timeoutSignal = AbortSignal.timeout(this.timeoutMs)
      const signal = AbortSignal.any([queueSignal, timeoutSignal])
      const startedAt = Date.now()

      log.debug('GET', { url: redact(url), label: options.label })

      let response: Response
      try {
        response = await this.fetchImpl(url, {
          method: 'GET',
          headers: {
            Authorization: `Bearer ${this.apiKey}`,
            Accept: 'application/json'
          },
          signal
        })
      } catch (error) {
        if (timeoutSignal.aborted) {
          throw new HttpError(408, `Request timed out after ${this.timeoutMs}ms`)
        }
        throw error
      }

      const elapsedMs = Date.now() - startedAt
      const text = await response.text()

      if (!response.ok) {
        let detail: string | null = null
        try {
          detail = describeMassiveError(JSON.parse(text))
        } catch {
          detail = text.slice(0, 300) || null
        }

        const retryAfterMs = parseRetryAfter(response.headers.get('retry-after'))
        // 401 and 403 mean different things and lead to different fixes: a bad
        // credential vs. a valid credential whose plan lacks the data. Conflating
        // them sends the user to re-check a key that was never the problem.
        const message =
          response.status === 401
            ? `Massive rejected the API key (HTTP 401). ${detail ?? 'Check the key in Settings.'}`
            : response.status === 403
              ? `Your Massive plan does not include this data (HTTP 403). ${detail ?? ''}`.trim()
              : `Massive request failed: HTTP ${response.status}${detail ? ` - ${detail}` : ''}`

        log.warn('request failed', {
          url: redact(url),
          status: response.status,
          elapsedMs,
          retryAfterMs,
          detail
        })

        throw new HttpError(response.status, message, {
          retryAfterMs,
          body: text.slice(0, 1000)
        })
      }

      let json: unknown
      try {
        json = JSON.parse(text)
      } catch {
        throw new MassiveSchemaError(url, 'Response body was not valid JSON')
      }

      const parsed = schema.safeParse(json)
      if (!parsed.success) {
        // Surface the discrepancy loudly rather than coercing it away.
        log.error('response schema mismatch', {
          url: redact(url),
          issues: parsed.error.issues.slice(0, 10)
        })
        throw new MassiveSchemaError(url, parsed.error.issues)
      }

      log.debug('GET ok', { url: redact(url), elapsedMs, bytes: text.length })
      return parsed.data
    }, {
      ...(options.label !== undefined ? { label: options.label } : {}),
      ...(options.priority !== undefined ? { priority: options.priority } : {}),
      ...(options.signal !== undefined ? { signal: options.signal } : {})
    })
  }

  /**
   * Follows `next_url` pagination, yielding each page.
   *
   * `maxPages` is a safety valve: at 5 requests/minute an accidental unbounded
   * walk is an hours-long mistake, so runaway pagination must be impossible.
   */
  async *paginate<T extends { next_url?: string | undefined }>(
    firstUrl: string,
    schema: z.ZodType<T>,
    options: RequestOptions & { maxPages?: number } = {}
  ): AsyncGenerator<T, void, undefined> {
    const maxPages = options.maxPages ?? 50
    let url: string | undefined = firstUrl
    let page = 0

    while (url && page < maxPages) {
      const response: T = await this.get(url, schema, {
        ...options,
        label: `${options.label ?? 'paginate'} p${page + 1}`
      })
      yield response
      page++

      const next = response.next_url
      if (!next) return
      url = next
    }

    if (url) {
      log.warn('pagination stopped at max pages', { maxPages, label: options.label })
    }
  }
}
