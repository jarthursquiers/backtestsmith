import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import type { StudyConfig } from '../../shared/study.js'
import { tradingDaysBetween } from '../../core/time/marketTime.js'
import {
  Badge,
  Button,
  Card,
  Field,
  Input,
  Notice,
  PageHeader,
  Select
} from '../components/primitives.js'
import { fmtInt, shiftDate, todayEastern } from '../lib/format.js'
import { useAsyncAction } from '../lib/hooks.js'
import { StudyProgressPanel } from '../components/StudyProgressPanel.js'

/** Ids the engine can resolve; kept in step with managementSets.ts. */
const MANAGEMENT_OPTIONS: { id: string; label: string; group: string }[] = [
  { id: 'hold', label: 'Hold to expiration', group: 'Baseline' },
  { id: 'tp25', label: '+25% target', group: 'Profit target' },
  { id: 'tp50', label: '+50% target', group: 'Profit target' },
  { id: 'tp75', label: '+75% target', group: 'Profit target' },
  { id: 'tp100', label: '+100% target', group: 'Profit target' },
  { id: 'tp150', label: '+150% target', group: 'Profit target' },
  { id: 'tp200', label: '+200% target', group: 'Profit target' },
  { id: 'tp300', label: '+300% target', group: 'Profit target' },
  { id: 'tp50-sl50', label: '+50% / -50%', group: 'Target with stop' },
  { id: 'tp100-sl50', label: '+100% / -50%', group: 'Target with stop' },
  { id: 'tp150-sl50', label: '+150% / -50%', group: 'Target with stop' },
  { id: 'tp200-sl50', label: '+200% / -50%', group: 'Target with stop' },
  { id: 'centerTouch', label: 'Center strike touch', group: 'Underlying location' },
  { id: 'tent1.0', label: 'Tent ≤ 1.00', group: 'Underlying location' },
  { id: 'tent0.75', label: 'Tent ≤ 0.75', group: 'Underlying location' },
  { id: 'tent0.5', label: 'Tent ≤ 0.50', group: 'Underlying location' },
  { id: 'tent0.25', label: 'Tent ≤ 0.25', group: 'Underlying location' },
  { id: 'dte3', label: 'Exit at 3 DTE', group: 'Time' },
  { id: 'dte2', label: 'Exit at 2 DTE', group: 'Time' },
  { id: 'dte1', label: 'Exit at 1 DTE', group: 'Time' },
  { id: 'trail100-30pct', label: 'Trail after +100%, give back 30% of peak', group: 'Trailing' },
  { id: 'trail100-30pts', label: 'Trail after +100%, give back 30 points', group: 'Trailing' }
]

const DEFAULT_SELECTION = MANAGEMENT_OPTIONS.filter((o) => o.group !== 'Trailing').map((o) => o.id)

