import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  CartesianGrid,
  Cell,
  ReferenceLine,
  ResponsiveContainer,
  Scatter,
  ScatterChart,
  Tooltip,
  XAxis,
  YAxis,
  ZAxis
} from 'recharts'
import type { StudyRunResult, StudyRunSummary } from '../../shared/study.js'
import { Badge, Button, Card, EmptyState, PageHeader, Select, Spinner } from '../components/primitives.js'
import { fmtCurrency, fmtDate, fmtInt } from '../lib/format.js'
import { useAsyncAction } from '../lib/hooks.js'

/**
 * Risk against return, across every management method in a run.
 *
 * The scatter exists because a ranked table invites reading the top row as the
 * answer. Plotting drawdown against return makes the trade-off visible: the
 * highest total return frequently sits alongside the deepest drawdown, and a
 * method slightly below it with half the drawdown is usually the better
 * proposition.
 */
export function ComparePage() {
  const [runs, setRuns] = useState<StudyRunSummary[]>([])
  const [runId, setRunId] = useState('')
  const [run, setRun] = useState<StudyRunResult | null>(null)

  const refresh = useCallback(async () => {
    const list = await window.api.study.list(50)
    setRuns(list)
    if (!runId && list[0]) setRunId(list[0].runId)
  }, [runId])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const [loadState, load] = useAsyncAction(async (id: string) => {
    const result = await window.api.study.load(id)
    setRun(result)
    return result
  })

  useEffect(() => {
    if (runId) void load(runId)
  }, [runId, load])

  const points = useMemo(() => {
    if (!run) return []
    return run.summaries.map((s) => ({
      id: s.strategyId,
      label: s.strategyLabel,
      // Plotted positive so "further right" reads as "worse", which is how the
      // eye expects a risk axis to behave.
      drawdown: Math.abs(s.metrics.maxDrawdown),
      total: s.metrics.totalPnl,
      capture: s.metrics.averageMfeCapture ?? 0,
      winRate: s.metrics.winRate,
      trades: s.metrics.totalTrades
    }))
  }, [run])

  /** Methods on the efficient frontier: nothing beats them on both axes. */
  const frontier = useMemo(() => {
    const ids = new Set<string>()
    for (const p of points) {
      const dominated = points.some(
        (other) => other.id !== p.id && other.total >= p.total && other.drawdown <= p.drawdown &&
          (other.total > p.total || other.drawdown < p.drawdown)
      )
      if (!dominated) ids.add(p.id)
    }
    return ids
  }, [points])

  return (
    <>
      <PageHeader
        title="Compare"
        description="Risk against return for every management method, over one identical entry population."
        actions={
          <div className="flex items-center gap-2">
            <Select value={runId} onChange={(e) => setRunId(e.target.value)} className="w-72">
              <option value="">Select a run…</option>
              {runs.map((r) => (
                <option key={r.runId} value={r.runId}>
                  {r.label ?? `${r.config.from} → ${r.config.to}`} · {r.entryCount} entries · {fmtDate(r.createdAt)}
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
            <Spinner /> Loading…
          </div>
        )}

        {!run && !loadState.loading && (
          <EmptyState title="No run selected">
            Run a study first, then compare its management methods here.
          </EmptyState>
        )}

        {run && points.length > 0 && (
          <>
            <Card
              title="Drawdown against return"
              subtitle="Each point is one management method. Highlighted points are not beaten on both axes by any other."
            >
              <div style={{ height: 380 }}>
                <ResponsiveContainer width="100%" height="100%">
                  <ScatterChart margin={{ top: 12, right: 16, bottom: 24, left: 8 }}>
                    <CartesianGrid stroke="#1a2233" strokeDasharray="2 4" />
                    <XAxis
                      type="number"
                      dataKey="drawdown"
                      name="Max drawdown"
                      tick={{ fill: '#64748b', fontSize: 10 }}
                      stroke="#222d44"
                      tickFormatter={(v: number) => fmtCurrency(v, 0)}
                      label={{ value: 'Maximum drawdown', position: 'insideBottom', offset: -14, fill: '#64748b', fontSize: 10 }}
                    />
                    <YAxis
                      type="number"
                      dataKey="total"
                      name="Total return"
                      tick={{ fill: '#64748b', fontSize: 10 }}
                      stroke="#222d44"
                      width={72}
                      tickFormatter={(v: number) => fmtCurrency(v, 0)}
                    />
                    <ZAxis type="number" dataKey="capture" range={[40, 260]} name="Capture" />
                    <ReferenceLine y={0} stroke="#64748b" />
                    <Tooltip
                      cursor={{ strokeDasharray: '3 3', stroke: '#2f3d5c' }}
                      contentStyle={{ background: '#111725', border: '1px solid #222d44', borderRadius: 6, fontSize: 11 }}
                      content={({ active, payload }) => {
                        if (!active || !payload?.length) return null
                        const p = payload[0]!.payload as (typeof points)[number]
                        return (
                          <div className="rounded-md border border-line bg-surface px-3 py-2 text-[11px]">
                            <div className="font-medium text-ink">{p.label}</div>
                            <div className="num mt-1 space-y-0.5 text-ink-dim">
                              <div>Total {fmtCurrency(p.total)}</div>
                              <div>Max DD {fmtCurrency(-p.drawdown)}</div>
                              <div>Capture {(p.capture * 100).toFixed(0)}%</div>
                              <div>Win {p.winRate.toFixed(1)}%</div>
                            </div>
                          </div>
                        )
                      }}
                    />
                    <Scatter data={points} isAnimationActive={false}>
                      {points.map((p) => (
                        <Cell
                          key={p.id}
                          fill={frontier.has(p.id) ? '#34d399' : '#4f9cf9'}
                          fillOpacity={frontier.has(p.id) ? 0.9 : 0.45}
                        />
                      ))}
                    </Scatter>
                  </ScatterChart>
                </ResponsiveContainer>
              </div>

              <div className="mt-2 flex flex-wrap items-center gap-2">
                <Badge tone="gain">● not dominated</Badge>
                <Badge tone="accent">● dominated</Badge>
                <span className="text-[10px] text-ink-faint">Bubble size is MFE capture.</span>
              </div>

              <p className="mt-2 text-[10px] leading-relaxed text-ink-faint">
                A method is dominated when another achieves at least as much return with no more drawdown. Those
                are straightforwardly worse on this sample. Among the rest there is no single answer: the choice
                between more return and less drawdown is a preference, not a calculation, and with{' '}
                {fmtInt(run.entryCount)} entries the gaps may not be distinguishable from chance anyway.
              </p>
            </Card>

            <Card title="Not dominated" subtitle="The methods worth actually choosing between">
              <div className="overflow-x-auto rounded-md border border-line">
                <table className="w-full border-collapse text-[11px]">
                  <thead className="bg-surface-2">
                    <tr className="text-left text-ink-faint">
                      <th className="px-3 py-1.5 font-medium">Method</th>
                      <th className="px-3 py-1.5 text-right font-medium">Total</th>
                      <th className="px-3 py-1.5 text-right font-medium">Max DD</th>
                      <th className="px-3 py-1.5 text-right font-medium">Return / DD</th>
                      <th className="px-3 py-1.5 text-right font-medium">Capture</th>
                      <th className="px-3 py-1.5 text-right font-medium">Win %</th>
                    </tr>
                  </thead>
                  <tbody className="num">
                    {points
                      .filter((p) => frontier.has(p.id))
                      .sort((a, b) => b.total - a.total)
                      .map((p) => (
                        <tr key={p.id} className="border-t border-line-soft hover:bg-surface-2">
                          <td className="px-3 py-1 text-ink-dim">{p.label}</td>
                          <td className={`px-3 py-1 text-right ${p.total >= 0 ? 'text-gain' : 'text-loss'}`}>
                            {fmtCurrency(p.total)}
                          </td>
                          <td className="px-3 py-1 text-right text-loss">{fmtCurrency(-p.drawdown)}</td>
                          <td className="px-3 py-1 text-right text-ink">
                            {p.drawdown > 0 ? (p.total / p.drawdown).toFixed(2) : '—'}
                          </td>
                          <td className="px-3 py-1 text-right text-ink-faint">{(p.capture * 100).toFixed(0)}%</td>
                          <td className="px-3 py-1 text-right text-ink-faint">{p.winRate.toFixed(1)}%</td>
                        </tr>
                      ))}
                  </tbody>
                </table>
              </div>
            </Card>
          </>
        )}
      </div>
    </>
  )
}
