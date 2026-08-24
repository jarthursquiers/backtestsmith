import type { OptionBar, UnderlyingBar } from '../domain/bars.js'
import type {
  CalendarEntryContext,
  CalendarExecutionAssumptions,
  CalendarLegRole,
  DoubleCalendarDefinition,
  DoubleCalendarSeries
} from '../domain/doubleCalendar.js'
import { DEFAULT_CALENDAR_EXECUTION } from '../domain/doubleCalendar.js'
import {
  easternToTimestamp,
  parseTimeOfDay,
  toEastern,
  tradingDaysBetween,
  type MarketDate
} from '../core/time/marketTime.js'
import { calendarDaysBetween } from '../core/time/dte.js'
import { selectCalendarStrikes, StrikeSelectionError, type ChainQuote } from './calendarStrikes.js'
import { impliedVolatility } from './optionMath.js'
import { reconstructDoubleCalendar } from './reconstructCalendar.js'
import { buildCalendarManagementSet } from './calendarExits.js'
import { simulateCalendarAll, type CalendarTradeResult } from './simulateCalendar.js'
import { createLogger } from '../services/logger.js'

const log = createLogger('calendar-study')

/**
 * Runs a double calendar study: open on a schedule, reconstruct each position
 * minute by minute, and put every one through the identical set of management
 * rules.
 *
 * Structured like `studyRunner.ts` and for the same reasons - data access
 * behind an interface, one session's failure never destroying the run, every
 * skip counted and reported rather than quietly dropped - but it is a separate
 * runner rather than a branch inside that one. The butterfly runner's core is a
 * placement rule producing three strikes on one expiration; nothing in it
 * survives contact with two expirations and a delta-selected pair of strikes,
 * so a branch would have been two runners sharing a name.
 */

export interface DoubleCalendarStudyConfig {
  underlying: string
  /** Option root; SPXW everywhere, since the AM-settled monthly stops trading early. */
  root: string
  from: MarketDate
  to: MarketDate
  /**
   * Weekdays a position may be opened on, 1 = Monday through 5 = Friday.
   * Omitted or empty means every session, which is how a rolling-entry
   * robustness check is run against the same rules.
   */
  entryWeekdays?: readonly number[]
  /** Eastern wall-clock time of the intended entry. */
  entryTime: string
  /** Minutes past the entry time an entry may drift while waiting for quotes. */
  entryWindowMinutes: number
  /** Target days to the short expiration. */
  frontTargetDte: number
  /** Target days to the long expiration. */
  backTargetDte: number
  /** Largest acceptable deviation from either target, in days. */
  maxDteDeviation: number
  /** Absolute delta targeted for both short strikes. */
  targetDelta: number
  /**
   * Eastern time on the front expiration day at which any still-open position
   * is closed. Never later than the close: carrying a double calendar into the
   * short legs' settlement makes it a different structure.
   */
  horizonTime: string
  quantity: number
  execution: CalendarExecutionAssumptions
  /** Reject a trade whose minutes could not be quoted at least this often. */
  minimumCoverage: number
  managements: readonly string[]
}

export const DEFAULT_CALENDAR_STUDY: Omit<DoubleCalendarStudyConfig, 'from' | 'to' | 'managements'> = {
  underlying: 'SPX',
  root: 'SPXW',
  entryWeekdays: [1],
  entryTime: '10:00',
  entryWindowMinutes: 30,
  frontTargetDte: 14,
  backTargetDte: 21,
  maxDteDeviation: 3,
  targetDelta: 0.3,
  horizonTime: '15:45',
  quantity: 1,
  execution: DEFAULT_CALENDAR_EXECUTION,
  minimumCoverage: 0.8
}

export interface CalendarDataSource {
  /** Expirations quoted on a given session, for the given root. */
  listExpirations(root: string, onDate: MarketDate): Promise<MarketDate[]>
  /** Every two-sided quote for one expiration at one minute. */
  chainSnapshot(
    root: string,
    expiration: MarketDate,
    onDate: MarketDate,
    minute: number
  ): Promise<ChainQuote[]>
  /** Minute bars for several contracts at once, keyed by ticker. */
  getOptionBars(
    tickers: readonly string[],
    from: MarketDate,
    to: MarketDate
  ): Promise<Record<string, OptionBar[]>>
  getUnderlyingMinutes(ticker: string, date: MarketDate): Promise<UnderlyingBar[]>
}

