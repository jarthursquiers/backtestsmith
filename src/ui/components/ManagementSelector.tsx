import type { ReactNode } from 'react'
import {
  managementGroupsFor,
  managementsFor,
  type TradeHorizon
} from '../../shared/managementCatalog.js'
import type { StudyStructure } from '../../shared/study.js'
import { Button, Card, Notice } from './primitives.js'

/**
 * Selection of the exit rules a study compares.
 *
 * Filtered by the strategy's horizon rather than showing everything, because a
 * method that cannot fire on the trade in question is not a neutral extra - it
 * silently reports itself as hold-to-expiration and pads the comparison with a
 * duplicate.
 */

export interface ManagementSelectorProps {
  horizon: TradeHorizon
  structure?: StudyStructure
  selected: string[]
  onChange(ids: string[]): void
  /** Restores whatever the current strategy considers its default comparison. */
  defaults: string[]
  footer?: ReactNode
}

export function ManagementSelector({
  horizon,
  structure,
  selected,
  onChange,
  defaults,
  footer
}: ManagementSelectorProps) {
  const methods = managementsFor(structure, horizon)
  const groups = managementGroupsFor(structure, horizon)
  const selectedSet = new Set(selected)

  const toggle = (id: string): void =>
    onChange(selectedSet.has(id) ? selected.filter((x) => x !== id) : [...selected, id])

  const toggleGroup = (group: string): void => {
    const ids = methods.filter((m) => m.group === group).map((m) => m.id)
    const allOn = ids.every((id) => selectedSet.has(id))
    onChange(allOn ? selected.filter((id) => !ids.includes(id)) : [...new Set([...selected, ...ids])])
  }

  return (
    <Card
      title="Management methods"
      subtitle="Every selected method sees the identical entry population, which is what makes the comparison valid. Management is simulated against an already-reconstructed path, so selecting them all costs no extra data."
      actions={
        <div className="flex gap-2">
          <Button onClick={() => onChange(methods.map((method) => method.id))}>All</Button>
          <Button onClick={() => onChange([...defaults])}>Strategy default</Button>
          <Button onClick={() => onChange([])}>None</Button>
        </div>
      }
    >
      <div className="space-y-3">
        {groups.map((group) => (
          <div key={group}>
            <button
              onClick={() => toggleGroup(group)}
              className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-ink-faint transition hover:text-ink"
              title="Toggle the whole group"
            >
              {group}
            </button>
            <div className="flex flex-wrap gap-1.5">
              {methods
                .filter((method) => method.group === group)
                .map((method) => (
                  <button
                    key={method.id}
                    onClick={() => toggle(method.id)}
                    className={`rounded-md border px-2 py-1 text-[11px] transition ${
                      selectedSet.has(method.id)
                        ? 'border-accent/50 bg-accent/15 text-accent'
                        : 'border-line bg-surface-2 text-ink-dim hover:border-ink-faint'
                    }`}
                  >
                    {method.label}
                  </button>
                ))}
            </div>
          </div>
        ))}

        {selected.length === 0 && (
          <Notice tone="warn">
            No management method is selected, so the study has nothing to compare and cannot run.
          </Notice>
        )}

        {footer}
      </div>
    </Card>
  )
}
