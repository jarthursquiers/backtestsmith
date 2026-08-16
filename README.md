# Backtestsmith

A local desktop research application for studying historical SPX butterfly option trades.

The central research question it exists to answer:

> Given a consistent method for entering approximately 7-DTE SPX butterflies,
> what management method produces the best risk-adjusted results?

This is a research tool, not a trading platform and not an optimizer for finding
the prettiest historical result.

## Status

Built in verifiable phases. **Phases 1 and 2 are complete.**

| Phase | Scope | State |
| --- | --- | --- |
| 1 | Electron + React + TypeScript skeleton, routing, settings, secure API key | Done |
| 2 | Massive API client, rate limiter, contract lookup, minute aggregates, dev UI | Done |
| 3 | Local cache (DuckDB) so backtests never re-call Massive | Done |
| 4 | SPX underlying history via CSV import (`I:SPX` not entitled) | Mechanism done, data not yet loaded |
| 5 | Single butterfly reconstruction, minute by minute | Planned |
| 6 | Single-trade management rules | Planned |
| 7 | Automated entry generation (9 EMA, 7 DTE, placement) | Planned |
| 8 | Batch backtester and summary statistics | Planned |
| 9 | Management comparison and equity curves | Planned |
| 10 | MFE / MAE / conditional path analytics | Planned |
| 11 | Generic parameter sweep | Planned |
| 12 | Polish, exports, diagnostics, performance | Planned |

## Getting started

```bash
npm install
npm run dev
```

Then open **Data**, paste a Massive API key, and press **Test connection**.
Get a key at <https://massive.com/dashboard/keys>.

For development you can instead set the key in the environment; it takes
precedence over any stored key:

```bash
# .env is git-ignored
MASSIVE_API_KEY=your-key-here
```

### Commands

| Command | Purpose |
| --- | --- |
| `npm run dev` | Launch with hot reload |
| `npm run build` | Typecheck both projects and build all bundles |
| `npm test` | Run the engine test suite |
| `npm run typecheck` | Typecheck main and renderer projects |
| `npm run package` | Produce an unpacked Windows build |

## Architecture

The research engine is deliberately separated from the UI. All data access and,
in later phases, all backtesting run in the Electron **main** process; the React
renderer holds no research logic and cannot reach Massive or the filesystem
directly.

```
src/
  domain/      Provider-agnostic models (OptionContract, OptionBar, ...)
  core/time/   Eastern-time market calendar, sessions, DTE
  data/        Provider abstraction and the rate-limited request queue
    massive/   The only place that knows Massive's API shape
  services/    Logging, settings, encrypted secrets
  shared/      Contracts that cross the IPC boundary
  electron/    Main process, preload bridge, IPC handlers
  ui/          React renderer: pages, components, charts
  renderer/    Vite entry HTML
```

Three rules hold this together:

1. **Nothing above `data/provider.ts` knows Massive exists.** Adding a second
   provider, or a CSV importer, must not touch the backtest engine.
2. **The renderer imports only from `shared/`, `domain/`, and `core/`.** It never
   reaches into engine or main-process modules.
3. **Every simulated timestamp is explicit.** Nothing consults a wall clock, which
   is what makes look-ahead bias detectable by tests.

## Data correctness notes

These are the assumptions the engine is built around. They matter more than any
feature in this codebase.

**A missing bar is not a zero price.** Massive minute aggregates are derived from
qualifying trades. A minute with no trade produces no bar at all. The provider
reports this as `empty`, never as a synthetic zero, and Phase 3 onward will apply
an explicit missing-data policy with a per-trade data-quality score.

**Aggregates are not quotes.** These are trade-derived OHLCV bars, not historical
NBBO. Results computed from them are estimates, not guaranteed executable fills,
and are labelled as such.

**Calendar DTE and trading DTE are different numbers.** They are computed and
stored separately. A 7-calendar-day butterfly entered 2025-06-13 is only 4
trading sessions, because Juneteenth closes the market. DTE is never computed by
subtracting raw timestamps.

**Eastern time is the only time.** Provider timestamps arrive as UTC epoch
milliseconds; every market decision converts through `core/time`, which handles
DST transitions, weekends, holidays, ad-hoc closures, and 1:00 PM half sessions.

**SPX and SPXW settle differently, and both exist at the same strike.** Standard
monthly SPX is AM-settled and stops trading at the Thursday close; SPXW weeklies
are PM-settled on Friday. On third-Friday monthly expirations *both roots are
listed at every strike* - verified against live data for 2025-06-20, which
returned 970 SPX/AM and 946 SPXW/PM contracts, including two distinct 5875 puts:

```
O:SPX250620P05875000    root=SPX   settlement=am
O:SPXW250620P05875000   root=SPXW  settlement=pm
```

Selecting a butterfly leg by strike alone is therefore ambiguous on those dates
and can silently pick an AM-settled monthly that stops trading a day early. The
provider decodes the root and records settlement on every contract so leg
selection can disambiguate. Near-the-money SPXW strikes are spaced 5 points
apart, so every candidate wing width from 10 to 50 is constructible.

