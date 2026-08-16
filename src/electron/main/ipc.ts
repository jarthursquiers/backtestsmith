import { app, ipcMain, type BrowserWindow } from 'electron'
import type { BarQuery } from '../../domain/bars.js'
import type { ContractQuery } from '../../domain/contracts.js'
import { IPC, type AppInfo, type IpcResult } from '../../shared/ipc.js'
import { createLogger, logStore, type LogLevel } from '../../services/logger.js'
import type { QueueStats } from '../../data/requestQueue.js'
import { getServices } from './services.js'

const log = createLogger('ipc')

/**
 * Wraps a handler so failures cross the boundary as structured results rather
 * than mangled Electron rejection strings.
 */
function handle<TArgs extends unknown[], TResult>(
  channel: string,
  fn: (...args: TArgs) => Promise<TResult> | TResult
): void {
  ipcMain.handle(channel, async (_event, ...args): Promise<IpcResult<TResult>> => {
    try {
      const data = await fn(...(args as TArgs))
      return { ok: true, data }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      log.error(`handler failed: ${channel}`, { error: message })
      return { ok: false, error: message }
    }
  })
}

export function registerIpcHandlers(getWindow: () => BrowserWindow | null): void {
  const services = getServices()

  // --- settings -------------------------------------------------------------
  handle(IPC.settingsGet, () => services.settings.read())
  handle(IPC.settingsUpdate, (patch: Parameters<typeof services.settings.update>[0]) => {
    const next = services.settings.update(patch)
    services.applySettings()
    return next
  })
  handle(IPC.settingsReset, () => {
    const next = services.settings.reset()
    services.applySettings()
    return next
  })

  // --- secrets --------------------------------------------------------------
  handle(IPC.secretsStatus, () => services.secrets.status())
  handle(IPC.secretsSetApiKey, (key: string) => {
    const result = services.secrets.setApiKey(key)
    services.applySettings()
    return result
  })
  handle(IPC.secretsClear, () => {
    services.secrets.clearApiKey()
    services.applySettings()
  })

  // --- Massive --------------------------------------------------------------
  handle(IPC.massiveTestConnection, () => services.upstream.testConnection())
  handle(IPC.massiveGetContracts, (query: ContractQuery) => services.provider.getContracts(query))
  handle(IPC.massiveGetOptionBars, (query: BarQuery) => services.provider.getOptionBars(query))
  handle(IPC.massiveGetUnderlyingBars, (query: BarQuery) => services.provider.getUnderlyingBars(query))

  // --- cache ----------------------------------------------------------------
  handle(IPC.cacheStats, () => services.cacheStats())
  handle(IPC.cacheClear, async () => {
    await services.store.clear()
    return services.cacheStats()
  })

  // --- queue ----------------------------------------------------------------
  handle(IPC.queueStats, () => services.queue.getStats())
  handle(IPC.queuePause, () => services.queue.pause())
  handle(IPC.queueResume, () => services.queue.resume())
  handle(IPC.queueCancelAll, () => services.queue.cancelAll('Cancelled from the UI'))

  // --- logs -----------------------------------------------------------------
  handle(IPC.logsRecent, (limit?: number, minLevel?: LogLevel) => logStore.recent(limit, minLevel))
  handle(IPC.logsClear, () => logStore.clear())

  // --- app info -------------------------------------------------------------
  handle(IPC.appInfo, (): AppInfo => {
    const gitCommit = process.env.GIT_COMMIT
    return {
      name: app.getName(),
      version: app.getVersion(),
      electronVersion: process.versions.electron ?? 'unknown',
      nodeVersion: process.versions.node,
      platform: process.platform,
      userDataPath: app.getPath('userData'),
      dataDirectory: services.dataDirectory,
      settingsPath: services.settings.path,
      ...(gitCommit ? { gitCommit } : {})
    }
  })

  // --- push events to the renderer -----------------------------------------
  // Throttled so a burst of log lines cannot flood the IPC channel.
  let pendingStats: QueueStats | null = null
  let statsTimer: NodeJS.Timeout | null = null

  services.queue.on('stats', (stats: QueueStats) => {
    pendingStats = stats
    if (statsTimer) return
    statsTimer = setTimeout(() => {
      statsTimer = null
      const window = getWindow()
      if (window && !window.isDestroyed() && pendingStats) {
        window.webContents.send(IPC.queueStatsEvent, pendingStats)
      }
      pendingStats = null
    }, 100)
    statsTimer.unref?.()
  })

  logStore.on('record', (record) => {
    const window = getWindow()
    if (window && !window.isDestroyed()) {
      window.webContents.send(IPC.logRecordEvent, record)
    }
  })

  log.info('IPC handlers registered')
}
