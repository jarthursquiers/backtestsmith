import type { OptionBar, UnderlyingBar } from '../domain/bars.js'
import type { OptionContract, OptionType } from '../domain/contracts.js'
import type { ButterflySeries, MissingDataPolicy, PricingAssumptions } from '../domain/butterfly.js'
import type { TradeResult } from '../shared/trade.js'
import {
  normalizeSkipReason,
  type StudyConfig,
  type StudyProgress,
  type SkippedEntry,
  type StudyPreflight
} from '../shared/study.js'
import {
  easternToTimestamp,
  parseTimeOfDay,
  tradingDaysBetween,
  type MarketDate
} from '../core/time/marketTime.js'
import { buildButterfly } from './buildButterfly.js'
import { emaDirectionStrategy, fixedDirectionStrategy, type EntryStrategy } from './entryStrategy.js'
import { candidateExpirationDates, selectExpiration } from './expirationSelection.js'
import { expectedMoveFromStraddle } from './expectedMove.js'
import { buildLegSeries, resolveLegQuote } from './legPricing.js'
import {
  expectedMovePlacement,
  fixedDistancePlacement,
  nearestStrike,
  normalizedDistancePlacement,
  type ButterflyPlacement
} from './placement.js'
import { estimateFromParity, yearsBetween } from './putCallParity.js'
import { reconstructButterfly } from './reconstruct.js'
import { simulateAll } from './simulate.js'
import { previousCompletedBar } from './indicators.js'
import { buildManagementSet } from './managementSets.js'
import { createLogger } from '../services/logger.js'

const log = createLogger('study')

/**
 * Runs a study: generate entries across a date range, reconstruct each trade,
 * and put every one through the same set of management rules.
 *
 * Data access is behind an interface so the orchestration can be tested without
 * a provider, and so the caching layer stays the caller's concern. The runner
 * itself makes no network decisions - it asks for data and reports honestly
 * about days it had to skip.
 */

export interface StudyDataSource {
  /** Daily bars for the indicator warm-up and entry-day strike selection. */
  getDailyBars(ticker: string, from: MarketDate, to: MarketDate): Promise<UnderlyingBar[]>
  /** Cached intraday bars for the underlying, if any exist. */
  getUnderlyingMinutes(ticker: string, date: MarketDate): Promise<UnderlyingBar[]>
  /** Option chain for an expiration; empty means the expiration is not listed. */
  getChain(underlying: string, expiration: MarketDate, type: OptionType): Promise<OptionContract[]>
  getOptionBars(ticker: string, from: MarketDate, to: MarketDate): Promise<OptionBar[]>
}

export interface StudyHooks {
  onProgress?: (progress: StudyProgress) => void
  signal?: AbortSignal
  /** Called for every skipped session, so callers can log as it happens. */
  onSkip?: (entry: SkippedEntry) => void
}

export { normalizeSkipReason } from '../shared/study.js'

/**
 * Checks whether a study can produce anything, before spending an hour finding
 * out that it cannot.
 */
export async function preflightStudy(
  config: StudyConfig,
  source: StudyDataSource
): Promise<StudyPreflight> {
  const sessions = tradingDaysBetween(config.from, config.to)
  const dailyBars = await source.getDailyBars(config.underlying, shiftDays(config.from, -180), config.to)

  // Sample the first few sessions rather than every one; the question is whether
  // intraday data exists at all, not exactly how much.
  let underlyingMinuteSessions = 0
  for (const date of sessions.slice(0, 10)) {
    if ((await source.getUnderlyingMinutes(config.underlying, date)).length > 0) {
      underlyingMinuteSessions++
    }
  }

  const blockers: string[] = []
  const warnings: string[] = []
  const period = config.entry.type === 'ema' ? config.entry.period : 0

  if (sessions.length === 0) {
    blockers.push(`No trading days between ${config.from} and ${config.to}.`)
  }

  if (dailyBars.length === 0) {
    blockers.push(
      `No daily ${config.underlying} bars are cached, so every session will be skipped for want of an ` +
        'indicator. Download daily underlying history on the SPX Underlying screen first.'
    )
  } else if (period > 0 && dailyBars.length < period + 1) {
    blockers.push(
      `Only ${dailyBars.length} daily bars are cached, but the ${period} EMA needs at least ${period + 1}.`
    )
  }

  if (underlyingMinuteSessions === 0) {
    warnings.push(
      'No intraday underlying data is cached at the start of this range. The index level at entry will be ' +
        'derived from put-call parity, and underlying-location rules such as centre touch cannot fire.'
    )
  }

  return {
    sessions: sessions.length,
    dailyBars: dailyBars.length,
    underlyingMinuteSessions,
    blockers,
    warnings
  }
}

