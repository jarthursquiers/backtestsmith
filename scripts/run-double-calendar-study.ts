import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { computeMetrics, median } from '../src/backtest/metrics.js'
import {
  DEFAULT_CALENDAR_STUDY,
  runDoubleCalendarStudy,
  type CalendarDataSource,
  type CalendarStudyOutcome,
  type DoubleCalendarStudyConfig
} from '../src/backtest/calendarStudy.js'
import type { CalendarTradeResult } from '../src/backtest/simulateCalendar.js'
import { calendarSourceFrom, MarketArchive } from '../src/data/archiveSource.js'
import { DEFAULT_CALENDAR_EXECUTION } from '../src/domain/doubleCalendar.js'
import type { StudyMetrics } from '../src/shared/metrics.js'

/**
 * The double calendar study.
 *
 * Runs entirely off the local archive - no provider, no rate limit - because
 * every contract it needs is already cached. See `src/data/archiveSource.ts`.
 *
 *   npm run study:calendar -- --from 2025-08-25 --to 2026-07-27
 *
 * Scenarios are selected with `--scenarios`; `core` alone is the fast path
 * while the rest answer the surrounding questions - is 30 delta the right
 * delta, is 14/21 the right pair of expirations, does the ranking survive a
 * worse fill assumption, and does it survive being run on every session rather
 * than only on Mondays.
 */

/**
 * The management rules under test.
 *
 * Every rule is evaluated against the identical set of reconstructed positions,
 * so differences between them are differences in the rule and nothing else.
 * Targets are a percentage of the debit paid: a calendar has no defined maximum
 * profit for a "percent of max" to refer to, and the debit is the capital
 * genuinely at risk.
 */
const MANAGEMENTS = [
  'hold',

  // Flat profit targets, spanning the range calendars are actually managed in.
  'tp10',
  'tp15',
  'tp20',
  'tp25',
  'tp30',
  'tp40',
  'tp50',

  // Stops alone, to separate what the stop does from what the target does.
  'sl25',
  'sl50',

  // Targets paired with stops.
  'tp15-sl50',
  'tp20-sl40',
  'tp25-sl25',
  'tp25-sl50',
  'tp25-sl100',
  'tp30-sl60',
  'tp50-sl50',
  'tp50-sl100',

  // Scheduled exits before the short expires.
  'dte7',
  'dte5',
  'dte3',
  'dte1',
  'day3',
  'day5',
  'day7',

  // The structural rule: leave when the index leaves the tent.
  'breach-25',
  'breach',
  'breach+25',

  // Target or stop, plus the structural rule.
  'tp25+breach',
  'tp50+breach',
  'tp25-sl50+breach',

  // Trailing.
  'trail15-50pct',
  'trail25-30pct',
  'trail25-50pct',
  'trail40-50pct'
] as const

interface Scenario {
  key: string
  label: string
  config: DoubleCalendarStudyConfig
}

interface ScenarioResult {
  key: string
  label: string
  config: DoubleCalendarStudyConfig
  entries: number
  sessionsConsidered: number
  skipReasons: Record<string, number>
  entrySummary: EntrySummary
  rows: ManagementRow[]
}

interface EntrySummary {
  medianDebit: number
  medianTentWidth: number
  medianFrontIv: number
  medianBackIv: number
  /** Front minus back implied volatility, in points of volatility. */
  medianTermSpread: number
  medianSpreadPoints: number
  /** Share of positions the index left the tent at some point, in percent. */
  breachedPct: number
}

interface ManagementRow {
  id: string
  label: string
  metrics: StudyMetrics
  /** Median trade P/L as a percentage of the debit. */
  medianReturnPct: number
  averageReturnPct: number
  averageSessionsHeld: number
  exitReasons: Record<string, number>
}

