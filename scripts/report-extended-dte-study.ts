import { join } from 'node:path'
import { computeMetrics } from '../src/backtest/metrics.js'
import { marketDateOf } from '../src/core/time/marketTime.js'
import { Database } from '../src/database/duckdb.js'
import { StudyStore } from '../src/database/studyStore.js'
import { normalizeSkipReason, type StudyRunResult } from '../src/shared/study.js'

function metrics(run: StudyRunResult, strategyId: string, dates?: Set<string>) {
  const trades = run.trades.filter((trade) =>
    trade.strategyId === strategyId && (!dates || dates.has(marketDateOf(trade.entryTimestamp)))
  )
  const value = computeMetrics(trades)
  return {
    trades: trades.length,
    totalPnl: value.totalPnl,
    expectancy: value.expectancy,
    winRate: value.winRate,
    profitFactor: value.profitFactor,
    maxDrawdown: value.maxDrawdown,
    averageHoldingMinutes: value.averageHoldingMinutes
  }
}

async function main(): Promise<void> {
  const db = new Database(join(process.env.APPDATA ?? '', 'backtestsmith', 'data', 'market-data.duckdb'))
  await db.open()
  try {
    const store = new StudyStore(db)
    const summaries = await store.list(100)
    const targetDtes = [7, 11, 15, 19, 23]
    const selected = targetDtes.map((targetDte) => summaries.find((run) =>
      run.label?.startsWith(`extended DTE ${targetDte} `) &&
      run.config.pricing.maxStaleMinutes === 3 &&
      run.config.to === '2026-07-10'
    )).filter((run): run is NonNullable<typeof run> => run !== undefined)
    const runs = (await Promise.all(selected.map((summary) => store.load(summary.runId))))
      .filter((run): run is StudyRunResult => run !== null)
      .sort((a, b) => a.config.targetDte - b.config.targetDte)

    if (runs.length !== targetDtes.length) {
      throw new Error(`Expected ${targetDtes.length} extended-DTE runs; found ${runs.length}.`)
    }
    const entryDates = (run: StudyRunResult) => new Set(
      run.trades.filter((trade) => trade.strategyId === 'hold').map((trade) => marketDateOf(trade.entryTimestamp))
    )
    const dateSets = runs.map(entryDates)
    const matched = new Set([...dateSets[0]!].filter((date) => dateSets.every((dates) => dates.has(date))))

    const output = {
      runs: runs.map((run) => ({
        runId: run.runId,
        targetDte: run.config.targetDte,
        from: run.config.from,
        to: run.config.to,
        maxStaleMinutes: run.config.pricing.maxStaleMinutes,
        entryCount: run.entryCount,
        entriesAttempted: run.entriesAttempted,
        skips: Object.entries(run.skipped.reduce<Record<string, number>>((counts, skip) => {
          const reason = normalizeSkipReason(skip.reason)
          counts[reason] = (counts[reason] ?? 0) + 1
          return counts
        }, {})).sort((a, b) => b[1] - a[1]),
        metrics: Object.fromEntries(run.config.managements.map((id) => [id, metrics(run, id)]))
      })),
      matchedSessions: matched.size,
      matchedMetrics: Object.fromEntries(runs.map((run) => [
        String(run.config.targetDte),
        Object.fromEntries(run.config.managements.map((id) => [id, metrics(run, id, matched)]))
      ]))
    }
    console.log(JSON.stringify(output, null, 2))
  } finally {
    await db.close()
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error))
  process.exitCode = 1
})