export interface StudyOutcome {
  trades: TradeResult[]
  /** One reconstructed series per accepted entry, keyed by entry timestamp. */
  series: ButterflySeries[]
  skipped: SkippedEntry[]
  entriesAttempted: number
  /** Grouped skip tally, so the dominant cause is immediately visible. */
  skipReasons: Record<string, number>
  elapsedMs: number
}

function buildEntryStrategy(config: StudyConfig): EntryStrategy {
  if (config.entry.type === 'fixed') return fixedDirectionStrategy(config.entry.direction)
  return emaDirectionStrategy({
    period: config.entry.period,
    ...(config.entry.invert !== undefined ? { invert: config.entry.invert } : {}),
    ...(config.entry.minimumDistance !== undefined
      ? { minimumDistance: config.entry.minimumDistance }
      : {})
  })
}

function buildPlacement(config: StudyConfig, expectedMove: number | null): ButterflyPlacement | null {
  switch (config.placement.type) {
    case 'fixedDistance':
      return fixedDistancePlacement(config.placement.offsetPoints)
    case 'wingWidths':
      return normalizedDistancePlacement(config.placement.wingsAway)
    case 'expectedMove':
      if (expectedMove === null) return null
      return expectedMovePlacement({
        expectedMove,
        ...(config.placement.buffer !== undefined ? { buffer: config.placement.buffer } : {})
      })
  }
}

