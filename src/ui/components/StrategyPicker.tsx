import type { ReactNode } from 'react'
import {
  isParamVisible,
  STRATEGY_CATALOG,
  type StrategyDefinition,
  type StrategyParam,
  type StrategyParamValue
} from '../../shared/strategyCatalog.js'
import { Badge, Card, Field, Input, Notice, Select } from './primitives.js'

/**
 * Strategy selection and its generated parameter form.
 *
 * The form is driven entirely by the catalogue's parameter specs, so adding a
 * strategy is an entry in `shared/strategyCatalog` and nothing else. Shared by
 * Run Study and Parameter Sweep, which is what keeps the two screens from
 * drifting into testing subtly different rules.
 */

export interface StrategyPickerProps {
  strategy: StrategyDefinition
  params: Record<string, StrategyParamValue>
  onSelect(strategyId: string): void
  onParamChange(key: string, value: StrategyParamValue): void
  /** Extra content rendered under the parameter grid, e.g. a session count. */
  footer?: ReactNode
}

function ParamControl({
  param,
  value,
  onChange
}: {
  param: StrategyParam
  value: StrategyParamValue | undefined
  onChange(value: StrategyParamValue): void
}) {
  switch (param.kind) {
    case 'number':
      return (
        <Input
          type="number"
          value={String(value ?? param.default)}
          {...(param.min !== undefined ? { min: param.min } : {})}
          {...(param.max !== undefined ? { max: param.max } : {})}
          {...(param.step !== undefined ? { step: param.step } : {})}
          onChange={(event) => onChange(Number(event.target.value))}
        />
      )
    case 'time':
      return (
        <Input
          value={String(value ?? param.default)}
          placeholder="HH:mm"
          onChange={(event) => onChange(event.target.value)}
        />
      )
    case 'text':
      return (
        <Input
          value={String(value ?? param.default)}
          spellCheck={false}
          {...(param.placeholder ? { placeholder: param.placeholder } : {})}
          onChange={(event) => onChange(event.target.value)}
        />
      )
    case 'choice':
      return (
        <Select value={String(value ?? param.default)} onChange={(event) => onChange(event.target.value)}>
          {param.options.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </Select>
      )
    case 'toggle':
      return (
        <div className="flex h-[30px] items-center gap-2 rounded-md border border-line bg-surface-2 px-2.5 text-[11px] text-ink-dim">
          <input
            type="checkbox"
            checked={value === true}
            onChange={(event) => onChange(event.target.checked)}
          />
          {value === true ? 'Enabled' : 'Disabled'}
        </div>
      )
  }
}

export function StrategyPicker({
  strategy,
  params,
  onSelect,
  onParamChange,
  footer
}: StrategyPickerProps) {
  const visible = strategy.params.filter((param) => isParamVisible(param, params))

  return (
    <Card
      title="Strategy"
      subtitle="Pick a rule set; the parameters below belong to it"
      actions={
        <Badge tone={strategy.horizon === 'intraday' ? 'accent' : 'neutral'}>
          {strategy.horizon === 'intraday' ? 'Intraday · 0DTE' : 'Multi-day'}
        </Badge>
      }
    >
      <div className="grid gap-3 md:grid-cols-2">
        <Field label="Strategy" hint={strategy.summary}>
          <Select value={strategy.id} onChange={(event) => onSelect(event.target.value)}>
            {STRATEGY_CATALOG.map((option) => (
              <option key={option.id} value={option.id}>
                {option.label}
              </option>
            ))}
          </Select>
        </Field>
      </div>

      <div className="mt-3">
        <Notice tone="info">
          <div className="space-y-1">
            {strategy.rules.map((rule) => (
              <div key={rule}>· {rule}</div>
            ))}
            {strategy.requiresIntradayIndex && (
              <div className="pt-1 font-medium">
                Needs cached SPX minute bars for every session in the range; sessions without them are skipped.
              </div>
            )}
          </div>
        </Notice>
      </div>

      <div className="mt-3 grid gap-3 md:grid-cols-3">
        {visible.map((param) => (
          <Field key={param.key} label={param.label} {...(param.hint ? { hint: param.hint } : {})}>
            <ParamControl
              param={param}
              value={params[param.key]}
              onChange={(value) => onParamChange(param.key, value)}
            />
          </Field>
        ))}
      </div>

      {footer && <div className="mt-3">{footer}</div>}
    </Card>
  )
}
