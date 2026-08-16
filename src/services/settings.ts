import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { createLogger } from './logger.js'
import { defaultSettings, deepMerge, settingsSchema, type DeepPartial, type Settings } from '../shared/settings.js'

const log = createLogger('settings')

export type { Settings, DeepPartial } from '../shared/settings.js'
export { defaultSettings, settingsSchema } from '../shared/settings.js'

/**
 * Persists settings as plain JSON in the Electron userData directory.
 *
 * The schema itself lives in `shared` so the renderer can use it too; this file
 * holds only the filesystem-bound store, which is main-process-only.
 */
export class SettingsStore {
  private cached: Settings | null = null

  constructor(private readonly filePath: string) {}

  get path(): string {
    return this.filePath
  }

  /**
   * Reads settings, repairing rather than throwing. A corrupt or partial file
   * must not prevent the app from launching - unknown keys are dropped and
   * missing keys fall back to defaults.
   */
  read(): Settings {
    if (this.cached) return this.cached

    if (!existsSync(this.filePath)) {
      this.cached = defaultSettings()
      return this.cached
    }

    try {
      const raw: unknown = JSON.parse(readFileSync(this.filePath, 'utf8'))
      const parsed = settingsSchema.safeParse(raw)
      if (!parsed.success) {
        log.warn('settings file failed validation; falling back to defaults for invalid keys', {
          issues: parsed.error.issues.slice(0, 5)
        })
        this.cached = defaultSettings()
      } else {
        this.cached = parsed.data
      }
    } catch (error) {
      log.error('could not read settings; using defaults', {
        error: error instanceof Error ? error.message : String(error)
      })
      this.cached = defaultSettings()
    }

    return this.cached
  }

  /** Applies a partial update and persists the merged result. */
  update(patch: DeepPartial<Settings>): Settings {
    const merged = settingsSchema.parse(deepMerge(this.read(), patch))
    this.cached = merged
    this.write(merged)
    return merged
  }

  reset(): Settings {
    const fresh = defaultSettings()
    this.cached = fresh
    this.write(fresh)
    return fresh
  }

  private write(settings: Settings): void {
    try {
      mkdirSync(dirname(this.filePath), { recursive: true })
      writeFileSync(this.filePath, JSON.stringify(settings, null, 2), 'utf8')
      log.debug('settings saved', { path: this.filePath })
    } catch (error) {
      log.error('could not save settings', {
        error: error instanceof Error ? error.message : String(error)
      })
    }
  }
}

/** Default cache location under the app's userData directory. */
export function resolveDataDirectory(settings: Settings, userDataPath: string): string {
  return settings.data.directory.trim() || join(userDataPath, 'data')
}