export async function runStudy(
  config: StudyConfig,
  source: StudyDataSource,
  hooks: StudyHooks = {}
): Promise<StudyOutcome> {
  const entryStrategy = buildEntryStrategy(config)
  const managements = buildManagementSet(config.managements)
  const missingData: MissingDataPolicy =
    config.pricing.missingDataMode === 'strict'
      ? { mode: 'strict' }
      : { mode: 'carryForward', maxStaleMinutes: config.pricing.maxStaleMinutes }
  const pricing: PricingAssumptions = {
    model: config.pricing.model,
    slippage: config.pricing.slippage,
    missingData
  }

  const entryTime = parseTimeOfDay(config.entryTime)
  const sessions = tradingDaysBetween(config.from, config.to)

  /*
   * Daily history starts well before the range so the EMA is warm on the first
   * entry. Without the lead-in the earliest trades would be skipped for want of
   * an indicator, quietly biasing the sample toward later dates.
   */
  const warmupStart = shiftDays(config.from, -(config.entry.type === 'ema' ? config.entry.period * 4 : 10) - 30)
  const dailyBars = await source.getDailyBars(config.underlying, warmupStart, config.to)

  const trades: TradeResult[] = []
  const series: ButterflySeries[] = []
  const skipped: SkippedEntry[] = []
  const skipReasons: Record<string, number> = {}
  const startedAt = Date.now()
  let attempted = 0

  const report = (index: number, entryDate: string, stage: string): void => {
    const elapsedMs = Date.now() - startedAt
    hooks.onProgress?.({
      phase: 'entries',
      completed: index,
      total: sessions.length,
      currentDate: entryDate,
      stage,
      tradesGenerated: series.length,
      skipped: skipped.length,
      skipReasons: { ...skipReasons },
      elapsedMs,
      // Linear extrapolation from work already done. Crude, but the dominant
      // cost is a fixed per-request wait, so it is close enough to be useful.
      ...(index > 0
        ? { estimatedRemainingMs: (elapsedMs / index) * (sessions.length - index) }
        : {})
    })
  }

  for (const [index, entryDate] of sessions.entries()) {
    if (hooks.signal?.aborted) break
    attempted++

    report(index, entryDate, 'starting')

    const skip = (reason: string): void => {
      skipped.push({ date: entryDate, reason })
      const key = normalizeSkipReason(reason)
      skipReasons[key] = (skipReasons[key] ?? 0) + 1
      hooks.onSkip?.({ date: entryDate, reason })
    }

    const entryTimestamp = easternToTimestamp(entryDate, entryTime.hour, entryTime.minute)

    // Yesterday's close picks the at-the-money strike. It is known at entry, so
    // using it introduces no look-ahead, and it avoids the circularity of
    // needing the index level to find the strike that reveals the index level.
    const previous = previousCompletedBar(dailyBars, entryDate)
    if (!previous) {
      skip('no completed daily bar before this date')
      continue
    }

    // --- choose an expiration -------------------------------------------------
    const candidates = candidateExpirationDates(
      shiftDays(entryDate, 1),
      shiftDays(entryDate, config.targetDte + (config.maxDeviation ?? 3) + 1)
    )

    const optionTypeForChain: OptionType =
      config.entry.type === 'fixed'
        ? config.entry.direction === 'bearish'
          ? 'put'
          : 'call'
        : 'put'

    report(index, entryDate, 'checking expirations')
    const listed: MarketDate[] = []
    for (const candidate of candidates) {
      if (hooks.signal?.aborted) break
      const chain = await source.getChain(config.underlying, candidate, optionTypeForChain)
      if (chain.length > 0) listed.push(candidate)
    }

    const choice = selectExpiration({
      entryDate,
      available: listed,
      targetDte: config.targetDte,
      rule: config.expirationRule,
      ...(config.maxDeviation !== undefined ? { maxDeviation: config.maxDeviation } : {})
    })
    if (!choice) {
      skip(`no listed expiration within tolerance of ${config.targetDte} DTE`)
      continue
    }

    // --- resolve the index level at entry, and the expected move -------------
    const chainForStrikes = await source.getChain(config.underlying, choice.expiration, optionTypeForChain)
    const callChain = await source.getChain(config.underlying, choice.expiration, 'call')
    const rootOk = (c: OptionContract): boolean =>
      !config.preferredRoot || (c.root ?? '').toUpperCase() === config.preferredRoot.toUpperCase()

    const putStrikes = chainForStrikes.filter(rootOk).map((c) => c.strike)
    const atmStrike = nearestStrike(previous.close, [...new Set(putStrikes)].sort((a, b) => a - b))
    if (atmStrike === null) {
      skip('no strikes listed for the chosen expiration')
      continue
    }

    const atmCall = callChain.find((c) => rootOk(c) && c.strike === atmStrike)
    const atmPut = chainForStrikes.find((c) => rootOk(c) && c.strike === atmStrike)

    let underlyingAtEntry: number | undefined
    let expectedMove: number | null = null

    const cachedMinutes = await source.getUnderlyingMinutes(config.underlying, entryDate)
    const exact = cachedMinutes.find((b) => Math.floor(b.timestamp / 60_000) * 60_000 === entryTimestamp)
    if (exact) underlyingAtEntry = exact.close

    const needsStraddle = config.placement.type === 'expectedMove' || underlyingAtEntry === undefined
    if (needsStraddle && atmCall && atmPut) {
      const [callBars, putBars] = await Promise.all([
        source.getOptionBars(atmCall.ticker, entryDate, entryDate),
        source.getOptionBars(atmPut.ticker, entryDate, entryDate)
      ])
      const legs = {
        call: buildLegSeries('lower', atmCall.ticker, callBars),
        put: buildLegSeries('upper', atmPut.ticker, putBars)
      }

      const move = expectedMoveFromStraddle(
        {
          underlyingAtEntry: previous.close,
          strike: atmStrike,
          callBars,
          putBars,
          timestamp: entryTimestamp,
          model: config.pricing.model,
          missingData
        },
        legs
      )
      if (move) expectedMove = move.points

      if (underlyingAtEntry === undefined) {
        // Fall back to a parity-derived level, which is measurably accurate
        // enough for placement even though it is not for touch detection.
        const call = resolveLegQuote(legs.call.ticker, entryTimestamp, legs.call.index, legs.call.minutes, config.pricing.model, missingData)
        const put = resolveLegQuote(legs.put.ticker, entryTimestamp, legs.put.index, legs.put.minutes, config.pricing.model, missingData)
        if (call && put) {
          const estimate = estimateFromParity(
            [{ strike: atmStrike, callPrice: call.price, putPrice: put.price, callAgeMs: call.ageMs, putAgeMs: put.ageMs }],
            { yearsToExpiry: yearsBetween(entryTimestamp, easternToTimestamp(choice.expiration, 16, 0)) }
          )
          if (estimate) underlyingAtEntry = estimate.spot
        }
      }
    }

    if (underlyingAtEntry === undefined) {
      skip('could not establish the index level at the entry minute')
      continue
    }

    // --- signal ---------------------------------------------------------------
    const signal = entryStrategy.getSignal({
      entryTimestamp,
      entryDate,
      dailyBars,
      underlyingAtEntry
    })
    if (!signal) {
      skip('entry strategy produced no signal')
      continue
    }

    // --- placement ------------------------------------------------------------
    const placement = buildPlacement(config, expectedMove)
    if (!placement) {
      skip('expected move could not be measured, so placement was impossible')
      continue
    }

    const directionalChain = await source.getChain(config.underlying, choice.expiration, signal.optionType)
    const strikes = [...new Set(directionalChain.filter(rootOk).map((c) => c.strike))].sort((a, b) => a - b)

    const placed = placement.place({ signal, availableStrikes: strikes, wingWidth: config.wingWidth })
    if (!placed) {
      skip(`placement failed: required strikes are not all listed (wing ${config.wingWidth})`)
      continue
    }

    // --- build and reconstruct -----------------------------------------------
    let definition
    try {
      definition = buildButterfly(
        {
          underlying: config.underlying,
          expiration: choice.expiration,
          optionType: signal.optionType,
          lowerStrike: placed.lowerStrike,
          centerStrike: placed.centerStrike,
          upperStrike: placed.upperStrike,
          ...(config.preferredRoot ? { preferredRoot: config.preferredRoot } : {}),
          quantity: config.quantity
        },
        directionalChain
      )
    } catch (error) {
      skip(error instanceof Error ? error.message : String(error))
      continue
    }

    report(index, entryDate, 'fetching legs')
    const [lower, center, upper] = await Promise.all([
      source.getOptionBars(definition.lowerTicker, entryDate, choice.expiration),
      source.getOptionBars(definition.centerTicker, entryDate, choice.expiration),
      source.getOptionBars(definition.upperTicker, entryDate, choice.expiration)
    ])

    const underlyingBars = await collectUnderlying(source, config.underlying, entryDate, choice.expiration)

    let reconstructed: ButterflySeries
    try {
      reconstructed = reconstructButterfly({
        definition,
        legBars: { lower, center, upper },
        underlyingBars,
        entryTimestamp,
        pricing
      })
    } catch (error) {
      skip(error instanceof Error ? error.message : String(error))
      continue
    }

    if (reconstructed.quality.coverage < config.minimumCoverage) {
      skip(
        `data quality below threshold: ${(reconstructed.quality.coverage * 100).toFixed(0)}% coverage`
      )
      continue
    }

    series.push(reconstructed)
    trades.push(...simulateAll(reconstructed, managements))
  }

  const elapsedMs = Date.now() - startedAt
  log.info('study complete', {
    sessions: sessions.length,
    entries: series.length,
    skipped: skipped.length,
    trades: trades.length,
    elapsedSeconds: Math.round(elapsedMs / 1000)
  })

  /*
   * A grouped tally, because a flat list of 57 skips hides that they share one
   * cause, while a tally makes that the first thing anyone reads.
   */
  for (const [reason, count] of Object.entries(skipReasons).sort((a, b) => b[1] - a[1])) {
    log.warn(`skipped ${count} session(s): ${reason}`)
  }

  return { trades, series, skipped, entriesAttempted: attempted, skipReasons, elapsedMs }
}

async function collectUnderlying(
  source: StudyDataSource,
  ticker: string,
  from: MarketDate,
  to: MarketDate
): Promise<UnderlyingBar[]> {
  const out: UnderlyingBar[] = []
  for (const date of tradingDaysBetween(from, to)) {
    out.push(...(await source.getUnderlyingMinutes(ticker, date)))
  }
  return out
}

/** Shifts an ISO market date by whole days, without timezone involvement. */
function shiftDays(date: MarketDate, days: number): MarketDate {
  const shifted = new Date(`${date}T00:00:00Z`).getTime() + days * 86_400_000
  return new Date(shifted).toISOString().slice(0, 10)
}
