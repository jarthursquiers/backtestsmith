import type { BarQuery, OptionBar, UnderlyingBar } from '../domain/bars.js'
import type { ContractQuery, OptionContract } from '../domain/contracts.js'
import type { BarFetchResult, ProviderStatus } from './provider.js'
import type { QueueStats } from './queue.js'
import type { LogLevel, LogRecord } from './logging.js'
import type { SecretStatus } from './secrets.js'
import type { DeepPartial, Settings } from './settings.js'

/**
 * Contract between the Electron main process (which owns all data access and,
 * later, the backtest engine) and the React renderer (which owns none of it).
 *
 * The renderer is deliberately incapable of reaching Massive or the filesystem
 * directly: it only speaks these channels.
 */

export const IPC = {
  settingsGet: 'settings:get',
  settingsUpdate: 'settings:update',
  settingsReset: 'settings:reset',

  secretsStatus: 'secrets:status',
  secretsSetApiKey: 'secrets:setApiKey',
  secretsClear: 'secrets:clear',

  massiveTestConnection: 'massive:testConnection',
  massiveGetContracts: 'massive:getContracts',
  massiveGetOptionBars: 'massive:getOptionBars',
  massiveGetUnderlyingBars: 'massive:getUnderlyingBars',

  queueStats: 'queue:stats',
  queuePause: 'queue:pause',
  queueResume: 'queue:resume',
  queueCancelAll: 'queue:cancelAll',
  queueStatsEvent: 'queue:stats:event',

  logsRecent: 'logs:recent',
  logsClear: 'logs:clear',
  logRecordEvent: 'logs:record:event',

  appInfo: 'app:info'
} as const

export interface AppInfo {
  name: string
  version: string
  electronVersion: string
  nodeVersion: string
  platform: string
  userDataPath: string
  dataDirectory: string
  settingsPath: string
  /** Populated when the build embeds a git commit, for reproducibility records. */
  gitCommit?: string
}

/**
 * IPC results are wrapped rather than thrown across the boundary, because raw
 * Electron rejections arrive mangled ("Error invoking remote method..."). The
 * preload layer unwraps these back into clean Errors.
 */
export type IpcResult<T> = { ok: true; data: T } | { ok: false; error: string }

export interface AppApi {
  settings: {
    get(): Promise<Settings>
    update(patch: DeepPartial<Settings>): Promise<Settings>
    reset(): Promise<Settings>
  }
  secrets: {
    status(): Promise<SecretStatus>
    setApiKey(key: string): Promise<{ ok: boolean; message: string }>
    clear(): Promise<void>
  }
  massive: {
    testConnection(): Promise<ProviderStatus>
    getContracts(query: ContractQuery): Promise<OptionContract[]>
    getOptionBars(query: BarQuery): Promise<BarFetchResult<OptionBar>>
    getUnderlyingBars(query: BarQuery): Promise<BarFetchResult<UnderlyingBar>>
  }
  queue: {
    stats(): Promise<QueueStats>
    pause(): Promise<void>
    resume(): Promise<void>
    cancelAll(): Promise<void>
    /** Subscribes to live queue stats. Returns an unsubscribe function. */
    onStats(listener: (stats: QueueStats) => void): () => void
  }
  logs: {
    recent(limit?: number, minLevel?: LogLevel): Promise<LogRecord[]>
    clear(): Promise<void>
    onRecord(listener: (record: LogRecord) => void): () => void
  }
  app: {
    info(): Promise<AppInfo>
  }
}

declare global {
  interface Window {
    api: AppApi
  }
}
