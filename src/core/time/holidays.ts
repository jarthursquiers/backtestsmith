/**
 * NYSE / CBOE holiday calendar, computed from rules rather than a hard-coded
 * table so the application keeps working as the research window extends.
 *
 * All dates are Eastern-time market dates in YYYY-MM-DD form.
 */

/** Anonymous Gregorian algorithm (Meeus/Jones/Butcher) for Easter Sunday. */
function easterSunday(year: number): { month: number; day: number } {
  const a = year % 19
  const b = Math.floor(year / 100)
  const c = year % 100
  const d = Math.floor(b / 4)
  const e = b % 4
  const f = Math.floor((b + 8) / 25)
  const g = Math.floor((b - f + 1) / 3)
  const h = (19 * a + b - d - g + 15) % 30
  const i = Math.floor(c / 4)
  const k = c % 4
  const l = (32 + 2 * e + 2 * i - h - k) % 7
  const m = Math.floor((a + 11 * h + 22 * l) / 451)
  const month = Math.floor((h + l - 7 * m + 114) / 31)
  const day = ((h + l - 7 * m + 114) % 31) + 1
  return { month, day }
}

function iso(year: number, month: number, day: number): string {
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
}

/** Day of week for a civil date, 0=Sunday..6=Saturday. Uses UTC to stay zone-free. */
function dayOfWeek(year: number, month: number, day: number): number {
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay()
}

/** Nth given weekday of a month, e.g. nthWeekday(2026, 1, 1, 3) = 3rd Monday of January. */
function nthWeekday(year: number, month: number, weekday: number, n: number): number {
  const firstDow = dayOfWeek(year, month, 1)
  const offset = (weekday - firstDow + 7) % 7
  return 1 + offset + (n - 1) * 7
}

/** Last given weekday of a month, e.g. last Monday of May. */
function lastWeekday(year: number, month: number, weekday: number): number {
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate()
  const lastDow = dayOfWeek(year, month, daysInMonth)
  return daysInMonth - ((lastDow - weekday + 7) % 7)
}

/**
 * Applies the NYSE observation rule for fixed-date holidays: a Saturday holiday
 * is observed the preceding Friday, a Sunday holiday the following Monday.
 */
function observed(year: number, month: number, day: number): string {
  const dow = dayOfWeek(year, month, day)
  const base = Date.UTC(year, month - 1, day)
  let shifted = base
  if (dow === 6) shifted = base - 86400000
  else if (dow === 0) shifted = base + 86400000
  const d = new Date(shifted)
  return iso(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate())
}

function addDaysIso(year: number, month: number, day: number, delta: number): string {
  const d = new Date(Date.UTC(year, month - 1, day) + delta * 86400000)
  return iso(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate())
}

/**
 * One-off market closures that no rule predicts (funerals, disasters).
 * Extend as needed; entries outside the research window are harmless.
 */
const AD_HOC_CLOSURES: readonly string[] = [
  '2018-12-05', // National Day of Mourning, George H. W. Bush
  '2025-01-09'  // National Day of Mourning, Jimmy Carter
]

const holidayCache = new Map<number, Set<string>>()

/** Full-day market closures for a calendar year. */
export function marketHolidays(year: number): Set<string> {
  const cached = holidayCache.get(year)
  if (cached) return cached

  const days = new Set<string>()

  days.add(observed(year, 1, 1))                              // New Year's Day
  days.add(iso(year, 1, nthWeekday(year, 1, 1, 3)))           // MLK Jr. Day (3rd Mon Jan)
  days.add(iso(year, 2, nthWeekday(year, 2, 1, 3)))           // Washington's Birthday (3rd Mon Feb)

  const easter = easterSunday(year)                            // Good Friday (Easter - 2)
  days.add(addDaysIso(year, easter.month, easter.day, -2))

  days.add(iso(year, 5, lastWeekday(year, 5, 1)))             // Memorial Day (last Mon May)
  if (year >= 2022) days.add(observed(year, 6, 19))           // Juneteenth (NYSE from 2022)
  days.add(observed(year, 7, 4))                              // Independence Day
  days.add(iso(year, 9, nthWeekday(year, 9, 1, 1)))           // Labor Day (1st Mon Sep)
  days.add(iso(year, 11, nthWeekday(year, 11, 4, 4)))         // Thanksgiving (4th Thu Nov)
  days.add(observed(year, 12, 25))                            // Christmas

  for (const d of AD_HOC_CLOSURES) {
    if (d.startsWith(String(year))) days.add(d)
  }

  holidayCache.set(year, days)
  return days
}

const earlyCloseCache = new Map<number, Set<string>>()

/**
 * Half sessions that close at 1:00 PM ET. Relevant because a 7-DTE butterfly
 * can span one, and assuming a 4:00 PM close would invent bars that never existed.
 */
export function earlyCloseDays(year: number): Set<string> {
  const cached = earlyCloseCache.get(year)
  if (cached) return cached

  const days = new Set<string>()
  const holidays = marketHolidays(year)

  // Day after Thanksgiving
  const thanksgiving = nthWeekday(year, 11, 4, 4)
  days.add(addDaysIso(year, 11, thanksgiving, 1))

  // July 3 when it is itself a weekday trading session
  const julyThirdDow = dayOfWeek(year, 7, 3)
  if (julyThirdDow >= 1 && julyThirdDow <= 5 && !holidays.has(iso(year, 7, 3))) {
    days.add(iso(year, 7, 3))
  }

  // Christmas Eve when it is a weekday trading session
  const dec24Dow = dayOfWeek(year, 12, 24)
  if (dec24Dow >= 1 && dec24Dow <= 5 && !holidays.has(iso(year, 12, 24))) {
    days.add(iso(year, 12, 24))
  }

  earlyCloseCache.set(year, days)
  return days
}

export function isMarketHoliday(date: string): boolean {
  const year = Number(date.slice(0, 4))
  return marketHolidays(year).has(date)
}

export function isEarlyCloseDay(date: string): boolean {
  const year = Number(date.slice(0, 4))
  return earlyCloseDays(year).has(date)
}
