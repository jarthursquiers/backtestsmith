import type { OptionBar, UnderlyingBar } from '../domain/bars.js'
import type {
  ButterflyDefinition,
  ButterflyObservation,
  ButterflyPriceAudit,
  ButterflySeries,
  DataQuality,
  InvalidButterflyPrice,
  LegRole,
  PricingAssumptions
} from '../domain/butterfly.js'
import { CONTRACT_MULTIPLIER, DEFAULT_PRICING } from '../domain/butterfly.js'
import { dteAt } from '../core/time/dte.js'
import {
  marketDateOf,
  sessionClose,
  sessionOpen,
  tradingDaysBetween,
  type MarketDate
} from '../core/time/marketTime.js'
import {
  alignLegs,
  buildLegSeries,
  butterflyValue,
  butterflyValueBounds,
  type AlignedMinute
} from './legPricing.js'

/**
 * Reconstructs a butterfly's minute-by-minute value from its three legs.
 *
 * Everything downstream - management rules, MFE/MAE, conditional path analysis -
 * consumes this series, so its correctness matters more than anything else in
 * the engine. Two properties are load-bearing:
 *
 *  - No value is ever invented. A minute where the missing-data policy cannot
 *    price all three legs produces no observation, and is counted against the
 *    trade's data quality instead.
 *  - The entry price is taken at the simulated entry timestamp and nothing
 *    later is consulted to establish it, so the debit is knowable at entry.
 */

export interface ReconstructInput {
  definition: ButterflyDefinition
  legBars: Record<LegRole, readonly OptionBar[]>
  /** Optional; the option legs alone determine the butterfly's value. */
  underlyingBars?: readonly UnderlyingBar[]
  /** Simulated entry instant, epoch ms. */
  entryTimestamp: number
  /** Entry may not drift beyond this instant while waiting for all three legs. */
  entryDeadlineTimestamp?: number
  /** Require all three entry legs to be observed in the accepted minute. */
  requireFreshEntry?: boolean
  /**
   * Last instant to track, epoch ms. Defaults to the expiration session close.
   */
  exitTimestamp?: number
  pricing?: PricingAssumptions
}

export class ReconstructionError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ReconstructionError'
  }
}

/** Small allowance for floating-point and option tick rounding, never dollars of latitude. */
export const BUTTERFLY_PRICE_TOLERANCE = 0.01

function priceAudit(point: AlignedMinute, value: number): ButterflyPriceAudit {
  return {
    timestamp: point.minute,
    value,
    lower: point.lower!,
    center: point.center!,
    upper: point.upper!,
    stale: point.stale,
    maxLegAgeMs: point.maxAgeMs
  }
}

function invalidPriceReason(value: number, wingWidth: number): string | null {
  if (!Number.isFinite(value)) return 'synthetic value is not finite'
  if (value < -BUTTERFLY_PRICE_TOLERANCE) {
    return `synthetic value ${value.toFixed(2)} is below zero`
  }
  if (value > wingWidth + BUTTERFLY_PRICE_TOLERANCE) {
    return `synthetic value ${value.toFixed(2)} exceeds the ${wingWidth.toFixed(2)}-point wing width`
  }
  return null
}

function describeAudit(audit: ButterflyPriceAudit): string {
  const leg = (role: 'lower' | 'center' | 'upper'): string => {
    const quote = audit[role]
    return `${role} ${quote.ticker}=${quote.price.toFixed(2)}@${new Date(quote.observedAt).toISOString()}` +
      (quote.ageMs > 0 ? ` age ${Math.round(quote.ageMs / 60_000)}m` : '')
  }
  return `${leg('lower')}, ${leg('center')}, ${leg('upper')}; value=${audit.value.toFixed(2)}`
}

/** One grid minute, with the market date it belongs to already resolved. */
export interface GridMinute {
  timestamp: number
  marketDate: MarketDate
}

