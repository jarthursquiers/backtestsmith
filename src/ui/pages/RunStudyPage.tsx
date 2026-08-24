import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import type { StudyConfig } from '../../shared/study.js'
import {
  buildStudyConfig,
  DEFAULT_STRATEGY_ID,
  defaultStrategyParams,
  requireStrategy,
  type StrategyParamValue
} from '../../shared/strategyCatalog.js'
import { tradingDaysBetween } from '../../core/time/marketTime.js'
import { Badge, Button, Card, Field, Input, Notice, PageHeader, Select } from '../components/primitives.js'
import { fmtInt, shiftDate, todayEastern } from '../lib/format.js'
import { useAsyncAction } from '../lib/hooks.js'
import { StudyProgressPanel } from '../components/StudyProgressPanel.js'
import { StrategyPicker } from '../components/StrategyPicker.js'
import { ManagementSelector } from '../components/ManagementSelector.js'

/**
 * Configure and run one study.
 *
 * The screen is built from the strategy catalogue rather than from a fixed set
 * of controls, so a new strategy appears here the moment it is defined and
 * nothing on this page has to know what it does.
 */
export function RunStudyPage() {
  const navigate = useNavigate()

  const defaultTo = shiftDate(todayEastern(), -7)
  const [from, setFrom] = useState(shiftDate(defaultTo, -365))
  const [to, setTo] = useState(defaultTo)

  const [strategyId, setStrategyId] = useState(DEFAULT_STRATEGY_ID)
  const strategy = useMemo(() => requireStrategy(strategyId), [strategyId])
  const [params, setParams] = useState<Record<string, StrategyParamValue>>(() =>
    defaultStrategyParams(requireStrategy(DEFAULT_STRATEGY_ID))
  )
  const [selected, setSelected] = useState<string[]>(() => [
    ...requireStrategy(DEFAULT_STRATEGY_ID).defaultManagements
  ])

  const [slippage, setSlippage] = useState('0.05')
  const [missingDataMode, setMissingDataMode] = useState<'strict' | 'carryForward'>('carryForward')
  const [maxStale, setMaxStale] = useState('1')
  const [minimumCoverage, setMinimumCoverage] = useState('0.8')
  const [label, setLabel] = useState('')
  const [offlineOnly, setOfflineOnly] = useState(false)

  const sessions = useMemo(() => {
    try {
      const dates = tradingDaysBetween(from, to)
      if (strategy.structure !== 'doubleCalendar') return dates.length

      const built = strategy.build({ ...defaultStrategyParams(strategy), ...params })
      if (!built.calendar || built.calendar.entryWeekdays.length === 0) return dates.length

      // A scheduled calendar opens once per ISO week. Holidays shift the entry
      // to another session in that week, so counting week buckets is exact even
      // when the requested weekday is closed.
      return new Set(dates.map((date) => {
        const day = new Date(`${date}T12:00:00Z`)
        const weekday = day.getUTCDay() || 7
        day.setUTCDate(day.getUTCDate() - weekday + 1)
        return day.toISOString().slice(0, 10)
      })).size
    } catch {
      return 0
    }
  }, [from, params, strategy, to])

  /*
   * Switching strategy resets both the parameters and the management set. The
   * two are strategy-specific - a 0DTE study has no use for a 3-DTE exit - and
   * carrying stale values across would produce a run that looks configured but
   * is not.
   */
  const selectStrategy = (id: string): void => {
    const next = requireStrategy(id)
    setStrategyId(id)
    setParams(defaultStrategyParams(next))
    setSelected([...next.defaultManagements])
  }

  const config = (): StudyConfig => ({
    ...buildStudyConfig({
      strategyId,
      params,
      from,
      to,
      managements: selected,
      pricing: {
        model: 'close',
        // Calendar fills are controlled by their four-leg package-spread
        // assumption. The butterfly-only fixed slippage must not leak into it.
        slippage: strategy.structure === 'doubleCalendar' ? 0 : Number(slippage) || 0,
        missingDataMode,
        maxStaleMinutes: Number(maxStale) || 5
      },
      minimumCoverage: Number(minimumCoverage) || 0
    }),
    ...(offlineOnly ? { offlineOnly: true } : {})
  })

  const [runState, run] = useAsyncAction(async () => {
    const result = await window.api.study.run(config(), label.trim() || undefined)
    // Only navigate away when there is something to look at; otherwise the
    // progress panel and its skip reasons stay on screen where they are useful.
    if (result.entryCount > 0) navigate(`/results?run=${result.runId}`)
    return result
  })

  const running = runState.loading

  return (
    <>
      <PageHeader
        title="Run Study"
        description="Choose a strategy, then compare every management method against the one entry population it produces."
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

        <StrategyPicker
          strategy={strategy}
          params={params}
          onSelect={selectStrategy}
          onParamChange={(key, value) => setParams((prev) => ({ ...prev, [key]: value }))}
          footer={
            <div className="grid gap-3 md:grid-cols-3">
              <Field label="From">
                <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
              </Field>
              <Field label="To">
                <Input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
              </Field>
              <Field label="Label" hint="Optional name for this run">
                <Input
                  value={label}
                  onChange={(e) => setLabel(e.target.value)}
                  placeholder={`e.g. ${strategy.label}`}
                />
              </Field>
            </div>
          }
        />

        <Card title="Execution assumptions" subtitle="Recorded with the run, since they change the numbers">
          <div className="mb-3">
            <Notice tone="info">
              {strategy.structure === 'doubleCalendar'
                ? 'Double calendars run from the local option archive. Entries must fill inside the entry window, carried quotes cannot exceed the configured age, and both calendars must have non-negative close values. Strict mode requires fresh same-minute prices for all four legs.'
                : 'Safety checks are always on: entries must fill inside the entry window, carried quotes cannot exceed the configured age, and every synthetic mark must remain between zero and the wing width. Strict mode requires fresh same-minute prices for all three legs.'}
            </Notice>
          </div>
          <div className={`grid gap-3 ${strategy.structure === 'doubleCalendar' ? 'md:grid-cols-3' : 'md:grid-cols-4'}`}>
            {strategy.structure !== 'doubleCalendar' && (
              <Field label="Slippage" hint="Points against you, each way">
                <Input type="number" step="0.05" value={slippage} onChange={(e) => setSlippage(e.target.value)} />
              </Field>
            )}
            <Field label="Missing data">
              <Select
                value={missingDataMode}
                onChange={(e) => setMissingDataMode(e.target.value as 'strict' | 'carryForward')}
              >
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
          {strategy.structure === 'doubleCalendar' ? (
            <Notice tone="warn">
              Archive only: this study never falls back to a quote provider because selecting and following four
              legs from whole chains would require tens of thousands of requests. Import the option archive first.
            </Notice>
          ) : (
            <label className="mt-3 flex cursor-pointer items-start gap-2 rounded-md border border-line bg-ground p-3">
              <input
                type="checkbox"
                checked={offlineOnly}
                onChange={(event) => setOfflineOnly(event.target.checked)}
                className="mt-0.5"
              />
              <span>
                <span className="block text-[12px] font-medium text-ink">Offline only</span>
                <span className="block text-[10px] leading-relaxed text-ink-faint">
                  Read DuckDB only and refuse provider fallback. Use this to prove an archived strategy can run
                  after the ThetaData subscription is removed.
                </span>
              </span>
            </label>
          )}
        </Card>

        <ManagementSelector
          horizon={strategy.horizon}
          structure={strategy.structure}
          selected={selected}
          defaults={strategy.defaultManagements}
          onChange={setSelected}
          footer={
            <div className="flex flex-wrap items-center gap-2">
              <Badge tone="accent">{fmtInt(sessions)} candidate sessions</Badge>
              <Badge>{fmtInt(selected.length)} methods</Badge>
              <span className="text-[11px] text-ink-faint">
                {strategy.structure === 'doubleCalendar'
                  ? 'Calendar entries are served only from the local option archive.'
                  : 'Uncached data is fetched from the configured paid providers, so a cold first run can take time; a re-run over the same range is served from the local cache.'}
              </span>
            </div>
          }
        />
      </div>
    </>
  )
}
