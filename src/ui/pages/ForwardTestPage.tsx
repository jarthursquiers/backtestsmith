import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import type { ForwardRunPlan, ForwardTestDetail, ForwardTestSummary } from '../../shared/forwardTest.js'
import type { StudyRunSummary } from '../../shared/study.js'
import {
  Badge,
  Button,
  Card,
  EmptyState,
  Field,
  Input,
  Notice,
  PageHeader,
  Select,
  Spinner,
  StatTile
} from '../components/primitives.js'
import { StudyProgressPanel } from '../components/StudyProgressPanel.js'
import { fmtCurrency, fmtDate, fmtInt, shiftDate, todayEastern } from '../lib/format.js'
import { useAsyncAction } from '../lib/hooks.js'
import { nextTradingDay } from '../../core/time/marketTime.js'

const METHOD_LABELS: Record<string, string> = {
  hold: 'Hold to expiration',
  tp25: '+25% target',
  tp50: '+50% target',
  tp75: '+75% target',
  tp100: '+100% target',
  tp150: '+150% target',
  tp200: '+200% target',
  tp300: '+300% target',
  'tp50-sl50': '+50% / -50%',
  'tp100-sl50': '+100% / -50%',
  'tp150-sl50': '+150% / -50%',
  'tp200-sl50': '+200% / -50%',
  centerTouch: 'Center strike touch',
  'tent1.0': 'Tent <= 1.00',
  'tent0.75': 'Tent <= 0.75',
  'tent0.5': 'Tent <= 0.50',
  'tent0.25': 'Tent <= 0.25',
  dte3: 'Exit at 3 DTE',
  dte2: 'Exit at 2 DTE',
  dte1: 'Exit at 1 DTE'
}

function methodLabel(id: string): string {
  return METHOD_LABELS[id] ?? id
}

function configDescription(run: StudyRunSummary): string {
  const entry = run.config.entry.type === 'ema'
    ? `${run.config.entry.period} EMA${run.config.entry.meanReversionOverride ? ' + two-candle override' : ''}`
    : `${run.config.entry.direction} fixed`
  return `${run.config.from} -> ${run.config.to} | ${entry} | ${run.config.targetDte} DTE | ${run.config.wingWidth}-wide`
}