/**
 * Builds the regular-session minute grid between two instants, inclusive.
 *
 * Each minute carries its market date. The generator already knows it, and
 * recovering it later would mean a timezone conversion per bar - which, at a few
 * thousand bars per trade and hundreds of trades per study, is the difference
 * between a study taking seconds and taking minutes.
 */
export function sessionMinuteGridDetailed(fromTs: number, toTs: number): GridMinute[] {
  if (toTs < fromTs) return []
  const minutes: GridMinute[] = []
  const dates = tradingDaysBetween(marketDateOf(fromTs), marketDateOf(toTs))

  for (const date of dates) {
    const open = sessionOpen(date)
    const close = sessionClose(date)
    const start = Math.max(open, Math.ceil(fromTs / 60_000) * 60_000)
    // The close is exclusive, matching isDuringRegularSession and
    // sessionMinuteCount. Including it would make a full session 391 minutes
    // and quietly inflate every coverage denominator.
    const end = Math.min(close - 60_000, toTs)
    for (let t = start; t <= end; t += 60_000) minutes.push({ timestamp: t, marketDate: date })
  }
  return minutes
}

/** Timestamps only, for callers that do not need the dates. */
export function sessionMinuteGrid(fromTs: number, toTs: number): number[] {
  return sessionMinuteGridDetailed(fromTs, toTs).map((m) => m.timestamp)
}

