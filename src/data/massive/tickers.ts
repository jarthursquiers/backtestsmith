import type { OptionType, SettlementStyle } from '../../domain/contracts.js'

/**
 * OCC-style option ticker handling for Massive symbols.
 *
 * Format: O:{root}{YYMMDD}{C|P}{strike * 1000, zero-padded to 8}
 * Example: O:SPY251219C00650000  -> SPY, 2025-12-19, call, strike 650
 *
 * Project rule: prefer contract metadata returned by Massive over constructing
 * symbols locally. `parseOptionTicker` is the primary direction (validating and
 * displaying what the provider gave us); `formatOptionTicker` exists only as a
 * labelled fallback and for round-trip testing.
 */

export interface ParsedOptionTicker {
  /** Option root as encoded in the symbol, e.g. "SPX" or "SPXW". */
  root: string
  expirationDate: string
  type: OptionType
  strike: number
}

const TICKER_RE = /^O:([A-Z0-9]{1,6}?)(\d{6})([CP])(\d{8})$/

/**
 * Maps an SPX option root to its settlement style. Returns null for roots whose
 * settlement we cannot infer, so callers never assume one.
 */
export function spxSettlementForRoot(root: string): SettlementStyle | null {
  const upper = root.toUpperCase()
  if (upper === 'SPX') return 'am'
  if (upper === 'SPXW') return 'pm'
  return null
}

export function parseOptionTicker(ticker: string): ParsedOptionTicker | null {
  const match = TICKER_RE.exec(ticker.trim().toUpperCase())
  if (!match) return null

  const [, root, yymmdd, cp, strikeRaw] = match
  if (!root || !yymmdd || !cp || !strikeRaw) return null

  const year = 2000 + Number(yymmdd.slice(0, 2))
  const month = Number(yymmdd.slice(2, 4))
  const day = Number(yymmdd.slice(4, 6))
  if (month < 1 || month > 12 || day < 1 || day > 31) return null

  return {
    root,
    expirationDate: `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`,
    type: cp === 'C' ? 'call' : 'put',
    // Strike is encoded in thousandths; divide before rounding to avoid
    // floating point dust on strikes like 6002.5.
    strike: Number(strikeRaw) / 1000
  }
}

/**
 * Builds an OCC ticker. Use only when no provider metadata is available;
 * an incorrect root (SPX vs SPXW) silently yields a nonexistent contract.
 */
export function formatOptionTicker(params: {
  root: string
  expirationDate: string
  type: OptionType
  strike: number
}): string {
  const { root, expirationDate, type, strike } = params
  if (!/^\d{4}-\d{2}-\d{2}$/.test(expirationDate)) {
    throw new Error(`Invalid expiration date "${expirationDate}": expected YYYY-MM-DD`)
  }
  if (!(strike > 0)) throw new Error(`Invalid strike ${strike}`)

  const yy = expirationDate.slice(2, 4)
  const mm = expirationDate.slice(5, 7)
  const dd = expirationDate.slice(8, 10)
  const cp = type === 'call' ? 'C' : 'P'
  const strikeInt = Math.round(strike * 1000)
  if (strikeInt > 99_999_999) throw new Error(`Strike ${strike} exceeds OCC encoding range`)

  return `O:${root.toUpperCase()}${yy}${mm}${dd}${cp}${String(strikeInt).padStart(8, '0')}`
}

/** Index tickers use an `I:` prefix, verified from the Massive indices docs. */
export function indexTicker(symbol: string): string {
  const upper = symbol.trim().toUpperCase()
  return upper.startsWith('I:') ? upper : `I:${upper}`
}

export function isIndexTicker(ticker: string): boolean {
  return ticker.trim().toUpperCase().startsWith('I:')
}
