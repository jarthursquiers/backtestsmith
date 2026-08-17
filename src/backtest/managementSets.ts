import {
  centerTouch,
  holdToExpiration,
  profitTarget,
  stopLoss,
  targetWithStop,
  tentEntry,
  timeExit,
  trailingProfit,
  type ExitStrategy
} from './exits.js'

/**
 * Named management methods, resolved from stable string ids.
 *
 * Ids are what get persisted with a study, so a stored run can be reproduced
 * later without embedding executable configuration in the database.
 */
const BUILDERS: Record<string, () => ExitStrategy> = {
  hold: () => holdToExpiration(),

  tp25: () => profitTarget(25),
  tp50: () => profitTarget(50),
  tp75: () => profitTarget(75),
  tp100: () => profitTarget(100),
  tp150: () => profitTarget(150),
  tp200: () => profitTarget(200),
  tp300: () => profitTarget(300),

  sl25: () => stopLoss(25),
  sl50: () => stopLoss(50),
  sl75: () => stopLoss(75),
  sl100: () => stopLoss(100),

  'tp50-sl50': () => targetWithStop(50, 50),
  'tp100-sl50': () => targetWithStop(100, 50),
  'tp150-sl50': () => targetWithStop(150, 50),
  'tp200-sl50': () => targetWithStop(200, 50),

  centerTouch: () => centerTouch(),
  'tent1.0': () => tentEntry(1.0),
  'tent0.75': () => tentEntry(0.75),
  'tent0.5': () => tentEntry(0.5),
  'tent0.25': () => tentEntry(0.25),

  dte3: () => timeExit({ atDte: 3 }),
  dte2: () => timeExit({ atDte: 2 }),
  dte1: () => timeExit({ atDte: 1 }),

  'trail100-30pct': () => trailingProfit({ triggerPct: 100, givebackFractionOfPeak: 0.3 }),
  'trail100-50pct': () => trailingProfit({ triggerPct: 100, givebackFractionOfPeak: 0.5 }),
  'trail100-30pts': () => trailingProfit({ triggerPct: 100, givebackPoints: 30 })
}

/** Every id the app can resolve, for populating a selection UI. */
export const MANAGEMENT_IDS = Object.keys(BUILDERS)

/**
 * The comparison set from the first formal study in the specification.
 *
 * Kept as a named constant so the headline study is reproducible by reference
 * rather than by remembering which boxes to tick.
 */
export const DEFAULT_MANAGEMENT_SET = [
  'hold',
  'tp25', 'tp50', 'tp75', 'tp100', 'tp150', 'tp200', 'tp300',
  'tp50-sl50', 'tp100-sl50', 'tp150-sl50', 'tp200-sl50',
  'centerTouch',
  'tent1.0', 'tent0.75', 'tent0.5', 'tent0.25',
  'dte3', 'dte2', 'dte1'
]

/** Resolves ids into strategies, rejecting unknown ones rather than skipping. */
export function buildManagementSet(ids: readonly string[]): ExitStrategy[] {
  return ids.map((id) => {
    const builder = BUILDERS[id]
    if (!builder) throw new Error(`Unknown management method "${id}"`)
    return builder()
  })
}
