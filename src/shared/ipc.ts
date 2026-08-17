import type { BarQuery, OptionBar, UnderlyingBar } from '../domain/bars.js'
import type { ContractQuery, OptionContract } from '../domain/contracts.js'
import type { BarFetchResult, ProviderStatus } from './provider.js'
import type { CacheStats } from './cache.js'
import type { SchwabBackfillRequest, SchwabBackfillResult, SchwabConnectionStatus } from './schwab.js'
import type { ChainSummary, ReconstructRequest, ReconstructResponse } from './butterfly.js'
import type { ParityValidationRequest, ParityValidationResponse } from './parity.js'
import type {
  StudyConfig,
  StudyPreflight,
  StudyProgress,
  StudyRunResult,
  StudyRunSummary
} from './study.js'
import type { AnalyticsReport } from './analytics.js'
import type { SweepAxis, SweepResult } from './sweep.js'
import type {
  CsvImportOptions,
  CsvImportResult,
  CsvPreview,
  UnderlyingCoverageDay
} from './underlying.js'
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

  studyPreflight: 'study:preflight',
  studyAnalytics: 'study:analytics',
  studyExportTrades: 'study:exportTrades',
  studyExportJson: 'study:exportJson',
  sweepEstimate: 'sweep:estimate',
  sweepRun: 'sweep:run',

  studyRun: 'study:run',
  studyCancel: 'study:cancel',
  studyList: 'study:list',
  studyLoad: 'study:load',
  studyDelete: 'study:delete',
  studyProgressEvent: 'study:progress:event',

  parityValidate: 'parity:validate',

  butterflyChain: 'butterfly:chain',
  butterflyReconstruct: 'butterfly:reconstruct',

  schwabStatus: 'schwab:status',
  schwabSetCredentials: 'schwab:setCredentials',
  schwabAuthorizeUrl: 'schwab:authorizeUrl',
  schwabCompleteAuth: 'schwab:completeAuth',
  schwabDisconnect: 'schwab:disconnect',
  schwabTest: 'schwab:test',
  schwabBackfill: 'schwab:backfill',

  underlyingDownloadMassive: 'underlying:downloadMassive',
  underlyingPickFile: 'underlying:pickFile',
  underlyingPreviewCsv: 'underlying:previewCsv',
  underlyingImportCsv: 'underlying:importCsv',
  underlyingCachedBars: 'underlying:cachedBars',
  underlyingCoverage: 'underlying:coverage',

  cacheStats: 'cache:stats',
  cacheClear: 'cache:clear',

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
  study: {
    /** Checks whether a study can produce anything, before running it. */
    preflight(config: StudyConfig): Promise<StudyPreflight>
    /** Runs a study to completion, persisting the result. */
    run(config: StudyConfig, label?: string): Promise<StudyRunResult>
    /** Requests cancellation of the run in progress. */
    cancel(): Promise<void>
    list(limit?: number): Promise<StudyRunSummary[]>
    load(runId: string): Promise<StudyRunResult | null>
    remove(runId: string): Promise<void>
    /** Subscribes to progress while a study runs. Returns an unsubscribe. */
    onProgress(listener: (progress: StudyProgress) => void): () => void
    /** Aggregate research views for one management method within a run. */
    analytics(runId: string, strategyId: string): Promise<AnalyticsReport>
    /** Writes trade-level CSV; returns the path, or null if cancelled. */
    exportTrades(runId: string): Promise<string | null>
    /** Writes the full study JSON including config and caveats. */
    exportJson(runId: string): Promise<string | null>
  }
  sweep: {
    /** Cost of a sweep before running it. */
    estimate(axes: SweepAxis[]): Promise<{
      entryCombinations: number
      managementVariants: number
      requiresRefetch: boolean
    }>
    /** Runs every combination, reusing cached data between them. */
    run(base: StudyConfig, axes: SweepAxis[], objective: string): Promise<SweepResult[]>
  }
  parity: {
    /** Measures derived-index accuracy against real index data. */
    validate(request: ParityValidationRequest): Promise<ParityValidationResponse>
  }
  butterfly: {
    /** Loads the option chain for an expiration, so strikes can be chosen. */
    chain(underlying: string, expiration: string, optionType: 'call' | 'put'): Promise<ChainSummary>
    /** Downloads the three legs if needed and reconstructs the lifecycle. */
    reconstruct(request: ReconstructRequest): Promise<ReconstructResponse>
  }
  schwab: {
    status(): Promise<SchwabConnectionStatus>
    setCredentials(credentials: { clientId?: string; clientSecret?: string; redirectUri?: string }): Promise<SchwabConnectionStatus>
    /** Returns the URL to open in a browser to authorize. */
    authorizeUrl(): Promise<string>
    /** Completes the flow from the pasted redirect URL. */
    completeAuth(redirectedUrl: string): Promise<SchwabConnectionStatus>
    disconnect(): Promise<SchwabConnectionStatus>
    test(): Promise<ProviderStatus>
    /** Downloads a date range into the local cache. */
    backfill(request: SchwabBackfillRequest): Promise<SchwabBackfillResult>
  }
  underlying: {
    /**
     * Downloads index history from Massive into the local cache. Requires an
     * Indices subscription; without one the request returns HTTP 403.
     */
    downloadMassive(request: SchwabBackfillRequest): Promise<SchwabBackfillResult>
    /** Opens a native file picker. Returns null if cancelled. */
    pickFile(): Promise<string | null>
    /** Parses without storing, so the interpretation can be confirmed first. */
    previewCsv(filePath: string, options: CsvImportOptions): Promise<CsvPreview>
    importCsv(filePath: string, options: CsvImportOptions): Promise<CsvImportResult>
    /** Reads only from the local cache; never calls a provider. */
    cachedBars(ticker: string, from: string, to: string, timespan?: string): Promise<UnderlyingBar[]>
    coverage(ticker: string, from: string, to: string): Promise<UnderlyingCoverageDay[]>
  }
  cache: {
    stats(): Promise<CacheStats>
    /** Wipes cached market data. Schema is preserved. */
    clear(): Promise<CacheStats>
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
