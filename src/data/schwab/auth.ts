import { z } from 'zod'

/**
 * Schwab OAuth 2.0, authorization-code flow.
 *
 * Endpoints and semantics verified against the working Optionsmith
 * implementation in ../kingarthurtrader rather than guessed:
 *   authorize : https://api.schwabapi.com/v1/oauth/authorize
 *   token     : https://api.schwabapi.com/v1/oauth/token
 *   auth      : HTTP Basic, base64(clientId:clientSecret)
 *
 * Two Schwab-specific behaviors shape this module:
 *
 *  - The access token lives ~30 minutes, so it is refreshed on demand.
 *  - The refresh token has a **hard 7-day expiry and is not rotated** - the same
 *    refresh token comes back from every refresh and simply stops working on day
 *    seven. There is therefore no rotation race to defend against, but the user
 *    must re-authorize weekly. For this application that is mostly harmless:
 *    SPX history is backfilled once into the local cache and then reused.
 */

export const SCHWAB_AUTHORIZE_URL = 'https://api.schwabapi.com/v1/oauth/authorize'
export const SCHWAB_TOKEN_URL = 'https://api.schwabapi.com/v1/oauth/token'

/** Schwab access tokens last 30 minutes; refresh a little early to avoid races. */
export const ACCESS_TOKEN_TTL_SECONDS = 1800
export const ACCESS_TOKEN_SKEW_SECONDS = 120
/** Hard limit imposed by Schwab; not extendable by refreshing. */
export const REFRESH_TOKEN_TTL_SECONDS = 604_800

export interface SchwabCredentials {
  clientId: string
  clientSecret: string
  /** Must exactly match one of the callback URLs registered for the app. */
  redirectUri: string
}

export interface SchwabTokens {
  accessToken: string
  refreshToken: string
  /** Epoch ms when the access token expires. */
  accessTokenExpiresAt: number
  /** Epoch ms when the refresh token expires and re-authorization is required. */
  refreshTokenExpiresAt: number
}

const tokenResponseSchema = z.looseObject({
  access_token: z.string(),
  refresh_token: z.string(),
  token_type: z.string().optional(),
  expires_in: z.number().optional(),
  scope: z.string().optional()
})

export class SchwabAuthError extends Error {
  readonly status: number | null
  /** True when the user must re-run the browser authorization. */
  readonly requiresReauthorization: boolean

  constructor(message: string, opts: { status?: number | null; requiresReauthorization?: boolean } = {}) {
    super(message)
    this.name = 'SchwabAuthError'
    this.status = opts.status ?? null
    this.requiresReauthorization = opts.requiresReauthorization ?? false
  }
}

/** Builds the URL the user opens in a browser to authorize the application. */
export function buildAuthorizeUrl(
  credentials: Pick<SchwabCredentials, 'clientId' | 'redirectUri'>,
  state?: string
): string {
  if (!credentials.clientId) throw new Error('Schwab client ID is not configured')
  if (!credentials.redirectUri) throw new Error('Schwab redirect URI is not configured')

  const url = new URL(SCHWAB_AUTHORIZE_URL)
  url.searchParams.set('response_type', 'code')
  url.searchParams.set('client_id', credentials.clientId)
  url.searchParams.set('redirect_uri', credentials.redirectUri)
  if (state) url.searchParams.set('state', state)
  return url.toString()
}

/**
 * Extracts the authorization code from the URL the browser was redirected to.
 *
 * The registered callbacks are `https://127.0.0.1:...` addresses that nothing is
 * listening on, so the browser shows a connection error while the address bar
 * still holds the code. Pasting that URL back is the simplest reliable desktop
 * flow: no local HTTPS server, no self-signed certificate warnings.
 */
