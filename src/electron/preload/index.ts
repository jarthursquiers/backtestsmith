import { contextBridge, ipcRenderer } from 'electron'
import { IPC, type AppApi, type IpcResult } from '../../shared/ipc.js'
import type { LogLevel, LogRecord } from '../../services/logger.js'
import type { QueueStats } from '../../data/requestQueue.js'

/**
 * The only bridge between the renderer and the main process.
 *
 * Nothing here exposes raw `ipcRenderer`, arbitrary channels, or Node APIs -
 * the renderer gets exactly the typed methods below and nothing else.
 */

/** Unwraps the main process result envelope back into a normal Promise. */
async function invoke<T>(channel: string, ...args: unknown[]): Promise<T> {
  const result = (await ipcRenderer.invoke(channel, ...args)) as IpcResult<T>
  if (!result.ok) throw new Error(result.error)
  return result.data
}

/** Subscribes to a push channel and returns an unsubscribe function. */
function subscribe<T>(channel: string, listener: (payload: T) => void): () => void {
  const handler = (_event: Electron.IpcRendererEvent, payload: T): void => listener(payload)
  ipcRenderer.on(channel, handler)
  return () => {
    ipcRenderer.removeListener(channel, handler)
  }
}

const api: AppApi = {
  settings: {
    get: () => invoke(IPC.settingsGet),
    update: (patch) => invoke(IPC.settingsUpdate, patch),
    reset: () => invoke(IPC.settingsReset)
  },
  secrets: {
    status: () => invoke(IPC.secretsStatus),
    setApiKey: (key) => invoke(IPC.secretsSetApiKey, key),
    clear: () => invoke(IPC.secretsClear)
  },
  massive: {
    testConnection: () => invoke(IPC.massiveTestConnection),
    getContracts: (query) => invoke(IPC.massiveGetContracts, query),
    getOptionBars: (query) => invoke(IPC.massiveGetOptionBars, query),
    getUnderlyingBars: (query) => invoke(IPC.massiveGetUnderlyingBars, query)
  },
  butterfly: {
    chain: (underlying, expiration, optionType) =>
      invoke(IPC.butterflyChain, underlying, expiration, optionType),
    reconstruct: (request) => invoke(IPC.butterflyReconstruct, request)
  },
  schwab: {
    status: () => invoke(IPC.schwabStatus),
    setCredentials: (credentials) => invoke(IPC.schwabSetCredentials, credentials),
    authorizeUrl: () => invoke(IPC.schwabAuthorizeUrl),
    completeAuth: (redirectedUrl) => invoke(IPC.schwabCompleteAuth, redirectedUrl),
    disconnect: () => invoke(IPC.schwabDisconnect),
    test: () => invoke(IPC.schwabTest),
    backfill: (request) => invoke(IPC.schwabBackfill, request)
  },
  underlying: {
    downloadMassive: (request) => invoke(IPC.underlyingDownloadMassive, request),
    pickFile: () => invoke(IPC.underlyingPickFile),
    previewCsv: (filePath, options) => invoke(IPC.underlyingPreviewCsv, filePath, options),
    importCsv: (filePath, options) => invoke(IPC.underlyingImportCsv, filePath, options),
    cachedBars: (ticker, from, to) => invoke(IPC.underlyingCachedBars, ticker, from, to),
    coverage: (ticker, from, to) => invoke(IPC.underlyingCoverage, ticker, from, to)
  },
  cache: {
    stats: () => invoke(IPC.cacheStats),
    clear: () => invoke(IPC.cacheClear)
  },
  queue: {
    stats: () => invoke(IPC.queueStats),
    pause: () => invoke(IPC.queuePause),
    resume: () => invoke(IPC.queueResume),
    cancelAll: () => invoke(IPC.queueCancelAll),
    onStats: (listener) => subscribe<QueueStats>(IPC.queueStatsEvent, listener)
  },
  logs: {
    recent: (limit?: number, minLevel?: LogLevel) => invoke(IPC.logsRecent, limit, minLevel),
    clear: () => invoke(IPC.logsClear),
    onRecord: (listener) => subscribe<LogRecord>(IPC.logRecordEvent, listener)
  },
  app: {
    info: () => invoke(IPC.appInfo)
  }
}

contextBridge.exposeInMainWorld('api', api)
