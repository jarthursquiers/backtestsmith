/** How trades are sized when building an equity curve. */
export type PositionSizing =
  /** Raw result of trading the structure as defined. */
  | 'oneContract'
  /** Every trade normalized to risk the same dollar amount. */
  | 'equalRisk'

export interface EquityPoint {
  timestamp: number
  equity: number
  /** Distance below the running peak; zero or negative. */
  drawdown: number
  peak: number
}

/**
 * Statistics for one management method over one entry population.
 *
 * Medians sit beside averages throughout, because butterfly returns are heavily
 * skewed and a mean alone misleads. Ratios that would divide by zero are null
 * rather than Infinity: an unanswerable question is not a large number.
 */
export interface StudyMetrics {
  totalTrades: number
  winningTrades: number
  losingTrades: number
  winRate: number

  totalPnl: number
  averageTrade: number
  medianTrade: number
  averageWinner: number
  averageLoser: number
  largestWinner: number
  largestLoser: number

  /** Gross profit over gross loss. Null when nothing lost. */
  profitFactor: number | null
  expectancy: number

  /** Most negative point of the equity curve relative to its peak. */
  maxDrawdown: number
  averageDrawdown: number

  maxConsecutiveWins: number
  maxConsecutiveLosses: number

  averageHoldingMinutes: number
  medianHoldingMinutes: number

  averageMfePct: number
  medianMfePct: number
  averageMaePct: number
  medianMaePct: number

  /** Realized over maximum unrealized profit. Null when nothing went positive. */
  averageMfeCapture: number | null
  medianMfeCapture: number | null
  averageProfitGiveback: number

  /** Percent of trades that ever reached each return threshold. */
  reachedPct: Record<string, number>

  returnStdDev: number
  /**
   * Mean return divided by its standard deviation, per trade.
   *
   * Deliberately not called Sharpe and not annualized: these are overlapping
   * trades over a short sample, and scaling to a yearly figure would overstate
   * what the data supports.
   */
  returnPerUnitRisk: number | null
  /** Same, against downside deviation only. */
  returnPerUnitDownside: number | null

  /** Exits that minute bars could not fully establish. */
  ambiguousExits: number

  sizing: PositionSizing
  riskPerTrade: number | null
}
