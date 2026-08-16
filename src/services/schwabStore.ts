import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { safeStorage } from 'electron'
import { z } from 'zod'
import type { SchwabCredentials, SchwabTokens } from '../data/schwab/auth.js'
import type { SchwabConnectionStatus } from '../shared/schwab.js'
import { createLogger } from './logger.js'

const log = createLogger('schwab.store')

/**
 * Encrypted storage for Schwab credentials and OAuth tokens.
 *
 * Same threat model and mechanism as the Massive API key: the OS keystore
 * (DPAPI on Windows) via Electron `safeStorage`. Refresh tokens are effectively
 * bearer credentials for the account, so this file is never written in plain
 * text, never logged, and never returned to the renderer.
 */
const stateSchema = z.object({
  clientId: z.string().default(''),
  clientSecret: z.string().default(''),
  redirectUri: z.string().default(''),
  tokens: z
    .object({
      accessToken: z.string(),
      refreshToken: z.string(),
      accessTokenExpiresAt: z.number(),
      refreshTokenExpiresAt: z.number()
    })
    .nullable()
    .default(null)
})

type SchwabState = z.infer<typeof stateSchema>

const EMPTY: SchwabState = { clientId: '', clientSecret: '', redirectUri: '', tokens: null }

export class SchwabStore {
  private cached: SchwabState | null = null

  constructor(private readonly filePath: string) {}

  private encryptionAvailable(): boolean {
    try {
      return safeStorage.isEncryptionAvailable()
    } catch {
      return false
    }
  }

  private read(): SchwabState {
    if (this.cached) return this.cached

    if (!existsSync(this.filePath) || !this.encryptionAvailable()) {
      this.cached = { ...EMPTY }
      return this.cached
    }

    try {
      const decrypted = safeStorage.decryptString(readFileSync(this.filePath))
      const parsed = stateSchema.safeParse(JSON.parse(decrypted))
      this.cached = parsed.success ? parsed.data : { ...EMPTY }
      if (!parsed.success) log.warn('stored Schwab state failed validation; starting empty')
    } catch (error) {
      log.error('could not decrypt Schwab state', {
        error: error instanceof Error ? error.message : String(error)
      })
      this.cached = { ...EMPTY }
    }

    return this.cached
  }

  private write(state: SchwabState): void {
    if (!this.encryptionAvailable()) {
      log.error('OS encryption unavailable; refusing to store Schwab credentials in plain text')
      return
    }
    try {
      mkdirSync(dirname(this.filePath), { recursive: true })
      writeFileSync(this.filePath, safeStorage.encryptString(JSON.stringify(state)))
      this.cached = state
    } catch (error) {
      log.error('could not save Schwab state', {
        error: error instanceof Error ? error.message : String(error)
      })
    }
  }

  /**
   * Resolves credentials, environment variables winning over stored values so a
   * developer can point at a different app without touching the keystore.
   */
  credentials(): SchwabCredentials {
    const stored = this.read()
    return {
      clientId: process.env.SCHWAB_CLIENT_ID?.trim() || stored.clientId,
      clientSecret: process.env.SCHWAB_CLIENT_SECRET?.trim() || stored.clientSecret,
      redirectUri: process.env.SCHWAB_REDIRECT_URI?.trim() || stored.redirectUri
    }
  }

  setCredentials(credentials: Partial<SchwabCredentials>): void {
    const current = this.read()
    this.write({
      ...current,
      clientId: credentials.clientId?.trim() ?? current.clientId,
      clientSecret: credentials.clientSecret?.trim() ?? current.clientSecret,
      redirectUri: credentials.redirectUri?.trim() ?? current.redirectUri
    })
    log.info('Schwab credentials saved')
  }

  getTokens(): SchwabTokens | null {
    return this.read().tokens
  }

  setTokens(tokens: SchwabTokens | null): void {
    this.write({ ...this.read(), tokens })
    log.info(tokens ? 'Schwab tokens saved' : 'Schwab tokens cleared')
  }

  disconnect(): void {
    this.setTokens(null)
  }

  /** Clears credentials and tokens entirely. */
  reset(): void {
    try {
      if (existsSync(this.filePath)) rmSync(this.filePath)
    } catch {
      // Falling through to the in-memory reset is enough.
    }
    this.cached = { ...EMPTY }
    log.warn('Schwab state cleared')
  }

  /** Renderer-safe status. Never includes the secret or either token. */
  status(): SchwabConnectionStatus {
    const credentials = this.credentials()
    const tokens = this.getTokens()
    const stored = this.read()
    const fromEnv =
      process.env.SCHWAB_CLIENT_ID?.trim() !== undefined && process.env.SCHWAB_CLIENT_ID?.trim() !== ''

    return {
      hasCredentials: credentials.clientId.length > 0 && credentials.clientSecret.length > 0,
      credentialsFromEnv: fromEnv,
      clientIdHint: credentials.clientId ? `${credentials.clientId.slice(0, 6)}…` : null,
      redirectUri: credentials.redirectUri,
      connected: tokens !== null && Date.now() < tokens.refreshTokenExpiresAt,
      refreshTokenExpiresAt: tokens?.refreshTokenExpiresAt ?? null,
      encryptionAvailable: this.encryptionAvailable(),
      // Surfaced so the UI can explain why nothing was persisted.
      storedCredentials: stored.clientId.length > 0
    }
  }
}