export interface CalendarSkip {
  date: MarketDate
  reason: string
}

export interface CalendarStudyOutcome {
  trades: CalendarTradeResult[]
  series: DoubleCalendarSeries[]
  skipped: CalendarSkip[]
  skipReasons: Record<string, number>
  sessionsConsidered: number
  elapsedMs: number
}

export interface CalendarStudyHooks {
  onProgress?: (progress: { completed: number; total: number; date: MarketDate; entries: number }) => void
  signal?: AbortSignal
}

/** Trims the variable parts out of a skip so a tally groups the same cause. */
export function normalizeCalendarSkip(reason: string): string {
  return reason
    .replace(/O:[A-Z]+\d{6}[CP]\d{8}/g, '<contract>')
    .replace(/\d{4}-\d{2}-\d{2}/g, '<date>')
    .replace(/-?\d+(\.\d+)?/g, 'N')
}

const YEAR_MS = 365 * 24 * 60 * 60 * 1000

/** Fraction of a year from an instant to an expiration's 16:00 close. */
function yearsToExpiration(from: number, expiration: MarketDate): number {
  return Math.max(1 / (365 * 24 * 60), (easternToTimestamp(expiration, 16, 0) - from) / YEAR_MS)
}

/**
 * Picks the expiration nearest a target, refusing anything past tolerance.
 *
 * Every weekday now lists an SPX expiration, so this is normally exact. It
 * still matters around holidays, where "closest to 14 days" can be a day either
 * side and a silent substitution would quietly change what is being studied.
 */
export function nearestExpiration(
  entryDate: MarketDate,
  available: readonly MarketDate[],
  targetDte: number,
  maxDeviation: number
): { expiration: MarketDate; dte: number } | null {
  let best: { expiration: MarketDate; dte: number } | null = null
  for (const expiration of available) {
    const dte = calendarDaysBetween(entryDate, expiration)
    if (dte <= 0) continue
    if (Math.abs(dte - targetDte) > maxDeviation) continue
    if (!best || Math.abs(dte - targetDte) < Math.abs(best.dte - targetDte)) {
      best = { expiration, dte }
    }
  }
  return best
}

/**
 * Sessions in the range the entry schedule selects.
 *
 * Grouped by calendar week rather than filtered by weekday, so a holiday costs
 * the week's position only if the whole week is closed. A trader whose routine
 * is "open one on Monday" opens it on Tuesday when Monday is Presidents' Day;
 * a plain weekday filter would instead drop the entry, and every dropped entry
 * falls on a holiday week, which is not a random sample.
 */
export function entrySessions(config: DoubleCalendarStudyConfig): MarketDate[] {
  const all = tradingDaysBetween(config.from, config.to)
  const weekdays = config.entryWeekdays
  if (!weekdays || weekdays.length === 0) return all

  const wanted = new Set(weekdays)
  const byWeek = new Map<string, MarketDate[]>()

  for (const date of all) {
    const eastern = toEastern(easternToTimestamp(date, 12, 0))
    const week = `${eastern.weekYear}-${String(eastern.weekNumber).padStart(2, '0')}`
    const bucket = byWeek.get(week)
    if (bucket) bucket.push(date)
    else byWeek.set(week, [date])
  }

  const chosen: MarketDate[] = []
  for (const dates of byWeek.values()) {
    const scheduled = dates.find((date) =>
      wanted.has(toEastern(easternToTimestamp(date, 12, 0)).weekday)
    )
    chosen.push(scheduled ?? dates[0]!)
  }

  return chosen.sort()
}

function buildDefinition(
  config: DoubleCalendarStudyConfig,
  front: MarketDate,
  back: MarketDate,
  putStrike: number,
  callStrike: number,
  tickers: Record<CalendarLegRole, string>
): DoubleCalendarDefinition {
  return {
    structure: 'doubleCalendar',
    underlying: config.underlying,
    root: config.root,
    frontExpiration: front,
    backExpiration: back,
    putStrike,
    callStrike,
    tickers,
    quantity: config.quantity
  }
}

