import type { OptionBar, UnderlyingBar } from '../domain/bars.js'
import type { DataQuality, MissingDataPolicy } from '../domain/butterfly.js'
import { CONTRACT_MULTIPLIER } from '../domain/butterfly.js'
import type {
  CalendarEntryContext,
  CalendarExecutionAssumptions,
  CalendarLegQuote,
  CalendarLegRole,
  CalendarObservation,
  CalendarPriceAudit,
  DoubleCalendarDefinition,
  DoubleCalendarSeries,
  InvalidCalendarPrice
} from '../domain/doubleCalendar.js'
import { CALENDAR_LEG_ROLES, CALENDAR_LEG_SIGN } from '../domain/doubleCalendar.js'
import { dteAt } from '../core/time/dte.js'
import { marketDateOf, sessionOpen, type MarketDate } from '../core/time/marketTime.js'
import { indexBarsByMinute, latestAtOrBefore } from './legPricing.js'
import { sessionMinuteGridDetailed } from './reconstruct.js'

/**
 * Reconstructs a double calendar's minute-by-minute value from its four legs.
 *
 * The butterfly reconstruction this mirrors had to work from trade aggregates,
 * where an absent bar is the normal case and half the module is about not
 * inventing a price. The calendar archive is continuous NBBO, so the hard part
 * moves elsewhere: to execution. Four legs across two expirations means four
 * bid-ask spreads paid on the way in and four more on the way out, and on a
 * structure whose whole edge is a few points of decay, that friction is not a
 * rounding error - it is frequently the difference between a strategy that
 * works and one that does not.
 *
 * So this module tracks two values per minute, not one:
 *
 *  - `midValue`, the package midpoint, which is what the position is worth.
 *  - `netValue`, what closing it right now would actually put in the account.
 *
 * Every management rule is evaluated against `netValue`. A "+25% target" that
 * fires on the midpoint and then fills below it is not a 25% winner, and a
 * study that reports it as one is flattering itself.
 */

export interface CalendarReconstructInput {
  definition: DoubleCalendarDefinition
  legBars: Record<CalendarLegRole, readonly OptionBar[]>
  underlyingBars?: readonly UnderlyingBar[]
  entryContext: CalendarEntryContext
  /** Simulated entry instant, epoch ms. */
  entryTimestamp: number
  /** Entry may not drift beyond this instant while waiting for four quotes. */
  entryDeadlineTimestamp?: number
  /**
   * Last instant to track. Never later than the front expiration: once the
   * short legs settle the position is no longer a calendar, and modelling what
   * it becomes would be modelling a different trade.
   */
  exitHorizonTimestamp: number
  execution: CalendarExecutionAssumptions
}

export class CalendarReconstructionError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CalendarReconstructionError'
  }
}

/** Allowance for tick rounding, never dollars of latitude. */
export const CALENDAR_PRICE_TOLERANCE = 0.02

/** Commission for one round of four contracts, expressed in index points. */
export function commissionPoints(perContract: number): number {
  return (perContract * CALENDAR_LEG_ROLES.length) / CONTRACT_MULTIPLIER
}

/** Package midpoint: long legs less short legs, in index points. */
export function packageMid(legs: Record<CalendarLegRole, CalendarLegQuote>): number {
  let total = 0
  for (const role of CALENDAR_LEG_ROLES) total += CALENDAR_LEG_SIGN[role] * legs[role].mid
  return total
}

/**
 * Package bid-ask spread, in index points.
 *
 * Buying the package means lifting the offer on both longs and hitting the bid
 * on both shorts, so the package's own spread is the sum of all four leg
 * spreads regardless of sign. Signs cancel in the midpoint; they never cancel
 * in the cost of crossing.
 *
 * Built from each leg's `typicalSpread` rather than the snapshot's own width -
 * see that field for why a single NBBO sample is the wrong number to charge a
 * fill against.
 */
export function packageSpread(legs: Record<CalendarLegRole, CalendarLegQuote>): number {
  let total = 0
  for (const role of CALENDAR_LEG_ROLES) total += legs[role].typicalSpread
  return total
}

/** Package width in this very snapshot, for diagnostics and the entry gate. */
export function packageQuotedSpread(legs: Record<CalendarLegRole, CalendarLegQuote>): number {
  let total = 0
  for (const role of CALENDAR_LEG_ROLES) total += legs[role].ask - legs[role].bid
  return total
}

