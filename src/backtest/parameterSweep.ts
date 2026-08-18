import type { StudyConfig } from '../shared/study.js'
import type { SweepAxis, SweepPoint } from '../shared/sweep.js'

/**
 * Generic parameter sweeps.
 *
 * The engine is deliberately not specific to profit targets. Any axis of the
 * study configuration can be swept, and the cartesian product is generated
 * mechanically, because the research question is which parameters matter - and
 * deciding that in advance by hard-coding one axis would beg it.
 *
 * ## Why the axis kind matters
 *
 * Sweeping a *management* parameter is nearly free: management runs against an
 * already-reconstructed price path, so a hundred profit targets cost one data
 * fetch and a hundred cheap simulations. Sweeping an *entry* parameter - entry
 * time, target DTE, wing width, placement - changes which contracts are traded
 * and forces a fresh reconstruction per combination.
 *
 * Separating them lets the caller see, before starting, whether a sweep costs
 * seconds or hours.
 */

/** Applies an axis value to a config, returning a new config. */
type Applier = (config: StudyConfig, value: number) => StudyConfig

const APPLIERS: Record<string, { apply: Applier; kind: 'entry' | 'management' }> = {
  targetDte: {
    kind: 'entry',
    apply: (c, v) => ({ ...c, targetDte: v })
  },
  wingWidth: {
    kind: 'entry',
    apply: (c, v) => ({ ...c, wingWidth: v })
  },
  emaPeriod: {
    kind: 'entry',
    // Rebuilding the whole entry would turn a breakout study into an EMA one
    // partway through a sweep. An axis that does not apply is a no-op, not a
    // silent change of strategy.
    apply: (c, v) => (c.entry.type === 'ema' ? { ...c, entry: { ...c.entry, period: v } } : c)
  },
  openingRangeMinutes: {
    kind: 'entry',
    apply: (c, v) => (c.entry.type === 'orb' ? { ...c, entry: { ...c.entry, openingRangeMinutes: v } } : c)
  },
  confirmationMinutes: {
    kind: 'entry',
    apply: (c, v) => (c.entry.type === 'orb' ? { ...c, entry: { ...c.entry, confirmationMinutes: v } } : c)
  },
  offsetPoints: {
    kind: 'entry',
    apply: (c, v) => ({ ...c, placement: { type: 'fixedDistance', offsetPoints: v } })
  },
  wingsAway: {
    kind: 'entry',
    apply: (c, v) => ({ ...c, placement: { type: 'wingWidths', wingsAway: v } })
  },
  expectedMoveBuffer: {
    kind: 'entry',
    // Preserves the anchor: buffer and anchor are independent choices, and
    // resetting one while sweeping the other would confound the result.
    apply: (c, v) => ({
      ...c,
      placement: {
        type: 'expectedMove',
        buffer: v,
        ...(c.placement.type === 'expectedMove' && c.placement.anchor !== undefined
          ? { anchor: c.placement.anchor }
          : {})
      }
    })
  },
  slippage: {
    kind: 'entry',
    apply: (c, v) => ({ ...c, pricing: { ...c.pricing, slippage: v } })
  },
  maxStaleMinutes: {
    kind: 'entry',
    apply: (c, v) => ({ ...c, pricing: { ...c.pricing, maxStaleMinutes: v } })
  },
  minimumCoverage: {
    kind: 'entry',
    apply: (c, v) => ({ ...c, minimumCoverage: v })
  },

  /*
   * Management axes are expressed as the ids the engine already knows, so a
   * sweep over profit targets is just a study whose management set is every
   * target - one reconstruction, many simulations.
   */
  profitTarget: {
    kind: 'management',
    apply: (c, v) => ({ ...c, managements: [...new Set([...c.managements, `tp${v}`])] })
  },
  stopLoss: {
    kind: 'management',
    apply: (c, v) => ({ ...c, managements: [...new Set([...c.managements, `sl${v}`])] })
  }
}

export const SWEEPABLE_AXES = Object.keys(APPLIERS)

export function axisKind(name: string): 'entry' | 'management' | null {
  return APPLIERS[name]?.kind ?? null
}

/** Cartesian product of the supplied axes. */
export function expandSweep(base: StudyConfig, axes: readonly SweepAxis[]): SweepPoint[] {
  const entryAxes = axes.filter((a) => axisKind(a.name) === 'entry')
  const managementAxes = axes.filter((a) => axisKind(a.name) === 'management')

  for (const axis of axes) {
    if (!APPLIERS[axis.name]) throw new Error(`Unknown sweep axis "${axis.name}"`)
    if (axis.values.length === 0) throw new Error(`Sweep axis "${axis.name}" has no values`)
  }

  /*
   * Management axes collapse into the management set of every point rather than
   * multiplying the point count. Running 8 targets against one reconstruction is
   * one study, not eight, and treating them as separate points would multiply
   * the data cost by eight for no benefit.
   */
  const managementIds = managementAxes.flatMap((axis) =>
    axis.values.map((v) => (axis.name === 'profitTarget' ? `tp${v}` : `sl${v}`))
  )

  let combinations: { values: Record<string, number>; config: StudyConfig }[] = [
    { values: {}, config: base }
  ]

  for (const axis of entryAxes) {
    const next: typeof combinations = []
    for (const current of combinations) {
      for (const value of axis.values) {
        next.push({
          values: { ...current.values, [axis.name]: value },
          config: APPLIERS[axis.name]!.apply(current.config, value)
        })
      }
    }
    combinations = next
  }

  return combinations.map((combination, index) => ({
    index,
    values: combination.values,
    config:
      managementIds.length > 0
        ? { ...combination.config, managements: [...new Set([...base.managements, ...managementIds])] }
        : combination.config
  }))
}

/**
 * Cost estimate for a sweep, in units of full study runs.
 *
 * Only entry-axis combinations require fresh data; management axes ride along on
 * the same reconstructions. Surfacing this before a run is the difference
 * between a sweep that finishes over lunch and one that runs overnight.
 */
export function estimateSweepCost(axes: readonly SweepAxis[]): {
  entryCombinations: number
  managementVariants: number
  requiresRefetch: boolean
} {
  const entryAxes = axes.filter((a) => axisKind(a.name) === 'entry')
  const managementAxes = axes.filter((a) => axisKind(a.name) === 'management')

  const entryCombinations = entryAxes.reduce((total, axis) => total * axis.values.length, 1)
  const managementVariants = managementAxes.reduce((total, axis) => total + axis.values.length, 0)

  return {
    entryCombinations,
    managementVariants,
    requiresRefetch: entryAxes.length > 0
  }
}

/** Parses "25, 50, 75-125:25" into [25, 50, 75, 100, 125]. */
export function parseValueList(input: string): number[] {
  const out: number[] = []
  for (const part of input.split(',').map((s) => s.trim()).filter(Boolean)) {
    const range = /^(-?\d+(?:\.\d+)?)\s*-\s*(-?\d+(?:\.\d+)?)(?::(\d+(?:\.\d+)?))?$/.exec(part)
    if (range) {
      const from = Number(range[1])
      const to = Number(range[2])
      const step = Number(range[3] ?? 1)
      if (step <= 0) throw new Error(`Step must be positive in "${part}"`)
      for (let v = from; v <= to + 1e-9; v += step) out.push(Number(v.toFixed(6)))
      continue
    }
    const single = Number(part)
    if (!Number.isFinite(single)) throw new Error(`"${part}" is not a number`)
    out.push(single)
  }
  return [...new Set(out)]
}
