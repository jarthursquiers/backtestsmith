import { useCallback, useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import {
  CartesianGrid,
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis
} from 'recharts'
import {
  normalizeSkipReason,
  resolveStructure,
  type ManagementSummary,
  type StudyRunResult,
  type StudyRunSummary
} from '../../shared/study.js'
import type { PositionSizing } from '../../shared/metrics.js'
import {
  Badge,
  Button,
  Card,
  EmptyState,
  Field,
  PageHeader,
  Select,
  Spinner,
  StatTile
} from '../components/primitives.js'
import { describeConfig, findStrategy } from '../../shared/strategyCatalog.js'
import { fmtCurrency, fmtDate, fmtInt, fmtPct } from '../lib/format.js'
import { useAsyncAction } from '../lib/hooks.js'
import { AnalyticsPanel } from '../components/AnalyticsPanel.js'

type SortKey = 'totalPnl' | 'expectancy' | 'maxDrawdown' | 'profitFactor' | 'winRate' | 'capture'

export function ResultsPage() {
  const [params, setParams] = useSearchParams()
  const [runs, setRuns] = useState<StudyRunSummary[]>([])
  const [run, setRun] = useState<StudyRunResult | null>(null)
  const [sortKey, setSortKey] = useState<SortKey>('totalPnl')
  const [sizing, setSizing] = useState<PositionSizing>('oneContract')
  const [highlighted, setHighlighted] = useState<string | null>(null)

  const selectedId = params.get('run')
  const isCalendar = run ? resolveStructure(run.config) === 'doubleCalendar' : false

  const refresh = useCallback(async () => {
    setRuns(await window.api.study.list(50))
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const [loadState, load] = useAsyncAction(async (runId: string) => {
    const result = await window.api.study.load(runId)
    setRun(result)
    return result
  })

  useEffect(() => {
    if (selectedId) void load(selectedId)
  }, [selectedId, load])

  const summaries = useMemo(() => {
    if (!run) return []
    const copy = [...run.summaries]
    copy.sort((a, b) => {
      const m = (s: ManagementSummary) => s.metrics
      switch (sortKey) {
        case 'expectancy':
          return m(b).expectancy - m(a).expectancy
        case 'maxDrawdown':
          return m(b).maxDrawdown - m(a).maxDrawdown // less negative first
        case 'profitFactor':
          return (m(b).profitFactor ?? -Infinity) - (m(a).profitFactor ?? -Infinity)
        case 'winRate':
          return m(b).winRate - m(a).winRate
        case 'capture':
          return (m(b).averageMfeCapture ?? -Infinity) - (m(a).averageMfeCapture ?? -Infinity)
        default:
          return m(b).totalPnl - m(a).totalPnl
      }
    })
    return copy
  }, [run, sortKey])

  /** Equity curves for the highlighted method, or the top three by return. */
  const curves = useMemo(() => {
    if (!run) return []
    const ids = highlighted ? [highlighted] : summaries.slice(0, 3).map((s) => s.strategyId)
    return ids.map((id) => {
      const trades = run.trades
        .filter((t) => t.strategyId === id)
        .sort((a, b) => a.exitTimestamp - b.exitTimestamp)
      let equity = 0
      const points = trades.map((t) => {
        const risk = t.entryDebit * 100 * t.definition.quantity
        const scaled = sizing === 'equalRisk' && risk > 0 ? t.pnlDollars * (1000 / risk) : t.pnlDollars
        equity += scaled
        return { timestamp: t.exitTimestamp, equity }
      })
      return { id, label: run.summaries.find((s) => s.strategyId === id)?.strategyLabel ?? id, points }
    })
  }, [run, summaries, highlighted, sizing])

  const chartData = useMemo(() => {
    const length = Math.max(0, ...curves.map((c) => c.points.length))
    return Array.from({ length }, (_, i) => {
      const row: Record<string, number | undefined> = { index: i }
      for (const c of curves) row[c.id] = c.points[i]?.equity
      return row
    })
  }, [curves])

  const invalidPriceAudit = useMemo(() => {
    if (!run) return { entries: 0, minutes: 0 }
    const byEntry = new Map<number, number>()
    for (const trade of run.trades) {
      const count = trade.quality.invalidPriceMinutes ?? 0
      byEntry.set(trade.entryTimestamp, Math.max(byEntry.get(trade.entryTimestamp) ?? 0, count))
    }
    const counts = [...byEntry.values()]
    return {
      entries: counts.filter((count) => count > 0).length,
      minutes: counts.reduce((sum, count) => sum + count, 0)
    }
  }, [run])

  const COLORS = ['#4f9cf9', '#34d399', '#fbbf24']

  const header = (key: SortKey, label: string) => (
    <th
      className={`cursor-pointer px-3 py-1.5 text-right font-medium select-none hover:text-ink ${
        sortKey === key ? 'text-accent' : ''
      }`}
      onClick={() => setSortKey(key)}
    >
      {label}
      {sortKey === key ? ' ↓' : ''}
    </th>
  )

  return (
    <>
      <PageHeader
        title="Results"
        description="Management methods compared over one identical entry population."
        actions={
          <div className="flex items-center gap-2">
            <Select
              value={selectedId ?? ''}
              onChange={(e) => setParams(e.target.value ? { run: e.target.value } : {})}
              className="w-72"
            >
              <option value="">Select a run…</option>
              {runs.map((r) => (
                <option key={r.runId} value={r.runId}>
                  {r.label ?? `${r.config.from} → ${r.config.to}`} · {r.entryCount} entries ·{' '}
                  {fmtDate(r.createdAt)}
                </option>
              ))}
            </Select>
            <Button onClick={() => void refresh()}>Refresh</Button>
          </div>
        }
      />

      <div className="flex-1 space-y-4 overflow-y-auto p-6">
        {loadState.loading && (
          <div className="flex items-center gap-2 text-[12px] text-ink-dim">
            <Spinner /> Loading run…
          </div>
        )}

        {!selectedId && runs.length === 0 && !loadState.loading && (
          <EmptyState title="No studies have been run yet">
            Configure and run one from the Run Study screen. Results are stored locally with the exact
            configuration that produced them.
          </EmptyState>
        )}

        {run && (
          <>
            <Card
              title={findStrategy(run.config.strategyId ?? '')?.label ?? 'Run'}
              subtitle={`${run.config.from} to ${run.config.to} · ${describeConfig(run.config)}`}
              actions={
                <Field label="">
                  <Select value={sizing} onChange={(e) => setSizing(e.target.value as PositionSizing)}>
                    <option value="oneContract">One contract</option>
                    <option value="equalRisk">Equal risk ($1,000)</option>
                  </Select>
                </Field>
              }
            >
              <div className="grid grid-cols-2 gap-3 md:grid-cols-6">
                <StatTile label="Entries" value={fmtInt(run.entryCount)} hint={`of ${run.entriesAttempted} sessions`} />
                <StatTile label="Methods" value={fmtInt(run.summaries.length)} />
                <StatTile label="Trades" value={fmtInt(run.trades.length)} />
                <StatTile label="Skipped" value={fmtInt(run.skipped.length)} tone={run.skipped.length > 0 ? 'warn' : 'neutral'} />
                <StatTile
                  label={isCalendar ? 'Expirations' : run.config.targetDte === 0 ? 'Expiration' : 'Target DTE'}
                  value={isCalendar && run.config.calendar
                    ? `${run.config.calendar.frontTargetDte} / ${run.config.calendar.backTargetDte} DTE`
                    : run.config.targetDte === 0 ? '0DTE' : run.config.targetDte}
                  hint={isCalendar && run.config.calendar
                    ? `${Math.round(run.config.calendar.targetDelta * 100)}Δ shorts`
                    : `${run.config.wingWidth} wide`}
                />
                <StatTile label="Version" value={run.appVersion} hint={run.gitCommit?.slice(0, 7)} />
              </div>

              {run.entryCount < 30 && (
                <div className="mt-3 rounded-md border border-warn/30 bg-warn/10 px-3 py-2 text-[11px] leading-relaxed text-warn">
                  Only {run.entryCount} entries. That is far too few to distinguish management methods from
                  chance — treat differences below as hypothesis generation, not evidence.
                </div>
              )}

              {invalidPriceAudit.minutes > 0 && (
                <div className="mt-3 rounded-md border border-warn/30 bg-warn/10 px-3 py-2 text-[11px] leading-relaxed text-warn">
                  Rejected {invalidPriceAudit.minutes} impossible synthetic mark(s) across {invalidPriceAudit.entries}{' '}
                  entries. They were excluded and counted as unpriced minutes. The Study JSON contains raw leg
                  prices and timestamps for representative failures.
                </div>
              )}

              {run.skipped.length > 0 && (
                <div className="mt-3">
                  <div className="mb-1.5 text-[11px] font-medium text-ink-dim">
                    Why sessions were skipped
                  </div>
                  <div className="overflow-hidden rounded-md border border-line">
                    <table className="w-full border-collapse text-[11px]">
                      <tbody className="num">
                        {Object.entries(
                          run.skipped.reduce<Record<string, number>>((acc, s) => {
                            // Group by reason with the specifics stripped, so one
                            // shared cause reads as one line rather than fifty.
                            const key = normalizeSkipReason(s.reason)
                            acc[key] = (acc[key] ?? 0) + 1
                            return acc
                          }, {})
                        )
                          .sort((a, b) => b[1] - a[1])
                          .map(([reason, count]) => (
                            <tr key={reason} className="border-b border-line-soft last:border-0">
                              <td className="w-14 px-3 py-1 text-right text-warn">{count}</td>
                              <td className="px-3 py-1 text-ink-dim">{reason}</td>
                            </tr>
                          ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}

              {run.skipped.length > 0 && (
                <details className="mt-3 text-[11px]">
                  <summary className="cursor-pointer text-ink-dim">Every skipped session</summary>
                  <ul className="num mt-1 max-h-48 space-y-0.5 overflow-y-auto text-[10px] text-ink-faint">
                    {run.skipped.map((s) => (
                      <li key={s.date}>
                        {s.date}: {s.reason}
                      </li>
                    ))}
                  </ul>
                </details>
              )}
            </Card>

            <Card
              title="Management comparison"
              subtitle="Click a row to isolate its equity curve. Sort by any column to see the trade-offs."
            >
              <div className="overflow-x-auto rounded-md border border-line">
                <table className="w-full border-collapse text-[11px]">
                  <thead className="bg-surface-2">
                    <tr className="text-left text-ink-faint">
                      <th className="px-3 py-1.5 font-medium">Method</th>
                      {header('totalPnl', 'Total P/L')}
                      {header('expectancy', 'Expectancy')}
                      {header('winRate', 'Win %')}
                      {header('profitFactor', 'PF')}
                      {header('maxDrawdown', 'Max DD')}
                      {header('capture', 'Capture')}
                      <th className="px-3 py-1.5 text-right font-medium">Median</th>
                      <th className="px-3 py-1.5 text-right font-medium">Held</th>
                      <th className="px-3 py-1.5 text-right font-medium">Amb.</th>
                    </tr>
                  </thead>
                  <tbody className="num">
                    {summaries.map((s) => {
                      const m = s.metrics
                      const active = highlighted === s.strategyId
                      return (
                        <tr
                          key={s.strategyId}
                          onClick={() => setHighlighted(active ? null : s.strategyId)}
                          className={`cursor-pointer border-t border-line-soft transition ${
                            active ? 'bg-accent/15 text-accent' : 'hover:bg-surface-2'
                          }`}
                        >
                          <td className="px-3 py-1 text-ink-dim">{s.strategyLabel}</td>
                          <td className={`px-3 py-1 text-right ${m.totalPnl >= 0 ? 'text-gain' : 'text-loss'}`}>
                            {fmtCurrency(m.totalPnl)}
                          </td>
                          <td className="px-3 py-1 text-right">{fmtCurrency(m.expectancy)}</td>
                          <td className="px-3 py-1 text-right text-ink-faint">{m.winRate.toFixed(1)}%</td>
                          <td className="px-3 py-1 text-right text-ink-faint">
                            {m.profitFactor === null ? '—' : m.profitFactor.toFixed(2)}
                          </td>
                          <td className="px-3 py-1 text-right text-loss">{fmtCurrency(m.maxDrawdown)}</td>
                          <td className="px-3 py-1 text-right text-ink-faint">
                            {m.averageMfeCapture === null ? '—' : `${(m.averageMfeCapture * 100).toFixed(0)}%`}
                          </td>
                          <td className="px-3 py-1 text-right text-ink-faint">{fmtCurrency(m.medianTrade)}</td>
                          <td className="px-3 py-1 text-right text-ink-faint">
                            {Math.round(m.averageHoldingMinutes / 60)}h
                          </td>
                          <td className="px-3 py-1 text-right text-ink-faint">
                            {m.ambiguousExits > 0 ? m.ambiguousExits : '—'}
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>

              <p className="mt-2 text-[10px] leading-relaxed text-ink-faint">
                Sorting by total P/L alone picks the method that happened to fit this sample. The trade-off worth
                reading is return against drawdown and capture: a method that keeps most of its maximum
                unrealized profit is doing something repeatable, while one that leads on total return with a deep
                drawdown may simply have been lucky about sequence.
              </p>
            </Card>

            <Card
              title="Equity curve"
              subtitle={highlighted ? 'Isolated method' : 'Top three by total return'}
            >
              {chartData.length === 0 ? (
                <EmptyState title="No trades to plot" />
              ) : (
                <div style={{ height: 300 }}>
                  <ResponsiveContainer width="100%" height="100%">
                    <LineChart data={chartData} margin={{ top: 8, right: 12, bottom: 4, left: 0 }}>
                      <CartesianGrid stroke="#1a2233" strokeDasharray="2 4" vertical={false} />
                      <XAxis dataKey="index" tick={{ fill: '#64748b', fontSize: 10 }} stroke="#222d44" minTickGap={40} />
                      <YAxis
                        tick={{ fill: '#64748b', fontSize: 10 }}
                        stroke="#222d44"
                        width={70}
                        tickFormatter={(v: number) => fmtCurrency(v, 0)}
                      />
                      <ReferenceLine y={0} stroke="#64748b" />
                      <Tooltip
                        contentStyle={{ background: '#111725', border: '1px solid #222d44', borderRadius: 6, fontSize: 11 }}
                        labelStyle={{ color: '#94a3bd' }}
                        labelFormatter={(i) => `Trade ${Number(i) + 1}`}
                        formatter={(value, name) => [fmtCurrency(typeof value === 'number' ? value : undefined), String(name)]}
                      />
                      {curves.map((c, i) => (
                        <Line
                          key={c.id}
                          type="linear"
                          dataKey={c.id}
                          name={c.label}
                          stroke={COLORS[i % COLORS.length]}
                          strokeWidth={1.4}
                          dot={false}
                          connectNulls
                          isAnimationActive={false}
                        />
                      ))}
                    </LineChart>
                  </ResponsiveContainer>
                </div>
              )}
              <div className="mt-2 flex flex-wrap gap-2">
                {curves.map((c, i) => (
                  <Badge key={c.id} tone="neutral">
                    <span style={{ color: COLORS[i % COLORS.length] }}>●</span> {c.label}
                  </Badge>
                ))}
              </div>
            </Card>

            <AnalyticsPanel
              runId={run.runId}
              structure={run.config.structure}
              strategyIds={run.summaries.map((s) => s.strategyId)}
              labels={Object.fromEntries(run.summaries.map((s) => [s.strategyId, s.strategyLabel]))}
            />

            <Card
              title="Export"
              subtitle="Trade-level CSV, or the complete study with its configuration and caveats"
              actions={
                <div className="flex gap-2">
                  <Button onClick={() => void window.api.study.exportTrades(run.runId)}>Trades CSV</Button>
                  <Button onClick={() => void window.api.study.exportJson(run.runId)}>Study JSON</Button>
                </div>
              }
            >
              <p className="text-[11px] leading-relaxed text-ink-faint">
                The JSON export carries the configuration and an explicit list of caveats alongside the numbers,
                because a result shipped without its assumptions cannot be checked by anyone else.
              </p>
            </Card>

            <Card title="Reproducibility" subtitle="The exact configuration this run used">
              <pre className="num max-h-64 overflow-auto rounded-md border border-line bg-ground p-3 text-[10px] leading-relaxed text-ink-dim">
                {JSON.stringify(run.config, null, 2)}
              </pre>
            </Card>
          </>
        )}
      </div>
    </>
  )
}
