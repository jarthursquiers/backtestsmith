import type { MarketDate } from '../core/time/marketTime.js'
import type { DataQuality, MissingDataPolicy } from './butterfly.js'

/**
 * A double calendar: a put calendar and a call calendar sharing one pair of
 * expirations.
 *
 * Four legs, two expirations, two strikes. The near-dated options are sold and
 * the far-dated ones bought at the same strike, so the position is long two
 * horizontal spreads and is entered for a net debit.
 *
 * The butterfly types in `butterfly.ts` cannot describe this and are
 * deliberately not stretched to. A butterfly's value is bounded by its wing
 * width, which is what makes every validity check, every intra-minute bound and
 * every "percent of max" in that engine meaningful. A calendar has no such
 * bound: its maximum value is not knowable at entry, only its maximum loss is.
 * Reusing the butterfly path would have meant disabling the checks that make it
 * trustworthy, so this structure gets its own.
 */

export type CalendarLegRole = 'putShort' | 'putLong' | 'callShort' | 'callLong'

export const CALENDAR_LEG_ROLES: readonly CalendarLegRole[] = [
  'putShort',
  'putLong',
  'callShort',
  'callLong'
]

/** Signed contribution of each leg to the package's value, per one lot. */
export const CALENDAR_LEG_SIGN: Record<CalendarLegRole, 1 | -1> = {
  putShort: -1,
  putLong: 1,
  callShort: -1,
  callLong: 1
}

export interface DoubleCalendarDefinition {
  /** Discriminates this from a butterfly wherever the two share a type. */
  structure: 'doubleCalendar'
  underlying: string
  /** Option root the legs were selected from, e.g. 'SPXW'. */
  root: string
  /** Expiration of the two short legs. */
  frontExpiration: MarketDate
  /** Expiration of the two long legs. */
  backExpiration: MarketDate
  putStrike: number
  callStrike: number
  tickers: Record<CalendarLegRole, string>
  /** Number of double calendars; one is 1x1 puts plus 1x1 calls. */
  quantity: number
}

/** One leg's two-sided quote at one instant, with its provenance. */
export interface CalendarLegQuote {
  ticker: string
  bid: number
  ask: number
  mid: number
  /**
   * The width a resting order should expect to cross, in points.
   *
   * Not `ask - bid` from this one snapshot. The archive samples the NBBO once a
   * minute, and a single sample regularly catches a market maker mid-reprice: a
   * contract whose spread is 0.50 wide all session shows 4.70 in one minute and
   * 0.70 in the minutes either side. Filling against that sample would charge a
   * trade for a market that existed for a fraction of a second, and because all
   * four legs widen together when the index moves, it charges hardest exactly
   * when a rule is deciding something. This is instead the rolling median of
   * the leg's own recent quoted widths, which is what an order actually meets.
   */
  typicalSpread: number
  observedAt: number
  /** Milliseconds between the observation and the instant it is used for. */
  ageMs: number
}

/**
 * The four leg observations behind one package mark.
 *
 * Kept per accepted entry and exit so a result can always be traced back to the
 * exact quotes that produced it.
 */
export interface CalendarPriceAudit {
  timestamp: number
  /** Package midpoint, in index points. */
  mid: number
  /** Package width used to charge friction, in index points. See `typicalSpread`. */
  spread: number
  /** Package ask minus package bid in this very snapshot, for diagnostics. */
  quotedSpread: number
  legs: Record<CalendarLegRole, CalendarLegQuote>
  stale: boolean
  maxLegAgeMs: number
}

/**
 * How a double calendar is assumed to fill.
 *
 * Expressed against the quoted spread rather than as a flat number of points,
 * because the archive carries full NBBO for every leg and the spread on a
 * four-legged SPX package varies by a factor of three between calm and stressed
 * sessions. A fixed allowance would be far too generous in the sessions that
 * decide a strategy's tail and too harsh everywhere else.
 */