function parseArgs(argv: readonly string[]): Record<string, string> {
  const args: Record<string, string> = {}
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]!
    if (!token.startsWith('--')) continue
    const [name, inline] = token.slice(2).split('=')
    if (inline !== undefined) args[name!] = inline
    else if (argv[i + 1] && !argv[i + 1]!.startsWith('--')) args[name!] = argv[++i]!
    else args[name!] = 'true'
  }
  return args
}

function baseConfig(from: string, to: string): DoubleCalendarStudyConfig {
  return { ...DEFAULT_CALENDAR_STUDY, from, to, managements: [...MANAGEMENTS] }
}

function buildScenarios(from: string, to: string, groups: ReadonlySet<string>): Scenario[] {
  const base = baseConfig(from, to)
  const scenarios: Scenario[] = []

  if (groups.has('core')) {
    scenarios.push({ key: 'core', label: 'Monday entry, 30 delta, 14/21 DTE, half-spread fills', config: base })
  }

  if (groups.has('delta')) {
    for (const delta of [0.2, 0.25, 0.35, 0.4]) {
      scenarios.push({
        key: `delta-${Math.round(delta * 100)}`,
        label: `Short strikes at ${Math.round(delta * 100)} delta`,
        config: { ...base, targetDelta: delta }
      })
    }
  }

  if (groups.has('dte')) {
    for (const [front, back] of [
      [7, 14],
      [14, 28],
      [21, 28],
      [7, 21]
    ] as const) {
      scenarios.push({
        key: `dte-${front}-${back}`,
        label: `${front} DTE short against ${back} DTE long`,
        config: { ...base, frontTargetDte: front, backTargetDte: back }
      })
    }
  }

  if (groups.has('friction')) {
    for (const fraction of [0, 1]) {
      scenarios.push({
        key: `friction-${fraction}`,
        label: fraction === 0 ? 'Midpoint fills (no spread paid)' : 'Full-spread fills (worst case)',
        config: {
          ...base,
          execution: { ...DEFAULT_CALENDAR_EXECUTION, spreadFraction: fraction }
        }
      })
    }
  }

  if (groups.has('weekday')) {
    for (const [weekday, name] of [
      [2, 'Tuesday'],
      [3, 'Wednesday'],
      [4, 'Thursday'],
      [5, 'Friday']
    ] as const) {
      scenarios.push({
        key: `weekday-${weekday}`,
        label: `${name} entry`,
        config: { ...base, entryWeekdays: [weekday] }
      })
    }
  }

  if (groups.has('daily')) {
    scenarios.push({
      key: 'daily',
      label: 'Every session (overlapping), as a robustness check on the ranking',
      config: { ...base, entryWeekdays: [] }
    })
  }

  if (groups.has('entrytime')) {
    for (const time of ['09:45', '11:00', '14:00', '15:30']) {
      scenarios.push({
        key: `time-${time.replace(':', '')}`,
        label: `Entry at ${time} ET`,
        config: { ...base, entryTime: time }
      })
    }
  }

  return scenarios
}

function summarizeEntries(outcome: CalendarStudyOutcome): EntrySummary {
  const series = outcome.series
  const pick = (fn: (s: (typeof series)[number]) => number | undefined): number =>
    median(series.map(fn).filter((v): v is number => v !== undefined && Number.isFinite(v)))

  const held = outcome.trades.filter((t) => t.strategyId === 'hold')
  const breached = held.filter((t) => (t.maxBreachPoints ?? -1) >= 0).length

  const frontIv = pick((s) => (s.entryContext.putIv + s.entryContext.callIv) / 2)
  const backIv = pick((s) =>
    s.entryContext.putBackIv !== undefined && s.entryContext.callBackIv !== undefined
      ? (s.entryContext.putBackIv + s.entryContext.callBackIv) / 2
      : undefined
  )

  return {
    medianDebit: pick((s) => s.entryCost),
    medianTentWidth: pick((s) => s.entryContext.tentWidth),
    medianFrontIv: frontIv,
    medianBackIv: backIv,
    medianTermSpread: frontIv - backIv,
    medianSpreadPoints: pick((s) => s.entryAudit?.spread),
    breachedPct: held.length > 0 ? (breached / held.length) * 100 : 0
  }
}

