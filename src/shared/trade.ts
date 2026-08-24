import type {
  ButterflyDefinition,
  ButterflyPriceAudit,
  DataQuality,
  InvalidButterflyPrice
} from '../domain/butterfly.js'
import type {
  CalendarEntryContext,
  CalendarPriceAudit,
  DoubleCalendarDefinition,
  InvalidCalendarPrice
} from '../domain/doubleCalendar.js'
import type { Excursions } from './excursions.js'

/**
 * The structures a stored trade can describe.
 *
 * A union rather than a common base, because the two share almost nothing
 * concrete: a butterfly has three legs on one expiration and a bounded value, a
 * double calendar has four across two and no ceiling at all. What they do share
 * is everything a *result* needs - an entry, an exit, a P/L and a data-quality
 * record - which is why the union sits here at the result boundary and not in
 * the engines, where the differences are the whole point.
 *
 * Narrow with `isCalendarTrade`. An absent `structure` means butterfly, so every
 * run stored before double calendars existed still reads correctly.
 */
export type PositionDefinition = ButterflyDefinition | DoubleCalendarDefinition

export type PositionAudit = ButterflyPriceAudit | CalendarPriceAudit

/** Why a trade was closed. */
export type ExitReasonDto =
  | 'expiration'
  | 'profitTarget'
  | 'stopLoss'
  | 'timeExit'
  | 'centerTouch'
  | 'tentEntry'
  | 'trailingProfit'
  | 'endOfData'
  /** Double calendar: closed at the front expiration, the end of its tracked life. */
  | 'horizon'
  /** Double calendar: the index reached a short strike. */
  | 'strikeBreach'

/** One completed trade under one management method. */
export interface TradeResult {
  definition: PositionDefinition
  strategyId: string
  strategyLabel: string

  entryTimestamp: number
  entryUnderlying?: number
  /** Net debit paid, in price points, including entry slippage. */
  entryDebit: number
  /** Optional for compatibility with studies saved before price auditing existed. */
  entryAudit?: PositionAudit
  /**
   * What the entry rule measured, e.g. the EMA and its distance, or the
   * volatility gauge that set the wing width. Absent on studies saved before
   * these were retained.
   */
  entryIndicators?: Record<string, number>

  exitTimestamp: number
  /** Value received, in price points, after exit slippage. */
  exitValue: number
  /** Raw leg mark for the minute that caused the exit. */
  exitAudit?: PositionAudit
  exitReason: ExitReasonDto
  /**
   * True when minute bars could not establish that the exit trigger actually
   * occurred, or when opposing triggers were reachable in the same minute.
   */
  ambiguous: boolean
  note?: string
  exitUnderlying?: number

  pnlDollars: number
  pnlPct: number
  holdingMinutes: number
  exitDte: number

  excursions: Excursions
  /** Maximum unrealized profit minus realized profit, in dollars. */
  profitGiveback: number
  /** realized / maximum unrealized. Null when the trade never went positive. */
  mfeCaptureRatio: number | null
  /** Minutes from entry to first touching each return threshold, or null. */
  firstReached: Record<string, number | null>
  /**
   * Lowest return seen *after* first reaching each threshold, or null when the
   * threshold was never reached.
   *
   * This is what makes conditional path questions answerable: "of the trades
   * that reached +100%, how many later fell back below +50%, or all the way to
   * a loss" cannot be recovered from the final result and the MFE alone, since
   * the maximum adverse excursion may well have occurred before the peak.
   */
  lowestAfterReaching: Record<string, number | null>
  /**
   * Closest the underlying came to the centre strike over the held path, in
   * wing widths. Undefined when no underlying data was available.
   */
  minNormalizedDistance?: number

  quality: DataQuality
  /** Representative impossible marks excluded from this reconstructed path. */
  invalidPriceSamples?: (InvalidButterflyPrice | InvalidCalendarPrice)[]

  // --- double calendar only --------------------------------------------------
  /*
   * Present only when `definition.structure` is 'doubleCalendar'. Optional
   * rather than a second result type because everything above already describes
   * the trade completely; these are the few measures a calendar has and a
   * butterfly does not, and splitting the type in two would have forked storage,
   * export, and every screen that reads a result.
   */

  /** Package midpoint at entry, before friction. */
  entryMid?: number
  /** Trading sessions from entry to exit. */
  sessionsHeld?: number
  /**
   * Furthest the index got outside the short strikes over the held path, in
   * points. Negative means it never left the tent.
   */
  maxBreachPoints?: number
  /** What the delta selection measured at entry. */
  calendarContext?: CalendarEntryContext
}

/**
 * A trade the butterfly engine produced.
 *
 * The engines each produce one structure and know which; only storage, export
 * and the screens have to handle both. Naming that lets a butterfly-only caller
 * reach `definition.wingWidth` without narrowing, and stops a calendar result
 * being passed somewhere that would silently misread it.
 */
export type ButterflyTradeResult = TradeResult & { definition: ButterflyDefinition }

/** A trade the double calendar engine produced. */
export type CalendarTradeResultDto = TradeResult & { definition: DoubleCalendarDefinition }

/** Narrows a stored trade to the double calendar case. */
export function isCalendarTrade(
  trade: Pick<TradeResult, 'definition'>
): trade is Pick<TradeResult, 'definition'> & { definition: DoubleCalendarDefinition } {
  return trade.definition.structure === 'doubleCalendar'
}

/** Narrows a definition to the double calendar case. */
export function isCalendarDefinition(
  definition: PositionDefinition
): definition is DoubleCalendarDefinition {
  return definition.structure === 'doubleCalendar'
}
