import { randomBytes } from 'node:crypto'
import { join } from 'node:path'
import { app } from 'electron'
import { computeMetrics } from '../src/backtest/metrics.js'
import { preflightStudy, runStudy, type StudyDataSource } from '../src/backtest/studyRunner.js'
import { prepareStudyData } from '../src/backtest/studyPreparation.js'
import { tradingDaysBetween } from '../src/core/time/marketTime.js'
import { disposeServices, initServices, type AppServices } from '../src/electron/main/services.js'
import { resolveIndexTicker, type ManagementSummary, type StudyConfig, type StudyRunResult } from '../src/shared/study.js'

const ENTRY_END = '2026-07-10'
const DEFAULT_TARGET_DTES = [19, 23]
const MAX_STALE_MINUTES = 3
const MANAGEMENTS = ['hold', 'tp150', 'tp200', 'tp300']

function buildSource(services: AppServices, signal: AbortSignal): StudyDataSource {
  const minuteShape = { timespan: 'minute' as const, multiplier: 1 }
  const dailyShape = { timespan: 'day' as const, multiplier: 1 }
  return {
    getDailyBars: async (ticker, from, to) =>
      (await services.provider.getUnderlyingBars({ ticker, from, to, timespan: 'day' }, { signal, priority: 10 })).bars,
    getUnderlyingMinutes: async (ticker, date) =>
      (await services.provider.getUnderlyingBars({ ticker, from: date, to: date, timespan: 'minute' }, { signal, priority: 10 })).bars,
    getChain: (underlying, expiration, type) =>
      services.provider.getContracts(
        { underlying, expirationDate: expiration, type, expired: true },
        { signal, priority: 20 }
      ),
    getOptionBars: async (ticker, from, to) =>
      (await services.provider.getOptionBars({ ticker, from, to, ...minuteShape }, { signal, priority: 20 })).bars
  }
}

function cloneConfig(base: StudyConfig, targetDte: number): StudyConfig {
  return {
    ...base,
    to: ENTRY_END,
    targetDte,
    pricing: {
      ...base.pricing,
      missingDataMode: 'carryForward',
      maxStaleMinutes: MAX_STALE_MINUTES
    },
    managements: [...MANAGEMENTS],
    strategyParams: {
      ...base.strategyParams,
      targetDte
    }
  }
}

function formatMetrics(summary: ManagementSummary): string {
  const m = summary.metrics
  return `${summary.strategyId}: P/L $${m.totalPnl.toFixed(2)}, EV $${m.expectancy.toFixed(2)}, ` +
    `win ${(m.winRate * 100).toFixed(1)}%, PF ${m.profitFactor?.toFixed(2) ?? 'n/a'}, DD $${m.maxDrawdown.toFixed(2)}`
}

async function runOne(services: AppServices, base: StudyConfig, targetDte: number): Promise<StudyRunResult> {
  const config = cloneConfig(base, targetDte)
  const controller = new AbortController()
  const source = buildSource(services, controller.signal)
  const sessions = tradingDaysBetween(config.from, config.to).length

  console.log(`\n[extended-dte] preparing ${targetDte} DTE (${sessions} sessions, stale <= ${MAX_STALE_MINUTES}m)`)
  await prepareStudyData(config, resolveIndexTicker(config), services.provider, {
    signal: controller.signal,
    onProgress: (progress) => console.log(
      `[extended-dte] prep ${progress.completed}/${progress.total} ${progress.stage}`
    )
  })

  const preflight = await preflightStudy(config, source)
  for (const warning of preflight.warnings) console.log(`[extended-dte] warning: ${warning}`)
  if (preflight.blockers.length > 0) throw new Error(preflight.blockers.join(' '))

  let lastReported = -1
  const outcome = await runStudy(config, source, {
    signal: controller.signal,
    onSkip: ({ date, reason }) => console.log(`[extended-dte] skip ${date}: ${reason}`),
    onProgress: (progress) => {
      if (progress.completed === lastReported) return
      lastReported = progress.completed
      console.log(
        `[extended-dte] ${targetDte} DTE ${progress.completed}/${progress.total} ` +
        `${progress.currentDate ?? ''} | entries ${progress.tradesGenerated} | skipped ${progress.skipped}`
      )
    }
  })

  const summaries: ManagementSummary[] = config.managements.map((strategyId) => {
    const trades = outcome.trades.filter((trade) => trade.strategyId === strategyId)
    return {
      strategyId,
      strategyLabel: trades[0]?.strategyLabel ?? strategyId,
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

  const label = `extended DTE ${targetDte} | 20-wide | ${config.from}..${config.to} | stale<=${MAX_STALE_MINUTES}m`
  await services.studies.save(result, label)
  console.log(`[extended-dte] saved ${targetDte} DTE as ${result.runId}: ${result.entryCount}/${result.entriesAttempted} entries`)
  for (const summary of summaries) console.log(`[extended-dte] ${formatMetrics(summary)}`)
  return result
}

async function main(): Promise<void> {
  const services = await initServices()
  const runs = await services.studies.list(200)
  const baseline = runs.find((run) =>
    run.config.strategyId === 'ema-swing-butterfly' &&
    run.config.targetDte === 19 &&
    run.config.wingWidth === 20 &&
    run.config.pricing.missingDataMode === 'carryForward' &&
    run.config.pricing.maxStaleMinutes === 1
  )
  if (!baseline) throw new Error('Could not find the existing 19-DTE, 20-wide sweep baseline in the study database.')

  const requested = process.argv.slice(2).map(Number)
  const targetDtes = requested.length > 0 ? requested : DEFAULT_TARGET_DTES
  if (targetDtes.some((value) => !Number.isInteger(value) || value < 0)) {
    throw new Error(`DTE arguments must be non-negative integers; received ${process.argv.slice(2).join(', ')}.`)
  }

  console.log(`[extended-dte] baseline ${baseline.runId}, ${baseline.config.from}..${baseline.config.to}`)
  console.log(`[extended-dte] requested DTEs: ${targetDtes.join(', ')}`)
  for (const targetDte of targetDtes) await runOne(services, baseline.config, targetDte)
}

app.setName('backtestsmith')
app.setPath('userData', join(app.getPath('appData'), 'backtestsmith'))
app.disableHardwareAcceleration()
app.whenReady()
  .then(main)
  .then(async () => {
    await disposeServices()
    app.quit()
  })
  .catch(async (error) => {
    console.error('[extended-dte] FAILED:', error instanceof Error ? error.stack ?? error.message : String(error))
    await disposeServices().catch(() => undefined)
    app.exit(1)
  })
