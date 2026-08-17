import { describe, expect, it, vi } from 'vitest'
import {
  REFRESH_TOKEN_TTL_SECONDS,
  SchwabAuthError,
  buildAuthorizeUrl,
  exchangeAuthorizationCode,
  extractAuthorizationCode,
  isAccessTokenExpired,
  isRefreshTokenExpired,
  refreshAccessToken,
  type SchwabCredentials,
  type SchwabTokens
} from './auth.js'
import { MAX_MINUTE_SPAN_DAYS, SchwabProvider, chunkDateRange, schwabSymbol } from './schwabProvider.js'
import { RequestQueue } from '../requestQueue.js'

const CREDS: SchwabCredentials = {
  clientId: 'test-client',
  clientSecret: 'test-secret',
  redirectUri: 'https://127.0.0.1:5173/callback'
}

function tokens(overrides: Partial<SchwabTokens> = {}): SchwabTokens {
  return {
    accessToken: 'access-1',
    refreshToken: 'refresh-1',
    accessTokenExpiresAt: Date.now() + 1_800_000,
    refreshTokenExpiresAt: Date.now() + REFRESH_TOKEN_TTL_SECONDS * 1000,
    ...overrides
  }
}

describe('authorize URL', () => {
  it('builds the documented authorize request', () => {
    const url = new URL(buildAuthorizeUrl(CREDS, 'nonce-123'))
    expect(url.origin + url.pathname).toBe('https://api.schwabapi.com/v1/oauth/authorize')
    expect(url.searchParams.get('response_type')).toBe('code')
    expect(url.searchParams.get('client_id')).toBe('test-client')
    expect(url.searchParams.get('redirect_uri')).toBe('https://127.0.0.1:5173/callback')
    expect(url.searchParams.get('state')).toBe('nonce-123')
  })

  it('refuses to build without credentials', () => {
    expect(() => buildAuthorizeUrl({ clientId: '', redirectUri: 'x' })).toThrow(/client ID/)
    expect(() => buildAuthorizeUrl({ clientId: 'x', redirectUri: '' })).toThrow(/redirect URI/)
  })
})

describe('authorization code extraction', () => {
  it('pulls the code out of a pasted redirect URL', () => {
    const result = extractAuthorizationCode(
      'https://127.0.0.1:5173/callback?code=ABC123%40&session=xyz&state=nonce'
    )
    // URLSearchParams decodes the trailing @ marker Schwab appends.
    expect(result.code).toBe('ABC123@')
    expect(result.state).toBe('nonce')
  })

  it('tolerates surrounding whitespace from a copy/paste', () => {
    expect(extractAuthorizationCode('  https://127.0.0.1:5173/callback?code=XYZ  ').code).toBe('XYZ')
  })

  it('surfaces an OAuth error returned in the redirect', () => {
    expect(() =>
      extractAuthorizationCode('https://127.0.0.1:5173/callback?error=access_denied&error_description=User%20declined')
    ).toThrow(/access_denied - User declined/)
  })

  it('explains what went wrong for unusable input', () => {
    expect(() => extractAuthorizationCode('')).toThrow(/Paste the full URL/)
    expect(() => extractAuthorizationCode('not a url')).toThrow(/does not look like a URL/)
    expect(() => extractAuthorizationCode('https://127.0.0.1:5173/callback')).toThrow(/no "code" parameter/)
  })
})

