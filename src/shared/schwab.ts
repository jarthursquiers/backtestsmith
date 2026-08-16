/** Schwab connection state, safe for the renderer: no secrets or tokens. */
export interface SchwabConnectionStatus {
  hasCredentials: boolean
  credentialsFromEnv: boolean
  /** Truncated client ID for identification only. */
  clientIdHint: string | null
  redirectUri: string
  connected: boolean
  /**
   * Epoch ms when re-authorization becomes necessary. Schwab refresh tokens
   * have a hard 7-day life and refreshing does not extend it.
   */
  refreshTokenExpiresAt: number | null
  encryptionAvailable: boolean
  storedCredentials: boolean
}

export interface SchwabBackfillRequest {
  ticker: string
  from: string
  to: string
  timespan: 'minute' | 'day'
}

export interface SchwabBackfillResult {
  ticker: string
  timespan: 'minute' | 'day'
  barsWritten: number
  sessionsWritten: number
  dateRange: { from: string; to: string } | null
  requests: number
}