/** What opening the package here costs, including friction and commissions. */
export function buyCost(
  legs: Record<CalendarLegRole, CalendarLegQuote>,
  execution: CalendarExecutionAssumptions
): number {
  return (
    packageMid(legs) +
    (execution.spreadFraction * packageSpread(legs)) / 2 +
    commissionPoints(execution.commissionPerContract)
  )
}

/** What closing the package here realizes, after friction and commissions. */
export function sellProceeds(
  legs: Record<CalendarLegRole, CalendarLegQuote>,
  execution: CalendarExecutionAssumptions
): number {
  return (
    packageMid(legs) -
    (execution.spreadFraction * packageSpread(legs)) / 2 -
    commissionPoints(execution.commissionPerContract)
  )
}

interface CalendarLegSeries {
  role: CalendarLegRole
  ticker: string
  index: Map<number, OptionBar>
  minutes: number[]
  /** Rolling median quoted width, keyed by the minute it applies to. */
  typicalSpread: Map<number, number>
}

/**
 * Minutes of quoted width behind each typical-spread estimate.
 *
 * Long enough that one wide sample cannot move the median, short enough to
 * follow a genuine widening within a few minutes - which matters, because the
 * sessions where spreads really do double are the sessions a stop fires in,
 * and smoothing those away would understate the cost of exactly the fills that
 * decide a strategy.
 */
export const TYPICAL_SPREAD_WINDOW = 15

/**
 * How far a snapshot may exceed its own typical width and still count as a
 * market at all.
 *
 * A package several times wider than its running width is a market maker
 * mid-reprice, not something anyone could trade against - and crucially, its
 * *midpoint is wrong too*. The 09:30 snapshot is the standard case: a leg
 * quoted 0.50 wide all session opens the next one at 74.20 bid, 119.70 offer,
 * whose midpoint is twenty-five points above the truth. Four legs make that a
 * package mark tens of points off, which on a forty-point debit reads as an
 * instant sixty percent loss. Left in, every stop in the study fires at 09:30
 * on the first morning after entry and nowhere else - which is precisely what
 * this engine did before the gate was applied to the whole path rather than to
 * the entry alone.
 *
 * Rejected minutes are counted against the trade's data quality, exactly like
 * a minute that could not be quoted at all, rather than silently dropped.
 */
export const MAX_QUOTE_SPREAD_MULTIPLE = 2.5

/** Median of a small array, without disturbing the caller's ordering. */
function medianOf(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!
}

function buildSeries(role: CalendarLegRole, ticker: string, bars: readonly OptionBar[]): CalendarLegSeries {
  const index = indexBarsByMinute(bars)
  const minutes = [...index.keys()].sort((a, b) => a - b)

  /*
   * Only usable quotes contribute a width. The 09:30 snapshot is stored as
   * 0.00 bid / 0.00 offer, and counting its zero width would drag the running
   * median down for the first quarter hour of every session - understating the
   * cost of exactly the fills a morning rule makes.
   */
  const widths = minutes.map((minute) => {
    const bar = index.get(minute)!
    if (bar.bid === undefined || bar.ask === undefined) return Number.NaN
    if (!(bar.ask > 0) || !(bar.ask > bar.bid) || bar.bid < 0) return Number.NaN
    return bar.ask - bar.bid
  })

  /*
   * Strictly trailing, inclusive of the minute being estimated.
   *
   * A centred window would be the better statistical estimator and is not
   * available: it would let a fill be priced using quotes from after the fill.
   * The effect would be small and would still be look-ahead, which is the one
   * error this engine cannot make and remain worth running.
   */
  const typicalSpread = new Map<number, number>()
  for (let i = 0; i < minutes.length; i++) {
    const window: number[] = []
    for (let j = Math.max(0, i - TYPICAL_SPREAD_WINDOW + 1); j <= i; j++) {
      const width = widths[j]!
      if (Number.isFinite(width) && width >= 0) window.push(width)
    }
    const observed = widths[i]!
    typicalSpread.set(
      minutes[i]!,
      window.length > 0 ? medianOf(window) : Number.isFinite(observed) ? observed : 0
    )
  }

  return { role, ticker, index, minutes, typicalSpread }
}

/**
 * Resolves one leg's two-sided quote at a minute.
 *
 * Unlike the butterfly path this insists on a genuine two-sided quote rather
 * than any single price: the entry cost, the exit proceeds and the friction
 * between them are all defined by the two sides, and a one-sided or crossed
 * quote cannot produce them.
 */
