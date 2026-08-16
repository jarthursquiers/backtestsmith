import { z } from 'zod'

/**
 * Settings schema and types.
 *
 * Lives in `shared` because both sides of the IPC boundary need it: the main
 * process persists and validates it, the renderer edits it. Deliberately free of
 * Node and Electron imports so the renderer can use it directly.
 *
 * Secrets never appear here - the Massive API key is handled separately and
 * encrypted with the OS keystore.
 */
export const settingsSchema = z.object({
  massive: z
    .object({
      /**
       * Free "Options Basic" is documented at roughly 5 calls/minute. Kept
       * configurable so upgrading the plan is a settings change, not a code
       * change. 0 means unlimited.
       */
      requestsPerMinute: z.number().int().min(0).max(10_000).default(5),
      timeoutMs: z.number().int().min(1000).max(120_000).default(30_000),
      maxRetries: z.number().int().min(0).max(10).default(4)
    })
    .default({ requestsPerMinute: 5, timeoutMs: 30_000, maxRetries: 4 }),

  data: z
    .object({
      /** Root of the local historical cache. Empty means "default under userData". */
      directory: z.string().default('')
    })
    .default({ directory: '' }),

  research: z
    .object({
      /** Defaults for the SPX 7-DTE butterfly study; all overridable per study. */
      underlying: z.string().default('SPX'),
      entryTimeEastern: z.string().default('09:35'),
      targetDte: z.number().int().min(0).max(60).default(7),
      wingWidth: z.number().min(1).default(25)
    })
    .default({ underlying: 'SPX', entryTimeEastern: '09:35', targetDte: 7, wingWidth: 25 }),

  ui: z
    .object({
      theme: z.enum(['dark', 'light']).default('dark')
    })
    .default({ theme: 'dark' }),

  logLevel: z.enum(['debug', 'info', 'warn', 'error']).default('info')
})

export type Settings = z.infer<typeof settingsSchema>

export function defaultSettings(): Settings {
  return settingsSchema.parse({})
}

export type DeepPartial<T> = {
  [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K]
}

/** Recursive merge for plain objects; arrays and scalars are replaced wholesale. */
export function deepMerge<T>(base: T, patch: unknown): T {
  if (patch === undefined || patch === null) return base
  if (typeof base !== 'object' || base === null || Array.isArray(base)) return patch as T
  if (typeof patch !== 'object' || Array.isArray(patch)) return patch as T

  const result: Record<string, unknown> = { ...(base as Record<string, unknown>) }
  for (const [key, value] of Object.entries(patch as Record<string, unknown>)) {
    if (value === undefined) continue
    result[key] = deepMerge((base as Record<string, unknown>)[key], value)
  }
  return result as T
}
