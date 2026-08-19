import type {
  ButterflyDefinition,
  ButterflyPriceAudit,
  DataQuality,
  InvalidButterflyPrice
} from '../domain/butterfly.js'
import type { Excursions } from './excursions.js'

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

/** One completed trade under one management method. */
export interface TradeResult {
  definition: ButterflyDefinition
  strategyId: string
  strategyLabel: string

  entryTimestamp: number
  entryUnderlying?: number
  /** Net debit paid, in price points, including entry slippage. */
  entryDebit: number
  /** Optional for compatibility with studies saved before price auditing existed. */
  entryAudit?: ButterflyPriceAudit
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
  exitAudit?: ButterflyPriceAudit
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
  invalidPriceSamples?: InvalidButterflyPrice[]
}