function resolveQuote(
  series: CalendarLegSeries,
  minute: number,
  policy: MissingDataPolicy
): CalendarLegQuote | null {
  const build = (bar: OptionBar, observedAt: number): CalendarLegQuote | null => {
    const { bid, ask } = bar
    if (bid === undefined || ask === undefined) return null
    if (!Number.isFinite(bid) || !Number.isFinite(ask) || bid < 0) return null

    /*
     * A zero offer is not a price, and neither is a locked market.
     *
     * The archive records the 09:30 snapshot as 0.00 bid, 0.00 offer on every
     * contract - the state before the opening rotation posts quotes, faithfully
     * stored. Taken at face value it makes the package worth nothing, which
     * reads as an instant total loss and fires every stop in the study at 09:30
     * on the first morning after entry. Treating it as "no quote" is what it
     * is: the minute is counted as unquoted against the trade's data quality,
     * and the position is simply not marked until the market opens.
     */
    if (ask <= 0 || ask <= bid) return null
    return {
      ticker: series.ticker,
      bid,
      ask,
      mid: (bid + ask) / 2,
      typicalSpread: series.typicalSpread.get(observedAt) ?? ask - bid,
      observedAt,
      ageMs: minute - observedAt
    }
  }

  const exact = series.index.get(minute)
  if (exact) {
    const quote = build(exact, minute)
    if (quote) return quote
  }

  if (policy.mode === 'strict') return null

  const previous = latestAtOrBefore(series.minutes, minute - 60_000)
  if (previous === null) return null
  if (minute - previous > policy.maxStaleMinutes * 60_000) return null

  const bar = series.index.get(previous)
  return bar ? build(bar, previous) : null
}

interface AlignedCalendarMinute {
  minute: number
  legs: Record<CalendarLegRole, CalendarLegQuote> | null
  stale: boolean
  maxAgeMs: number
  missing: CalendarLegRole[]
}

function align(
  minutes: readonly number[],
  series: Record<CalendarLegRole, CalendarLegSeries>,
  policy: MissingDataPolicy
): AlignedCalendarMinute[] {
  return minutes.map((minute) => {
    const legs = {} as Record<CalendarLegRole, CalendarLegQuote>
    const missing: CalendarLegRole[] = []
    let maxAgeMs = 0

    for (const role of CALENDAR_LEG_ROLES) {
      const quote = resolveQuote(series[role], minute, policy)
      if (!quote) {
        missing.push(role)
        continue
      }
      legs[role] = quote
      if (quote.ageMs > maxAgeMs) maxAgeMs = quote.ageMs
    }

    const complete = missing.length === 0
    return {
      minute,
      legs: complete ? legs : null,
      stale: complete && maxAgeMs > 0,
      maxAgeMs: complete ? maxAgeMs : 0,
      missing
    }
  })
}

function audit(point: AlignedCalendarMinute): CalendarPriceAudit {
  const legs = point.legs!
  return {
    timestamp: point.minute,
    mid: packageMid(legs),
    spread: packageSpread(legs),
    quotedSpread: packageQuotedSpread(legs),
    legs,
    stale: point.stale,
    maxLegAgeMs: point.maxAgeMs
  }
}

/**
 * Why a set of four quotes cannot describe a long double calendar.
 *
 * Both horizontal spreads must be worth something: at a shared strike the
 * later-dated option carries every scenario the earlier one does plus more
 * time, so a negative calendar value is a stale or crossed quote rather than an
 * opportunity. The check is per-side, not on the package, because one side
 * being broken is exactly the case a package-level test would hide.
 */
function invalidReason(legs: Record<CalendarLegRole, CalendarLegQuote>): string | null {
  const put = legs.putLong.mid - legs.putShort.mid
  const call = legs.callLong.mid - legs.callShort.mid

  if (!Number.isFinite(put) || !Number.isFinite(call)) return 'a leg midpoint is not finite'
  if (put < -CALENDAR_PRICE_TOLERANCE) {
    return `the put calendar is worth ${put.toFixed(2)}, which is below zero`
  }
  if (call < -CALENDAR_PRICE_TOLERANCE) {
    return `the call calendar is worth ${call.toFixed(2)}, which is below zero`
  }

  const quoted = packageQuotedSpread(legs)
  const typical = packageSpread(legs)
  if (typical > 0 && quoted > typical * MAX_QUOTE_SPREAD_MULTIPLE) {
    return `the quoted package is ${quoted.toFixed(2)} wide against a typical ${typical.toFixed(2)}, ` +
      'so this snapshot is a reprice rather than a market'
  }
  return null
}