## Local cache

Downloaded data is stored in DuckDB under the configured data directory and
reused indefinitely. Massive is called only for ranges the cache has never been
asked about, which is what makes the research loop viable: at five calls per
minute, re-fetching a three-leg butterfly on every run would cost roughly 36
seconds per trade.

Two storage conventions exist to make timezone bugs impossible rather than
merely unlikely:

- **Market dates are ISO `YYYY-MM-DD` strings, always Eastern** - never DATE
  columns, because each DATE round-trip risks an implicit UTC shift.
- **Timestamps are BIGINT epoch milliseconds, UTC.** Conversion to Eastern
  happens once, in `core/time`, never in SQL.

### The coverage ledger

`bar_coverage` records, per (ticker, date, bar shape), that the provider *was
asked* and how many bars came back. This is what distinguishes "never
requested" from "requested, and the contract genuinely had no qualifying
trades". Both look identical in a bars table - zero rows - so without the ledger
every silent day would be re-requested forever. A row with `bar_count = 0` is a
positive assertion of emptiness. `contract_coverage` does the same for option
chains.

Because of this, a contract that never traded costs exactly one request, ever.

### Caching strategy

- Contract chains are fetched **whole** for an expiration, ignoring the caller's
  strike filters, then filtered locally. A partial chain behind a "covered"
  marker would be a lie, and butterfly construction needs many strikes anyway.
- Bar gaps are batched into **one request per contiguous run of missing trading
  days**, not one per day. A 7-DTE contract's entire life is ~2,700 minute bars,
  far under the 50,000 limit, so its full history costs a single call.
- Writes are delete-then-insert per day inside a transaction, so re-downloading
  a day is idempotent.
- Weekends and holidays are never fetched and never recorded as gaps.

## SPX underlying data

**Massive's Options plans do not include index data.** A request for `I:SPX`
returns:

```
HTTP 403 - You are not entitled to this data. Please upgrade your plan.
```

CSV import is therefore the primary acquisition path for SPX, not a fallback.
The Massive index path remains implemented and isolated, so upgrading the plan
would enable it with no code changes.

The importer auto-detects delimiter and column mapping, accepts ISO, US-style,
and epoch timestamps, and tolerates thousands separators and quoted fields. Two
behaviors matter for correctness:

- **Naive timestamps are interpreted in a zone the user states explicitly**
  (Eastern by default), because platform exports rarely carry an offset and
  guessing would silently shift every bar.
- **Rows that cannot be true are rejected, not repaired.** A bar whose high is
  below its low or outside its open/close is skipped and reported with its line
  number, since fabricating a correction would corrupt research silently.

Every import is previewed before anything is written, showing the parsed
timestamps in Eastern time so the zone interpretation can be confirmed by eye.

## Massive API integration

Endpoints and conventions verified against the official documentation, not
guessed:

| Item | Value | Source |
| --- | --- | --- |
| Base URL | `https://api.massive.com` | `massive-com/client-python` |
| Auth | `Authorization: Bearer <key>` | `massive-com/client-python` |
| Contracts | `GET /v3/reference/options/contracts` | [docs](https://massive.com/docs/rest/options/contracts/all-contracts) |
| Aggregates | `GET /v2/aggs/ticker/{ticker}/range/{multiplier}/{timespan}/{from}/{to}` | [docs](https://massive.com/docs/rest/options/aggregates/custom-bars) |
| Pagination | `next_url` on the response body | [docs](https://massive.com/docs/rest/options/contracts/all-contracts) |
| Contracts page size | max 1000 | as above |
| Aggregates page size | max 50000, default 5000 | as above |
| Timestamps | Unix epoch milliseconds | as above |
| Index tickers | `I:` prefix, e.g. `I:SPX` | [docs](https://massive.com/docs/rest/indices/aggregates/custom-bars) |
| Option tickers | OCC format, e.g. `O:SPY251219C00650000` | client-python example |

Responses are validated with zod. A schema mismatch is raised and logged as a
diagnostic rather than coerced away, so a discrepancy between documentation and
actual behavior surfaces instead of silently corrupting research data.

### Rate limiting

The free Options Basic plan allows roughly 5 calls per minute. Every request in
the application flows through one shared queue that enforces a sliding
60-second window, retries HTTP 429 (honoring `Retry-After`), 5xx, and transient
network faults with exponential backoff and jitter, and can be paused, resumed,
and cancelled from the UI. The limit is a setting, so upgrading the plan is a
configuration change rather than a code change.

### API key handling

The key is encrypted with Electron's `safeStorage`, which uses the OS keystore
(DPAPI on Windows). It is never written to `settings.json`, never returned to the
renderer, and redacted from all log output. If OS encryption is unavailable the
app refuses to save rather than silently writing plaintext.

## Tests

```bash
npm test
```

The suite covers the pieces where silent errors are most costly: Eastern-time
conversion across both DST boundaries, the holiday and half-session calendar,
calendar-vs-trading DTE, OCC ticker round-tripping, rate-limit pacing, retry and
backoff behavior, and provider normalization including the missing-bar case.
