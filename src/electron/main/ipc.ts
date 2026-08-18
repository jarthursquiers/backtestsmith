import { readFileSync, statSync } from 'node:fs'
import { basename, join } from 'node:path'
import { app, dialog, ipcMain, shell, type BrowserWindow } from 'electron'
import { createHash, randomBytes } from 'node:crypto'
import {
  buildAuthorizeUrl,
  exchangeAuthorizationCode,
  extractAuthorizationCode
} from '../../data/schwab/auth.js'
import type { SchwabBackfillRequest, SchwabBackfillResult } from '../../shared/schwab.js'
import type { ChainSummary, ReconstructRequest, ReconstructResponse } from '../../shared/butterfly.js'
import {
  easternToTimestamp,
  addCalendarDays,
  isTradingDay,
  marketDateOf,
  nextTradingDay,
  parseTimeOfDay,
  previousTradingDay,
  sessionClose,
  tradingDaysBetween
} from '../../core/time/marketTime.js'
import { availableRoots, buildButterfly } from '../../backtest/buildButterfly.js'
import { reconstructButterfly } from '../../backtest/reconstruct.js'
import { computeExcursions } from '../../backtest/excursions.js'
import { simulateAll } from '../../backtest/simulate.js'
import { buildLegSeries, resolveLegQuote, type LegSeries } from '../../backtest/legPricing.js'
import { estimateFromParity, yearsBetween, type ParityQuote } from '../../backtest/putCallParity.js'
import {
  buildParityReport,
  indexUnderlyingByMinute,
  type ParitySample
} from '../../backtest/parityValidation.js'
import type { ParityValidationRequest, ParityValidationResponse } from '../../shared/parity.js'
import { sessionMinuteGrid } from '../../backtest/reconstruct.js'
import { preflightStudy, runStudy, type StudyDataSource } from '../../backtest/studyRunner.js'
import { prepareStudyData } from '../../backtest/studyPreparation.js'
import { computeMetrics } from '../../backtest/metrics.js'
import { buildAnalyticsReport } from '../../backtest/conditionalPaths.js'
import { seriesToCsv, studyJsonFilename, studyToJson, tradesToCsv } from '../../backtest/exports.js'
import { estimateSweepCost, expandSweep } from '../../backtest/parameterSweep.js'
import type { SweepAxis, SweepResult } from '../../shared/sweep.js'
import type { StudyMetrics } from '../../shared/metrics.js'
import type { AppServices } from './services.js'
import { writeFileSync } from 'node:fs'
import type {
  ManagementSummary,
  StudyConfig,
  StudyPreflight,
  StudyProgress,
  StudyRunResult
} from '../../shared/study.js'
import { resolveIndexTicker } from '../../shared/study.js'
import {
  centerTouch,
  holdToExpiration,
  profitTarget,
  stopLoss,
  targetWithStop,
  tentEntry,
  timeExit,
  trailingProfit,
  type ExitStrategy
} from '../../backtest/exits.js'
import type { MissingDataPolicy } from '../../domain/butterfly.js'
import { parseUnderlyingCsv } from '../../data/csv/csvImport.js'
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
import type {
  CreateForwardTestRequest,
  ForwardRunPlan,
  ForwardTestDetail,
  ForwardTestSummary
} from '../../shared/forwardTest.js'
import type { ForwardTestRecord } from '../../database/forwardTestStore.js'
import type { TradeResult } from '../../shared/trade.js'
import { planForwardRange } from '../../backtest/forwardTest.js'
import type { DatabaseBackupResult } from '../../shared/cache.js'

const log = createLogger('ipc')

/** Only one study may run at a time; a second would contend for the same queue. */
let activeStudy: AbortController | null = null

/** Dates advance during a forward test; every other assumption is immutable. */
function lockedConfigPayload(config: StudyConfig): Omit<StudyConfig, 'from' | 'to'> {
  const { from: _from, to: _to, ...locked } = config
  return locked
}

function lockedConfigHash(config: StudyConfig): string {
  return createHash('sha256').update(JSON.stringify(lockedConfigPayload(config))).digest('hex')
}

function latestMatureEntryDate(config: StudyConfig, now = Date.now()): string {
  const lastCompleteSession = previousTradingDay(marketDateOf(now))
  const maximumExpirationDte = config.targetDte + (config.maxDeviation ?? 3)
  const candidate = addCalendarDays(lastCompleteSession, -maximumExpirationDte)
  return isTradingDay(candidate) ? candidate : previousTradingDay(candidate)
}

function forwardSummary(
  record: ForwardTestRecord,
  runs: Awaited<ReturnType<AppServices['forwardTests']['runs']>>
): ForwardTestSummary {
  const completedSessions = runs.reduce((sum, run) => sum + run.sessions, 0)
  const acceptedEntries = runs.reduce((sum, run) => sum + run.acceptedEntries, 0)
  return {
    forwardTestId: record.forwardTestId,
    name: record.name,
    createdAt: record.createdAt,
    startDate: record.startDate,
    targetSessions: record.targetSessions,
    state: record.state,
    config: record.config,
    configHash: record.configHash,
    appVersion: record.appVersion,
    ...(record.gitCommit ? { gitCommit: record.gitCommit } : {}),
    completedSessions,
    acceptedEntries,
    skippedSessions: runs.reduce((sum, run) => sum + run.skippedSessions, 0),
    runCount: runs.length,
    latestMatureEntryDate: latestMatureEntryDate(record.config),
    ...(runs.at(-1) ? { lastCompletedDate: runs.at(-1)!.to } : {})
  }
}