function describeAudit(entry: CalendarPriceAudit): string {
  const parts = CALENDAR_LEG_ROLES.map((role) => {
    const leg = entry.legs[role]
    const age = leg.ageMs > 0 ? ` age ${Math.round(leg.ageMs / 60_000)}m` : ''
    return `${role} ${leg.ticker} ${leg.bid.toFixed(2)}/${leg.ask.toFixed(2)}${age}`
  })
  return `${parts.join(', ')}; mid=${entry.mid.toFixed(2)} spread=${entry.spread.toFixed(2)}`
}

function indexUnderlying(bars: readonly UnderlyingBar[]): Map<number, UnderlyingBar> {
  const index = new Map<number, UnderlyingBar>()
  for (const bar of bars) index.set(Math.floor(bar.timestamp / 60_000) * 60_000, bar)
  return index
}

export function reconstructDoubleCalendar(input: CalendarReconstructInput): DoubleCalendarSeries {
  const { definition, execution, entryTimestamp } = input
  const warnings: string[] = []

  if (input.exitHorizonTimestamp < entryTimestamp) {
    throw new CalendarReconstructionError('The exit horizon is before the entry timestamp.')
  }

  const series = {} as Record<CalendarLegRole, CalendarLegSeries>
  for (const role of CALENDAR_LEG_ROLES) {
    series[role] = buildSeries(role, definition.tickers[role], input.legBars[role])
    if (series[role].minutes.length === 0) {
      warnings.push(`The ${role} leg (${definition.tickers[role]}) has no bars at all in the requested range.`)
    }
  }

  const grid = sessionMinuteGridDetailed(entryTimestamp, input.exitHorizonTimestamp)
  if (grid.length === 0) {
    throw new CalendarReconstructionError(
      `No regular-session minutes between ${new Date(entryTimestamp).toISOString()} and ` +
        `${new Date(input.exitHorizonTimestamp).toISOString()}`
    )
  }

  const aligned = align(grid.map((m) => m.timestamp), series, execution.missingData)

  // Front DTE is constant within a session, so it is resolved once per market
  // date rather than once per minute, as in the butterfly engine.
  const dteByDate = new Map<MarketDate, { calendarDte: number; tradingDte: number }>()
  const sessionOrdinal = new Map<MarketDate, number>()
  for (const { marketDate } of grid) {
    if (dteByDate.has(marketDate)) continue
    sessionOrdinal.set(marketDate, sessionOrdinal.size)
    const breakdown = dteAt(sessionOpen(marketDate), definition.frontExpiration)
    dteByDate.set(marketDate, { calendarDte: breakdown.calendarDte, tradingDte: breakdown.tradingDte })
  }

  // --- entry ----------------------------------------------------------------
  const entryDeadline = input.entryDeadlineTimestamp ?? input.exitHorizonTimestamp
  const invalidPriceSamples: InvalidCalendarPrice[] = []
  let entryIndex = -1

  for (let i = 0; i < aligned.length; i++) {
    const point = aligned[i]!
    if (point.minute > entryDeadline) break
    if (!point.legs) continue

    const entry = audit(point)
    const violation = invalidReason(point.legs)
    const cost = buyCost(point.legs, execution)
    const costViolation = cost <= 0 ? `entry cost ${cost.toFixed(2)} is not a debit` : null

    if (violation || costViolation) {
      if (invalidPriceSamples.length < 5) {
        invalidPriceSamples.push({ ...entry, reason: violation ?? costViolation! })
      }
      continue
    }

    entryIndex = i
    break
  }

  if (entryIndex === -1) {
    const invalid = invalidPriceSamples[0]
    const shortfall = aligned
      .filter((p) => p.minute <= entryDeadline)
      .flatMap((p) => p.missing)
    const counts = CALENDAR_LEG_ROLES.map(
      (role) => `${role} ${shortfall.filter((r) => r === role).length}`
    ).join(', ')
    throw new CalendarReconstructionError(
      invalid
        ? `invalid calendar entry: ${invalid.reason}; ${describeAudit(invalid)}`
        : `The calendar could not be quoted at any minute by ${new Date(entryDeadline).toISOString()}; ` +
          `minutes missing a quote by leg: ${counts}.`
    )
  }

  const entryPoint = aligned[entryIndex]!
  const entryLegs = entryPoint.legs!
  const entryMid = packageMid(entryLegs)
  const entryCost = buyCost(entryLegs, execution)

  if (entryPoint.minute > entryTimestamp) {
    const late = Math.round((entryPoint.minute - entryTimestamp) / 60_000)
    warnings.push(`No quotable minute at entry; the first fill was ${late} minute(s) later.`)
  }
  if (entryPoint.stale) {
    warnings.push('The entry used at least one carried-forward quote rather than a same-minute one.')
  }

  const underlyingIndex = indexUnderlying(input.underlyingBars ?? [])
  const entryUnderlying = underlyingIndex.get(entryPoint.minute)?.close
  const entrySession = sessionOrdinal.get(grid[entryIndex]!.marketDate) ?? 0

  // --- the path -------------------------------------------------------------
  const observations: CalendarObservation[] = []
  const invalidMinutes = new Set<number>()

  for (let i = entryIndex; i < aligned.length; i++) {
    const point = aligned[i]!
    if (!point.legs) continue

    const violation = invalidReason(point.legs)
    if (violation) {
      invalidMinutes.add(point.minute)
      if (invalidPriceSamples.length < 5) {
        invalidPriceSamples.push({ ...audit(point), reason: violation })
      }
      continue
    }

    const midValue = packageMid(point.legs)
    const netValue = sellProceeds(point.legs, execution)
    const pnlDollars = (netValue - entryCost) * CONTRACT_MULTIPLIER * definition.quantity
    const pnlPct = entryCost > 0 ? ((netValue - entryCost) / entryCost) * 100 : 0

    const marketDate = grid[i]!.marketDate
    const dte = dteByDate.get(marketDate)!
    const underlyingPrice = underlyingIndex.get(point.minute)?.close

    const observation: CalendarObservation = {
      timestamp: point.minute,
      midValue,
      netValue,
      spread: packageSpread(point.legs),
      pnlDollars,
      pnlPct,
      frontDte: dte.calendarDte,
      frontTradingDte: dte.tradingDte,
      minutesSinceEntry: Math.round((point.minute - entryPoint.minute) / 60_000),
      sessionsSinceEntry: (sessionOrdinal.get(marketDate) ?? entrySession) - entrySession,
      stale: point.stale,
      maxLegAgeMs: point.maxAgeMs,
      priceAudit: audit(point)
    }

    if (underlyingPrice !== undefined) {
      observation.underlyingPrice = underlyingPrice
      observation.breachPoints = Math.max(
        definition.putStrike - underlyingPrice,
        underlyingPrice - definition.callStrike
      )
    }

    observations.push(observation)
  }

  if (observations.length === 0) {
    throw new CalendarReconstructionError('No minute after entry could be quoted.')
  }

  const quality = summarizeCalendarQuality(aligned.slice(entryIndex), invalidMinutes)

  if (invalidMinutes.size > 0) {
    warnings.push(
      `${invalidMinutes.size} quoted minute(s) were rejected as unusable marks: one side priced below ` +
        'zero, or the snapshot was a reprice rather than a market.'
    )
  }
  if (quality.coverage < 0.9) {
    warnings.push(
      `Only ${(quality.coverage * 100).toFixed(0)}% of session minutes carried four two-sided quotes.`
    )
  }
  if ((input.underlyingBars?.length ?? 0) === 0) {
    warnings.push('No underlying data was supplied, so strike-breach analysis is unavailable.')
  }

  return {
    definition,
    entryCost,
    entryMid,
    entryTimestamp: entryPoint.minute,
    entryAudit: audit(entryPoint),
    ...(entryUnderlying !== undefined ? { entryUnderlying } : {}),
    entryContext: input.entryContext,
    observations,
    quality,
    execution,
    invalidPriceSamples,
    warnings
  }
}

/**
 * Per-trade data quality, in the same shape the butterfly engine reports.
 *
 * `missingByLeg` there is keyed by the three butterfly roles, so the four
 * calendar roles are folded onto it: the lower/upper pair carries the two puts
 * and the two calls, and `center` carries nothing. The alternative was a second
 * quality type differing in one field, which would have forced every consumer
 * to branch.
 */
export function summarizeCalendarQuality(
  aligned: readonly {
    minute: number
    legs: unknown
    stale: boolean
    missing: readonly CalendarLegRole[]
  }[],
  invalidMinutes: ReadonlySet<number> = new Set()
): DataQuality {
  const expectedMinutes = aligned.length
  let pricedMinutes = 0
  let freshMinutes = 0
  let staleMinutes = 0
  let invalidPriceMinutes = 0
  let longestStaleRunMinutes = 0
  let currentRun = 0
  const missingByLeg = { lower: 0, center: 0, upper: 0 }

  for (const point of aligned) {
    for (const role of point.missing) {
      if (role === 'putShort' || role === 'putLong') missingByLeg.lower++
      else missingByLeg.upper++
    }

    if (invalidMinutes.has(point.minute)) {
      invalidPriceMinutes++
      currentRun++
    } else if (!point.legs) {
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