describe('token exchange', () => {
  it('posts the documented body with Basic auth', async () => {
    let captured: { url: string; headers: Headers; body: string } | null = null
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      captured = { url: String(url), headers: new Headers(init?.headers), body: String(init?.body) }
      return new Response(
        JSON.stringify({ access_token: 'a1', refresh_token: 'r1', expires_in: 1800, token_type: 'Bearer' }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      )
    }) as unknown as typeof fetch

    const result = await exchangeAuthorizationCode(CREDS, 'the-code', fetchImpl)

    expect(captured!.url).toBe('https://api.schwabapi.com/v1/oauth/token')
    expect(captured!.headers.get('Authorization')).toBe(
      `Basic ${Buffer.from('test-client:test-secret').toString('base64')}`
    )
    expect(captured!.headers.get('Content-Type')).toBe('application/x-www-form-urlencoded')
    const body = new URLSearchParams(captured!.body)
    expect(body.get('grant_type')).toBe('authorization_code')
    expect(body.get('code')).toBe('the-code')
    expect(body.get('redirect_uri')).toBe('https://127.0.0.1:5173/callback')

    expect(result.accessToken).toBe('a1')
    expect(result.refreshToken).toBe('r1')
    expect(result.accessTokenExpiresAt).toBeGreaterThan(Date.now())
  })

  it('flags a failed exchange as needing re-authorization', async () => {
    const fetchImpl = vi.fn(async () =>
      new Response('{"error":"invalid_grant"}', { status: 400 })
    ) as unknown as typeof fetch

    await expect(exchangeAuthorizationCode(CREDS, 'bad', fetchImpl)).rejects.toMatchObject({
      name: 'SchwabAuthError',
      requiresReauthorization: true
    })
  })

  it('preserves the original 7-day deadline across a refresh', async () => {
    // Schwab does not rotate refresh tokens, and refreshing does not extend the
    // 7-day window; pretending otherwise would hide an imminent re-auth.
    const original = tokens({ refreshTokenExpiresAt: Date.now() + 2 * 86_400_000 })
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ access_token: 'a2', refresh_token: 'refresh-1', expires_in: 1800 }), {
        status: 200
      })
    ) as unknown as typeof fetch

    const refreshed = await refreshAccessToken(CREDS, original, fetchImpl)
    expect(refreshed.accessToken).toBe('a2')
    expect(refreshed.refreshTokenExpiresAt).toBe(original.refreshTokenExpiresAt)
  })
})

describe('token expiry', () => {
  it('refreshes slightly before the access token actually expires', () => {
    const now = Date.now()
    expect(isAccessTokenExpired(tokens({ accessTokenExpiresAt: now + 300_000 }), now)).toBe(false)
    // Inside the 120s safety skew.
    expect(isAccessTokenExpired(tokens({ accessTokenExpiresAt: now + 60_000 }), now)).toBe(true)
  })

  it('detects an expired refresh token', () => {
    const now = Date.now()
    expect(isRefreshTokenExpired(tokens({ refreshTokenExpiresAt: now + 1000 }), now)).toBe(false)
    expect(isRefreshTokenExpired(tokens({ refreshTokenExpiresAt: now - 1000 }), now)).toBe(true)
  })
})

describe('symbol mapping', () => {
  it('maps SPX option roots and index tickers onto Schwab index symbols', () => {
    expect(schwabSymbol('SPX')).toBe('$SPX')
    expect(schwabSymbol('SPXW')).toBe('$SPX')
    expect(schwabSymbol('I:SPX')).toBe('$SPX') // the app's internal index form
    expect(schwabSymbol('$SPX')).toBe('$SPX')
    expect(schwabSymbol('VIX')).toBe('$VIX')
    expect(schwabSymbol('AAPL')).toBe('AAPL') // equities pass through
  })
})

describe('date range chunking', () => {
  it('splits long ranges into windows Schwab will accept', () => {
    const chunks = chunkDateRange('2025-01-01', '2025-01-25', MAX_MINUTE_SPAN_DAYS)
    expect(chunks).toEqual([
      { from: '2025-01-01', to: '2025-01-10' },
      { from: '2025-01-11', to: '2025-01-20' },
      { from: '2025-01-21', to: '2025-01-25' }
    ])
  })

  it('leaves a short range as a single request', () => {
    expect(chunkDateRange('2025-01-01', '2025-01-05', MAX_MINUTE_SPAN_DAYS)).toEqual([
      { from: '2025-01-01', to: '2025-01-05' }
    ])
  })

  it('handles a single day', () => {
    expect(chunkDateRange('2025-01-01', '2025-01-01', MAX_MINUTE_SPAN_DAYS)).toEqual([
      { from: '2025-01-01', to: '2025-01-01' }
    ])
  })
})

