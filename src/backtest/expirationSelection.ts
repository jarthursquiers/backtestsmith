import { calendarDaysBetween, tradingDaysUntil } from '../core/time/dte.js'
import type { MarketDate } from '../core/time/marketTime.js'
import type { ExpirationRule } from '../shared/study.js'

/**
 * Choosing which expiration to trade.
 *
 * Calendar and trading DTE are reported separately and never conflated: a
 * 7-calendar-day butterfly is five sessions in a normal week and four when a
 * holiday intervenes, and decay follows sessions rather than dates.
 */

export type { ExpirationRule } from '../shared/study.js'

export interface ExpirationChoice {
  expiration: MarketDate
  calendarDte: number
  tradingDte: number
  /** Signed difference from the requested target, in calendar days. */
  deviation: number
}

export interface SelectExpirationOptions {
  entryDate: MarketDate
  /** Expirations known to exist. Order does not matter. */
  available: readonly MarketDate[]
  targetDte: number
  rule?: ExpirationRule
  /** Widest acceptable deviation from the target, in calendar days. */
  maxDeviation?: number
}

/**
 * Picks an expiration for a target DTE.
 *
 * Only expirations strictly after the entry date are considered: a same-day
 * expiration is a different instrument with different risk, and silently
 * substituting one would corrupt a DTE-targeted study.
 */
export function selectExpiration(options: SelectExpirationOptions): ExpirationChoice | null {
  const { entryDate, available, targetDte, rule = 'nearest', maxDeviation } = options

  const candidates: ExpirationChoice[] = available
    .filter((expiration) => expiration > entryDate)
    .map((expiration) => {
      const calendarDte = calendarDaysBetween(entryDate, expiration)
      return {
        expiration,
        calendarDte,
        tradingDte: tradingDaysUntil(entryDate, expiration),
        deviation: calendarDte - targetDte
      }
    })

  const eligible = candidates.filter((c) =>
    rule === 'preferGte' ? c.deviation >= 0 : rule === 'preferLte' ? c.deviation <= 0 : true
  )

  const withinTolerance =
    maxDeviation === undefined
      ? eligible
      : eligible.filter((c) => Math.abs(c.deviation) <= maxDeviation)

  if (withinTolerance.length === 0) return null

  return withinTolerance.reduce((best, candidate) => {
    const byDistance = Math.abs(candidate.deviation) - Math.abs(best.deviation)
    if (byDistance !== 0) return byDistance < 0 ? candidate : best
    // Equidistant: prefer the longer-dated contract, which has more time value
    // and is the more conservative choice for a debit structure.
    return candidate.calendarDte > best.calendarDte ? candidate : best
  })
}

/**
 * Candidate SPX expiration dates over a range.
 *
 * SPX lists weeklies expiring Monday, Wednesday, and Friday, plus monthlies.
 * These are *candidates* only: whether a given date actually lists contracts is
 * settled by loading its chain, never assumed here.
 */
export function candidateExpirationDates(
  from: MarketDate,
  to: MarketDate,
  weekdays: readonly number[] = [1, 3, 5]
): MarketDate[] {
  const out: MarketDate[] = []
  const start = new Date(`${from}T00:00:00Z`)
  const end = new Date(`${to}T00:00:00Z`)

  for (let d = start.getTime(); d <= end.getTime(); d += 86_400_000) {
    const date = new Date(d)
    // getUTCDay is safe here because these are date-only values, never instants.
    if (weekdays.includes(date.getUTCDay())) {
      out.push(date.toISOString().slice(0, 10))
    }
  }
  return out
}
