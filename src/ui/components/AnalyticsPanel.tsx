import { useEffect, useState } from 'react'
import {
  Bar,
  BarChart,
  CartesianGrid,
  ReferenceLine,
  ResponsiveContainer,
  Scatter,
  ScatterChart,
  Tooltip,
  XAxis,
  YAxis
} from 'recharts'
import type { AnalyticsReport, Histogram } from '../../shared/analytics.js'
import { Badge, Card, EmptyState, Select, Spinner } from './primitives.js'
import { fmtInt, fmtPct } from '../lib/format.js'
import { useAsyncAction } from '../lib/hooks.js'

/**
 * Aggregate research views for one management method.
 *
 * The conditional table is the centrepiece. A distribution tells you what
 * happened; the conditional probabilities tell you what a decision is worth -
 * which is the question a management study actually asks.
 */

function HistogramChart({ data, color = '#4f9cf9', height = 160 }: { data: Histogram; color?: string; height?: number }) {
  if (data.bins.length === 0) {
    return <div className="py-6 text-center text-[11px] text-ink-faint">No data</div>
  }
  const rows = data.bins.map((b) => ({ label: b.from.toFixed(0), count: b.count, from: b.from, to: b.to }))
  return (
    <div style={{ height }}>
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={rows} margin={{ top: 6, right: 8, bottom: 4, left: 0 }}>
          <CartesianGrid stroke="#1a2233" strokeDasharray="2 4" vertical={false} />
          <XAxis dataKey="label" tick={{ fill: '#64748b', fontSize: 9 }} stroke="#222d44" minTickGap={24} />
          <YAxis tick={{ fill: '#64748b', fontSize: 9 }} stroke="#222d44" width={34} />
          <ReferenceLine x="0" stroke="#64748b" />
          <Tooltip
            contentStyle={{ background: '#111725', border: '1px solid #222d44', borderRadius: 6, fontSize: 11 }}
            labelFormatter={(v) => `from ${v}`}
            formatter={(value) => [String(value), 'trades']}
          />
          <Bar dataKey="count" fill={color} isAnimationActive={false} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  )
}