export function extractAuthorizationCode(redirectedUrl: string): { code: string; state: string | null } {
  const trimmed = redirectedUrl.trim()
  if (!trimmed) throw new Error('Paste the full URL you were redirected to after authorizing.')

  let url: URL
  try {
    url = new URL(trimmed)
  } catch {
    throw new Error(`That does not look like a URL: "${trimmed.slice(0, 60)}"`)
  }

  const error = url.searchParams.get('error')
  if (error) {
    const description = url.searchParams.get('error_description')
    throw new Error(`Schwab returned an error: ${error}${description ? ` - ${description}` : ''}`)
  }

  const code = url.searchParams.get('code')
  if (!code) {
    throw new Error('That URL contains no "code" parameter. Copy the full address bar contents after authorizing.')
  }

  return { code, state: url.searchParams.get('state') }
}

function basicAuthHeader(credentials: SchwabCredentials): string {
  return `Basic ${Buffer.from(`${credentials.clientId}:${credentials.clientSecret}`).toString('base64')}`
}

async function requestTokens(
  credentials: SchwabCredentials,
  body: URLSearchParams,
  fetchImpl: typeof fetch
): Promise<SchwabTokens> {
  const response = await fetchImpl(SCHWAB_TOKEN_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Authorization: basicAuthHeader(credentials),
      Accept: 'application/json'
    },
    body: body.toString()
  })

  const text = await response.text()

  if (!response.ok) {
    const lower = text.toLowerCase()
    // Schwab signals an exhausted or invalid refresh token through these
    // patterns; they mean "re-authorize", not "retry".
    const requiresReauthorization =
      lower.includes('refresh_token') ||
      lower.includes('unsupported_token_type') ||
      lower.includes('authentication_error') ||
      response.status === 400 ||
      response.status === 401

    throw new SchwabAuthError(
      `Schwab token request failed (HTTP ${response.status}): ${text.replace(/\s+/g, ' ').slice(0, 240)}`,
      { status: response.status, requiresReauthorization }
    )
  }

  let json: unknown
  try {
    json = JSON.parse(text)
  } catch {
    throw new SchwabAuthError('Schwab returned a token response that was not valid JSON')
  }

  const parsed = tokenResponseSchema.safeParse(json)
  if (!parsed.success) {
    throw new SchwabAuthError(
      `Schwab token response did not match the expected shape: ${JSON.stringify(parsed.error.issues.slice(0, 3))}`
    )
  }

  const now = Date.now()
  const expiresIn = parsed.data.expires_in ?? ACCESS_TOKEN_TTL_SECONDS

  return {
    accessToken: parsed.data.access_token,
    refreshToken: parsed.data.refresh_token,
    accessTokenExpiresAt: now + expiresIn * 1000,
    refreshTokenExpiresAt: now + REFRESH_TOKEN_TTL_SECONDS * 1000
  }
}

/** Exchanges the one-time authorization code for tokens. */
export function exchangeAuthorizationCode(
  credentials: SchwabCredentials,
  code: string,
  fetchImpl: typeof fetch = globalThis.fetch
): Promise<SchwabTokens> {
  return requestTokens(
    credentials,
    new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: credentials.redirectUri
    }),
    fetchImpl
  )
}

/**
 * Mints a new access token.
 *
 * Schwab returns the same refresh token rather than rotating it, so the original
 * 7-day deadline is preserved rather than extended.
 */
export async function refreshAccessToken(
  credentials: SchwabCredentials,
  current: SchwabTokens,
  fetchImpl: typeof fetch = globalThis.fetch
): Promise<SchwabTokens> {
  const refreshed = await requestTokens(
    credentials,
    new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: current.refreshToken
    }),
    fetchImpl
  )

  return {
    ...refreshed,
    // Refreshing does not extend the 7-day window; keep the original deadline
    // so the UI can warn honestly about when re-authorization is due.
    refreshTokenExpiresAt: current.refreshTokenExpiresAt
  }
}

export function isAccessTokenExpired(tokens: SchwabTokens, now = Date.now()): boolean {
  return now >= tokens.accessTokenExpiresAt - ACCESS_TOKEN_SKEW_SECONDS * 1000
}

export function isRefreshTokenExpired(tokens: SchwabTokens, now = Date.now()): boolean {
  return now >= tokens.refreshTokenExpiresAt
}