function summarizeManagement(id: string, trades: readonly CalendarTradeResult[]): ManagementRow {
  const exitReasons: Record<string, number> = {}
  for (const trade of trades) {
    exitReasons[trade.exitReason] = (exitReasons[trade.exitReason] ?? 0) + 1
  }

  return {
    id,
    label: trades[0]?.strategyLabel ?? id,
    metrics: computeMetrics(trades),
    medianReturnPct: median(trades.map((t) => t.pnlPct)),
    averageReturnPct:
      trades.length > 0 ? trades.reduce((sum, t) => sum + t.pnlPct, 0) / trades.length : 0,
    averageSessionsHeld:
      trades.length > 0 ? trades.reduce((sum, t) => sum + t.sessionsHeld, 0) / trades.length : 0,
    exitReasons
  }
}

function toResult(scenario: Scenario, outcome: CalendarStudyOutcome): ScenarioResult {
  const byStrategy = new Map<string, CalendarTradeResult[]>()
  for (const trade of outcome.trades) {
    const bucket = byStrategy.get(trade.strategyId)
    if (bucket) bucket.push(trade)
    else byStrategy.set(trade.strategyId, [trade])
  }

  return {
    key: scenario.key,
    label: scenario.label,
    config: scenario.config,
    entries: outcome.series.length,
    sessionsConsidered: outcome.sessionsConsidered,
    skipReasons: outcome.skipReasons,
    entrySummary: summarizeEntries(outcome),
    rows: [...byStrategy.entries()].map(([id, trades]) => summarizeManagement(id, trades))
  }
}

// --- reporting ---------------------------------------------------------------

function pad(value: string, width: number, align: 'left' | 'right' = 'left'): string {
  return align === 'left' ? value.padEnd(width) : value.padStart(width)
}

function money(value: number): string {
  return `${value < 0 ? '-' : ''}$${Math.abs(value).toFixed(0)}`
}

/**
 * Return per unit of risk, suppressed when the sample cannot support it.
 *
 * A rule that exits nearly every trade at its own threshold produces almost
 * identical returns, so the standard deviation collapses toward zero and the
 * ratio explodes into the quadrillions. That is an artifact of dividing by a
 * spread that does not exist, not a strategy with astonishing risk-adjusted
 * returns, and printing it as one would be actively misleading.
 */
function riskRatio(metrics: StudyMetrics): string {
  if (metrics.returnPerUnitRisk === null) return 'n/a'
  if (metrics.returnStdDev < 0.5) return 'n/a'
  return metrics.returnPerUnitRisk.toFixed(3)
}

