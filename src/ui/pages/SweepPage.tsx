import { useEffect, useMemo, useState } from 'react'
import type { StudyConfig, StudyProgress } from '../../shared/study.js'
import { valuesFromRange, type SweepAxis, type SweepResult } from '../../shared/sweep.js'
import {
  buildStudyConfig,
  DEFAULT_STRATEGY_ID,
  defaultStrategyParams,
  requireStrategy,
  type StrategyParamValue
} from '../../shared/strategyCatalog.js'
import { StrategyPicker } from '../components/StrategyPicker.js'
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
import { fmtCurrency, fmtInt, shiftDate, todayEastern } from '../lib/format.js'
import { useAsyncAction } from '../lib/hooks.js'

/**
 * Axes the engine can sweep, with their cost character.
 *
 * `strategies` narrows the list to the axes that mean something for the chosen
 * rule set: an EMA period is inert on a breakout study, and offering it invites
 * a sweep whose every combination is identical.
 */
const AXES: {
  name: string
  label: string
  kind: 'entry' | 'management'
  placeholder: string
}[] = [
  { name: 'profitTarget', label: 'Profit target %', kind: 'management', placeholder: '25, 50, 75-300:25' },
  { name: 'stopLoss', label: 'Stop loss %', kind: 'management', placeholder: '25, 50, 75, 100' },
  { name: 'targetDte', label: 'Target DTE', kind: 'entry', placeholder: '5, 7, 10' },
  { name: 'wingWidth', label: 'Wing width', kind: 'entry', placeholder: '10, 25, 50' },
  { name: 'emaPeriod', label: 'EMA period', kind: 'entry', placeholder: '9, 21' },
  { name: 'openingRangeMinutes', label: 'Opening range minutes', kind: 'entry', placeholder: '5, 15, 30' },
  { name: 'confirmationMinutes', label: 'Confirmation minutes', kind: 'entry', placeholder: '1, 5, 15' },
  { name: 'offsetPoints', label: 'Offset points OTM', kind: 'entry', placeholder: '50, 100, 150' },
  { name: 'expectedMoveBuffer', label: 'Expected move buffer', kind: 'entry', placeholder: '0, 10, 25' },
  { name: 'slippage', label: 'Slippage', kind: 'entry', placeholder: '0, 0.05, 0.1' },
  { name: 'maxStaleMinutes', label: 'Max stale minutes', kind: 'entry', placeholder: '1, 5, 15' },
  { name: 'targetDelta', label: 'Short strike delta', kind: 'entry', placeholder: '20, 25, 30, 35' },
  { name: 'frontDte', label: 'Short expiration DTE', kind: 'entry', placeholder: '7, 10, 14' },
  { name: 'backDte', label: 'Long expiration DTE', kind: 'entry', placeholder: '14, 21, 28' },
  { name: 'spreadFraction', label: 'Package spread paid', kind: 'entry', placeholder: '0, 0.25, 0.5, 1' }
]

type RangeAxisName = 'targetDte' | 'wingWidth'

interface RangeInput {
  enabled: boolean
  start: string
  end: string
  increment: string
}

const RANGE_AXES: {
  name: RangeAxisName
  label: string
  minimum: number
  integer: boolean
  defaults: Omit<RangeInput, 'enabled'>
}[] = [
  {
    name: 'targetDte',
    label: 'Target DTE range',
    minimum: 1,
    integer: true,
    defaults: { start: '3', end: '14', increment: '1' }
  },
  {
    name: 'wingWidth',
    label: 'Wing-width range',
    minimum: 5,
    integer: false,
    defaults: { start: '10', end: '50', increment: '5' }
  }
]

const RANGE_AXIS_NAMES = new Set<string>(RANGE_AXES.map((axis) => axis.name))

function resolveRange(
  definition: (typeof RANGE_AXES)[number],
  input: RangeInput
): { axis: SweepAxis | null; error: string | null } {
  if (!input.enabled) return { axis: null, error: null }

  try {
    const values = valuesFromRange({
      start: Number(input.start),
      end: Number(input.end),
      increment: Number(input.increment)
    })
    if (values.some((value) => value < definition.minimum)) {
      return { axis: null, error: `${definition.label} values must be at least ${definition.minimum}.` }
    }
    if (definition.integer && values.some((value) => !Number.isInteger(value))) {
      return { axis: null, error: `${definition.label} values and increment must be whole numbers.` }
    }
    return { axis: { name: definition.name, values }, error: null }
  } catch (error) {
    return { axis: null, error: error instanceof Error ? error.message : String(error) }
  }
}