export async function runDoubleCalendarStudy(
  config: DoubleCalendarStudyConfig,
  source: CalendarDataSource,
  hooks: CalendarStudyHooks = {}
): Promise<CalendarStudyOutcome> {
  if (!(config.execution.spreadFraction >= 0 && config.execution.spreadFraction <= 1)) {
    throw new Error('The spread fraction must be between 0 and 1.')
  }
  if (config.backTargetDte <= config.frontTargetDte) {
    throw new Error('The back expiration must be later than the front one.')
  }

  const managements = buildCalendarManagementSet(config.managements)
  const entryTime = parseTimeOfDay(config.entryTime)
  const horizon = parseTimeOfDay(config.horizonTime)
  const sessions = entrySessions(config)
  const indexTicker = `I:${config.underlying}`

  const trades: CalendarTradeResult[] = []
  const series: DoubleCalendarSeries[] = []
  const skipped: CalendarSkip[] = []
  const skipReasons: Record<string, number> = {}
  const startedAt = Date.now()

  for (const [index, entryDate] of sessions.entries()) {
    if (hooks.signal?.aborted) break
    hooks.onProgress?.({ completed: index, total: sessions.length, date: entryDate, entries: series.length })

    const skip = (reason: string): void => {
      skipped.push({ date: entryDate, reason })
      const key = normalizeCalendarSkip(reason)
      skipReasons[key] = (skipReasons[key] ?? 0) + 1
    }

    /*
     * One session's failure must not destroy the run. A study whose window
     * reaches the end of the archive routinely asks for days beyond it, and
     * letting that throw would discard every entry already computed.
     */
    try {
      // --- when, and at what index level ------------------------------------
      const scheduled = easternToTimestamp(entryDate, entryTime.hour, entryTime.minute)
      const indexMinutes = await source.getUnderlyingMinutes(indexTicker, entryDate)
      const byMinute = new Map(
        indexMinutes.map((bar) => [Math.floor(bar.timestamp / 60_000) * 60_000, bar.close])
      )

      let entryTimestamp: number | null = null
      let spot = 0
      for (let offset = 0; offset <= config.entryWindowMinutes; offset++) {
        const minute = scheduled + offset * 60_000
        const level = byMinute.get(minute)
        if (level !== undefined) {
          entryTimestamp = minute
          spot = level
          break
        }
      }
      if (entryTimestamp === null) {
        skip(`no ${indexTicker} level within ${config.entryWindowMinutes} minutes of ${config.entryTime}`)
        continue
      }

      // --- which two expirations --------------------------------------------
      const listed = await source.listExpirations(config.root, entryDate)
      const front = nearestExpiration(entryDate, listed, config.frontTargetDte, config.maxDteDeviation)
      if (!front) {
        skip(`no listed expiration within ${config.maxDteDeviation} days of ${config.frontTargetDte} DTE`)
        continue
      }
      const back = nearestExpiration(
        entryDate,
        listed.filter((date) => date > front.expiration),
        config.backTargetDte,
        config.maxDteDeviation
      )
      if (!back) {
        skip(`no listed expiration within ${config.maxDteDeviation} days of ${config.backTargetDte} DTE`)
        continue
      }

      // --- which two strikes -------------------------------------------------
      const [frontChain, backChain] = await Promise.all([
        source.chainSnapshot(config.root, front.expiration, entryDate, entryTimestamp),
        source.chainSnapshot(config.root, back.expiration, entryDate, entryTimestamp)
      ])
      if (frontChain.length === 0 || backChain.length === 0) {
        skip(
          `the ${frontChain.length === 0 ? front.expiration : back.expiration} chain has no quotes ` +
            'at the entry minute'
        )
        continue
      }

      /*
       * A calendar leg needs the same strike in both expirations, and SPX does
       * not list the same ladder in each - the nearer weekly carries five-point
       * strikes considerably further out than the one a week behind it. The
       * search is therefore restricted to the shared ladder up front rather
       * than picking from the front chain and discovering the mismatch after.
       */
      const backStrikes = { put: new Map<number, ChainQuote>(), call: new Map<number, ChainQuote>() }
      for (const quote of backChain) {
        if (quote.ask > quote.bid && quote.bid >= 0) backStrikes[quote.right].set(quote.strike, quote)
      }
      const shared = new Set(
        [...backStrikes.put.keys()].filter((strike) => backStrikes.call.has(strike))
      )

      let selection
      try {
        selection = selectCalendarStrikes({
          quotes: frontChain,
          spot,
          years: yearsToExpiration(entryTimestamp, front.expiration),
          targetDelta: config.targetDelta,
          allowedStrikes: shared
        })
      } catch (error) {
        if (error instanceof StrikeSelectionError) {
          skip(error.message)
          continue
        }
        throw error
      }

      const backPut = backStrikes.put.get(selection.put.strike)
      const backCall = backStrikes.call.get(selection.call.strike)
      if (!backPut || !backCall) {
        skip(
          `the ${back.expiration} chain does not quote both selected strikes ` +
            `(${selection.put.strike} put, ${selection.call.strike} call) at the entry minute`
        )
        continue
      }

      /*
       * The long legs' implied volatilities, at the same strikes. The premise of
       * a calendar is that the front month is priced richer than the back, so
       * recording both is what makes it possible to ask afterwards whether that
       * spread predicted anything.
       */
      const backYears = yearsToExpiration(entryTimestamp, back.expiration)
      const backIv = (quote: ChainQuote): number | undefined =>
        impliedVolatility(
          (quote.bid + quote.ask) / 2,
          selection.forward,
          quote.strike,
          backYears,
          selection.discountFactor,
          quote.right
        ) ?? undefined
      const putBackIv = backIv(backPut)
      const callBackIv = backIv(backCall)

      const entryContext: CalendarEntryContext = {
        spot,
        forward: selection.forward,
        discountFactor: selection.discountFactor,
        putDelta: selection.put.delta,
        callDelta: selection.call.delta,
        putIv: selection.put.impliedVolatility,
        callIv: selection.call.impliedVolatility,
        ...(putBackIv !== undefined ? { putBackIv } : {}),
        ...(callBackIv !== undefined ? { callBackIv } : {}),
        frontDte: front.dte,
        backDte: back.dte,
        tentWidth: selection.call.strike - selection.put.strike
      }

      const tickers: Record<CalendarLegRole, string> = {
        putShort: selection.put.ticker,
        putLong: backPut.ticker,
        callShort: selection.call.ticker,
        callLong: backCall.ticker
      }
      const definition = buildDefinition(
        config,
        front.expiration,
        back.expiration,
        selection.put.strike,
        selection.call.strike,
        tickers
      )

      // --- the path ----------------------------------------------------------
      const barsByTicker = await source.getOptionBars(
        Object.values(tickers),
        entryDate,
        front.expiration
      )
      const legBars = {
        putShort: barsByTicker[tickers.putShort] ?? [],
        putLong: barsByTicker[tickers.putLong] ?? [],
        callShort: barsByTicker[tickers.callShort] ?? [],
        callLong: barsByTicker[tickers.callLong] ?? []
      }

      const underlyingBars: UnderlyingBar[] = []
      for (const date of tradingDaysBetween(entryDate, front.expiration)) {
        underlyingBars.push(...(await source.getUnderlyingMinutes(indexTicker, date)))
      }

      let reconstructed: DoubleCalendarSeries
      try {
        reconstructed = reconstructDoubleCalendar({
          definition,
          legBars,
          underlyingBars,
          entryContext,
          entryTimestamp,
          entryDeadlineTimestamp: scheduled + config.entryWindowMinutes * 60_000,
          exitHorizonTimestamp: easternToTimestamp(front.expiration, horizon.hour, horizon.minute),
          execution: config.execution
        })
      } catch (error) {
        skip(error instanceof Error ? error.message : String(error))
        continue
      }

      if (reconstructed.quality.coverage < config.minimumCoverage) {
        const q = reconstructed.quality
        skip(
          `data quality ${(q.coverage * 100).toFixed(1)}% < ${(config.minimumCoverage * 100).toFixed(1)}%; ` +
            `${q.pricedMinutes}/${q.expectedMinutes} minutes quoted, longest gap ${q.longestStaleRunMinutes}m`
        )
        continue
      }

      series.push(reconstructed)
      trades.push(...simulateCalendarAll(reconstructed, managements))
    } catch (error) {
      if (hooks.signal?.aborted) break
      const message = error instanceof Error ? error.message : String(error)
      log.warn('calendar session failed', { date: entryDate, error: message })
      skip(`data request failed: ${message}`)
    }
  }

  const elapsedMs = Date.now() - startedAt
  log.info('calendar study complete', {
    sessions: sessions.length,
    entries: series.length,
    skipped: skipped.length,
    trades: trades.length,
    elapsedSeconds: Math.round(elapsedMs / 1000)
  })

  return {
    trades,
    series,
    skipped,
    skipReasons,
    sessionsConsidered: sessions.length,
    elapsedMs
  }
}
