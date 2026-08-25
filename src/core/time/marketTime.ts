import { DateTime } from 'luxon'
import { isEarlyCloseDay, isMarketHoliday } from './holidays.js'

/**
 * Every trading calculation in this application is anchored to U.S. Eastern
 * market time. Provider timestamps arrive as UTC epoch milliseconds; calendar
 * dates arrive as ET market dates. Mixing the two silently is the single most
 * likely source of off-by-one-day and DST bugs, so all conversion goes through
 * this module.
 */
export const MARKET_ZONE = 'America/New_York'

/** Regular session open, Eastern. */
export const SESSION_OPEN = { hour: 9, minute: 30 } as const
/** Regular session close, Eastern. */
export const SESSION_CLOSE = { hour: 16, minute: 0 } as const
/** Half-session close, Eastern. */
export const EARLY_SESSION_CLOSE = { hour: 13, minute: 0 } as const

/** A market date in YYYY-MM-DD form, always interpreted in Eastern time. */
export type MarketDate = string

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/

export function assertMarketDate(date: string): MarketDate {
  if (!ISO_DATE.test(date)) {
    throw new Error(`Invalid market date "${date}": expected YYYY-MM-DD`)
  }
  return date
}

/** Converts a UTC epoch-millisecond timestamp into an Eastern-time DateTime. */
export function toEastern(timestampMs: number): DateTime {
  return DateTime.fromMillis(timestampMs, { zone: MARKET_ZONE })
}

/**
 * The Eastern market date a timestamp belongs to.
 *
 * Note this is the *calendar date in Eastern time*, which is why a 20:30 UTC
 * timestamp maps to the same day but a 01:00 UTC timestamp maps to the previous
 * day. Naive UTC date slicing gets this wrong for the after-hours tail.
 */
export function marketDateOf(timestampMs: number): MarketDate {
  return toEastern(timestampMs).toFormat('yyyy-MM-dd')
}

/** Builds a UTC epoch-millisecond timestamp from an Eastern-time wall clock. */
export function easternToTimestamp(
  date: MarketDate,
  hour: number,
  minute: number,
  second = 0
): number {
  assertMarketDate(date)
  const dt = DateTime.fromObject(
    { year: Number(date.slice(0, 4)), month: Number(date.slice(5, 7)), day: Number(date.slice(8, 10)), hour, minute, second },
    { zone: MARKET_ZONE }
  )
  if (!dt.isValid) {
    throw new Error(`Invalid Eastern datetime ${date} ${hour}:${minute}: ${dt.invalidReason}`)
  }
  return dt.toMillis()
}

/** Parses "HH:mm" or "HH:mm:ss" into components; throws on malformed input. */
export function parseTimeOfDay(value: string): { hour: number; minute: number; second: number } {
  const m = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(value)
  if (!m) throw new Error(`Invalid time of day "${value}": expected HH:mm`)
  const hour = Number(m[1])
  const minute = Number(m[2])
  const second = m[3] ? Number(m[3]) : 0
  if (hour > 23 || minute > 59 || second > 59) {
    throw new Error(`Invalid time of day "${value}": out of range`)
  }
  return { hour, minute, second }
}

/** Session open timestamp (9:30 AM ET) for a market date. */
export function sessionOpen(date: MarketDate): number {
  const cached = sessionOpenCache.get(date)
  if (cached !== undefined) return cached
  const value = easternToTimestamp(date, SESSION_OPEN.hour, SESSION_OPEN.minute)
  sessionOpenCache.set(date, value)
  return value
}

/**
 * Session close timestamp for a market date, honoring 1:00 PM ET half sessions.
 */
export function sessionClose(date: MarketDate): number {
  const cached = sessionCloseCache.get(date)
  if (cached !== undefined) return cached
  const close = isEarlyCloseDay(date) ? EARLY_SESSION_CLOSE : SESSION_CLOSE
  const value = easternToTimestamp(date, close.hour, close.minute)
  sessionCloseCache.set(date, value)
  return value
}

/** True when the timestamp falls inside the regular session for its own market date. */
export function isDuringRegularSession(timestampMs: number): boolean {
  const date = marketDateOf(timestampMs)
  if (!isTradingDay(date)) return false
  return timestampMs >= sessionOpen(date) && timestampMs < sessionClose(date)
}