function reportScenario(result: ScenarioResult): string {
  const lines: string[] = []
  const s = result.entrySummary

  lines.push('')
  lines.push(`=== ${result.label} ===`)
  lines.push(
    `${result.entries} positions from ${result.sessionsConsidered} scheduled sessions ` +
      `(${result.config.from} to ${result.config.to})`
  )
  lines.push(
    `Median debit ${s.medianDebit.toFixed(2)} pts ($${(s.medianDebit * 100).toFixed(0)}), ` +
      `quoted spread ${s.medianSpreadPoints.toFixed(2)} pts, tent ${s.medianTentWidth.toFixed(0)} pts wide`
  )
  lines.push(
    `Median IV front ${(s.medianFrontIv * 100).toFixed(1)}% vs back ${(s.medianBackIv * 100).toFixed(1)}% ` +
      `(term spread ${(s.medianTermSpread * 100).toFixed(1)} vol points); ` +
      `the index left the tent in ${s.breachedPct.toFixed(0)}% of positions`
  )

  const skips = Object.entries(result.skipReasons).sort((a, b) => b[1] - a[1])
  if (skips.length > 0) {
    lines.push(`Skipped: ${skips.map(([reason, count]) => `${count}x ${reason}`).join('; ')}`)
  }

  lines.push('')
  lines.push(
    [
      pad('management', 18),
      pad('n', 4, 'right'),
      pad('total', 9, 'right'),
      pad('per trade', 10, 'right'),
      pad('median', 9, 'right'),
      pad('win%', 6, 'right'),
      pad('PF', 6, 'right'),
      pad('maxDD', 9, 'right'),
      pad('ret/risk', 9, 'right'),
      pad('days', 6, 'right'),
      'exits'
    ].join(' ')
  )

  const ordered = [...result.rows].sort((a, b) => b.metrics.expectancy - a.metrics.expectancy)
  for (const row of ordered) {
    const m = row.metrics
    const exits = Object.entries(row.exitReasons)
      .sort((a, b) => b[1] - a[1])
      .map(([reason, count]) => `${reason.replace(/([A-Z])/g, ' $1').trim()} ${count}`)
      .join(', ')

    lines.push(
      [
        pad(row.id, 18),
        pad(String(m.totalTrades), 4, 'right'),
        pad(money(m.totalPnl), 9, 'right'),
        pad(money(m.expectancy), 10, 'right'),
        pad(money(m.medianTrade), 9, 'right'),
        pad(m.winRate.toFixed(0), 6, 'right'),
        pad(m.profitFactor === null ? 'n/a' : m.profitFactor.toFixed(2), 6, 'right'),
        pad(money(m.maxDrawdown), 9, 'right'),
        pad(riskRatio(m), 9, 'right'),
        pad(row.averageSessionsHeld.toFixed(1), 6, 'right'),
        exits
      ].join(' ')
    )
  }

  return lines.join('\n')
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  const from = args.from ?? '2025-08-25'
  const to = args.to ?? '2026-07-27'
  const groups = new Set((args.scenarios ?? 'core').split(',').map((g) => g.trim()))
  const archivePath =
    args.archive ?? join(process.env.APPDATA ?? '', 'backtestsmith', 'data', 'market-data.duckdb')

  const archive = new MarketArchive({ path: archivePath })
  await archive.open()

  try {
    const scenarios = buildScenarios(from, to, groups)
    if (scenarios.length === 0) {
      throw new Error(`No scenarios matched "${args.scenarios}".`)
    }

    const results: ScenarioResult[] = []
    for (const scenario of scenarios) {
      process.stdout.write(`\nrunning ${scenario.key}: ${scenario.label}\n`)

      // A fresh source per scenario: its caches are sized for one pass and
      // holding every session's index minutes across thirteen of them is a
      // gigabyte of nothing useful.
      const source: CalendarDataSource = calendarSourceFrom(archive)
      const started = Date.now()

      const outcome = await runDoubleCalendarStudy(scenario.config, source, {
        onProgress: ({ completed, total, date, entries }) => {
          if (completed % 10 === 0) {
            process.stdout.write(`  ${completed}/${total} sessions, ${entries} entries (${date})\r`)
          }
        }
      })

      process.stdout.write(
        `  ${outcome.series.length} entries, ${outcome.skipped.length} skipped, ` +
          `${Math.round((Date.now() - started) / 1000)}s\n`
      )
      results.push(toResult(scenario, outcome))
    }

    const report = results.map(reportScenario).join('\n')
    process.stdout.write(`${report}\n`)

    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
    mkdirSync('studies', { recursive: true })
    const path = join('studies', `double-calendar-${stamp}.json`)
    writeFileSync(path, JSON.stringify({ from, to, generatedAt: Date.now(), results }, null, 2))
    process.stdout.write(`\nWrote ${path}\n`)
  } finally {
    await archive.close()
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`)
  process.exitCode = 1
})
