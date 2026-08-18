/**
 * The catalogue of management (exit) methods the engine can resolve.
 *
 * Data only, and deliberately in `shared`: the ids are persisted with every
 * study, the engine resolves them into executable rules, and the UI lists them
 * for selection. Those three views were previously three hand-maintained copies
 * of one list, which is exactly the arrangement that lets a method exist in one
 * place and silently not in another. A test asserts that the engine builder
 * table and this catalogue agree.
 */

/**
 * Which trade horizons a method is meaningful for.
 *
 * A day-count exit cannot fire on a 0DTE trade, and a wall-clock exit fires on
 * the first afternoon of a seven-day one. Tagging them keeps a study from
 * offering rules that are guaranteed to behave as hold-to-expiration.
 */
export type TradeHorizon = 'intraday' | 'multiDay'

export interface ManagementMethod {
  id: string
  label: string
  group: string
  /** Horizons the method is offered for. Omitted means both. */
  horizons?: TradeHorizon[]
}

export const MANAGEMENT_CATALOG: readonly ManagementMethod[] = [
  { id: 'hold', label: 'Hold to expiration', group: 'Baseline' },

  { id: 'tp15', label: '+15% target', group: 'Profit target' },
  { id: 'tp25', label: '+25% target', group: 'Profit target' },
  { id: 'tp35', label: '+35% target', group: 'Profit target' },
  { id: 'tp50', label: '+50% target', group: 'Profit target' },
  { id: 'tp75', label: '+75% target', group: 'Profit target' },
  { id: 'tp100', label: '+100% target', group: 'Profit target' },
  { id: 'tp150', label: '+150% target', group: 'Profit target' },
  { id: 'tp200', label: '+200% target', group: 'Profit target' },
  { id: 'tp300', label: '+300% target', group: 'Profit target' },

  { id: 'sl25', label: '-25% stop', group: 'Stop' },
  { id: 'sl50', label: '-50% stop', group: 'Stop' },
  { id: 'sl75', label: '-75% stop', group: 'Stop' },
  { id: 'sl100', label: '-100% stop', group: 'Stop' },

  { id: 'tp50-sl50', label: '+50% / -50%', group: 'Target with stop' },
  { id: 'tp75-sl50', label: '+75% / -50%', group: 'Target with stop' },
  { id: 'tp100-sl50', label: '+100% / -50%', group: 'Target with stop' },
  { id: 'tp100-sl75', label: '+100% / -75%', group: 'Target with stop' },
  { id: 'tp150-sl50', label: '+150% / -50%', group: 'Target with stop' },
  { id: 'tp200-sl50', label: '+200% / -50%', group: 'Target with stop' },
  { id: 'tp200-sl100', label: '+200% / -100%', group: 'Target with stop' },

  { id: 'centerTouch', label: 'Center strike touch', group: 'Underlying location' },
  { id: 'tent1.0', label: 'Tent <= 1.00', group: 'Underlying location' },
  { id: 'tent0.75', label: 'Tent <= 0.75', group: 'Underlying location' },
  { id: 'tent0.5', label: 'Tent <= 0.50', group: 'Underlying location' },
  { id: 'tent0.25', label: 'Tent <= 0.25', group: 'Underlying location' },

  { id: 'trail50-30pct', label: 'Trail after +50%, give back 30% of peak', group: 'Trailing' },
  { id: 'trail100-30pct', label: 'Trail after +100%, give back 30% of peak', group: 'Trailing' },
  { id: 'trail100-50pct', label: 'Trail after +100%, give back 50% of peak', group: 'Trailing' },
  { id: 'trail100-30pts', label: 'Trail after +100%, give back 30 points', group: 'Trailing' },
  { id: 'trail200-30pct', label: 'Trail after +200%, give back 30% of peak', group: 'Trailing' },

  { id: 'at1100', label: 'Exit at 11:00 ET', group: 'Time of day', horizons: ['intraday'] },
  { id: 'at1200', label: 'Exit at 12:00 ET', group: 'Time of day', horizons: ['intraday'] },
  { id: 'at1300', label: 'Exit at 13:00 ET', group: 'Time of day', horizons: ['intraday'] },
  { id: 'at1400', label: 'Exit at 14:00 ET', group: 'Time of day', horizons: ['intraday'] },
  { id: 'at1500', label: 'Exit at 15:00 ET', group: 'Time of day', horizons: ['intraday'] },
  { id: 'at1530', label: 'Exit at 15:30 ET', group: 'Time of day', horizons: ['intraday'] },
  { id: 'at1545', label: 'Exit at 15:45 ET', group: 'Time of day', horizons: ['intraday'] },
  { id: 'at1550', label: 'Exit at 15:50 ET', group: 'Time of day', horizons: ['intraday'] },

  { id: 'elapsed30m', label: 'Exit 30 minutes in', group: 'Elapsed time', horizons: ['intraday'] },
  { id: 'elapsed60m', label: 'Exit 60 minutes in', group: 'Elapsed time', horizons: ['intraday'] },
  { id: 'elapsed90m', label: 'Exit 90 minutes in', group: 'Elapsed time', horizons: ['intraday'] },
  { id: 'elapsed120m', label: 'Exit 120 minutes in', group: 'Elapsed time', horizons: ['intraday'] },
  { id: 'elapsed180m', label: 'Exit 180 minutes in', group: 'Elapsed time', horizons: ['intraday'] },

  { id: 'dte3', label: 'Exit at 3 DTE', group: 'Days to expiration', horizons: ['multiDay'] },
  { id: 'dte2', label: 'Exit at 2 DTE', group: 'Days to expiration', horizons: ['multiDay'] },
  { id: 'dte1', label: 'Exit at 1 DTE', group: 'Days to expiration', horizons: ['multiDay'] }
]

const BY_ID = new Map(MANAGEMENT_CATALOG.map((method) => [method.id, method]))

/** Human label for a management id, falling back to the id itself. */
export function managementLabel(id: string): string {
  return BY_ID.get(id)?.label ?? id
}

export function managementMethod(id: string): ManagementMethod | undefined {
  return BY_ID.get(id)
}

/** Methods meaningful for a horizon, in catalogue order. */
export function managementsForHorizon(horizon: TradeHorizon): ManagementMethod[] {
  return MANAGEMENT_CATALOG.filter((method) => !method.horizons || method.horizons.includes(horizon))
}

/** Distinct group names for a horizon, in catalogue order. */
export function managementGroups(horizon: TradeHorizon): string[] {
  return [...new Set(managementsForHorizon(horizon).map((method) => method.group))]
}

/**
 * Every method applicable to a horizon.
 *
 * This is the set a "really find out what works" study wants: management is
 * simulated against an already-reconstructed price path, so forty rules cost the
 * same data as one and comparing them all is close to free.
 */
export function allManagementsFor(horizon: TradeHorizon): string[] {
  return managementsForHorizon(horizon).map((method) => method.id)
}

/**
 * The comparison set from the first formal multi-day study.
 *
 * Kept as a named constant so the headline study is reproducible by reference
 * rather than by remembering which boxes to tick.
 */
export const DEFAULT_MANAGEMENT_SET: readonly string[] = [
  'hold',
  'tp25', 'tp50', 'tp75', 'tp100', 'tp150', 'tp200', 'tp300',
  'tp50-sl50', 'tp100-sl50', 'tp150-sl50', 'tp200-sl50',
  'centerTouch',
  'tent1.0', 'tent0.75', 'tent0.5', 'tent0.25',
  'dte3', 'dte2', 'dte1'
]