async function loadForwardDetail(services: AppServices, forwardTestId: string): Promise<ForwardTestDetail | null> {
  const record = await services.forwardTests.load(forwardTestId)
  if (!record) return null
  const runs = await services.forwardTests.runs(forwardTestId)
  const trades: TradeResult[] = []
  for (const linked of runs) {
    const run = await services.studies.load(linked.runId)
    if (run) trades.push(...run.trades)
  }
  const summaries: ManagementSummary[] = record.config.managements.map((id) => {
    const managed = trades.filter((trade) => trade.strategyId === id)
    return {
      strategyId: id,
      strategyLabel: managed[0]?.strategyLabel ?? id,
      metrics: computeMetrics(managed)
    }
  })
  return { test: forwardSummary(record, runs), runs, summaries }
}

/**
 * Data access for the study runner.
 *
 * Shared between single studies and sweeps so both go through the same caching
 * provider, which is what makes a sweep over management parameters cost nothing
 * beyond the first combination.
 */
function buildStudySource(services: AppServices, signal?: AbortSignal): StudyDataSource {
  const minuteShape = { timespan: 'minute', multiplier: 1 }
  const dailyShape = { timespan: 'day', multiplier: 1 }
  return {
    getDailyBars: async (ticker, from, to) =>
      signal
        ? (await services.provider.getUnderlyingBars(
            { ticker, from, to, timespan: 'day' },
            { signal, priority: 10 }
          )).bars
        : services.store.getUnderlyingBars(ticker, tradingDaysBetween(from, to), dailyShape),
    getUnderlyingMinutes: async (ticker, date) =>
      signal
        ? (await services.provider.getUnderlyingBars(
            { ticker, from: date, to: date, timespan: 'minute' },
            { signal, priority: 10 }
          )).bars
        : services.store.getUnderlyingBars(ticker, [date], minuteShape),
    getChain: (underlying, expiration, type) =>
      services.provider.getContracts(
        { underlying, expirationDate: expiration, type, expired: true },
        { ...(signal ? { signal } : {}), priority: 20 }
      ),
    getOptionBars: async (ticker, from, to) =>
      (await services.provider.getOptionBars(
        { ticker, from, to, timespan: 'minute' },
        { ...(signal ? { signal } : {}), priority: 20 }
      )).bars
  }
}

/** Ranks a sweep point. Drawdown is negative, so less negative scores higher. */
function scoreObjective(metrics: StudyMetrics, objective: string): number {
  switch (objective) {
    case 'expectancy':
      return metrics.expectancy
    case 'profitFactor':
      return metrics.profitFactor ?? -Infinity
    case 'maxDrawdown':
      return metrics.maxDrawdown
    case 'winRate':
      return metrics.winRate
    case 'capture':
      return metrics.averageMfeCapture ?? -Infinity
    default:
      return metrics.totalPnl
  }
}

/** Formats a duration as e.g. 2m14s, for progress lines. */
function humanDuration(ms: number): string {
  const total = Math.round(ms / 1000)
  const minutes = Math.floor(total / 60)
  const seconds = total % 60
  return minutes > 0 ? `${minutes}m${String(seconds).padStart(2, '0')}s` : `${seconds}s`
}

/**
 * Writes a scannable progress line to stdout.
 *
 * The structured log records detail for the in-app viewer; this exists so
 * someone watching a terminal can tell at a glance whether a long study is
 * advancing, stalled on the rate limiter, or skipping everything. A study that
 * takes an hour needs to prove it is alive.
 */
function logStudyLine(progress: StudyProgress, requests: number): void {
  const parts = [
    `${String(progress.completed).padStart(4)}/${progress.total}`,
    (progress.currentDate ?? '').padEnd(10),
    `entries=${progress.tradesGenerated}`,
    `skipped=${progress.skipped}`,
    `req=${requests}`,
    `elapsed=${humanDuration(progress.elapsedMs ?? 0)}`
  ]
  if (progress.estimatedRemainingMs !== undefined) {
    parts.push(`eta=${humanDuration(progress.estimatedRemainingMs)}`)
  }
  if (progress.stage) parts.push(`[${progress.stage}]`)
  // Written directly so it stays one tidy column in a terminal.
  console.log('[study] ' + parts.join('  '))
}

