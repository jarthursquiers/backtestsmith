import { CONTRACT_MULTIPLIER } from '../domain/butterfly.js'
import type { TradeResult } from '../shared/trade.js'
import type { EquityPoint, PositionSizing, StudyMetrics } from '../shared/metrics.js'

/**
 * Performance statistics over a set of trades.
 *
 * Deliberately reports distributions rather than single numbers wherever the
 * mean is misleading. Butterfly returns are heavily skewed - many small losses
 * against occasional large gains - so a median sits beside every average, and
 * risk-adjusted figures are labelled as per-trade ratios rather than dressed up
 * as annualized Sharpe values the sample cannot support.
 */

const REACH_THRESHOLDS = [25, 50, 100, 150, 200, 300] as const

function mean(values: readonly number[]): number {
  if (values.length === 0) return 0
  return values.reduce((s, v) => s + v, 0) / values.length
}

export function median(values: readonly number[]): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!
}

/** Sample standard deviation, using n-1. Zero for fewer than two values. */
export function standardDeviation(values: readonly number[]): number {
  if (values.length < 2) return 0
  const m = mean(values)
  const variance = values.reduce((s, v) => s + (v - m) ** 2, 0) / (values.length - 1)
  return Math.sqrt(variance)
}

/** Standard deviation of negative deviations only, for a Sortino-style ratio. */
export function downsideDeviation(values: readonly number[], target = 0): number {
  const shortfalls = values.filter((v) => v < target).map((v) => v - target)
  if (shortfalls.length === 0) return 0
  return Math.sqrt(shortfalls.reduce((s, v) => s + v * v, 0) / shortfalls.length)
}

/** Longest run of consecutive values satisfying a predicate. */
export function longestRun<T>(items: readonly T[], predicate: (item: T) => boolean): number {
  let best = 0
  let current = 0
  for (const item of items) {
    if (predicate(item)) {
      current++
      if (current > best) best = current
    } else {
      current = 0
    }
  }
  return best
}

/**
 * Scales a trade's P/L according to the sizing mode.
 *
 * `oneContract` reports the raw result of trading the structure as defined.
 * `equalRisk` normalizes every trade to risk the same dollar amount, which is
 * the fairer basis for comparing management rules: without it a cheap butterfly
 * and an expensive one contribute unequally to the equity curve purely because
 * of their debit, not because of the rule being tested.
 */
export function scaledPnl(trade: TradeResult, sizing: PositionSizing, riskPerTrade: number): number {
  if (sizing === 'oneContract') return trade.pnlDollars

  const riskDollars = trade.entryDebit * CONTRACT_MULTIPLIER * trade.definition.quantity
  if (!(riskDollars > 0)) return 0
  return trade.pnlDollars * (riskPerTrade / riskDollars)
}

/**
 * Cumulative equity, ordered by exit time.
 *
 * Ordering by exit rather than entry matters: a drawdown is only realized when
 * a trade closes, and overlapping positions would otherwise appear to resolve
 * in an order they never did.
 */
export function buildEquityCurve(
  trades: readonly TradeResult[],
  sizing: PositionSizing,
  riskPerTrade: number
): EquityPoint[] {
  const ordered = [...trades].sort((a, b) => a.exitTimestamp - b.exitTimestamp)
  const points: EquityPoint[] = []

  let equity = 0
  let peak = 0

  for (const trade of ordered) {
    equity += scaledPnl(trade, sizing, riskPerTrade)
    if (equity > peak) peak = equity
    points.push({
      timestamp: trade.exitTimestamp,
      equity,
      drawdown: equity - peak,
      peak
    })
  }

  return points
}

export interface MetricsOptions {
  sizing?: PositionSizing
  /** Dollar risk per trade under `equalRisk` sizing. */
  riskPerTrade?: number
}

/**
 * Computes the full statistics block for one management method.
 *
 * Every trade in `trades` must come from the same entry population for a
 * comparison between methods to mean anything; enforcing that is the caller's
 * job, and `simulateAll` guarantees it by construction.
 */
