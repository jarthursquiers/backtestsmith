import { readFileSync, statSync } from 'node:fs'
import { basename } from 'node:path'
import { app, dialog, ipcMain, shell, type BrowserWindow } from 'electron'
import { randomBytes } from 'node:crypto'
import {
  buildAuthorizeUrl,
  exchangeAuthorizationCode,
  extractAuthorizationCode
} from '../../data/schwab/auth.js'
import type { SchwabBackfillRequest, SchwabBackfillResult } from '../../shared/schwab.js'
import { marketDateOf } from '../../core/time/marketTime.js'
import { parseUnderlyingCsv } from '../../data/csv/csvImport.js'
import { tradingDaysBetween } from '../../core/time/marketTime.js'
import type {
  CsvImportOptions,
  CsvImportResult,
  CsvPreview,
  UnderlyingCoverageDay
} from '../../shared/underlying.js'
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

  // --- Schwab (SPX underlying source) ---------------------------------------
  handle(IPC.schwabStatus, () => services.schwabStore.status())

  handle(IPC.schwabSetCredentials, (credentials: { clientId?: string; clientSecret?: string; redirectUri?: string }) => {
    services.schwabStore.setCredentials(credentials)
    return services.schwabStore.status()
  })

  handle(IPC.schwabAuthorizeUrl, async () => {
    const credentials = services.schwabStore.credentials()
    // State is a one-shot nonce; it round-trips through Schwab so a stale or
    // foreign redirect can be spotted, though the desktop paste flow is manual.
    const url = buildAuthorizeUrl(credentials, randomBytes(12).toString('hex'))
    // Authorization must happen in the real browser, never inside the app: the
    // user needs to see Schwab's own address bar and certificate to trust it.
    await shell.openExternal(url)
    return url
  })

  handle(IPC.schwabCompleteAuth, async (redirectedUrl: string) => {
    const { code } = extractAuthorizationCode(redirectedUrl)
    const tokens = await exchangeAuthorizationCode(services.schwabStore.credentials(), code)
    services.schwabStore.setTokens(tokens)
    log.info('Schwab connected', {
      refreshTokenExpiresAt: new Date(tokens.refreshTokenExpiresAt).toISOString()
    })
    return services.schwabStore.status()
  })

  handle(IPC.schwabDisconnect, () => {
    services.schwabStore.disconnect()
    return services.schwabStore.status()
  })

  handle(IPC.schwabTest, () => services.schwab.testConnection())

  handle(IPC.schwabBackfill, async (request: SchwabBackfillRequest): Promise<SchwabBackfillResult> => {
    const before = services.schwabQueue.getStats().completed
    const result = await services.schwab.getUnderlyingBars({
      ticker: request.ticker,
      from: request.from,
      to: request.to,
      timespan: request.timespan
    })

    // Record coverage only for sessions Schwab actually returned. Absence here
    // is not evidence the index did not trade - it usually means the range is
    // outside Schwab's retention - so it must not be recorded as a confirmed
    // empty day, which would permanently suppress a later retry.
    const datesWithBars = [...new Set(result.bars.map((b) => marketDateOf(b.timestamp)))].sort()

    if (result.bars.length > 0) {
      await services.store.putBars(
        'underlying',
        request.ticker,
        datesWithBars,
        result.bars,
        { timespan: request.timespan, multiplier: 1 },
        'schwab'
      )
    }

    return {
      ticker: request.ticker,
      timespan: request.timespan,
      barsWritten: result.bars.length,
      sessionsWritten: datesWithBars.length,
      dateRange:
        datesWithBars.length > 0
          ? { from: datesWithBars[0]!, to: datesWithBars[datesWithBars.length - 1]! }
          : null,
      requests: services.schwabQueue.getStats().completed - before
    }
  })

  // --- underlying (SPX) -----------------------------------------------------
  handle(IPC.underlyingPickFile, async (): Promise<string | null> => {
    const window = getWindow()
    const options = {
      title: 'Select an underlying price history CSV',
      filters: [{ name: 'CSV', extensions: ['csv', 'txt'] }],
      properties: ['openFile' as const]
    }
    const result = window
      ? await dialog.showOpenDialog(window, options)
      : await dialog.showOpenDialog(options)
    return result.canceled ? null : (result.filePaths[0] ?? null)
  })

  handle(IPC.underlyingPreviewCsv, (filePath: string, options: CsvImportOptions): CsvPreview => {
    const text = readFileSync(filePath, 'utf8')
    const parsed = parseUnderlyingCsv(text, options)
    return {
      filePath,
      fileName: basename(filePath),
      fileBytes: statSync(filePath).size,
      rowsRead: parsed.rowsRead,
      rowsAccepted: parsed.rowsAccepted,
      distinctDates: parsed.marketDates.length,
      mapping: parsed.mapping,
      hasHeader: parsed.hasHeader,
      delimiter: parsed.delimiter,
      warnings: parsed.warnings,
      skipped: parsed.skipped.slice(0, 25),
      dateRange: parsed.dateRange,
      // Enough rows to confirm the timezone reading before committing anything.
      sample: parsed.bars.slice(0, 8)
    }
  })

  handle(IPC.underlyingImportCsv, async (filePath: string, options: CsvImportOptions): Promise<CsvImportResult> => {
    const text = readFileSync(filePath, 'utf8')
    const parsed = parseUnderlyingCsv(text, options)

    if (parsed.bars.length === 0) {
      throw new Error('No valid rows were found in this file, so nothing was imported.')
    }

    await services.store.putBars(
      'underlying',
      options.ticker,
      parsed.marketDates,
      parsed.bars,
      { timespan: options.timespan, multiplier: 1 },
      'csv-import'
    )

    log.info('underlying CSV imported', {
      ticker: options.ticker,
      timespan: options.timespan,
      bars: parsed.bars.length,
      dates: parsed.marketDates.length,
      from: parsed.dateRange?.from,
      to: parsed.dateRange?.to,
      skipped: parsed.skipped.length
    })

    return {
      imported: parsed.bars.length,
      distinctDates: parsed.marketDates.length,
      dateRange: parsed.dateRange,
      warnings: parsed.warnings,
      skippedCount: parsed.skipped.length
    }
  })

  handle(IPC.underlyingCachedBars, (ticker: string, from: string, to: string) => {
    // Cache-only by design: index data is not entitled on the Options plans, so
    // reaching upstream here would burn a request to earn an HTTP 403.
    return services.store.getUnderlyingBars(ticker, tradingDaysBetween(from, to))
  })

  handle(IPC.underlyingCoverage, (ticker: string, from: string, to: string): Promise<UnderlyingCoverageDay[]> => {
    return services.store.getUnderlyingCoverage(ticker, from, to)
  })

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