/** Number of regular-session minutes in a market date; 0 for non-trading days. */
export function sessionMinuteCount(date: MarketDate): number {
  if (!isTradingDay(date)) return 0
  return Math.round((sessionClose(date) - sessionOpen(date)) / 60000)
}

/*
 * These are pure functions of a market date, and the backtest engine calls them
 * on the order of a million times per study. Memoizing turns each into a map
 * lookup; the cache holds one small entry per distinct date, so a multi-year
 * study costs a few thousand entries.
 */
const tradingDayCache = new Map<MarketDate, boolean>()
const sessionOpenCache = new Map<MarketDate, number>()
const sessionCloseCache = new Map<MarketDate, number>()

export function isWeekend(date: MarketDate): boolean {
  assertMarketDate(date)
  const dow = DateTime.fromISO(date, { zone: MARKET_ZONE }).weekday // 1=Mon..7=Sun
  return dow === 6 || dow === 7
}

/** A trading day is a weekday that is not a full-day market holiday. */
export function isTradingDay(date: MarketDate): boolean {
  const cached = tradingDayCache.get(date)
  if (cached !== undefined) return cached
  assertMarketDate(date)
  const result = !isWeekend(date) && !isMarketHoliday(date)
  tradingDayCache.set(date, result)
  return result
}

export function addCalendarDays(date: MarketDate, days: number): MarketDate {
  assertMarketDate(date)
  return DateTime.fromISO(date, { zone: MARKET_ZONE }).plus({ days }).toFormat('yyyy-MM-dd')
}

/** Next trading day strictly after `date`. */
export function nextTradingDay(date: MarketDate): MarketDate {
  let cursor = addCalendarDays(date, 1)
  for (let i = 0; i < 30; i++) {
    if (isTradingDay(cursor)) return cursor
    cursor = addCalendarDays(cursor, 1)
  }
  throw new Error(`No trading day found within 30 days after ${date}`)
}

/** Previous trading day strictly before `date`. */
export function previousTradingDay(date: MarketDate): MarketDate {
  let cursor = addCalendarDays(date, -1)
  for (let i = 0; i < 30; i++) {
    if (isTradingDay(cursor)) return cursor
    cursor = addCalendarDays(cursor, -1)
  }
  throw new Error(`No trading day found within 30 days before ${date}`)
}

/** Inclusive list of trading days in [from, to]. */
export function tradingDaysBetween(from: MarketDate, to: MarketDate): MarketDate[] {
  assertMarketDate(from)
  assertMarketDate(to)
  const days: MarketDate[] = []
  let cursor = from
  while (cursor <= to) {
    if (isTradingDay(cursor)) days.push(cursor)
    cursor = addCalendarDays(cursor, 1)
  }
  return days
}

/**
 * Trading sessions selected by a once-per-week entry schedule.
 *
 * An empty weekday set means every session. Otherwise one session is chosen in
 * each ISO week: the requested weekday when it is open, or the nearest open
 * session when a holiday closes it.
 */
export function scheduledEntryDays(
  from: MarketDate,
  to: MarketDate,
  weekdays?: readonly number[]
): MarketDate[] {
  const all = tradingDaysBetween(from, to)
  if (!weekdays || weekdays.length === 0) return all

  const wanted = [...new Set(weekdays)]
  if (wanted.some((weekday) => !Number.isInteger(weekday) || weekday < 1 || weekday > 5)) {
    throw new Error('Entry weekdays must be integers from 1 (Monday) through 5 (Friday).')
  }

  const byWeek = new Map<string, MarketDate[]>()
  for (const date of all) {
    const value = DateTime.fromISO(date, { zone: MARKET_ZONE })
    const key = `${value.weekYear}-${String(value.weekNumber).padStart(2, '0')}`
    const bucket = byWeek.get(key)
    if (bucket) bucket.push(date)
    else byWeek.set(key, [date])
  }

  return [...byWeek.values()].map((dates) => {
    const exact = dates.find((date) => wanted.includes(DateTime.fromISO(date, { zone: MARKET_ZONE }).weekday))
    if (exact) return exact

    return dates.reduce((best, date) => {
      const day = DateTime.fromISO(date, { zone: MARKET_ZONE }).weekday
      const bestDay = DateTime.fromISO(best, { zone: MARKET_ZONE }).weekday
      const distance = Math.min(...wanted.map((target) => Math.abs(day - target)))
      const bestDistance = Math.min(...wanted.map((target) => Math.abs(bestDay - target)))
      return distance < bestDistance ? date : best
    })
  })
}