export function AnalyticsPanel({
  runId,
  strategyIds,
  labels
}: {
  runId: string
  strategyIds: string[]
  labels: Record<string, string>
}) {
  const [strategyId, setStrategyId] = useState(strategyIds[0] ?? '')
  const [report, setReport] = useState<AnalyticsReport | null>(null)

  const [state, load] = useAsyncAction(async (id: string) => {
    const result = await window.api.study.analytics(runId, id)
    setReport(result)
    return result
  })

  useEffect(() => {
    if (strategyId) void load(strategyId)
  }, [strategyId, runId, load])

  useEffect(() => {
    if (!strategyIds.includes(strategyId) && strategyIds[0]) setStrategyId(strategyIds[0])
  }, [strategyIds, strategyId])

  const thresholds = report?.conditional.rows.map((r) => r.threshold) ?? []

  return (
    <div className="space-y-4">
      <Card
        title="Conditional path analysis"
        subtitle="Given that a trade already reached a level, what happened next."
        actions={
          <Select value={strategyId} onChange={(e) => setStrategyId(e.target.value)} className="w-56">
            {strategyIds.map((id) => (
              <option key={id} value={id}>
                {labels[id] ?? id}
              </option>
            ))}
          </Select>
        }
      >
        {state.loading && (
          <div className="flex items-center gap-2 text-[12px] text-ink-dim">
            <Spinner /> Computing…
          </div>
        )}

        {report && report.conditional.totalTrades === 0 && <EmptyState title="No trades in this run" />}

        {report && report.conditional.totalTrades > 0 && (
          <>
            <div className="overflow-x-auto rounded-md border border-line">
              <table className="w-full border-collapse text-[11px]">
                <thead className="bg-surface-2">
                  <tr className="text-left text-ink-faint">
                    <th className="px-3 py-1.5 font-medium">Reached</th>
                    <th className="px-3 py-1.5 text-right font-medium">Trades</th>
                    <th className="px-3 py-1.5 text-right font-medium">Share</th>
                    {thresholds.map((t) => (
                      <th key={t} className="px-3 py-1.5 text-right font-medium">
                        → +{t}%
                      </th>
                    ))}
                    <th className="px-3 py-1.5 text-right font-medium">Fell to loss</th>
                    <th className="px-3 py-1.5 text-right font-medium">Median MFE</th>
                    <th className="px-3 py-1.5 text-right font-medium">Ended +</th>
                  </tr>
                </thead>
                <tbody className="num">
                  {report.conditional.rows.map((row) => (
                    <tr key={row.threshold} className="border-t border-line-soft hover:bg-surface-2">
                      <td className="px-3 py-1 text-ink">+{row.threshold}%</td>
                      <td className="px-3 py-1 text-right">{fmtInt(row.cohortSize)}</td>
                      <td className="px-3 py-1 text-right text-ink-faint">
                        {(row.cohortShare * 100).toFixed(0)}%
                      </td>
                      {thresholds.map((t) => {
                        const cell = row.wentOnTo[String(t)]
                        return (
                          <td key={t} className="px-3 py-1 text-right">
                            {t <= row.threshold ? (
                              <span className="text-ink-faint">—</span>
                            ) : cell === undefined || row.cohortSize === 0 ? (
                              <span className="text-ink-faint">—</span>
                            ) : (
                              <span title={`95% CI ${(cell.low * 100).toFixed(0)}–${(cell.high * 100).toFixed(0)}%`}>
                                <span className="text-gain">{(cell.probability * 100).toFixed(0)}%</span>
                                <span className="ml-1 text-[9px] text-ink-faint">
                                  ±{(((cell.high - cell.low) / 2) * 100).toFixed(0)}
                                </span>
                              </span>
                            )}
                          </td>
                        )
                      })}
                      <td className="px-3 py-1 text-right text-loss">
                        {row.cohortSize > 0 ? `${(row.fellBackToLoss * 100).toFixed(0)}%` : '—'}
                      </td>
                      <td className="px-3 py-1 text-right text-ink-faint">{fmtPct(row.medianEventualMfe, 0)}</td>
                      <td className="px-3 py-1 text-right text-ink-dim">
                        {row.cohortSize > 0 ? `${(row.endedProfitable * 100).toFixed(0)}%` : '—'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <p className="mt-2 text-[10px] leading-relaxed text-ink-faint">
              The ± figure is half a 95% confidence interval. Where it is large the sample cannot separate the
              probability from a wide range of alternatives, and the difference between two such cells is not
              evidence of anything. <span className="text-loss">Fell to loss</span> counts paths that went
              negative <em>after</em> first reaching the level, which is what a profit target is protecting
              against.
            </p>
          </>
        )}
      </Card>

      {report && (
        <>
          <Card title="Tent approach" subtitle="Outcomes by how close the underlying came to the centre strike">
            {report.tent.tradesWithUnderlying === 0 ? (
              <EmptyState title="No underlying data for these trades">
                Distance to the centre needs SPX levels during the trade. Load index data to enable this view.
              </EmptyState>
            ) : (
              <>
                <div className="overflow-x-auto rounded-md border border-line">
                  <table className="w-full border-collapse text-[11px]">
                    <thead className="bg-surface-2">
                      <tr className="text-left text-ink-faint">
                        <th className="px-3 py-1.5 font-medium">Came within</th>
                        <th className="px-3 py-1.5 text-right font-medium">Trades</th>
                        <th className="px-3 py-1.5 text-right font-medium">Share</th>
                        <th className="px-3 py-1.5 text-right font-medium">Median MFE</th>
                        <th className="px-3 py-1.5 text-right font-medium">Median final</th>
                        <th className="px-3 py-1.5 text-right font-medium">Ended +</th>
                      </tr>
                    </thead>
                    <tbody className="num">
                      {report.tent.rows.map((row) => (
                        <tr key={row.band} className="border-t border-line-soft hover:bg-surface-2">
                          <td className="px-3 py-1 text-ink">{row.band.toFixed(2)} wings</td>
                          <td className="px-3 py-1 text-right">{fmtInt(row.cohortSize)}</td>
                          <td className="px-3 py-1 text-right text-ink-faint">{(row.cohortShare * 100).toFixed(0)}%</td>
                          <td className="px-3 py-1 text-right text-gain">{fmtPct(row.medianMfe, 0)}</td>
                          <td className="px-3 py-1 text-right">{fmtPct(row.medianFinalReturn, 0)}</td>
                          <td className="px-3 py-1 text-right text-ink-dim">{(row.endedProfitable * 100).toFixed(0)}%</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                {report.tent.tradesWithoutUnderlying > 0 && (
                  <div className="mt-2">
                    <Badge tone="warn">
                      {fmtInt(report.tent.tradesWithoutUnderlying)} trades excluded for want of underlying data
                    </Badge>
                  </div>
                )}
              </>
            )}
          </Card>

          <div className="grid gap-4 lg:grid-cols-2">
            <Card title="Return distribution" subtitle="Realized return per trade">
              <HistogramChart data={report.returnDistribution} />
            </Card>
            <Card title="MFE distribution" subtitle="Best point each trade reached">
              <HistogramChart data={report.mfeDistribution} color="#34d399" />
            </Card>
            <Card title="MAE distribution" subtitle="Worst point each trade reached">
              <HistogramChart data={report.maeDistribution} color="#f87171" />
            </Card>
            <Card title="MFE capture" subtitle="Realized as a fraction of maximum unrealized">
              <HistogramChart data={report.captureDistribution} color="#fbbf24" />
            </Card>
          </div>

          <Card
            title="Exit against MFE"
            subtitle="Every point below the diagonal is profit that was reached and then given back."
          >
            <div style={{ height: 300 }}>
              <ResponsiveContainer width="100%" height="100%">
                <ScatterChart margin={{ top: 12, right: 16, bottom: 20, left: 8 }}>
                  <CartesianGrid stroke="#1a2233" strokeDasharray="2 4" />
                  <XAxis
                    type="number"
                    dataKey="mfe"
                    tick={{ fill: '#64748b', fontSize: 10 }}
                    stroke="#222d44"
                    tickFormatter={(v: number) => `${v.toFixed(0)}%`}
                    label={{ value: 'Maximum favourable excursion', position: 'insideBottom', offset: -12, fill: '#64748b', fontSize: 10 }}
                  />
                  <YAxis
                    type="number"
                    dataKey="exit"
                    tick={{ fill: '#64748b', fontSize: 10 }}
                    stroke="#222d44"
                    width={54}
                    tickFormatter={(v: number) => `${v.toFixed(0)}%`}
                  />
                  <ReferenceLine y={0} stroke="#64748b" />
                  <ReferenceLine
                    segment={[{ x: 0, y: 0 }, { x: 300, y: 300 }]}
                    stroke="#34d399"
                    strokeDasharray="4 4"
                  />
                  <Tooltip
                    cursor={{ strokeDasharray: '3 3', stroke: '#2f3d5c' }}
                    contentStyle={{ background: '#111725', border: '1px solid #222d44', borderRadius: 6, fontSize: 11 }}
                    formatter={(value, name) => [`${Number(value).toFixed(1)}%`, String(name)]}
                  />
                  <Scatter data={report.exitVsMfe} fill="#4f9cf9" fillOpacity={0.55} isAnimationActive={false} />
                </ScatterChart>
              </ResponsiveContainer>
            </div>
            <p className="mt-2 text-[10px] leading-relaxed text-ink-faint">
              The dashed line is a perfect exit at the peak. Distance below it is give-back, and the shape of
              that cloud is the strongest single argument for or against a management rule.
            </p>
          </Card>

          <div className="grid gap-4 lg:grid-cols-2">
            <Card title="Median return by weekday" subtitle="Entry weekday">
              <GroupTable rows={report.byWeekday} />
            </Card>
            <Card title="Median return by month" subtitle="Entry month">
              <GroupTable rows={report.byMonth} />
            </Card>
          </div>
        </>
      )}
    </div>
  )
}

function GroupTable({ rows }: { rows: { group: string; count: number; median: number; mean: number }[] }) {
  if (rows.length === 0) return <EmptyState title="No data" />
  return (
    <div className="overflow-x-auto rounded-md border border-line">
      <table className="w-full border-collapse text-[11px]">
        <thead className="bg-surface-2">
          <tr className="text-left text-ink-faint">
            <th className="px-3 py-1.5 font-medium">Group</th>
            <th className="px-3 py-1.5 text-right font-medium">Trades</th>
            <th className="px-3 py-1.5 text-right font-medium">Median</th>
            <th className="px-3 py-1.5 text-right font-medium">Mean</th>
          </tr>
        </thead>
        <tbody className="num">
          {rows.map((r) => (
            <tr key={r.group} className="border-t border-line-soft hover:bg-surface-2">
              <td className="px-3 py-1 text-ink-dim">{r.group}</td>
              <td className="px-3 py-1 text-right text-ink-faint">{fmtInt(r.count)}</td>
              <td className={`px-3 py-1 text-right ${r.median >= 0 ? 'text-gain' : 'text-loss'}`}>
                {fmtPct(r.median, 0)}
              </td>
              <td className="px-3 py-1 text-right text-ink-faint">{fmtPct(r.mean, 0)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
