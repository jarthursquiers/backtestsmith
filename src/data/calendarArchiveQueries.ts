import type { OptionBar } from '../domain/bars.js'
import type { MarketDate } from '../core/time/marketTime.js'
import type { ChainQuote } from '../backtest/calendarStrikes.js'

/**
 * The three queries a double calendar study asks of the local option archive.
 *
 * Written once here, against a plain query function, because two callers need
 * them and they must not drift: the application reads through its read-write
 * `MarketDataStore`, while `scripts/run-double-calendar-study.ts` opens the same
 * file read-only so a study can run while the app is open. Two copies of a
 * `QUALIFY row_number()` snapshot query is exactly the kind of duplication that
 * silently diverges and makes the app and the script disagree about what the
 * market looked like.
 *
 * All three are **cache-only**. A double calendar study needs a whole chain at
 * the entry minute and four contracts across every session of their lives;
 * served over a rate-limited API that is days of requests, so a miss here is a
 * gap in the archive to be reported, never a cue to fetch.
 */

export type QueryFn = <T>(sql: string, params: unknown[]) => Promise<T[]>

const MINUTE_SHAPE = "timespan = 'minute' AND multiplier = 1"

/**
 * Half-open ticker range covering one root and expiration.
 *
 * A `LIKE 'O:SPXW260316%'` predicate reads the same but cannot use the index on
 * `ticker`; an explicit range can, and on a table of over a billion rows that is
 * the difference between a scan and a seek.
 */
export function tickerRange(root: string, expiration: MarketDate): { low: string; high: string } {
  const compact = expiration.replace(/-/g, '').slice(2)
  const prefix = `O:${root}${compact}`
  // Every character an OCC symbol continues with sorts below '~'.
  return { low: prefix, high: `${prefix}~` }
}

/** Splits an OCC-style provider ticker into its parts. */
export function parseOptionTicker(
  ticker: string
): { root: string; expiration: MarketDate; right: 'call' | 'put'; strike: number } | null {
  const match = /^O:([A-Z]+)(\d{2})(\d{2})(\d{2})([CP])(\d{8})$/.exec(ticker)
  if (!match) return null
  const [, root, year, month, day, right, strike] = match
  return {
    root: root!,
    expiration: `20${year}-${month}-${day}`,
    right: right === 'C' ? 'call' : 'put',
    // OCC encodes the strike in thousandths of a point.
    strike: Number(strike) / 1000
  }
}

/** Expirations of one root that have cached minute bars on a session. */
export async function queryArchivedExpirations(
  query: QueryFn,
  root: string,
  onDate: MarketDate
): Promise<MarketDate[]> {
  const rows = await query<{ compact: string }>(
    `SELECT DISTINCT regexp_extract(ticker, 'O:[A-Z]+([0-9]{6})', 1) AS compact
       FROM option_bars
      WHERE ${MINUTE_SHAPE}
        AND market_date = ?
        AND ticker >= ? AND ticker < ?
      ORDER BY compact`,
    [onDate, `O:${root}0`, `O:${root}~`]
  )
  return rows
    .filter((row) => /^\d{6}$/.test(row.compact))
    .map((row) => `20${row.compact.slice(0, 2)}-${row.compact.slice(2, 4)}-${row.compact.slice(4, 6)}`)
}

/**
 * Every two-sided quote for one expiration at one minute.
 *
 * One query returns the whole chain rather than one strike at a time: the strike
 * selection needs the near-the-money band to fit the forward and a wide band to
 * search for a delta, and fetching those separately would scan the same rows
 * twice. `QUALIFY` keeps the latest quote at or before the minute per contract,
 * which is the carry-forward rule expressed in SQL rather than in a loop.
 */
export async function queryChainSnapshot(
  query: QueryFn,
  root: string,
  expiration: MarketDate,
  onDate: MarketDate,
  minute: number,
  carryMs: number
): Promise<ChainQuote[]> {
  const range = tickerRange(root, expiration)
  const rows = await query<{ ticker: string; ts: number; bid: number | null; ask: number | null }>(
    `SELECT ticker, ts, bid, ask
       FROM option_bars
      WHERE ${MINUTE_SHAPE}
        AND market_date = ?
        AND ticker >= ? AND ticker < ?
        AND ts <= ? AND ts >= ?
        AND bid IS NOT NULL AND ask IS NOT NULL
      QUALIFY row_number() OVER (PARTITION BY ticker ORDER BY ts DESC) = 1`,
    [onDate, range.low, range.high, minute, minute - carryMs]
  )

  const quotes: ChainQuote[] = []
  for (const row of rows) {
    const parsed = parseOptionTicker(row.ticker)
    if (!parsed || row.bid === null || row.ask === null) continue
    quotes.push({
      ticker: row.ticker,
      strike: parsed.strike,
      right: parsed.right,
      bid: row.bid,
      ask: row.ask,
      ageMs: minute - row.ts
    })
  }
  return quotes
}

/** Minute bars for several contracts at once, keyed by ticker. */
export async function queryOptionBarsForTickers(
  query: QueryFn,
  tickers: readonly string[],
  from: MarketDate,
  to: MarketDate
): Promise<Record<string, OptionBar[]>> {
  const result: Record<string, OptionBar[]> = {}
  for (const ticker of tickers) result[ticker] = []
  if (tickers.length === 0) return result

  const placeholders = tickers.map(() => '?').join(', ')
  const rows = await query<{
    ticker: string
    ts: number
    open: number
    high: number
    low: number
    close: number
    volume: number | null
    bid: number | null
    ask: number | null
  }>(
    `SELECT ticker, ts, open, high, low, close, volume, bid, ask
       FROM option_bars
      WHERE ${MINUTE_SHAPE}
        AND ticker IN (${placeholders})
        AND market_date BETWEEN ? AND ?
      ORDER BY ts`,
    [...tickers, from, to]
  )

  for (const row of rows) {
    const bars = result[row.ticker]
    if (!bars) continue
    bars.push({
      ticker: row.ticker,
      timestamp: row.ts,
      open: row.open,
      high: row.high,
      low: row.low,
      close: row.close,
      volume: row.volume ?? 0,
      ...(row.bid !== null ? { bid: row.bid } : {}),
      ...(row.ask !== null ? { ask: row.ask } : {})
    })
  }
  return result
}