export function reconstructButterfly(input: ReconstructInput): ButterflySeries {
  const pricing = input.pricing ?? DEFAULT_PRICING
  const { definition, entryTimestamp } = input
  const warnings: string[] = []

  const exitTimestamp = input.exitTimestamp ?? sessionClose(definition.expiration)
  if (exitTimestamp < entryTimestamp) {
    throw new ReconstructionError('Exit timestamp is before the entry timestamp')
  }

  const legs = {
    lower: buildLegSeries('lower', definition.lowerTicker, input.legBars.lower),
    center: buildLegSeries('center', definition.centerTicker, input.legBars.center),
    upper: buildLegSeries('upper', definition.upperTicker, input.legBars.upper)
  }

  for (const [role, series] of Object.entries(legs)) {
    if (series.minutes.length === 0) {
      warnings.push(`The ${role} leg (${series.ticker}) has no bars at all in the requested range.`)
    }
  }

  const grid = sessionMinuteGridDetailed(entryTimestamp, exitTimestamp)
  if (grid.length === 0) {
    throw new ReconstructionError(
      `No regular-session minutes between ${new Date(entryTimestamp).toISOString()} and ${new Date(exitTimestamp).toISOString()}`
    )
  }

  const aligned = alignLegs(grid.map((m) => m.timestamp), legs, pricing.model, pricing.missingData)

  /*
   * Calendar and trading DTE are constant within a session, so they are computed
   * once per market date rather than once per minute. That single change is
   * worth roughly an order of magnitude on a full study.
   */
  const dteByDate = new Map<MarketDate, { calendarDte: number; tradingDte: number }>()
  for (const { marketDate } of grid) {
    if (dteByDate.has(marketDate)) continue
    const breakdown = dteAt(sessionOpen(marketDate), definition.expiration)
    dteByDate.set(marketDate, {
      calendarDte: breakdown.calendarDte,
      tradingDte: breakdown.tradingDte
    })
  }

  // An entry is accepted only inside the declared fill window and at a price
  // consistent with a defined-risk fly. Strict entry requires three quotes in
  // that minute; carry-forward may use earlier quotes within its configured
  // age limit. The accepted minute is always the package entry timestamp, so a
  // later quote is never pulled backward into an earlier fill.
  const entryDeadline = input.entryDeadlineTimestamp ?? exitTimestamp
  const requireFreshEntry = input.requireFreshEntry ?? false
  const invalidPriceSamples: InvalidButterflyPrice[] = []
  let entryIndex = -1
  for (let i = 0; i < aligned.length; i++) {
    const point = aligned[i]!
    if (point.minute > entryDeadline) break
    if (!point.priced || (requireFreshEntry && point.stale)) continue
    const value = butterflyValue(point.lower!.price, point.center!.price, point.upper!.price)
    const audit = priceAudit(point, value)
    const violation = invalidPriceReason(value, definition.wingWidth)
    const debit = value + pricing.slippage
    const debitViolation = debit <= 0
      ? `entry debit ${debit.toFixed(2)} is not positive after slippage`
      : debit > definition.wingWidth + BUTTERFLY_PRICE_TOLERANCE
        ? `entry debit ${debit.toFixed(2)} exceeds the ${definition.wingWidth.toFixed(2)}-point wing width after slippage`
        : null
    if (violation || debitViolation) {
      if (invalidPriceSamples.length < 5) {
        invalidPriceSamples.push({ ...audit, reason: violation ?? debitViolation! })
      }
      continue
    }
    entryIndex = i
    break
  }
  if (entryIndex === -1) {
    const invalid = invalidPriceSamples[0]
    throw new ReconstructionError(
      invalid
        ? `invalid butterfly entry: ${invalid.reason}; ${describeAudit(invalid)}`
        : `The butterfly could not be priced at any minute by ${new Date(entryDeadline).toISOString()}: ` +
          (requireFreshEntry
            ? 'all three legs require fresh same-minute prices inside the entry window.'
            : 'at least one leg had no acceptable price inside the entry window.')
    )
  }

  const entryAligned = aligned[entryIndex]!
  const rawEntryValue = butterflyValue(
    entryAligned.lower!.price,
    entryAligned.center!.price,
    entryAligned.upper!.price
  )

  // Slippage works against the trader: pay more on entry, receive less on exit.
  const entryDebit = rawEntryValue + pricing.slippage

  if (entryAligned.minute > entryTimestamp) {
    const lateMinutes = Math.round((entryAligned.minute - entryTimestamp) / 60_000)
    warnings.push(`No priceable minute at entry; the first fill was ${lateMinutes} minute(s) later.`)
  }
  if (entryAligned.stale) {
    warnings.push('The entry price used at least one carried-forward leg rather than a same-minute trade.')
  }

  const underlyingIndex = indexUnderlying(input.underlyingBars ?? [])
  const underlyingMinutes = [...underlyingIndex.keys()].sort((a, b) => a - b)
  const entryUnderlying = underlyingIndex.get(entryAligned.minute)?.close

  const observations: ButterflyObservation[] = []
  const invalidMinutes = new Set<number>()
  for (let i = entryIndex; i < aligned.length; i++) {
    const point = aligned[i]!
    if (!point.priced) continue

    const value = butterflyValue(point.lower!.price, point.center!.price, point.upper!.price)
    const audit = priceAudit(point, value)
    const violation = invalidPriceReason(value, definition.wingWidth)
    if (violation) {
      invalidMinutes.add(point.minute)
      if (invalidPriceSamples.length < 5) invalidPriceSamples.push({ ...audit, reason: violation })
      continue
    }
    // Exit slippage is applied when a trade is closed, not to every mark; the
    // mark is the honest mid-path value under the chosen model.
    const pnlDollars = (value - entryDebit) * CONTRACT_MULTIPLIER * definition.quantity
    const pnlPct = entryDebit > 0 ? ((value - entryDebit) / entryDebit) * 100 : 0

    const dte = dteByDate.get(grid[i]!.marketDate)!
    const underlyingPrice = underlyingIndex.get(point.minute)?.close

    const observation: ButterflyObservation = {
      timestamp: point.minute,
      butterflyValue: value,
      pnlDollars,
      pnlPct,
      dte: dte.calendarDte,
      tradingDte: dte.tradingDte,
      minutesSinceEntry: Math.round((point.minute - entryAligned.minute) / 60_000),
      stale: point.stale,
      maxLegAgeMs: point.maxAgeMs,
      priceAudit: audit
    }

    // Bounds enable the exit engine to detect that a threshold *could* have been
    // touched inside a minute even when the mark did not cross it.
    if (point.bars.lower && point.bars.center && point.bars.upper) {
      const bounds = butterflyValueBounds(point.bars.lower, point.bars.center, point.bars.upper)
      // Independent leg OHLC extremes are very wide, but static arbitrage
      // bounds still apply to the package at every instant.
      observation.valueUpperBound = Math.min(definition.wingWidth, bounds.high)
      observation.valueLowerBound = Math.max(0, bounds.low)
    }

    if (underlyingPrice !== undefined) {
      observation.underlyingPrice = underlyingPrice
      const distance = Math.abs(underlyingPrice - definition.centerStrike)
      observation.distanceToCenter = distance
      // Normalizing by wing width makes the measure comparable across widths:
      // 1.00 is one full wing from center, 0.00 is exactly at it.
      observation.normalizedDistanceToCenter = definition.wingWidth > 0 ? distance / definition.wingWidth : undefined
    } else if (underlyingMinutes.length > 0) {
      // Underlying data exists but not for this minute; leave it undefined
      // rather than carrying a level forward into a distance measurement.
    }

    observations.push(observation)
  }

  const quality = summarizeQuality(aligned.slice(entryIndex), invalidMinutes)

  if (invalidMinutes.size > 0) {
    warnings.push(
      `${invalidMinutes.size} fully populated minute(s) were rejected because the synthetic butterfly value ` +
        `fell outside 0..${definition.wingWidth}. They count as unpriced minutes.`
    )
  }

  if (quality.coverage < 0.5) {
    warnings.push(
      `Only ${(quality.coverage * 100).toFixed(0)}% of session minutes could be priced. ` +
        'Interpret this trade with caution.'
    )
  }
  if ((input.underlyingBars?.length ?? 0) === 0) {
    warnings.push(
      'No underlying data was supplied, so distance-to-center and normalized distance are unavailable.'
    )
  }

  return {
    definition,
    entryDebit,
    entryTimestamp: entryAligned.minute,
    entryAudit: priceAudit(entryAligned, rawEntryValue),
    ...(entryUnderlying !== undefined ? { entryUnderlying } : {}),
    observations,
    quality,
    pricing,
    invalidPriceSamples,
    warnings
  }
}

