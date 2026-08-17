import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { safeStorage } from 'electron'
import { createLogger } from './logger.js'
import type { SecretStatus } from '../shared/secrets.js'

const log = createLogger('secrets')

/**
 * Massive API key storage.
 *
 * Threat model for a personal desktop research app: protect the key from casual
 * disclosure (config backups, screen sharing, accidental commits), not from an
 * attacker who already controls the machine. Electron's safeStorage delegates to
 * the OS keystore - DPAPI on Windows - which meets that bar without shipping a
 * key-management stack.
 *
 * Precedence:
 *   1. MASSIVE_API_KEY environment variable  (development convenience)
 *   2. encrypted key on disk                 (normal desktop use)
 *
 * The key is never written to settings.json and never included in log output.
 */

export type { SecretStatus } from '../shared/secrets.js'

/** Builds a display hint that identifies a key without revealing it. */
export function keyHint(key: string): string | null {
  const trimmed = key.trim()
  if (trimmed.length === 0) return null
  if (trimmed.length <= 8) return `${trimmed.slice(0, 2)}...`
  return `${trimmed.slice(0, 4)}...${trimmed.slice(-4)}`
}

export class SecretStore {
  constructor(
    private readonly filePath: string,
    private readonly envVariable = 'MASSIVE_API_KEY',
    private readonly label = 'API key'
  ) {}

  private envKey(): string | null {
    const fromEnv = process.env[this.envVariable]?.trim()
    return fromEnv && fromEnv.length > 0 ? fromEnv : null
  }

  /** True when the OS-backed keystore can encrypt. */
  encryptionAvailable(): boolean {
    try {
      return safeStorage.isEncryptionAvailable()
    } catch {
      return false
    }
  }

  /** Resolves the active key, env var winning over the stored value. */
  getApiKey(): string | null {
    const fromEnv = this.envKey()
    if (fromEnv) return fromEnv

    if (!existsSync(this.filePath)) return null

    try {
      const blob = readFileSync(this.filePath)
      if (!this.encryptionAvailable()) {
        log.warn('stored key present but OS encryption is unavailable; ignoring it')
        return null
      }
      const decrypted = safeStorage.decryptString(blob).trim()
      return decrypted.length > 0 ? decrypted : null
    } catch (error) {
      log.error('could not decrypt stored API key', {
        error: error instanceof Error ? error.message : String(error)
      })
      return null
    }
  }

  /**
   * Persists a key, encrypted. Refuses rather than silently writing plaintext
   * when the OS keystore is unavailable - a quiet downgrade would be worse than
   * a clear failure the user can act on.
   */
  setApiKey(key: string): { ok: boolean; message: string } {
    const trimmed = key.trim()

    if (trimmed.length === 0) {
      this.clearApiKey()
      return { ok: true, message: 'API key cleared.' }
    }

    if (!this.encryptionAvailable()) {
      const message =
        `OS encryption is unavailable, so the key was not saved. Set the ${this.envVariable} environment variable instead.`
      log.error(message)
      return { ok: false, message }
    }

    try {
      mkdirSync(dirname(this.filePath), { recursive: true })
      writeFileSync(this.filePath, safeStorage.encryptString(trimmed))
      log.info(`${this.label} saved`, { hint: keyHint(trimmed) })
      return { ok: true, message: `${this.label} saved securely.` }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      log.error('could not save API key', { error: message })
      return { ok: false, message: `Could not save API key: ${message}` }
    }
  }

  clearApiKey(): void {
    try {
      if (existsSync(this.filePath)) rmSync(this.filePath)
      log.info(`${this.label} cleared`)
    } catch (error) {
      log.error('could not clear API key', {
        error: error instanceof Error ? error.message : String(error)
      })
    }
  }

  status(): SecretStatus {
    const fromEnv = this.envKey()
    if (fromEnv) {
      return {
        present: true,
        source: 'env',
        encryptionAvailable: this.encryptionAvailable(),
        hint: keyHint(fromEnv)
      }
    }

    const stored = this.getApiKey()
    return {
      present: stored !== null,
      source: stored !== null ? 'stored' : 'none',
      encryptionAvailable: this.encryptionAvailable(),
      hint: stored ? keyHint(stored) : null
    }
  }
}
