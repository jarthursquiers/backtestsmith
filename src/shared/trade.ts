import type { ButterflyDefinition, DataQuality } from '../domain/butterfly.js'
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

  exitTimestamp: number
  /** Value received, in price points, after exit slippage. */
  exitValue: number
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

  quality: DataQuality
}
