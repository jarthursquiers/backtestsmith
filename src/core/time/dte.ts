import { DateTime } from 'luxon'
import {
  MARKET_ZONE,
  MarketDate,
  assertMarketDate,
  isTradingDay,
  marketDateOf,
  sessionClose,
  tradingDaysBetween
} from './marketTime.js'

/**
 * Days-to-expiration comes in two flavors that must never be conflated:
 *
 *  - calendar DTE: plain civil-day difference, what option chains usually show
 *  - trading DTE:  number of remaining sessions, what actually governs decay
 *
 * The spec is explicit that DTE must not be "calendar date subtraction" done
 * against raw timestamps, because a UTC subtraction across a DST boundary or an
 * after-hours timestamp silently shifts the answer by a day.
 */
export interface DteBreakdown {
  /** Civil days between the market date and expiration. */
  calendarDte: number
  /**
   * Remaining trading sessions, counting expiration day itself but not the
   * current day once it is already the expiration date.
   */
  tradingDte: number
  /** Fractional calendar days remaining until the expiration-day close. */
  fractionalDte: number
  /** The Eastern market date the reference timestamp belongs to. */
  asOfDate: MarketDate
  expirationDate: MarketDate
}

/** Calendar days between two Eastern market dates. Positive when `to` is later. */
export function calendarDaysBetween(from: MarketDate, to: MarketDate): number {
  assertMarketDate(from)
  assertMarketDate(to)
  const a = DateTime.fromISO(from, { zone: MARKET_ZONE }).startOf('day')
  const b = DateTime.fromISO(to, { zone: MARKET_ZONE }).startOf('day')
  // Luxon's diff on zone-anchored startOf('day') values is DST-safe, unlike
  // dividing a raw millisecond delta by 86_400_000.
  return Math.round(b.diff(a, 'days').days)
}

/**
 * Trading sessions remaining from `from` through `to`, inclusive of the
 * expiration session and exclusive of `from` itself.
 *
 * Entering on Tuesday with Friday expiration gives 3 (Wed, Thu, Fri).
 */
export function tradingDaysUntil(from: MarketDate, to: MarketDate): number {
  assertMarketDate(from)
  assertMarketDate(to)
  if (to <= from) return 0
  const days = tradingDaysBetween(from, to)
  // tradingDaysBetween is inclusive of `from`; drop it if it was a session.
  return isTradingDay(from) ? days.length - 1 : days.length
}

/**
 * Full DTE breakdown as of a specific simulated timestamp.
 *
 * `timestampMs` is the simulated "now" — passing it explicitly is what keeps
 * DTE honest during a backtest, since nothing may consult a wall clock.
 */
export function dteAt(timestampMs: number, expirationDate: MarketDate): DteBreakdown {
  assertMarketDate(expirationDate)
  const asOfDate = marketDateOf(timestampMs)
  const expiryClose = sessionClose(expirationDate)
  const remainingMs = Math.max(0, expiryClose - timestampMs)

  return {
    calendarDte: calendarDaysBetween(asOfDate, expirationDate),
    tradingDte: tradingDaysUntil(asOfDate, expirationDate),
    fractionalDte: remainingMs / 86_400_000,
    asOfDate,
    expirationDate
  }
}