export function ForwardTestPage() {
  const [sourceRuns, setSourceRuns] = useState<StudyRunSummary[]>([])
  const [tests, setTests] = useState<ForwardTestSummary[]>([])
  const [selectedId, setSelectedId] = useState('')
  const [detail, setDetail] = useState<ForwardTestDetail | null>(null)
  const [sourceRunId, setSourceRunId] = useState('')
  const [management, setManagement] = useState('')
  const [name, setName] = useState('')
  const [targetSessions, setTargetSessions] = useState('60')
  const [acknowledged, setAcknowledged] = useState(false)
  const [through, setThrough] = useState(shiftDate(todayEastern(), -1))

  const refresh = useCallback(async () => {
    const [runs, locked] = await Promise.all([window.api.study.list(100), window.api.forwardTest.list()])
    setSourceRuns(runs)
    setTests(locked)
    setSourceRunId((current) => current || runs[0]?.runId || '')
    setSelectedId((current) => current || locked[0]?.forwardTestId || '')
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const source = useMemo(
    () => sourceRuns.find((run) => run.runId === sourceRunId) ?? null,
    [sourceRuns, sourceRunId]
  )

  useEffect(() => {
    if (!source) return
    setManagement((current) => source.config.managements.includes(current) ? current : source.config.managements[0] ?? '')
  }, [source])

  const [detailState, loadDetail] = useAsyncAction(async (id: string) => {
    const loaded = await window.api.forwardTest.load(id)
    setDetail(loaded)
    return loaded
  })

  useEffect(() => {
    if (selectedId) void loadDetail(selectedId)
    else setDetail(null)
  }, [selectedId, loadDetail])

  const [createState, create] = useAsyncAction(async () => {
    const created = await window.api.forwardTest.create({
      sourceRunId,
      name,
      managements: [management],
      targetSessions: Number(targetSessions)
    })
    await refresh()
    setSelectedId(created.test.forwardTestId)
    setDetail(created)
    setAcknowledged(false)
    setName('')
    return created
  })

  const [planState, plan, resetPlan] = useAsyncAction(async (): Promise<ForwardRunPlan> =>
    window.api.forwardTest.plan(selectedId, through)
  )

  useEffect(() => {
    // A preview is valid only for the date and lock that produced it.
    resetPlan()
  }, [through, selectedId, resetPlan])

  const [runState, runBatch] = useAsyncAction(async () => {
    const prepared = planState.data
    if (!prepared) throw new Error('Preview the next batch before running it.')
    const result = await window.api.study.run(
      prepared.config,
      `[Forward] ${detail?.test.name ?? prepared.forwardTestId} ${prepared.from}..${prepared.to}`
    )
    const updated = await window.api.forwardTest.attachRun(prepared.forwardTestId, result.runId)
    setDetail(updated)
    await refresh()
    resetPlan()
    return updated
  })

  const selectedTest = detail?.test
  const nextDate = selectedTest?.lastCompletedDate
    ? nextTradingDay(selectedTest.lastCompletedDate)
    : selectedTest?.startDate
  const progress = selectedTest ? Math.min(100, (selectedTest.completedSessions / selectedTest.targetSessions) * 100) : 0

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
      <PageHeader
        title="Locked Forward Test"
        description="Freeze a tested hypothesis, evaluate only sessions that occur after the lock, and accumulate evidence without changing the rules."
      />

      <div className="space-y-4 p-6">
        <Card
          title="1. Lock one hypothesis"
          subtitle="Start from a saved study so every entry, placement, pricing, and data-quality assumption is copied exactly."
        >
          <div className="space-y-3">
            {sourceRuns.length === 0 ? (
              <EmptyState title="Run and save a study first">
                A forward lock needs a completed source study whose configuration can be frozen.
              </EmptyState>
            ) : (
              <>
                <div className="grid gap-3 md:grid-cols-2">
                  <Field label="Source study" hint={source ? configDescription(source) : undefined}>
                    <Select value={sourceRunId} onChange={(event) => setSourceRunId(event.target.value)}>
                      {sourceRuns.map((run) => (
                        <option key={run.runId} value={run.runId}>
                          {run.label || `${run.config.from} -> ${run.config.to}`} | {run.entryCount} entries
                        </option>
                      ))}
                    </Select>
                  </Field>
                  <Field label="Management rule" hint="One method per lock prevents choosing the winner after seeing forward results.">
                    <Select value={management} onChange={(event) => setManagement(event.target.value)}>
                      {(source?.config.managements ?? []).map((id) => (
                        <option key={id} value={id}>{methodLabel(id)}</option>
                      ))}
                    </Select>
                  </Field>
                  <Field label="Forward-test name">
                    <Input value={name} onChange={(event) => setName(event.target.value)} placeholder="Original EMA +200%" />
                  </Field>
                  <Field label="Target sessions" hint="60 is roughly three months; skipped sessions still count as evidence.">
                    <Input type="number" min="10" max="252" value={targetSessions} onChange={(event) => setTargetSessions(event.target.value)} />
                  </Field>
                </div>
                <Notice tone="info">
                  The first eligible date will be the next trading day after you lock it. Historical dates cannot be attached, and only the dates advance between batches.
                </Notice>
                <label className="flex items-start gap-2 text-[11px] leading-relaxed text-ink-dim">
                  <input type="checkbox" className="mt-0.5" checked={acknowledged} onChange={(event) => setAcknowledged(event.target.checked)} />
                  <span>I understand that changing any strategy setting requires a new forward test and a new start date.</span>
                </label>
                {createState.error && <Notice tone="error">{createState.error}</Notice>}
                <Button
                  variant="primary"
                  disabled={!sourceRunId || !management || !name.trim() || !acknowledged || createState.loading}
                  onClick={() => void create()}
                >
                  {createState.loading && <Spinner />} Lock configuration
                </Button>
              </>
            )}
          </div>
        </Card>

        <Card
          title="2. Collect new sessions"
          subtitle="Preview the next contiguous batch, then let the normal cache verification and download pipeline run it."
          actions={tests.length > 0 ? (
            <Select value={selectedId} onChange={(event) => setSelectedId(event.target.value)} className="w-64">
              {tests.map((test) => <option key={test.forwardTestId} value={test.forwardTestId}>{test.name}</option>)}
            </Select>
          ) : undefined}
        >
          {!selectedTest ? (
            <EmptyState title={detailState.loading ? 'Loading forward test...' : 'No locked test selected'}>
              Complete step 1 to begin prospective collection.
            </EmptyState>
          ) : (
            <div className="space-y-3">
                <div className="grid grid-cols-2 gap-3 md:grid-cols-6">
                <StatTile label="State" value={selectedTest.state} tone={selectedTest.state === 'complete' ? 'gain' : 'neutral'} />
                <StatTile label="First eligible" value={selectedTest.startDate} />
                <StatTile label="Next session" value={nextDate ?? '—'} />
                <StatTile label="Mature through" value={selectedTest.latestMatureEntryDate} hint="full lifecycle available" />
                <StatTile label="Evaluated" value={`${selectedTest.completedSessions}/${selectedTest.targetSessions}`} />
                <StatTile label="Accepted" value={fmtInt(selectedTest.acceptedEntries)} hint={`${selectedTest.skippedSessions} skipped`} />
              </div>
              <div className="h-1.5 overflow-hidden rounded-full bg-line">
                <div className="h-full bg-accent" style={{ width: `${progress}%` }} />
              </div>
              <div className="rounded-md border border-line-soft bg-ground p-3 text-[10px] leading-relaxed text-ink-faint">
                <div><span className="text-ink-dim">Locked:</span> {fmtDate(selectedTest.createdAt)}</div>
                <div><span className="text-ink-dim">Configuration hash:</span> <code className="num">{selectedTest.configHash}</code></div>
                <div><span className="text-ink-dim">Engine:</span> {selectedTest.appVersion}{selectedTest.gitCommit ? ` (${selectedTest.gitCommit.slice(0, 12)})` : ''}</div>
                <div><span className="text-ink-dim">Rules:</span> {selectedTest.config.entry.type === 'ema' ? `${selectedTest.config.entry.period} EMA` : selectedTest.config.entry.direction}, {selectedTest.config.targetDte} DTE, {selectedTest.config.wingWidth}-wide, {methodLabel(selectedTest.config.managements[0] ?? '')}</div>
              </div>
              {selectedTest.state === 'active' && (
                <div className="flex flex-wrap items-end gap-3">
                  <Field label="Check through" hint={`Only fully matured entries through ${selectedTest.latestMatureEntryDate} can be included.`}>
                    <Input type="date" value={through} max={shiftDate(todayEastern(), -1)} onChange={(event) => setThrough(event.target.value)} className="w-44" />
                  </Field>
                  <Button disabled={planState.loading || runState.loading} onClick={() => void plan()}>
                    {planState.loading && <Spinner />} Check available sessions
                  </Button>
                </div>
              )}
              {planState.error && <Notice tone="warn">{planState.error}</Notice>}
              {planState.data && (
                <Notice tone="info">
                  Next immutable batch: <span className="num">{planState.data.from} {'\u2192'} {planState.data.to}</span>, {planState.data.sessions} trading sessions. {planState.data.remainingAfterRun} will remain afterward.
                  <div className="mt-2 flex gap-2">
                    <Button variant="primary" disabled={runState.loading} onClick={() => void runBatch()}>
                      {runState.loading && <Spinner />} Verify data and run batch
                    </Button>
                    {runState.loading && <Button variant="danger" onClick={() => void window.api.study.cancel()}>Cancel</Button>}
                  </div>
                </Notice>
              )}
              {runState.error && <Notice tone="error">{runState.error}</Notice>}
              {selectedTest.state === 'complete' && (
                <Notice tone="success">The predeclared session target has been reached. This test is sealed as complete.</Notice>
              )}
            </div>
          )}
        </Card>

        {runState.loading && <StudyProgressPanel />}

        <Card
          title="3. Read forward-only evidence"
          subtitle="These metrics include attached forward batches only; the source backtest is never mixed into them."
        >
          {!detail || detail.runs.length === 0 ? (
            <EmptyState title="No forward sessions have been evaluated yet">
              Results appear here after the first eligible batch completes.
            </EmptyState>
          ) : (
            <div className="space-y-4">
              <div className="overflow-x-auto rounded-md border border-line">
                <table className="w-full border-collapse text-[11px]">
                  <thead className="bg-surface-2 text-ink-faint">
                    <tr><th className="px-3 py-2 text-left">Method</th><th className="px-3 py-2 text-right">Trades</th><th className="px-3 py-2 text-right">P/L</th><th className="px-3 py-2 text-right">Expectancy</th><th className="px-3 py-2 text-right">Win %</th><th className="px-3 py-2 text-right">PF</th><th className="px-3 py-2 text-right">Max DD</th></tr>
                  </thead>
                  <tbody className="num">
                    {detail.summaries.map((summary) => (
                      <tr key={summary.strategyId} className="border-t border-line-soft">
                        <td className="px-3 py-2 text-ink">{summary.strategyLabel}</td>
                        <td className="px-3 py-2 text-right">{fmtInt(summary.metrics.totalTrades)}</td>
                        <td className={`px-3 py-2 text-right ${summary.metrics.totalPnl >= 0 ? 'text-gain' : 'text-loss'}`}>{fmtCurrency(summary.metrics.totalPnl)}</td>
                        <td className="px-3 py-2 text-right">{fmtCurrency(summary.metrics.expectancy)}</td>
                        <td className="px-3 py-2 text-right">{summary.metrics.winRate.toFixed(1)}%</td>
                        <td className="px-3 py-2 text-right">{summary.metrics.profitFactor?.toFixed(2) ?? '—'}</td>
                        <td className="px-3 py-2 text-right text-loss">{fmtCurrency(summary.metrics.maxDrawdown)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div>
                <div className="mb-1.5 text-[11px] font-medium text-ink-dim">Auditable batches</div>
                <div className="space-y-1">
                  {detail.runs.map((run) => (
                    <div key={run.runId} className="flex items-center justify-between rounded-md border border-line-soft bg-surface-2 px-3 py-2 text-[11px]">
                      <span className="num text-ink-dim">{run.from} {'\u2192'} {run.to} | {run.sessions} sessions | {run.acceptedEntries} accepted</span>
                      <Link className="text-accent hover:underline" to={`/results?run=${run.runId}`}>Open result</Link>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}
        </Card>
      </div>
    </div>
  )
}
