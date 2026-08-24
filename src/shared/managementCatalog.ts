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

/**
 * Management methods for a double calendar.
 *
 * A separate list, not a filter of the butterfly one, because the percentages
 * mean different things and the useful ranges barely overlap. A butterfly
 * bought for two points routinely returns several hundred percent of its debit,
 * so its catalogue runs to +300%; a calendar bought for thirty-five points is
 * managed between +10% and +50%, and offering it a +300% target would be
 * offering a rule that can never fire.
 *
 * Every percentage here is of the **entry debit** - the capital at risk - since
 * a calendar has no defined maximum profit for a "percent of max" to refer to.
 */
export const CALENDAR_MANAGEMENT_CATALOG: readonly ManagementMethod[] = [
  { id: 'hold', label: 'Hold to front expiration', group: 'Baseline' },

  { id: 'tp10', label: '+10% of debit', group: 'Profit target' },
  { id: 'tp15', label: '+15% of debit', group: 'Profit target' },
  { id: 'tp20', label: '+20% of debit', group: 'Profit target' },
  { id: 'tp25', label: '+25% of debit', group: 'Profit target' },
  { id: 'tp30', label: '+30% of debit', group: 'Profit target' },
  { id: 'tp40', label: '+40% of debit', group: 'Profit target' },
  { id: 'tp50', label: '+50% of debit', group: 'Profit target' },

  { id: 'sl25', label: '-25% of debit', group: 'Stop' },
  { id: 'sl50', label: '-50% of debit', group: 'Stop' },
  { id: 'sl100', label: '-100% of debit', group: 'Stop' },

  { id: 'tp15-sl50', label: '+15% / -50%', group: 'Target with stop' },
  { id: 'tp20-sl40', label: '+20% / -40%', group: 'Target with stop' },
  { id: 'tp25-sl25', label: '+25% / -25%', group: 'Target with stop' },
  { id: 'tp25-sl50', label: '+25% / -50%', group: 'Target with stop' },
  { id: 'tp30-sl60', label: '+30% / -60%', group: 'Target with stop' },
  { id: 'tp50-sl50', label: '+50% / -50%', group: 'Target with stop' },

  // The calendar analogue of the butterfly centre touch, inverted: a butterfly
  // wants the index to arrive, a calendar wants it to stay away.
  { id: 'breach-25', label: 'Close 25 points inside a short strike', group: 'Underlying location' },
  { id: 'breach', label: 'Close on a short strike touch', group: 'Underlying location' },
  { id: 'breach+25', label: 'Close 25 points beyond a short strike', group: 'Underlying location' },
  { id: 'tp25+breach', label: '+25% or a short strike touch', group: 'Underlying location' },
  { id: 'tp50+breach', label: '+50% or a short strike touch', group: 'Underlying location' },

  { id: 'trail15-50pct', label: 'Trail after +15%, give back half the peak', group: 'Trailing' },
  { id: 'trail25-30pct', label: 'Trail after +25%, give back 30% of peak', group: 'Trailing' },
  { id: 'trail25-50pct', label: 'Trail after +25%, give back half the peak', group: 'Trailing' },
  { id: 'trail40-50pct', label: 'Trail after +40%, give back half the peak', group: 'Trailing' },

  { id: 'dte7', label: 'Close at 7 DTE', group: 'Days to expiration' },
  { id: 'dte5', label: 'Close at 5 DTE', group: 'Days to expiration' },
  { id: 'dte3', label: 'Close at 3 DTE', group: 'Days to expiration' },
  { id: 'dte1', label: 'Close at 1 DTE', group: 'Days to expiration' },

  { id: 'day3', label: 'Close after 3 sessions', group: 'Sessions held' },
  { id: 'day5', label: 'Close after 5 sessions', group: 'Sessions held' },
  { id: 'day7', label: 'Close after 7 sessions', group: 'Sessions held' }
]

/** The catalogue for a structure. Butterfly unless told otherwise. */
export function managementCatalogFor(structure?: string): readonly ManagementMethod[] {
  return structure === 'doubleCalendar' ? CALENDAR_MANAGEMENT_CATALOG : MANAGEMENT_CATALOG
}

/** Methods a structure offers for a horizon, in catalogue order. */
export function managementsFor(structure: string | undefined, horizon: TradeHorizon): ManagementMethod[] {
  return managementCatalogFor(structure).filter(
    (method) => !method.horizons || method.horizons.includes(horizon)
  )
}

/** Distinct group names a structure offers, in catalogue order. */
export function managementGroupsFor(structure: string | undefined, horizon: TradeHorizon): string[] {
  return [...new Set(managementsFor(structure, horizon).map((method) => method.group))]
}

/** Human label for a management id within a structure. */
export function managementLabelFor(structure: string | undefined, id: string): string {
  return managementCatalogFor(structure).find((method) => method.id === id)?.label ?? id
}

/**
 * The comparison set the first double calendar study was run with.
 *
 * Spans the range the structure is actually managed in, and deliberately keeps
 * the rules that lost money - the stops and the strike-touch exits - because a
 * comparison that quietly drops the losers is not a comparison.
 */
export const DEFAULT_CALENDAR_MANAGEMENT_SET: readonly string[] =
  CALENDAR_MANAGEMENT_CATALOG.map((method) => method.id)

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