export function RunStudyPage() {
  const navigate = useNavigate()

  const [from, setFrom] = useState(shiftDate(todayEastern(), -90))
  const [to, setTo] = useState(shiftDate(todayEastern(), -7))
  const [entryTime, setEntryTime] = useState('09:35')
  const [entryWindow, setEntryWindow] = useState('15')
  const [emaPeriod, setEmaPeriod] = useState('9')
  const [targetDte, setTargetDte] = useState('7')
  const [maxDeviation, setMaxDeviation] = useState('2')
  const [wingWidth, setWingWidth] = useState('25')
  const [placementType, setPlacementType] = useState<'expectedMove' | 'fixedDistance' | 'wingWidths'>('expectedMove')
  const [offsetPoints, setOffsetPoints] = useState('100')
  const [wingsAway, setWingsAway] = useState('4')
  const [buffer, setBuffer] = useState('0')
  const [slippage, setSlippage] = useState('0')
  const [missingDataMode, setMissingDataMode] = useState<'strict' | 'carryForward'>('carryForward')
  const [maxStale, setMaxStale] = useState('5')
  const [minimumCoverage, setMinimumCoverage] = useState('0.5')
  const [label, setLabel] = useState('')
  const [selected, setSelected] = useState<string[]>(DEFAULT_SELECTION)

  const sessions = useMemo(() => {
    try {
      return tradingDaysBetween(from, to).length
    } catch {
      return 0
    }
  }, [from, to])

  const config = (): StudyConfig => ({
    underlying: 'SPX',
    from,
    to,
    entryTime,
    entryWindowMinutes: Number(entryWindow) || 0,
    entry: { type: 'ema', period: Number(emaPeriod) || 9 },
    targetDte: Number(targetDte) || 7,
    expirationRule: 'nearest',
    maxDeviation: Number(maxDeviation) || 2,
    preferredRoot: 'SPXW',
    placement:
      placementType === 'fixedDistance'
        ? { type: 'fixedDistance', offsetPoints: Number(offsetPoints) || 100 }
        : placementType === 'wingWidths'
          ? { type: 'wingWidths', wingsAway: Number(wingsAway) || 4 }
          : { type: 'expectedMove', buffer: Number(buffer) || 0 },
    wingWidth: Number(wingWidth) || 25,
    quantity: 1,
    pricing: {
      model: 'close',
      slippage: Number(slippage) || 0,
      missingDataMode,
      maxStaleMinutes: Number(maxStale) || 5
    },
    minimumCoverage: Number(minimumCoverage) || 0,
    managements: selected
  })

  const [runState, run] = useAsyncAction(async () => {
    const result = await window.api.study.run(config(), label.trim() || undefined)
    // Only navigate away when there is something to look at; otherwise the
    // progress panel and its skip reasons stay on screen where they are useful.
    if (result.entryCount > 0) navigate(`/results?run=${result.runId}`)
    return result
  })

  const toggle = (id: string): void =>
    setSelected((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]))

  const groups = [...new Set(MANAGEMENT_OPTIONS.map((o) => o.group))]
  const running = runState.loading

  return (
    <>
      <PageHeader
        title="Run Study"
        description="One click verifies the local cache, downloads anything missing, and runs every management method."
        actions={
          running ? (
            <Button variant="danger" onClick={() => void window.api.study.cancel()}>
              Cancel
            </Button>
          ) : (
            <Button variant="primary" onClick={() => void run()} disabled={selected.length === 0}>
              Run study
            </Button>
          )
        }
      />

      <div className="flex-1 space-y-4 overflow-y-auto p-6">
        <StudyProgressPanel />

        {runState.error && <Notice tone="error">{runState.error}</Notice>}

        <div className="grid gap-4 lg:grid-cols-2">
          <Card title="Entry" subtitle="Signal, timing, and expiration targeting">
            <div className="grid gap-3 md:grid-cols-2">
              <Field label="From">
                <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
              </Field>
              <Field label="To">
                <Input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
              </Field>
              <Field label="Entry time (ET)">
                <Input value={entryTime} onChange={(e) => setEntryTime(e.target.value)} />
              </Field>
              <Field
                label="Entry window"
                hint="Minutes a fill may trail the entry time when prices are sparse"
              >
                <Input
                  type="number"
                  min={0}
                  value={entryWindow}
                  onChange={(e) => setEntryWindow(e.target.value)}
                />
              </Field>
              <Field label="EMA period" hint="Direction from price against this daily average">
                <Input type="number" min={2} value={emaPeriod} onChange={(e) => setEmaPeriod(e.target.value)} />
              </Field>
              <Field label="Target DTE" hint="Calendar days">
                <Input type="number" min={1} value={targetDte} onChange={(e) => setTargetDte(e.target.value)} />
              </Field>
              <Field label="Max deviation" hint="Days either side of the target">
                <Input type="number" min={0} value={maxDeviation} onChange={(e) => setMaxDeviation(e.target.value)} />
              </Field>
            </div>
            <div className="mt-3">
              <Badge tone="accent">{fmtInt(sessions)} candidate sessions</Badge>
            </div>
          </Card>

          <Card title="Structure" subtitle="Where the butterfly sits and how wide it is">
            <div className="grid gap-3 md:grid-cols-2">
              <Field label="Placement">
                <Select
                  value={placementType}
                  onChange={(e) => setPlacementType(e.target.value as typeof placementType)}
                >
                  <option value="expectedMove">Near wing outside expected move</option>
                  <option value="fixedDistance">Fixed distance OTM</option>
                  <option value="wingWidths">Wing widths OTM</option>
                </Select>
              </Field>
              <Field label="Wing width" hint="SPX points">
                <Select value={wingWidth} onChange={(e) => setWingWidth(e.target.value)}>
                  {[10, 15, 20, 25, 30, 50].map((w) => (
                    <option key={w} value={w}>{w}</option>
                  ))}
                </Select>
              </Field>
              {placementType === 'fixedDistance' && (
                <Field label="Offset" hint="Points from SPX to the centre">
                  <Input type="number" value={offsetPoints} onChange={(e) => setOffsetPoints(e.target.value)} />
                </Field>
              )}
              {placementType === 'wingWidths' && (
                <Field label="Wings away" hint="Centre distance in wing widths">
                  <Input type="number" step="0.5" value={wingsAway} onChange={(e) => setWingsAway(e.target.value)} />
                </Field>
              )}
              {placementType === 'expectedMove' && (
                <Field label="Buffer" hint="Extra points beyond the expected move">
                  <Input type="number" value={buffer} onChange={(e) => setBuffer(e.target.value)} />
                </Field>
              )}
            </div>
            {placementType === 'expectedMove' && (
              <div className="mt-3">
                <Notice tone="info">
                  Expected move is the at-the-money straddle price at the entry minute, measured from data. A
                  session where it cannot be priced is skipped rather than estimated.
                </Notice>
              </div>
            )}
          </Card>
        </div>

        <Card title="Execution assumptions" subtitle="Recorded with the run, since they change the numbers">
          <div className="grid gap-3 md:grid-cols-4">
            <Field label="Slippage" hint="Points against you, each way">
              <Input type="number" step="0.05" value={slippage} onChange={(e) => setSlippage(e.target.value)} />
            </Field>
            <Field label="Missing data">
              <Select value={missingDataMode} onChange={(e) => setMissingDataMode(e.target.value as 'strict' | 'carryForward')}>
                <option value="carryForward">Carry forward</option>
                <option value="strict">Strict</option>
              </Select>
            </Field>
            <Field label="Max stale" hint="Minutes a leg may be carried">
              <Input
                type="number"
                min={1}
                value={maxStale}
                disabled={missingDataMode === 'strict'}
                onChange={(e) => setMaxStale(e.target.value)}
              />
            </Field>
            <Field label="Minimum coverage" hint="0–1; trades below this are excluded">
              <Input
                type="number"
                step="0.05"
                min={0}
                max={1}
                value={minimumCoverage}
                onChange={(e) => setMinimumCoverage(e.target.value)}
              />
            </Field>
          </div>
        </Card>

        <Card
          title="Management methods"
          subtitle="Every selected method sees the identical entry population, which is what makes the comparison valid."
          actions={
            <div className="flex gap-2">
              <Button onClick={() => setSelected(MANAGEMENT_OPTIONS.map((o) => o.id))}>All</Button>
              <Button onClick={() => setSelected(DEFAULT_SELECTION)}>Default set</Button>
              <Button onClick={() => setSelected([])}>None</Button>
            </div>
          }
        >
          <div className="space-y-3">
            {groups.map((group) => (
              <div key={group}>
                <div className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-ink-faint">
                  {group}
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {MANAGEMENT_OPTIONS.filter((o) => o.group === group).map((option) => (
                    <button
                      key={option.id}
                      onClick={() => toggle(option.id)}
                      className={`rounded-md border px-2 py-1 text-[11px] transition ${
                        selected.includes(option.id)
                          ? 'border-accent/50 bg-accent/15 text-accent'
                          : 'border-line bg-surface-2 text-ink-dim hover:border-ink-faint'
                      }`}
                    >
                      {option.label}
                    </button>
                  ))}
                </div>
              </div>
            ))}

            <div className="grid gap-3 md:grid-cols-2">
              <Field label="Label" hint="Optional name for this run">
                <Input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="e.g. 7 DTE / 25 wide / EM" />
              </Field>
            </div>

            <Notice tone="info">
              {fmtInt(selected.length)} methods across up to {fmtInt(sessions)} sessions. Uncached data is
              fetched at the Massive rate limit, so a first run over a long range can take hours; a re-run over
              the same range is served from the local cache.
            </Notice>
          </div>
        </Card>
      </div>
    </>
  )
}