/** Mirrors parseValueList in the engine so the estimate can be shown live. */
function parseValues(input: string): number[] {
  const out: number[] = []
  for (const part of input.split(',').map((s) => s.trim()).filter(Boolean)) {
    const range = /^(-?\d+(?:\.\d+)?)\s*-\s*(-?\d+(?:\.\d+)?)(?::(\d+(?:\.\d+)?))?$/.exec(part)
    if (range) {
      const from = Number(range[1])
      const to = Number(range[2])
      const step = Number(range[3] ?? 1)
      if (step <= 0) continue
      for (let v = from; v <= to + 1e-9; v += step) out.push(Number(v.toFixed(6)))
      continue
    }
    const single = Number(part)
    if (Number.isFinite(single)) out.push(single)
  }
  return [...new Set(out)]
}

export function SweepPage() {
  const [from, setFrom] = useState(shiftDate(todayEastern(), -60))
  const [to, setTo] = useState(shiftDate(todayEastern(), -7))
  const [objective, setObjective] = useState('totalPnl')
  const [inputs, setInputs] = useState<Record<string, string>>({ profitTarget: '25, 50, 100, 150, 200' })
  const [rangeInputs, setRangeInputs] = useState<Record<RangeAxisName, RangeInput>>(() => ({
    targetDte: { enabled: false, ...RANGE_AXES[0]!.defaults },
    wingWidth: { enabled: false, ...RANGE_AXES[1]!.defaults }
  }))
  const [progress, setProgress] = useState<StudyProgress | null>(null)
  const [results, setResults] = useState<SweepResult[]>([])

  const [strategyId, setStrategyId] = useState(DEFAULT_STRATEGY_ID)
  const strategy = useMemo(() => requireStrategy(strategyId), [strategyId])
  const [params, setParams] = useState<Record<string, StrategyParamValue>>(() =>
    defaultStrategyParams(requireStrategy(DEFAULT_STRATEGY_ID))
  )

  useEffect(() => window.api.study.onProgress(setProgress), [])

  /** Axes offered for the chosen strategy, plus any the user has already filled. */
  const availableAxes = useMemo(
    () => AXES.filter((axis) =>
      strategy.sweepAxes.includes(axis.name) && !RANGE_AXIS_NAMES.has(axis.name)
    ),
    [strategy]
  )

  const configuredRanges = useMemo(() =>
    RANGE_AXES
      .filter((definition) => strategy.sweepAxes.includes(definition.name))
      .map((definition) => ({
        definition,
        input: rangeInputs[definition.name],
        resolved: resolveRange(definition, rangeInputs[definition.name])
      })),
  [rangeInputs, strategy])

  const rangeErrors = useMemo(
    () => configuredRanges.flatMap(({ definition, resolved }) =>
      resolved.error ? [`${definition.label}: ${resolved.error}`] : []
    ),
    [configuredRanges]
  )

  const axes = useMemo((): SweepAxis[] => [
    ...configuredRanges.flatMap(({ resolved }) => resolved.axis ? [resolved.axis] : []),
    ...Object.entries(inputs)
      .filter(([name]) => strategy.sweepAxes.includes(name))
      .map(([name, raw]) => ({ name, values: parseValues(raw) }))
      .filter((a) => a.values.length > 0)
  ], [configuredRanges, inputs, strategy])

  const selectStrategy = (id: string): void => {
    const next = requireStrategy(id)
    setStrategyId(id)
    setParams(defaultStrategyParams(next))
    setResults([])
  }

  const updateRange = (name: RangeAxisName, patch: Partial<RangeInput>): void => {
    setRangeInputs((previous) => ({
      ...previous,
      [name]: { ...previous[name], ...patch }
    }))
  }

  const estimate = useMemo(() => {
    const entryAxes = axes.filter((a) => AXES.find((x) => x.name === a.name)?.kind === 'entry')
    const managementAxes = axes.filter((a) => AXES.find((x) => x.name === a.name)?.kind === 'management')
    return {
      entryCombinations: entryAxes.reduce((total, a) => total * a.values.length, 1),
      managementVariants: managementAxes.reduce((total, a) => total + a.values.length, 0),
      requiresRefetch: entryAxes.length > 0
    }
  }, [axes])

  /*
   * The base configuration comes from the same catalogue Run Study uses, so a
   * sweep varies parameters around a strategy that is genuinely the one being
   * researched rather than a second, hand-maintained copy of it.
   */
  const baseConfig = (): StudyConfig =>
    buildStudyConfig({
      strategyId,
      params,
      from,
      to,
      managements: ['hold'],
      pricing: { model: 'close', slippage: 0.05, missingDataMode: 'carryForward', maxStaleMinutes: 1 },
      minimumCoverage: 0.8
    })

  const [runState, run] = useAsyncAction(async () => {
    setResults([])
    setProgress(null)
    const out = await window.api.sweep.run(baseConfig(), axes, objective)
    setResults(out)
    return out
  })

  const axisNames = useMemo(() => [...new Set(results.flatMap((r) => Object.keys(r.values)))], [results])

  return (
    <>
      <PageHeader
        title="Parameter Sweep"
        description="Vary any axis of the study and compare the outcomes. Management axes ride along on the same data; entry axes require fresh downloads."
        actions={
          runState.loading ? (
            <Button variant="danger" onClick={() => void window.api.study.cancel()}>
              Cancel
            </Button>
          ) : (
            <Button
              variant="primary"
              onClick={() => void run()}
              disabled={axes.length === 0 || rangeErrors.length > 0}
            >
              Run sweep
            </Button>
          )
        }
      />

      <div className="flex-1 space-y-4 overflow-y-auto p-6">
        {runState.loading && progress && (
          <Card title="Running">
            <div className="space-y-2">
              <div className="h-1.5 w-full overflow-hidden rounded-full bg-line">
                <div
                  className="h-full bg-accent transition-all"
                  style={{ width: `${progress.total > 0 ? (progress.completed / progress.total) * 100 : 0}%` }}
                />
              </div>
              <div className="num text-[11px] text-ink-dim">{progress.currentDate ?? ''}</div>
            </div>
          </Card>
        )}

        {runState.error && <Notice tone="error">{runState.error}</Notice>}

        <StrategyPicker
          strategy={strategy}
          params={params}
          onSelect={selectStrategy}
          onParamChange={(key, value) => setParams((prev) => ({ ...prev, [key]: value }))}
        />

        <Card title="Range and objective">
          <div className="grid gap-3 md:grid-cols-3">
            <Field label="From">
              <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
            </Field>
            <Field label="To">
              <Input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
            </Field>
            <Field label="Rank by" hint="Used only to mark a best row, not to choose for you">
              <Select value={objective} onChange={(e) => setObjective(e.target.value)}>
                <option value="totalPnl">Total P/L</option>
                <option value="expectancy">Expectancy</option>
                <option value="profitFactor">Profit factor</option>
                <option value="capture">MFE capture</option>
                <option value="winRate">Win rate</option>
                <option value="maxDrawdown">Smallest drawdown</option>
              </Select>
            </Field>
          </div>
        </Card>

        <Card
          title="Axes"
          subtitle="Enable DTE and wing-width ranges to run their full grid as one sweep. Leave anything else blank to hold it fixed."
        >
          <div className="space-y-3">
            {configuredRanges.length > 0 && (
              <div>
                <div className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-ink-faint">
                  DTE × wing-width grid
                </div>
                <div className="grid gap-3 xl:grid-cols-2">
                  {configuredRanges.map(({ definition, input, resolved }) => (
                    <div key={definition.name} className="rounded-md border border-line-soft bg-surface-2 p-3">
                      <div className="mb-2 flex items-center justify-between gap-3">
                        <label className="flex items-center gap-2 text-[11px] font-medium text-ink-dim">
                          <input
                            type="checkbox"
                            checked={input.enabled}
                            onChange={(event) => updateRange(definition.name, { enabled: event.target.checked })}
                          />
                          {definition.label}
                        </label>
                        {input.enabled && resolved.axis && (
                          <Badge tone="accent">{fmtInt(resolved.axis.values.length)} values</Badge>
                        )}
                      </div>
                      <div className="grid grid-cols-3 gap-2">
                        <Field label="Start">
                          <Input
                            type="number"
                            min={definition.minimum}
                            step={definition.integer ? 1 : 'any'}
                            disabled={!input.enabled}
                            value={input.start}
                            onChange={(event) => updateRange(definition.name, { start: event.target.value })}
                          />
                        </Field>
                        <Field label="End">
                          <Input
                            type="number"
                            min={definition.minimum}
                            step={definition.integer ? 1 : 'any'}
                            disabled={!input.enabled}
                            value={input.end}
                            onChange={(event) => updateRange(definition.name, { end: event.target.value })}
                          />
                        </Field>
                        <Field label="Increment">
                          <Input
                            type="number"
                            min={definition.integer ? 1 : 0.01}
                            step={definition.integer ? 1 : 'any'}
                            disabled={!input.enabled}
                            value={input.increment}
                            onChange={(event) => updateRange(definition.name, { increment: event.target.value })}
                          />
                        </Field>
                      </div>
                      {input.enabled && resolved.axis && (
                        <div className="num mt-2 text-[10px] text-ink-faint">
                          {resolved.axis.values.slice(0, 12).join(', ')}
                          {resolved.axis.values.length > 12
                            ? `, …, ${resolved.axis.values.at(-1)}`
                            : ''}
                        </div>
                      )}
                      {input.enabled && resolved.error && (
                        <div className="mt-2 text-[10px] text-loss">{resolved.error}</div>
                      )}
                    </div>
                  ))}
                </div>
                <div className="mt-2 text-[10px] text-ink-faint">
                  Enabled ranges replace the fixed values in the Strategy card. Enabling both creates every DTE ×
                  wing-width combination and reports them together below.
                </div>
              </div>
            )}

            {(['management', 'entry'] as const).map((kind) => (
              <div key={kind}>
                <div className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-ink-faint">
                  {kind === 'management' ? 'Management axes (no extra data)' : 'Entry axes (each combination refetches)'}
                </div>
                <div className="grid gap-3 md:grid-cols-3">
                  {availableAxes.filter((a) => a.kind === kind).map((axis) => (
                    <Field key={axis.name} label={axis.label}>
                      <Input
                        value={inputs[axis.name] ?? ''}
                        placeholder={axis.placeholder}
                        onChange={(e) => setInputs((prev) => ({ ...prev, [axis.name]: e.target.value }))}
                      />
                    </Field>
                  ))}
                </div>
              </div>
            ))}

            {rangeErrors.length > 0 && (
              <Notice tone="error">{rangeErrors.join(' ')}</Notice>
            )}

            <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
              <StatTile
                label="Entry combinations"
                value={fmtInt(estimate.entryCombinations)}
                hint="each needs its own data"
                tone={estimate.entryCombinations > 12 ? 'warn' : 'neutral'}
              />
              <StatTile label="Management variants" value={fmtInt(estimate.managementVariants)} hint="free" tone="gain" />
              <StatTile
                label="Data cost"
                value={estimate.requiresRefetch ? `${estimate.entryCombinations}×` : 'one pass'}
                tone={estimate.requiresRefetch ? 'warn' : 'gain'}
              />
              <StatTile label="Axes" value={fmtInt(axes.length)} />
            </div>

            {estimate.requiresRefetch ? (
              <Notice tone="warn">
                Entry axes change which contracts are traded, so each of the {fmtInt(estimate.entryCombinations)}{' '}
                combinations reconstructs from scratch. Uncached data is fetched from the configured providers, so
                this can run for hours. Cached ranges are reused across combinations.
              </Notice>
            ) : (
              <Notice tone="success">
                Management-only sweep: every variant runs against the same reconstructions, so this costs one
                pass over the data no matter how many values you list.
              </Notice>
            )}
          </div>
        </Card>

        {results.length > 0 && (
          <Card title="Results" subtitle={`${results.length} combinations, ranked within each row by ${objective}`}>
            <div className="overflow-x-auto rounded-md border border-line">
              <table className="w-full border-collapse text-[11px]">
                <thead className="bg-surface-2">
                  <tr className="text-left text-ink-faint">
                    {axisNames.map((name) => (
                      <th key={name} className="px-3 py-1.5 font-medium">{name}</th>
                    ))}
                    <th className="px-3 py-1.5 text-right font-medium">Entries</th>
                    <th className="px-3 py-1.5 font-medium">Best method</th>
                    <th className="px-3 py-1.5 text-right font-medium">Total</th>
                    <th className="px-3 py-1.5 text-right font-medium">Max DD</th>
                    <th className="px-3 py-1.5 text-right font-medium">Win %</th>
                  </tr>
                </thead>
                <tbody className="num">
                  {results.map((r) => (
                    <tr key={r.index} className="border-t border-line-soft hover:bg-surface-2">
                      {axisNames.map((name) => (
                        <td key={name} className="px-3 py-1 text-ink">{r.values[name] ?? '—'}</td>
                      ))}
                      <td className="px-3 py-1 text-right text-ink-faint">{fmtInt(r.entryCount)}</td>
                      <td className="px-3 py-1 text-ink-dim">{r.best?.strategyLabel ?? '—'}</td>
                      <td className={`px-3 py-1 text-right ${(r.best?.metrics.totalPnl ?? 0) >= 0 ? 'text-gain' : 'text-loss'}`}>
                        {fmtCurrency(r.best?.metrics.totalPnl)}
                      </td>
                      <td className="px-3 py-1 text-right text-loss">{fmtCurrency(r.best?.metrics.maxDrawdown)}</td>
                      <td className="px-3 py-1 text-right text-ink-faint">
                        {r.best ? `${r.best.metrics.winRate.toFixed(1)}%` : '—'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <Notice tone="warn">
              <strong>This is an optimizer, and optimizers overfit.</strong> The best row is the combination that
              best suited this particular sample; across many combinations some will look good by chance alone.
              Treat anything found here as a hypothesis and check it on a period that was not swept, using the
              validation split on the Run Study screen.
            </Notice>
          </Card>
        )}

        {results.length === 0 && !runState.loading && (
          <EmptyState title="No sweep run yet">
            Enter values on one or more axes. Management-only sweeps are cheap; entry axes multiply the data cost.
          </EmptyState>
        )}
      </div>
    </>
  )
}