export interface CalendarExecutionAssumptions {
  /**
   * Fraction of the distance from the midpoint to the far side of the package
   * spread that is given up on every fill. 0 fills at the midpoint, 1 pays the
   * full offer on entry and hits the full bid on exit.
   */
  spreadFraction: number
  /** Commission per contract per side, in dollars. Four contracts per lot. */
  commissionPerContract: number
  missingData: MissingDataPolicy
}

export const DEFAULT_CALENDAR_EXECUTION: CalendarExecutionAssumptions = {
  // Halfway to the far side. A four-leg SPX package rarely fills at the mid and
  // rarely needs the full offer; this is the honest middle, and every headline
  // result is reported beside a zero-friction and a full-spread run so the
  // choice can be judged rather than trusted.
  spreadFraction: 0.5,
  commissionPerContract: 1.3,
  // Quote archives are continuous, unlike the trade aggregates the butterfly
  // engine had to tolerate, so a short carry is a safety net rather than a
  // working assumption.
  missingData: { mode: 'carryForward', maxStaleMinutes: 5 }
}

/** One minute of a double calendar's life. */
export interface CalendarObservation {
  timestamp: number
  underlyingPrice?: number

  /** Package midpoint, in index points. */
  midValue: number
  /**
   * What closing the package here would actually realize, in index points:
   * the midpoint less the assumed exit friction and commissions.
   *
   * Management rules are evaluated against this rather than the midpoint, so a
   * "+25%" target means the trader banked 25%, not that a theoretical mark
   * touched it and the fill came in below.
   */
  netValue: number
  /** Package width used to charge friction, in index points. */
  spread: number

  pnlDollars: number
  /** Return on the entry cost, in percent. Max loss is -100%. */
  pnlPct: number

  /** Calendar days from this instant to the front expiration. */
  frontDte: number
  /** Remaining trading sessions to the front expiration. */
  frontTradingDte: number
  minutesSinceEntry: number
  /** Whole trading sessions elapsed since entry. */
  sessionsSinceEntry: number

  /**
   * How far the index sits outside the short strikes, in points.
   *
   * Negative inside the tent, zero at a short strike, positive beyond it. This
   * is the calendar's analogue of the butterfly's distance-to-centre: a double
   * calendar earns while the index stays between its shorts and bleeds once it
   * leaves.
   */
  breachPoints?: number

  stale: boolean
  maxLegAgeMs: number
  priceAudit?: CalendarPriceAudit
}

/** A mark rejected because the four quotes cannot describe a long calendar. */
export interface InvalidCalendarPrice extends CalendarPriceAudit {
  reason: string
}

/** What the strike selection measured at entry, kept for later analysis. */
export interface CalendarEntryContext {
  /** Index level used to anchor the chain search. */
  spot: number
  /** Forward implied by put-call parity across the front chain. */
  forward: number
  discountFactor: number
  /** Delta of the chosen short put, negative. */
  putDelta: number
  /** Delta of the chosen short call, positive. */
  callDelta: number
  /** Implied volatility of each short leg, from its own midpoint. */
  putIv: number
  callIv: number
  /**
   * Implied volatility of each long leg at the same strike.
   *
   * The calendar's entire edge is that the back month is priced at a lower
   * volatility than the front, so the spread between these and the pair above
   * is the entry condition worth testing against the outcome.
   */
  putBackIv?: number
  callBackIv?: number
  /** Calendar days from entry to each expiration. */
  frontDte: number
  backDte: number
  /** Points between the two short strikes: the width of the profit tent. */
  tentWidth: number
}

/** A reconstructed double calendar lifecycle. */
export interface DoubleCalendarSeries {
  definition: DoubleCalendarDefinition
  /**
   * Total cost to open, in index points per lot, including entry friction and
   * commissions. This is the capital at risk and the denominator of every
   * percentage return in the study.
   */
  entryCost: number
  /** Package midpoint at entry, before friction. */
  entryMid: number
  entryTimestamp: number
  entryUnderlying?: number
  entryAudit?: CalendarPriceAudit
  entryContext: CalendarEntryContext
  observations: CalendarObservation[]
  quality: DataQuality
  execution: CalendarExecutionAssumptions
  invalidPriceSamples?: InvalidCalendarPrice[]
  warnings: string[]
}