export function computeMetrics(
  trades: readonly TradeResult[],
  options: MetricsOptions = {}
): StudyMetrics {
  const sizing = options.sizing ?? 'oneContract'
  const riskPerTrade = options.riskPerTrade ?? 1000

  const ordered = [...trades].sort((a, b) => a.exitTimestamp - b.exitTimestamp)
  const pnls = ordered.map((t) => scaledPnl(t, sizing, riskPerTrade))
  const returns = ordered.map((t) => t.pnlPct)

  const winners = ordered.filter((_, i) => pnls[i]! > 0)
  const losers = ordered.filter((_, i) => pnls[i]! < 0)
  const winnerPnls = pnls.filter((p) => p > 0)
  const loserPnls = pnls.filter((p) => p < 0)

  const grossProfit = winnerPnls.reduce((s, p) => s + p, 0)
  const grossLoss = Math.abs(loserPnls.reduce((s, p) => s + p, 0))

  const equity = buildEquityCurve(ordered, sizing, riskPerTrade)
  const drawdowns = equity.map((p) => p.drawdown)
  const negativeDrawdowns = drawdowns.filter((d) => d < 0)

  const holdingMinutes = ordered.map((t) => t.holdingMinutes)
  const mfePcts = ordered.map((t) => t.excursions.mfe?.pct ?? 0)
  const maePcts = ordered.map((t) => t.excursions.mae?.pct ?? 0)
  const captures = ordered
    .map((t) => t.mfeCaptureRatio)
    .filter((c): c is number => c !== null)
  const givebacks = ordered.map((t) => t.profitGiveback)

  const reachedPct: Record<string, number> = {}
  for (const threshold of REACH_THRESHOLDS) {
    const reached = ordered.filter((t) => t.firstReached[String(threshold)] !== null).length
    reachedPct[String(threshold)] = ordered.length > 0 ? (reached / ordered.length) * 100 : 0
  }

  const returnStdDev = standardDeviation(returns)
  const returnDownside = downsideDeviation(returns)
  const meanReturn = mean(returns)

  return {
    totalTrades: ordered.length,
    winningTrades: winners.length,
    losingTrades: losers.length,
    winRate: ordered.length > 0 ? (winners.length / ordered.length) * 100 : 0,

    totalPnl: pnls.reduce((s, p) => s + p, 0),
    averageTrade: mean(pnls),
    medianTrade: median(pnls),
    averageWinner: mean(winnerPnls),
    averageLoser: mean(loserPnls),
    largestWinner: winnerPnls.length > 0 ? Math.max(...winnerPnls) : 0,
    largestLoser: loserPnls.length > 0 ? Math.min(...loserPnls) : 0,

    // Undefined rather than Infinity when nothing lost: a profit factor with no
    // denominator is not a large number, it is an unanswerable question.
    profitFactor: grossLoss > 0 ? grossProfit / grossLoss : null,
    expectancy: mean(pnls),

    maxDrawdown: negativeDrawdowns.length > 0 ? Math.min(...negativeDrawdowns) : 0,
    averageDrawdown: negativeDrawdowns.length > 0 ? mean(negativeDrawdowns) : 0,

    maxConsecutiveWins: longestRun(pnls, (p) => p > 0),
    maxConsecutiveLosses: longestRun(pnls, (p) => p < 0),

    averageHoldingMinutes: mean(holdingMinutes),
    medianHoldingMinutes: median(holdingMinutes),

    averageMfePct: mean(mfePcts),
    medianMfePct: median(mfePcts),
    averageMaePct: mean(maePcts),
    medianMaePct: median(maePcts),

    averageMfeCapture: captures.length > 0 ? mean(captures) : null,
    medianMfeCapture: captures.length > 0 ? median(captures) : null,
    averageProfitGiveback: mean(givebacks),

    reachedPct,

    returnStdDev,
    // Per-trade ratios, not annualized. The sample is a few hundred overlapping
    // trades, which cannot support an annualized Sharpe without overstating it.
    returnPerUnitRisk: returnStdDev > 0 ? meanReturn / returnStdDev : null,
    returnPerUnitDownside: returnDownside > 0 ? meanReturn / returnDownside : null,

    ambiguousExits: ordered.filter((t) => t.ambiguous).length,
    sizing,
    riskPerTrade: sizing === 'equalRisk' ? riskPerTrade : null
  }
}