/** Prompts for a location and writes text, returning the path or null. */
async function saveTextFile(
  window: BrowserWindow | null,
  defaultName: string,
  filters: { name: string; extensions: string[] }[],
  contents: string
): Promise<string | null> {
  const options = { defaultPath: defaultName, filters }
  const result = window
    ? await dialog.showSaveDialog(window, options)
    : await dialog.showSaveDialog(options)
  if (result.canceled || !result.filePath) return null
  writeFileSync(result.filePath, contents, 'utf8')
  log.info('exported file', { path: result.filePath, bytes: contents.length })
  return result.filePath
}

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

  handle(IPC.thetaSecretsStatus, () => services.thetaSecrets.status())
  handle(IPC.thetaSecretsSetApiKey, (key: string) => {
    const result = services.thetaSecrets.setApiKey(key)
    services.applySettings()
    return result
  })
  handle(IPC.thetaSecretsClear, () => {
    services.thetaSecrets.clearApiKey()
    services.applySettings()
  })
  handle(IPC.thetaTestConnection, () => services.thetaUpstream.testConnection())

  // --- Massive --------------------------------------------------------------
  handle(IPC.massiveTestConnection, () => services.upstream.testConnection())
  handle(IPC.massiveGetContracts, (query: ContractQuery) => services.provider.getContracts(query))
  handle(IPC.massiveGetOptionBars, (query: BarQuery) => services.provider.getOptionBars(query))
  handle(IPC.massiveGetUnderlyingBars, (query: BarQuery) => services.provider.getUnderlyingBars(query))

  // --- locked forward tests -------------------------------------------------
  handle(IPC.forwardTestCreate, async (request: CreateForwardTestRequest): Promise<ForwardTestDetail> => {
    const source = await services.studies.load(request.sourceRunId)
    if (!source) throw new Error(`Source study ${request.sourceRunId} was not found.`)

    const name = request.name.trim()
    if (!name) throw new Error('Give the forward test a name before locking it.')
    if (name.length > 120) throw new Error('Forward-test names must be 120 characters or fewer.')
    if (!Number.isInteger(request.targetSessions) || request.targetSessions < 10 || request.targetSessions > 252) {
      throw new Error('Target sessions must be a whole number between 10 and 252.')
    }
    const managements = [...new Set(request.managements)]
    if (managements.length === 0) throw new Error('Select at least one management method to lock.')
    const unavailable = managements.filter((id) => !source.config.managements.includes(id))
    if (unavailable.length > 0) {
      throw new Error(`The source study did not run these management methods: ${unavailable.join(', ')}.`)
    }

    const createdAt = Date.now()
    const startDate = nextTradingDay(marketDateOf(createdAt))
    const config: StudyConfig = {
      ...source.config,
      from: startDate,
      to: startDate,
      managements
    }
    const record: ForwardTestRecord = {
      forwardTestId: randomBytes(8).toString('hex'),
      name,
      createdAt,
      startDate,
      targetSessions: request.targetSessions,
      state: 'active',
      config,
      configHash: lockedConfigHash(config),
      appVersion: source.appVersion,
      ...(source.gitCommit ? { gitCommit: source.gitCommit } : {})
    }
    await services.forwardTests.create(record)
    return (await loadForwardDetail(services, record.forwardTestId))!
  })

  handle(IPC.forwardTestList, async (): Promise<ForwardTestSummary[]> => {
    const records = await services.forwardTests.list()
    return Promise.all(records.map(async (record) => forwardSummary(record, await services.forwardTests.runs(record.forwardTestId))))
  })

  handle(IPC.forwardTestLoad, (forwardTestId: string) => loadForwardDetail(services, forwardTestId))

  handle(IPC.forwardTestPlan, async (forwardTestId: string, through: string): Promise<ForwardRunPlan> => {
    const record = await services.forwardTests.load(forwardTestId)
    if (!record) throw new Error(`Forward test ${forwardTestId} was not found.`)
    if (record.state === 'complete') throw new Error('This forward test has already reached its session target.')

    const runs = await services.forwardTests.runs(forwardTestId)
    const range = planForwardRange({
      startDate: record.startDate,
      ...(runs.at(-1) ? { lastCompletedDate: runs.at(-1)!.to } : {}),
      completedSessions: runs.reduce((sum, run) => sum + run.sessions, 0),
      targetSessions: record.targetSessions,
      through,
      latestCompletedDate: latestMatureEntryDate(record.config)
    })
    return {
      forwardTestId,
      ...range,
      config: { ...record.config, from: range.from, to: range.to }
    }
  })

  handle(IPC.forwardTestAttachRun, async (forwardTestId: string, runId: string): Promise<ForwardTestDetail> => {
    const record = await services.forwardTests.load(forwardTestId)
    if (!record) throw new Error(`Forward test ${forwardTestId} was not found.`)
    const linked = await services.forwardTests.runs(forwardTestId)
    if (linked.some((run) => run.runId === runId)) return (await loadForwardDetail(services, forwardTestId))!
    if (record.state === 'complete') throw new Error('This forward test is complete and cannot accept another run.')

    const run = await services.studies.load(runId)
    if (!run) throw new Error(`Study run ${runId} was not found.`)
    if (lockedConfigHash(run.config) !== record.configHash) {
      throw new Error('The completed run does not match the locked configuration and was not attached.')
    }
    if (run.appVersion !== record.appVersion || (record.gitCommit && run.gitCommit !== record.gitCommit)) {
      throw new Error(
        `The completed run used app ${run.appVersion}${run.gitCommit ? ` (${run.gitCommit})` : ''}, ` +
          `but this lock requires ${record.appVersion}${record.gitCommit ? ` (${record.gitCommit})` : ''}. ` +
          'Create a new forward test after an engine update.'
      )
    }

    const expectedFrom = linked.at(-1) ? nextTradingDay(linked.at(-1)!.to) : record.startDate
    if (run.config.from !== expectedFrom) {
      throw new Error(`The next forward batch must begin on ${expectedFrom}, not ${run.config.from}.`)
    }
    const sessions = tradingDaysBetween(run.config.from, run.config.to).length
    const remaining = record.targetSessions - linked.reduce((sum, item) => sum + item.sessions, 0)
    if (sessions < 1 || sessions > remaining) {
      throw new Error(`The completed run contains ${sessions} sessions but only ${remaining} remain in the lock.`)
    }
    if (run.entriesAttempted !== sessions) {
      throw new Error(
        `The run evaluated ${run.entriesAttempted} of ${sessions} planned sessions. ` +
          'It may have been cancelled, so it was not attached.'
      )
    }

    await services.forwardTests.attachRun(
      forwardTestId,
      runId,
      run.config.from,
      run.config.to,
      sessions,
      sessions === remaining
    )
    return (await loadForwardDetail(services, forwardTestId))!
  })

  // --- studies --------------------------------------------------------------
  handle(IPC.studyPreflight, (config: StudyConfig): Promise<StudyPreflight> =>
    preflightStudy(config, buildStudySource(services))
  )

  handle(IPC.studyRun, async (config: StudyConfig, label?: string): Promise<StudyRunResult> => {
    if (activeStudy) throw new Error('A study is already running. Cancel it before starting another.')

    const controller = new AbortController()
    activeStudy = controller
    const source = buildStudySource(services, controller.signal)

    const providerRequests = (): number => services.queue.getStats().completed + services.thetaClient.completedRequests
    const requestsAtStart = providerRequests()
    const orchestrationStartedAt = Date.now()
    let lastSent = 0
    let lastLogged = 0
    let lastLoggedSession = -1

    try {
      const preparation = await prepareStudyData(
        config,
        resolveIndexTicker(config),
        services.provider,
        {
          signal: controller.signal,
          onProgress: (progress) => {
            const update: StudyProgress = {
              phase: 'preparing',
              completed: progress.completed,
              total: progress.total,
              ...(progress.currentDate ? { currentDate: progress.currentDate } : {}),
              stage: progress.stage,
              tradesGenerated: 0,
              skipped: 0,
              elapsedMs: Date.now() - orchestrationStartedAt,
              apiRequests: providerRequests() - requestsAtStart
            }
            const window = getWindow()
            if (window && !window.isDestroyed()) {
              window.webContents.send(IPC.studyProgressEvent, update)
            }
            logStudyLine(update, update.apiRequests ?? 0)
          }
        }
      )
      console.log(
        `[study] data ready  ${preparation.dailyBars} daily bars  ` +
          `${preparation.minuteBars} minute bars across ${preparation.minuteSessions} sessions`
      )

      // A pre-flight check first, so a run that cannot produce anything says so
      // immediately instead of an hour later.
      const preflightWindow = getWindow()
      if (preflightWindow && !preflightWindow.isDestroyed()) {
        preflightWindow.webContents.send(IPC.studyProgressEvent, {
          phase: 'preflight',
          completed: 0,
          total: 1,
          stage: 'verifying prepared cache',
          tradesGenerated: 0,
          skipped: 0,
          elapsedMs: Date.now() - orchestrationStartedAt,
          apiRequests: providerRequests() - requestsAtStart
        } satisfies StudyProgress)
      }
      const preflight = await preflightStudy(config, source)
      log.info('study preflight', {
        sessions: preflight.sessions,
        dailyBars: preflight.dailyBars,
        intradaySampled: preflight.underlyingMinuteSessions,
        blockers: preflight.blockers,
        warnings: preflight.warnings
      })
      for (const blocker of preflight.blockers) console.log('[study] BLOCKER: ' + blocker)
      for (const warning of preflight.warnings) console.log('[study] warning: ' + warning)
      if (preflight.blockers.length > 0) {
        throw new Error(preflight.blockers.join(' '))
      }
      console.log(
        `[study] starting ${config.from}..${config.to}  ${preflight.sessions} sessions  ` +
          `${config.managements.length} methods  ${preflight.dailyBars} daily bars cached`
      )

      const outcome = await runStudy(config, source, {
        signal: controller.signal,
        onSkip: ({ date, reason }) => {
          console.log(`[study]   skip ${date}: ${reason}`)
        },
        onProgress: (progress) => {
          const requests = providerRequests() - requestsAtStart
          const now = Date.now()

          // One terminal line per session, not per stage, so the log stays
          // readable while still proving the run is alive.
          if (progress.completed !== lastLoggedSession && now - lastLogged > 250) {
            lastLoggedSession = progress.completed
            lastLogged = now
            logStudyLine(progress, requests)
          }

          // The renderer is throttled harder: repainting faster than this makes
          // the page jitter without conveying anything extra.
          if (now - lastSent < 400) return
          lastSent = now
          const window = getWindow()
          if (window && !window.isDestroyed()) {
            window.webContents.send(IPC.studyProgressEvent, { ...progress, apiRequests: requests })
          }
        }
      })

      console.log(
        `[study] finished  ${outcome.series.length} entries  ${outcome.skipped.length} skipped  ` +
          `${humanDuration(outcome.elapsedMs)}  ${providerRequests() - requestsAtStart} requests`
      )
      for (const [reason, count] of Object.entries(outcome.skipReasons).sort((a, b) => b[1] - a[1])) {
        console.log(`[study]   ${String(count).padStart(4)} x ${reason}`)
      }

      const summaries: ManagementSummary[] = config.managements.map((id) => {
        const trades = outcome.trades.filter((t) => t.strategyId === id)
        return {
          strategyId: id,
          strategyLabel: trades[0]?.strategyLabel ?? id,
          metrics: computeMetrics(trades)
        }
      })

      const result: StudyRunResult = {
        runId: randomBytes(8).toString('hex'),
        createdAt: Date.now(),
        config,
        entryCount: outcome.series.length,
        entriesAttempted: outcome.entriesAttempted,
        skipped: outcome.skipped,
        summaries,
        trades: outcome.trades,
        sizing: 'oneContract',
        appVersion: app.getVersion(),
        ...(process.env.GIT_COMMIT ? { gitCommit: process.env.GIT_COMMIT } : {})
      }

      await services.studies.save(result, label)

      const window = getWindow()
      if (window && !window.isDestroyed()) {
        window.webContents.send(IPC.studyProgressEvent, {
          phase: controller.signal.aborted ? 'cancelled' : 'done',
          completed: outcome.entriesAttempted,
          total: outcome.entriesAttempted,
          tradesGenerated: outcome.series.length,
          skipped: outcome.skipped.length,
          skipReasons: outcome.skipReasons,
          elapsedMs: Date.now() - orchestrationStartedAt,
          apiRequests: providerRequests() - requestsAtStart
        })
      }

      return result
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      console.log('[study] FAILED: ' + message)
      const window = getWindow()
      if (window && !window.isDestroyed()) {
        window.webContents.send(IPC.studyProgressEvent, {
          phase: 'failed',
          completed: 0,
          total: 0,
          tradesGenerated: 0,
          skipped: 0,
          elapsedMs: Date.now() - orchestrationStartedAt,
          apiRequests: providerRequests() - requestsAtStart,
          error: message
        })
      }
      throw error
    } finally {
      activeStudy = null
    }
  })

  handle(IPC.studyCancel, () => {
    activeStudy?.abort()
  })

  handle(IPC.studyList, (limit?: number) => services.studies.list(limit))
  handle(IPC.studyLoad, async (runId: string) => {
    const run = await services.studies.load(runId)
    if (!run) return null
    // Summaries are recomputed on load so a change to the metric definitions
    // applies to historic runs rather than freezing an old interpretation.
    const ids = [...new Set(run.trades.map((t) => t.strategyId))]
    run.summaries = ids.map((id) => {
      const trades = run.trades.filter((t) => t.strategyId === id)
      return {
        strategyId: id,
        strategyLabel: trades[0]?.strategyLabel ?? id,
        metrics: computeMetrics(trades)
      }
    })
    return run
  })
  handle(IPC.studyDelete, (runId: string) => services.studies.remove(runId))

  handle(IPC.studyAnalytics, async (runId: string, strategyId: string) => {
    const run = await services.studies.load(runId)
    if (!run) throw new Error(`Run ${runId} was not found.`)
    return buildAnalyticsReport(run.trades, strategyId)
  })

  handle(IPC.studyExportTrades, async (runId: string): Promise<string | null> => {
    const run = await services.studies.load(runId)
    if (!run) throw new Error(`Run ${runId} was not found.`)
    return saveTextFile(
      getWindow(),
      `trades-${runId}.csv`,
      [{ name: 'CSV', extensions: ['csv'] }],
      tradesToCsv(runId, run.trades)
    )
  })

  handle(IPC.studyExportJson, async (runId: string): Promise<string | null> => {
    const run = await services.studies.load(runId)
    if (!run) throw new Error(`Run ${runId} was not found.`)
    const ids = [...new Set(run.trades.map((t) => t.strategyId))]
    run.summaries = ids.map((id) => {
      const trades = run.trades.filter((t) => t.strategyId === id)
      return { strategyId: id, strategyLabel: trades[0]?.strategyLabel ?? id, metrics: computeMetrics(trades) }
    })
    return saveTextFile(
      getWindow(),
      studyJsonFilename(runId, run.createdAt),
      [{ name: 'JSON', extensions: ['json'] }],
      studyToJson(run)
    )
  })

  // --- parameter sweep ------------------------------------------------------
  handle(IPC.sweepEstimate, (axes: SweepAxis[]) => estimateSweepCost(axes))

  handle(IPC.sweepRun, async (
    base: StudyConfig,
    axes: SweepAxis[],
    objective: string
  ): Promise<SweepResult[]> => {
    if (activeStudy) throw new Error('A study is already running. Cancel it before starting a sweep.')

    const points = expandSweep(base, axes)
    const controller = new AbortController()
    activeStudy = controller
    const results: SweepResult[] = []

    try {
      for (const point of points) {
        if (controller.signal.aborted) break

        const outcome = await runStudy(point.config, buildStudySource(services), {
          signal: controller.signal,
          onProgress: (progress) => {
            const window = getWindow()
            if (window && !window.isDestroyed()) {
              window.webContents.send(IPC.studyProgressEvent, {
                ...progress,
                // Report sweep position so the UI can show combination N of M.
                currentDate: `${point.index + 1}/${points.length} · ${progress.currentDate ?? ''}`
              })
            }
          }
        })

        const all = [...new Set(outcome.trades.map((t) => t.strategyId))].map((id) => {
          const trades = outcome.trades.filter((t) => t.strategyId === id)
          return {
            strategyId: id,
            strategyLabel: trades[0]?.strategyLabel ?? id,
            metrics: computeMetrics(trades)
          }
        })

        const best = all.length > 0
          ? all.reduce((a, b) => (scoreObjective(b.metrics, objective) > scoreObjective(a.metrics, objective) ? b : a))
          : null

        const runResult: StudyRunResult = {
          runId: randomBytes(8).toString('hex'),
          createdAt: Date.now(),
          config: point.config,
          entryCount: outcome.series.length,
          entriesAttempted: outcome.entriesAttempted,
          skipped: outcome.skipped,
          summaries: all,
          trades: outcome.trades,
          sizing: 'oneContract',
          appVersion: app.getVersion(),
          ...(process.env.GIT_COMMIT ? { gitCommit: process.env.GIT_COMMIT } : {})
        }
        await services.studies.save(runResult, `sweep ${JSON.stringify(point.values)}`)

        results.push({
          index: point.index,
          values: point.values,
          runId: runResult.runId,
          entryCount: outcome.series.length,
          best,
          all
        })
      }
      return results
    } finally {
      activeStudy = null
    }
  })

  // --- put-call parity validation -------------------------------------------
  handle(IPC.parityValidate, async (request: ParityValidationRequest): Promise<ParityValidationResponse> => {
    const requestsBefore = services.queue.getStats().completed + services.thetaClient.completedRequests
    const sessions = tradingDaysBetween(request.from, request.to)
    const skipped: { date: string; reason: string }[] = []
    const sessionsUsed: string[] = []
    const samples: ParitySample[] = []
    const strikesRequested = new Set<number>()
    const minuteShape = { timespan: 'minute', multiplier: 1 }

    const [calls, puts] = await Promise.all([
      services.provider.getContracts({
        underlying: request.underlying, expirationDate: request.expiration, type: 'call', expired: true
      }),
      services.provider.getContracts({
        underlying: request.underlying, expirationDate: request.expiration, type: 'put', expired: true
      })
    ])

    const rootMatches = (root?: string): boolean =>
      !request.preferredRoot || (root ?? '').toUpperCase() === request.preferredRoot.toUpperCase()

    const callByStrike = new Map(calls.filter((c) => rootMatches(c.root)).map((c) => [c.strike, c]))
    const putByStrike = new Map(puts.filter((c) => rootMatches(c.root)).map((c) => [c.strike, c]))
    const availableStrikes = [...callByStrike.keys()]
      .filter((k) => putByStrike.has(k))
      .sort((a, b) => a - b)

    if (availableStrikes.length === 0) {
      throw new Error('No strike has both a call and a put for this expiration and root.')
    }

    const expiryClose = sessionClose(request.expiration)
    const policy = { mode: 'carryForward' as const, maxStaleMinutes: request.maxStaleMinutes }

    for (const date of sessions) {
      // Ground truth. Without it this session can prove nothing.
      const actualBars = await services.store.getUnderlyingBars('I:SPX', [date], minuteShape)
      if (actualBars.length === 0) {
        skipped.push({ date, reason: 'no real index minute data cached' })
        continue
      }

      /*
       * Strikes are chosen from where the index actually was. Using ground truth
       * for that is legitimate here: the question is how accurate parity is at
       * the money, not how a strike would be picked live.
       */
      const midpoint = actualBars[Math.floor(actualBars.length / 2)]!.close
      const nearest = availableStrikes.reduce((best, k) =>
        Math.abs(k - midpoint) < Math.abs(best - midpoint) ? k : best
      )
      const centerIndex = availableStrikes.indexOf(nearest)
      const chosen = availableStrikes.slice(
        Math.max(0, centerIndex - request.strikesPerSide),
        centerIndex + request.strikesPerSide + 1
      )
      for (const k of chosen) strikesRequested.add(k)

      const legs: { strike: number; call: LegSeries; put: LegSeries }[] = []
      for (const strike of chosen) {
        const callContract = callByStrike.get(strike)!
        const putContract = putByStrike.get(strike)!
        const [callBars, putBars] = await Promise.all([
          services.provider.getOptionBars({
            ticker: callContract.ticker, from: date, to: date, timespan: 'minute'
          }),
          services.provider.getOptionBars({
            ticker: putContract.ticker, from: date, to: date, timespan: 'minute'
          })
        ])
        legs.push({
          strike,
          call: buildLegSeries('lower', callContract.ticker, callBars.bars),
          put: buildLegSeries('upper', putContract.ticker, putBars.bars)
        })
      }

      const actualByMinute = indexUnderlyingByMinute(actualBars)
      const timestamps = actualBars.map((b) => b.timestamp)
      let sessionSamples = 0

      for (const minute of sessionMinuteGrid(Math.min(...timestamps), Math.max(...timestamps))) {
        const actual = actualByMinute.get(minute)
        if (actual === undefined) continue

        const quotes: ParityQuote[] = []
        for (const leg of legs) {
          const call = resolveLegQuote(leg.call.ticker, minute, leg.call.index, leg.call.minutes, 'close', policy)
          const put = resolveLegQuote(leg.put.ticker, minute, leg.put.index, leg.put.minutes, 'close', policy)
          if (!call || !put) continue
          quotes.push({
            strike: leg.strike,
            callPrice: call.price,
            putPrice: put.price,
            callAgeMs: call.ageMs,
            putAgeMs: put.ageMs
          })
        }
        if (quotes.length === 0) continue

        const yearsToExpiry = yearsBetween(minute, expiryClose)
        const estimate = estimateFromParity(quotes, { yearsToExpiry })
        if (!estimate) continue

        samples.push({ timestamp: minute, estimate, actual, yearsToExpiry })
        sessionSamples++
      }

      if (sessionSamples === 0) {
        skipped.push({ date, reason: 'no minute had both a call and a put priced' })
      } else {
        sessionsUsed.push(date)
      }
    }

    // The denominator is the real index minutes available, since those bound
    // what could possibly have been compared.
    let expectedMinutes = 0
    for (const date of sessionsUsed) {
      expectedMinutes += (await services.store.getUnderlyingBars('I:SPX', [date], minuteShape)).length
    }

    const report = buildParityReport(samples, expectedMinutes)
    log.info('parity validation complete', {
      sessions: sessionsUsed.length,
      samples: samples.length,
      rawRms: report.raw.rms,
      calibratedRms: report.calibrated?.rms,
      fittedCarry: report.fittedCarryRate
    })

    return {
      report,
      sessionsUsed,
      skipped,
      strikesRequested: [...strikesRequested].sort((a, b) => a - b),
      apiRequests: services.queue.getStats().completed + services.thetaClient.completedRequests - requestsBefore
    }
  })

  // --- butterfly reconstruction ---------------------------------------------
  handle(IPC.butterflyChain, async (
    underlying: string,
    expiration: string,
    optionType: 'call' | 'put'
  ): Promise<ChainSummary> => {
    const contracts = await services.provider.getContracts({
      underlying,
      expirationDate: expiration,
      type: optionType,
      expired: true
    })
    return {
      expiration,
      contracts,
      roots: availableRoots(contracts),
      strikes: [...new Set(contracts.map((c) => c.strike))].sort((a, b) => a - b)
    }
  })

  handle(IPC.butterflyReconstruct, async (request: ReconstructRequest): Promise<ReconstructResponse> => {
    const chain = await services.provider.getContracts({
      underlying: request.underlying,
      expirationDate: request.expiration,
      type: request.optionType,
      expired: true
    })

    // Throws rather than guessing when SPX and SPXW both list a strike.
    const definition = buildButterfly(
      {
        underlying: request.underlying,
        expiration: request.expiration,
        optionType: request.optionType,
        lowerStrike: request.lowerStrike,
        centerStrike: request.centerStrike,
        upperStrike: request.upperStrike,
        ...(request.preferredRoot ? { preferredRoot: request.preferredRoot } : {}),
        quantity: request.quantity
      },
      chain
    )

    const time = parseTimeOfDay(request.entryTime)
    const entryTimestamp = easternToTimestamp(request.entryDate, time.hour, time.minute)
    const exitTimestamp = sessionClose(request.expiration)

    /*
     * One request per leg covers the trade's whole life, because the cache
     * batches contiguous missing days into a single upstream call. On a cold
     * cache that is three Massive calls; warm, it is none.
     */
    const [lower, center, upper] = await Promise.all([
      services.provider.getOptionBars({
        ticker: definition.lowerTicker, from: request.entryDate, to: request.expiration, timespan: 'minute'
      }),
      services.provider.getOptionBars({
        ticker: definition.centerTicker, from: request.entryDate, to: request.expiration, timespan: 'minute'
      }),
      services.provider.getOptionBars({
        ticker: definition.upperTicker, from: request.entryDate, to: request.expiration, timespan: 'minute'
      })
    ])

    // Underlying is read cache-only: index data is not entitled upstream, so a
    // fetch here would spend a request to earn an HTTP 403.
    const underlyingBars = await services.store.getUnderlyingBars(
      'I:SPX',
      tradingDaysBetween(request.entryDate, request.expiration),
      { timespan: 'minute', multiplier: 1 }
    )

    const missingData: MissingDataPolicy =
      request.missingDataMode === 'strict'
        ? { mode: 'strict' }
        : { mode: 'carryForward', maxStaleMinutes: request.maxStaleMinutes }

    const series = reconstructButterfly({
      definition,
      legBars: { lower: lower.bars, center: center.bars, upper: upper.bars },
      underlyingBars,
      entryTimestamp,
      exitTimestamp,
      pricing: { model: request.pricingModel, slippage: request.slippage, missingData }
    })

    log.info('butterfly reconstructed', {
      center: definition.centerStrike,
      width: definition.wingWidth,
      entry: request.entryDate,
      expiration: request.expiration,
      debit: series.entryDebit,
      observations: series.observations.length,
      coverage: series.quality.coverage
    })

    /*
     * Every management method runs against this one reconstructed series, so
     * they cannot diverge on entry price, timing, or data quality. That shared
     * basis is what makes the comparison meaningful rather than decorative.
     */
    const strategies: ExitStrategy[] = [
      holdToExpiration(),
      profitTarget(25),
      profitTarget(50),
      profitTarget(100),
      profitTarget(200),
      stopLoss(50),
      targetWithStop(100, 50),
      targetWithStop(200, 50),
      trailingProfit({ triggerPct: 100, givebackFractionOfPeak: 0.3 }),
      centerTouch(),
      tentEntry(0.5),
      timeExit({ atDte: 2 }),
      timeExit({ atDte: 1 })
    ]

    return {
      series,
      excursions: computeExcursions(series.observations),
      managements: simulateAll(series, strategies),
      legBarCounts: { lower: lower.bars.length, center: center.bars.length, upper: upper.bars.length },
      hasUnderlying: underlyingBars.length > 0
    }
  })

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
  handle(IPC.underlyingDownloadMassive, async (request: SchwabBackfillRequest): Promise<SchwabBackfillResult> => {
    const before = services.queue.getStats().completed
    const sessions = tradingDaysBetween(request.from, request.to)
    if (sessions.length === 0) {
      throw new Error(`No trading days between ${request.from} and ${request.to}.`)
    }

    /*
     * Chunked by month rather than issued as one span. A year of index minutes
     * is ~97,000 bars, past the documented 50,000-per-response limit, and at
     * five calls per minute a resumable sequence of small requests is far
     * better than one oversized one. The cache skips any month already held,
     * so re-running after an interruption costs nothing for completed months.
     */
    const chunks: { from: string; to: string }[] = []
    for (let i = 0; i < sessions.length; i += 21) {
      chunks.push({ from: sessions[i]!, to: sessions[Math.min(i + 20, sessions.length - 1)]! })
    }

    let barsWritten = 0
    const datesWritten = new Set<string>()

    for (const chunk of chunks) {
      const result = await services.provider.getUnderlyingBars({
        ticker: request.ticker,
        from: chunk.from,
        to: chunk.to,
        timespan: request.timespan
      })
      barsWritten += result.bars.length
      for (const bar of result.bars) datesWritten.add(marketDateOf(bar.timestamp))
    }

    const sorted = [...datesWritten].sort()
    log.info('underlying downloaded from Massive', {
      ticker: request.ticker,
      timespan: request.timespan,
      chunks: chunks.length,
      bars: barsWritten,
      sessions: sorted.length
    })

    return {
      ticker: request.ticker,
      timespan: request.timespan,
      barsWritten,
      sessionsWritten: sorted.length,
      dateRange: sorted.length > 0 ? { from: sorted[0]!, to: sorted[sorted.length - 1]! } : null,
      requests: services.queue.getStats().completed - before
    }
  })

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

  handle(IPC.underlyingCachedBars, (ticker: string, from: string, to: string, timespan?: string) => {
    // Cache-only by design: index data is not entitled on the Options plans, so
    // reaching upstream here would burn a request to earn an HTTP 403.
    return services.store.getUnderlyingBars(ticker, tradingDaysBetween(from, to), {
      timespan: timespan ?? 'minute',
      multiplier: 1
    })
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

  handle(IPC.databaseBackup, async (): Promise<DatabaseBackupResult | null> => {
    if (activeStudy) throw new Error('Wait for the running study to finish before creating a backup.')
    const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z').replace('T', '-')
    const backupDialogOptions = {
      title: 'Back up all Backtestsmith data',
      defaultPath: join(app.getPath('documents'), `backtestsmith-data-${stamp}.duckdb`),
      filters: [{ name: 'DuckDB database', extensions: ['duckdb'] }],
      properties: ['createDirectory', 'showOverwriteConfirmation']
    } satisfies Electron.SaveDialogOptions
    const window = getWindow()
    const result = window
      ? await dialog.showSaveDialog(window, backupDialogOptions)
      : await dialog.showSaveDialog(backupDialogOptions)
    if (result.canceled || !result.filePath) return null
    const backup = await services.database.backupTo(result.filePath)
    shell.showItemInFolder(backup.path)
    return backup
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