describe('SchwabProvider', () => {
  function makeProvider(
    handler: (url: string) => { status?: number; body: unknown },
    tokenState: { current: SchwabTokens | null }
  ) {
    const calls: string[] = []
    const fetchImpl = vi.fn(async (url: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const asString = String(url)
      calls.push(asString)
      if (asString.includes('/oauth/token')) {
        return new Response(
          JSON.stringify({ access_token: 'refreshed-access', refresh_token: 'refresh-1', expires_in: 1800 }),
          { status: 200 }
        )
      }
      const auth = new Headers(init?.headers).get('Authorization')
      if (!auth?.startsWith('Bearer ')) throw new Error('missing bearer token')
      const { status = 200, body } = handler(asString)
      return new Response(JSON.stringify(body), { status })
    }) as unknown as typeof fetch

    const provider = new SchwabProvider({
      getCredentials: () => CREDS,
      queue: new RequestQueue({ requestsPerMinute: 0, maxRetries: 0 }),
      getTokens: () => tokenState.current,
      saveTokens: (t) => { tokenState.current = t },
      fetchImpl
    })
    return { provider, calls, tokenState }
  }

  it('requests minute candles with the parameters Schwab requires', async () => {
    const state = { current: tokens() }
    const { provider, calls } = makeProvider(
      () => ({ body: { symbol: '$SPX', candles: [
        { datetime: 1750167000000, open: 6001, high: 6003, low: 6000, close: 6002, volume: 0 }
      ] } }),
      state
    )

    const result = await provider.getUnderlyingBars({
      ticker: 'I:SPX', from: '2025-06-17', to: '2025-06-17', timespan: 'minute'
    })

    const url = new URL(calls[0]!)
    expect(url.origin + url.pathname).toBe('https://api.schwabapi.com/marketdata/v1/pricehistory')
    expect(url.searchParams.get('symbol')).toBe('$SPX')
    // periodType 'day' is the only one valid with minute frequency.
    expect(url.searchParams.get('periodType')).toBe('day')
    expect(url.searchParams.get('frequencyType')).toBe('minute')
    expect(url.searchParams.get('frequency')).toBe('1')
    expect(url.searchParams.get('needExtendedHoursData')).toBe('false')

    // Stored under the caller's ticker, not Schwab's symbol.
    expect(result.bars[0]?.ticker).toBe('I:SPX')
    expect(result.bars[0]?.close).toBe(6002)
    // Zero index volume is dropped rather than recorded as a real zero.
    expect(result.bars[0]?.volume).toBeUndefined()
  })

  it('chunks a long minute range into several requests', async () => {
    const state = { current: tokens() }
    const { provider, calls } = makeProvider(() => ({ body: { candles: [] } }), state)

    await provider.getUnderlyingBars({
      ticker: 'I:SPX', from: '2025-06-01', to: '2025-06-25', timespan: 'minute'
    })
    expect(calls).toHaveLength(3)
  })

  it('uses a single request for daily bars', async () => {
    const state = { current: tokens() }
    const { provider, calls } = makeProvider(() => ({ body: { candles: [] } }), state)

    await provider.getUnderlyingBars({
      ticker: 'I:SPX', from: '2024-01-01', to: '2025-12-31', timespan: 'day'
    })
    expect(calls).toHaveLength(1)
    expect(new URL(calls[0]!).searchParams.get('frequencyType')).toBe('daily')
  })

  it('refreshes an expired access token before requesting', async () => {
    const state = { current: tokens({ accessTokenExpiresAt: Date.now() - 1000 }) }
    const { provider, calls } = makeProvider(() => ({ body: { candles: [] } }), state)

    await provider.getUnderlyingBars({ ticker: 'I:SPX', from: '2025-06-17', to: '2025-06-17' })

    expect(calls[0]).toContain('/oauth/token')
    expect(state.current?.accessToken).toBe('refreshed-access')
  })

  it('demands re-authorization once the refresh token has expired', async () => {
    const state = { current: tokens({ refreshTokenExpiresAt: Date.now() - 1000 }) }
    const { provider } = makeProvider(() => ({ body: { candles: [] } }), state)

    await expect(
      provider.getUnderlyingBars({ ticker: 'I:SPX', from: '2025-06-17', to: '2025-06-17' })
    ).rejects.toThrow(/expired.*7 days|Reconnect/)
  })

  it('reports a clear message when not connected at all', async () => {
    const state: { current: SchwabTokens | null } = { current: null }
    const { provider } = makeProvider(() => ({ body: { candles: [] } }), state)

    await expect(
      provider.getUnderlyingBars({ ticker: 'I:SPX', from: '2025-06-17', to: '2025-06-17' })
    ).rejects.toBeInstanceOf(SchwabAuthError)
  })

  it('treats an absent candles array as empty, not as an error', async () => {
    const state = { current: tokens() }
    const { provider } = makeProvider(() => ({ body: { symbol: '$SPX', empty: true } }), state)

    const result = await provider.getUnderlyingBars({ ticker: 'I:SPX', from: '2025-06-17', to: '2025-06-17' })
    expect(result.empty).toBe(true)
    expect(result.bars).toEqual([])
  })
})