function indexUnderlying(bars: readonly UnderlyingBar[]): Map<number, UnderlyingBar> {
  const index = new Map<number, UnderlyingBar>()
  for (const bar of bars) {
    index.set(Math.floor(bar.timestamp / 60_000) * 60_000, bar)
  }
  return index
}

/** Computes per-trade data quality from the aligned minutes. */
export function summarizeQuality(
  aligned: readonly AlignedMinute[],
  invalidMinutes: ReadonlySet<number> = new Set()
): DataQuality {
  const expectedMinutes = aligned.length
  let pricedMinutes = 0
  let freshMinutes = 0
  let staleMinutes = 0
  let invalidPriceMinutes = 0
  let longestStaleRunMinutes = 0
  let currentRun = 0
  const missingByLeg: Record<LegRole, number> = { lower: 0, center: 0, upper: 0 }

  for (const point of aligned) {
    if (point.lower === null) missingByLeg.lower++
    if (point.center === null) missingByLeg.center++
    if (point.upper === null) missingByLeg.upper++

    if (invalidMinutes.has(point.minute)) {
      invalidPriceMinutes++
      currentRun++
    } else if (!point.priced) {
      currentRun++
    } else if (point.stale) {
      pricedMinutes++
      staleMinutes++
      currentRun++
    } else {
      pricedMinutes++
      freshMinutes++
      currentRun = 0
    }
    if (currentRun > longestStaleRunMinutes) longestStaleRunMinutes = currentRun
  }

  return {
    expectedMinutes,
    pricedMinutes,
    freshMinutes,
    staleMinutes,
    unpricedMinutes: expectedMinutes - pricedMinutes,
    invalidPriceMinutes,
    longestStaleRunMinutes,
    missingByLeg,
    coverage: expectedMinutes > 0 ? pricedMinutes / expectedMinutes : 0,
    freshness: pricedMinutes > 0 ? freshMinutes / pricedMinutes : 0
  }
}
