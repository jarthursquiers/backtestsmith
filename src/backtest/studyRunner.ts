import type { OptionBar, UnderlyingBar } from '../domain/bars.js'
import type { OptionContract, OptionType } from '../domain/contracts.js'
import type { ButterflyDefinition, ButterflySeries, MissingDataPolicy, PricingAssumptions } from '../domain/butterfly.js'
import type { TradeResult } from '../shared/trade.js'
import {
  normalizeSkipReason,
  resolveIndexTicker,
  type StudyConfig,
  type StudyProgress,
  type SkippedEntry,
  type StudyPreflight
} from '../shared/study.js'
import {
  easternToTimestamp,
  parseTimeOfDay,
  toEastern,
  tradingDaysBetween,
  type MarketDate
} from '../core/time/marketTime.js'
import { buildButterfly } from './buildButterfly.js'
import { emaDirectionStrategy, fixedDirectionStrategy, type EntryStrategy } from './entryStrategy.js'
import { candidateExpirationDates, selectExpiration } from './expirationSelection.js'
import { expectedMoveFromStraddle } from './expectedMove.js'
import { buildLegSeries, resolveLegQuote, type LegSeries } from './legPricing.js'
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
import { studyWarmupStart } from './studyPreparation.js'

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
  const indexTicker = resolveIndexTicker(config)
  const dailyBars = await source.getDailyBars(indexTicker, shiftDays(config.from, -180), config.to)

  // Sample the first few sessions rather than every one; the question is whether
  // intraday data exists at all, not exactly how much.
  let underlyingMinuteSessions = 0
  for (const date of sessions.slice(0, 10)) {
    if ((await source.getUnderlyingMinutes(indexTicker, date)).length > 0) {
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
      `No daily bars are cached for ${indexTicker}, so every session will be skipped for want of an ` +
        `indicator. Download daily history for ${indexTicker} on the SPX Underlying screen first.`
    )
  } else if (period > 0 && dailyBars.length < period + 1) {
    blockers.push(
      `Only ${dailyBars.length} daily bars are cached, but the ${period} EMA needs at least ${period + 1}.`
    )
  } else if (sessions.length > 0) {
    const sessionsWithPriorDailyBar = sessions.filter(
      (date) => previousCompletedBar(dailyBars, date) !== null
    ).length
    if (sessionsWithPriorDailyBar === 0) {
      blockers.push(
        `${dailyBars.length} daily bars are cached for ${indexTicker}, but none is dated before the first ` +
          `study session (${sessions[0]}). Every session would be skipped.`
      )
    } else if (sessionsWithPriorDailyBar < sessions.length) {
      warnings.push(
        `${sessions.length - sessionsWithPriorDailyBar} of ${sessions.length} sessions have no completed ` +
          `daily ${indexTicker} bar before entry and will be skipped.`
      )
    }
  }

  if (underlyingMinuteSessions === 0) {
    warnings.push(
      `No intraday data is cached for ${indexTicker} at the start of this range. The index level at entry ` +
        'will be derived from put-call parity, and underlying-location rules such as centre touch cannot fire.'
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
      : {}),
    ...(config.entry.meanReversionOverride !== undefined
      ? { meanReversionOverride: config.entry.meanReversionOverride }
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
  if (!Number.isFinite(config.pricing.slippage) || config.pricing.slippage < 0) {
    throw new Error('Slippage must be a non-negative number of option points.')
  }
  if (config.minimumCoverage < 0 || config.minimumCoverage > 1) {
    throw new Error('Minimum coverage must be between 0 and 1.')
  }
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
  // Index bars live under the I: convention while chains use the bare root.
  const indexTicker = resolveIndexTicker(config)

  /*
   * Daily history starts well before the range so the EMA is warm on the first
   * entry. Without the lead-in the earliest trades would be skipped for want of
   * an indicator, quietly biasing the sample toward later dates.
   */
  const warmupStart = studyWarmupStart(config)
  const dailyBars = await source.getDailyBars(indexTicker, warmupStart, config.to)

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
      recentSkips: skipped.slice(-5),
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
    const callChain = optionTypeForChain === 'call'
      ? chainForStrikes
      : await source.getChain(config.underlying, choice.expiration, 'call')
    const putChain = optionTypeForChain === 'put'
      ? chainForStrikes
      : await source.getChain(config.underlying, choice.expiration, 'put')
    const rootOk = (c: OptionContract): boolean =>
      !config.preferredRoot || (c.root ?? '').toUpperCase() === config.preferredRoot.toUpperCase()

    const cachedMinutes = await source.getUnderlyingMinutes(indexTicker, entryDate)
    const cachedByMinute = new Map(
      cachedMinutes.map((b) => [Math.floor(b.timestamp / 60_000) * 60_000, b.close])
    )

    // The actual entry-minute index is a better ATM reference than yesterday's
    // close. The latter remains a fallback for providers without index minutes.
    const strikeReference = cachedByMinute.get(entryTimestamp) ?? previous.close
    const commonStrikes = putChain
      .filter(rootOk)
      .map((c) => c.strike)
      .filter((strike) => callChain.some((c) => rootOk(c) && c.strike === strike))
    const atmStrike = nearestStrike(strikeReference, [...new Set(commonStrikes)].sort((a, b) => a - b))
    if (atmStrike === null) {
      skip('no strike has both an SPXW call and put for the chosen expiration')
      continue
    }

    const atmCall = callChain.find((c) => rootOk(c) && c.strike === atmStrike)
    const atmPut = putChain.find((c) => rootOk(c) && c.strike === atmStrike)

    let underlyingAtEntry: number | undefined
    let expectedMove: number | null = null
    /** Minute the entry is actually attributed to, which may trail the request. */
    let filledAt = entryTimestamp

    /*
     * One straddle fetch serves two purposes: expected-move placement, and
     * deriving the index level itself when no intraday index data exists.
     */
    const needsStraddle = config.placement.type === 'expectedMove' || cachedByMinute.size === 0
    let straddle: { call: LegSeries; put: LegSeries } | null = null

    if (needsStraddle && atmCall && atmPut) {
      report(index, entryDate, 'fetching at-the-money straddle')
      const [callBars, putBars] = await Promise.all([
        source.getOptionBars(atmCall.ticker, entryDate, entryDate),
        source.getOptionBars(atmPut.ticker, entryDate, entryDate)
      ])
      straddle = {
        call: buildLegSeries('lower', atmCall.ticker, callBars),
        put: buildLegSeries('upper', atmPut.ticker, putBars)
      }
    }

    /*
     * Scan forward from the entry time for the first minute where the level can
     * be established. Demanding one exact minute discards every session whose
     * prints land moments later, which on sparse data is most of them - and a
     * trader entering "around 9:35" would have filled anyway. The minute used
     * becomes the recorded entry, so nothing is misattributed.
     */
    const windowMinutes = Math.max(0, config.entryWindowMinutes ?? 15)
    for (let offset = 0; offset <= windowMinutes; offset++) {
      const minute = entryTimestamp + offset * 60_000
      let candidateUnderlying: number | undefined

      const cached = cachedByMinute.get(minute)
      if (cached !== undefined) {
        candidateUnderlying = cached
      } else if (straddle) {
        const call = resolveLegQuote(straddle.call.ticker, minute, straddle.call.index, straddle.call.minutes, config.pricing.model, missingData)
        const put = resolveLegQuote(straddle.put.ticker, minute, straddle.put.index, straddle.put.minutes, config.pricing.model, missingData)
        if (call && put) {
          const estimate = estimateFromParity(
            [{ strike: atmStrike, callPrice: call.price, putPrice: put.price, callAgeMs: call.ageMs, putAgeMs: put.ageMs }],
            { yearsToExpiry: yearsBetween(minute, easternToTimestamp(choice.expiration, 16, 0)) }
          )
          if (estimate) {
            candidateUnderlying = estimate.spot
          }
        }
      }

      if (candidateUnderlying === undefined) continue

      const candidateMove = straddle
        ? expectedMoveFromStraddle(
            {
              underlyingAtEntry: candidateUnderlying,
              strike: atmStrike,
              callBars: [],
              putBars: [],
              timestamp: minute,
              model: config.pricing.model,
              missingData
            },
            straddle
          )
        : null

      // Expected-move placement needs both the index and the straddle. Keep
      // scanning the configured entry window until both are measurable.
      if (config.placement.type === 'expectedMove' && candidateMove === null) continue

      underlyingAtEntry = candidateUnderlying
      expectedMove = candidateMove?.points ?? null
      filledAt = minute
      break
    }

    if (underlyingAtEntry === undefined && config.placement.type === 'expectedMove') {
      const hadUnderlyingInWindow = Array.from({ length: windowMinutes + 1 }, (_, offset) =>
        cachedByMinute.has(entryTimestamp + offset * 60_000)
      ).some(Boolean)
      if (hadUnderlyingInWindow) {
        const details = describeStraddleData(atmStrike, straddle, entryTimestamp, windowMinutes, config.pricing.maxStaleMinutes)
        log.warn('expected move unavailable', { date: entryDate, expiration: choice.expiration, ...details.structured })
        skip(`expected move unavailable: ${details.summary}`)
        continue
      }
    }

    if (underlyingAtEntry === undefined) {
      skip(
        windowMinutes > 0
          ? `could not establish the index level within ${windowMinutes} minutes of the entry time`
          : 'could not establish the index level at the entry minute'
      )
      continue
    }

    // --- signal ---------------------------------------------------------------
    const signal = entryStrategy.getSignal({
      entryTimestamp: filledAt,
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
      const details = describeStraddleData(atmStrike, straddle, entryTimestamp, windowMinutes, config.pricing.maxStaleMinutes)
      log.warn('expected move unavailable', { date: entryDate, expiration: choice.expiration, ...details.structured })
      skip(`expected move unavailable: ${details.summary}`)
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

    const underlyingBars = await collectUnderlying(source, indexTicker, entryDate, choice.expiration)

    let reconstructed: ButterflySeries
    try {
      reconstructed = reconstructButterfly({
        definition,
        legBars: { lower, center, upper },
        underlyingBars,
        entryTimestamp: filledAt,
        entryDeadlineTimestamp: entryTimestamp + windowMinutes * 60_000,
        requireFreshEntry: true,
        pricing
      })
    } catch (error) {
      skip(error instanceof Error ? error.message : String(error))
      continue
    }

    if ((reconstructed.quality.invalidPriceMinutes ?? 0) > 0) {
      log.warn('invalid butterfly marks rejected', {
        date: entryDate,
        expiration: choice.expiration,
        tickers: {
          lower: definition.lowerTicker,
          center: definition.centerTicker,
          upper: definition.upperTicker
        },
        invalidPriceMinutes: reconstructed.quality.invalidPriceMinutes,
        samples: reconstructed.invalidPriceSamples ?? []
      })
    }

    if (reconstructed.quality.coverage < config.minimumCoverage) {
      const sensitivity = coverageSensitivity(
        definition,
        { lower, center, upper },
        underlyingBars,
        filledAt,
        pricing,
        config.pricing.maxStaleMinutes
      )
      const q = reconstructed.quality
      const barCounts = { lower: lower.length, center: center.length, upper: upper.length }
      log.warn('entry rejected for option data quality', {
        date: entryDate,
        expiration: choice.expiration,
        tickers: {
          lower: definition.lowerTicker,
          center: definition.centerTicker,
          upper: definition.upperTicker
        },
        barCounts,
        quality: q,
        invalidPriceSamples: reconstructed.invalidPriceSamples ?? [],
        coverageSensitivity: sensitivity
      })
      skip(
        `data quality ${(q.coverage * 100).toFixed(1)}% < ${(config.minimumCoverage * 100).toFixed(1)}%; ` +
          `expiration ${choice.expiration}, strikes ${definition.lowerStrike}/${definition.centerStrike}/${definition.upperStrike}: ` +
          `${q.pricedMinutes}/${q.expectedMinutes} minutes priced, fresh ${q.freshMinutes}, stale ${q.staleMinutes}, ` +
          `unpriced ${q.unpricedMinutes}, longest gap ${q.longestStaleRunMinutes}m; ` +
          `invalid synthetic prices ${q.invalidPriceMinutes ?? 0}; ` +
          `bars L/C/U ${barCounts.lower}/${barCounts.center}/${barCounts.upper}; ` +
          `missing L/C/U ${q.missingByLeg.lower}/${q.missingByLeg.center}/${q.missingByLeg.upper}; ` +
          `coverage sensitivity ${sensitivity.map((s) => `${s.maxStaleMinutes}m=${(s.coverage * 100).toFixed(1)}%`).join(', ')}`
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

function describeStraddleData(
  strike: number,
  straddle: { call: LegSeries; put: LegSeries } | null,
  entryTimestamp: number,
  windowMinutes: number,
  maxStaleMinutes: number
): { summary: string; structured: Record<string, unknown> } {
  const windowEnd = entryTimestamp + windowMinutes * 60_000
  const describe = (series: LegSeries | undefined): { bars: number; first: string | null; last: string | null } => ({
    bars: series?.minutes.length ?? 0,
    first: series?.minutes[0] !== undefined ? toEastern(series.minutes[0]).toFormat('HH:mm') : null,
    last: series?.minutes.at(-1) !== undefined ? toEastern(series.minutes.at(-1)!).toFormat('HH:mm') : null
  })
  const call = describe(straddle?.call)
  const put = describe(straddle?.put)
  const start = toEastern(entryTimestamp).toFormat('HH:mm')
  const end = toEastern(windowEnd).toFormat('HH:mm')
  return {
    summary:
      `strike ${strike}, window ${start}-${end}, carry ${maxStaleMinutes}m; ` +
      `call bars ${call.bars} (first ${call.first ?? 'none'}, last ${call.last ?? 'none'}), ` +
      `put bars ${put.bars} (first ${put.first ?? 'none'}, last ${put.last ?? 'none'})`,
    structured: { strike, windowStart: start, windowEnd: end, maxStaleMinutes, call, put }
  }
}

function coverageSensitivity(
  definition: ButterflyDefinition,
  legBars: { lower: readonly OptionBar[]; center: readonly OptionBar[]; upper: readonly OptionBar[] },
  underlyingBars: readonly UnderlyingBar[],
  entryTimestamp: number,
  pricing: PricingAssumptions,
  configuredMaxStale: number
): { maxStaleMinutes: number; coverage: number }[] {
  const tolerances = [...new Set([configuredMaxStale, 15, 30, 60])].sort((a, b) => a - b)
  return tolerances.flatMap((maxStaleMinutes) => {
    try {
      const series = reconstructButterfly({
        definition,
        legBars,
        underlyingBars,
        entryTimestamp,
        pricing: {
          ...pricing,
          missingData: { mode: 'carryForward', maxStaleMinutes }
        }
      })
      return [{ maxStaleMinutes, coverage: series.quality.coverage }]
    } catch {
      return []
    }
  })
}

/** Shifts an ISO market date by whole days, without timezone involvement. */
function shiftDays(date: MarketDate, days: number): MarketDate {
  const shifted = new Date(`${date}T00:00:00Z`).getTime() + days * 86_400_000
  return new Date(shifted).toISOString().slice(0, 10)
}
