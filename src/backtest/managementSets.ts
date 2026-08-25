import {
  centerTouch,
  elapsedExit,
  holdToExpiration,
  profitTarget,
  stopLoss,
  targetWithStop,
  tentEntry,
  timeExit,
  timeOfDayExit,
  trailingProfit,
  type ExitStrategy
} from './exits.js'
import { MANAGEMENT_CATALOG } from '../shared/managementCatalog.js'

/**
 * Named management methods, resolved from stable string ids.
 *
 * Ids are what get persisted with a study, so a stored run can be reproduced
 * later without embedding executable configuration in the database. The list of
 * ids and their labels lives in `shared/managementCatalog`, which the UI reads;
 * this table is the executable half, and a test holds the two in agreement.
 */
const BUILDERS: Record<string, () => ExitStrategy> = {
  hold: () => holdToExpiration(),

  tp15: () => profitTarget(15),
  tp25: () => profitTarget(25),
  tp35: () => profitTarget(35),
  tp50: () => profitTarget(50),
  tp75: () => profitTarget(75),
  tp100: () => profitTarget(100),
  tp150: () => profitTarget(150),
  tp200: () => profitTarget(200),
  tp300: () => profitTarget(300),
  tp500: () => profitTarget(500),

  sl25: () => stopLoss(25),
  sl50: () => stopLoss(50),
  sl75: () => stopLoss(75),
  sl100: () => stopLoss(100),

  'tp50-sl50': () => targetWithStop(50, 50),
  'tp75-sl50': () => targetWithStop(75, 50),
  'tp100-sl50': () => targetWithStop(100, 50),
  'tp100-sl75': () => targetWithStop(100, 75),
  'tp150-sl50': () => targetWithStop(150, 50),
  'tp200-sl50': () => targetWithStop(200, 50),
  'tp200-sl100': () => targetWithStop(200, 100),

  centerTouch: () => centerTouch(),
  'tent1.0': () => tentEntry(1.0),
  'tent0.75': () => tentEntry(0.75),
  'tent0.5': () => tentEntry(0.5),
  'tent0.25': () => tentEntry(0.25),

  dte3: () => timeExit({ atDte: 3 }),
  dte2: () => timeExit({ atDte: 2 }),
  dte1: () => timeExit({ atDte: 1 }),

  at1100: () => timeOfDayExit('11:00'),
  at1200: () => timeOfDayExit('12:00'),
  at1300: () => timeOfDayExit('13:00'),
  at1400: () => timeOfDayExit('14:00'),
  at1500: () => timeOfDayExit('15:00'),
  at1530: () => timeOfDayExit('15:30'),
  at1545: () => timeOfDayExit('15:45'),
  at1550: () => timeOfDayExit('15:50'),

  elapsed30m: () => elapsedExit(30),
  elapsed60m: () => elapsedExit(60),
  elapsed90m: () => elapsedExit(90),
  elapsed120m: () => elapsedExit(120),
  elapsed180m: () => elapsedExit(180),

  'trail50-30pct': () => trailingProfit({ triggerPct: 50, givebackFractionOfPeak: 0.3 }),
  'trail100-30pct': () => trailingProfit({ triggerPct: 100, givebackFractionOfPeak: 0.3 }),
  'trail100-50pct': () => trailingProfit({ triggerPct: 100, givebackFractionOfPeak: 0.5 }),
  'trail100-30pts': () => trailingProfit({ triggerPct: 100, givebackPoints: 30 }),
  'trail200-30pct': () => trailingProfit({ triggerPct: 200, givebackFractionOfPeak: 0.3 })
}

/** Every id the app can resolve, for populating a selection UI. */
export const MANAGEMENT_IDS = Object.keys(BUILDERS)

export { DEFAULT_MANAGEMENT_SET } from '../shared/managementCatalog.js'

/**
 * Ids in the catalogue with no builder, and builders with no catalogue entry.
 *
 * Exposed rather than merely asserted in a test so a future contributor adding
 * one half of a method gets a precise complaint instead of a mystery.
 */
export function managementCatalogDrift(): { missingBuilder: string[]; missingCatalogEntry: string[] } {
  const catalogIds = new Set(MANAGEMENT_CATALOG.map((method) => method.id))
  return {
    missingBuilder: [...catalogIds].filter((id) => !BUILDERS[id]),
    missingCatalogEntry: MANAGEMENT_IDS.filter((id) => !catalogIds.has(id))
  }
}

/**
 * Sweep-generated targets and stops are not limited to the curated catalogue.
 *
 * The catalogue remains the finite set shown as checkboxes on an ordinary
 * study, while a parameter sweep may legitimately ask for tp40, tp400, sl35,
 * or a decimal threshold. Keeping this parser here preserves strict rejection
 * for every other unknown id.
 */
function dynamicManagement(id: string): ExitStrategy | null {
  const match = /^(tp|sl)(\d+(?:\.\d+)?)$/.exec(id)
  if (!match) return null
  const value = Number(match[2])
  if (!Number.isFinite(value) || value <= 0) return null
  return match[1] === 'tp' ? profitTarget(value) : stopLoss(value)
}

/**
 * Resolves ids into strategies, rejecting unknown ones rather than skipping.
 *
 * The catalogue id is forced onto the resolved strategy. Each rule derives an id
 * of its own from its parameters, and those derivations had drifted from the
 * ids studies are configured with - `timeExit({ atDte: 3 })` calls itself
 * `time3` while the catalogue calls it `dte3`, and a trailing rule calls itself
 * `trail100-30%ofPeak` against a configured `trail100-30pct`. Since a run's
 * summaries are built by matching `config.managements` against each trade's
 * `strategyId`, any such disagreement silently produced a method with no
 * trades. Stamping the configured id here makes the two identical by
 * construction rather than by vigilance.
 */
export function buildManagementSet(ids: readonly string[]): ExitStrategy[] {
  return ids.map((id) => {
    const builder = BUILDERS[id]
    const strategy = builder ? builder() : dynamicManagement(id)
    if (!strategy) throw new Error(`Unknown management method "${id}"`)
    return strategy.id === id ? strategy : { ...strategy, id }
  })
}
