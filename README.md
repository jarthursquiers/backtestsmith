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
| 5 | Single butterfly reconstruction, minute by minute | Done |
| 6 | Single-trade management rules | Done |
| 7 | Automated entry generation (9 EMA, 7 DTE, placement) | Done |
| 8 | Batch backtester and summary statistics | Done |
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

## Butterfly reconstruction

A butterfly's value at any minute is computed from its three legs:

```
value = lower - 2 x center + upper
```

This is the *long* butterfly convention: long one lower strike, short two center
strikes, long one upper. The result is the net debit, bounded below by zero and
above by the wing width, which is what makes the position defined-risk. The
arithmetic is identical for the call and put variants; only the strike selection
relative to the underlying differs.

P/L is measured against the entry debit, so a percentage return is also a
percentage of risk.

### Choosing the legs

Selecting a leg by strike alone is ambiguous on third-Friday expirations, where
SPX lists both the AM-settled monthly and the PM-settled weekly at every strike.
The builder therefore **refuses to guess**: an ambiguous strike is an error
naming the available roots, an explicitly requested root is honored or refused
but never substituted, and legs that do not share a settlement style are
rejected outright.

### Missing data

A butterfly cannot be marked unless all three legs have a price in the same
minute, and for the out-of-the-money wings this study uses, silent minutes are
common. Two policies are available:

- **Strict** - only minutes where all three legs traded produce an observation.
- **Carry forward** - the last observed price may be reused for a configurable
  number of minutes, after which the minute goes unpriced.

No value is ever interpolated or invented. A minute that cannot be priced
produces no observation and is counted against the trade's data quality instead.
Every trade therefore carries coverage (minutes priced), freshness (minutes where
all three legs actually traded), the longest consecutive gap, and per-leg absent
counts, so results can be filtered on quality rather than trusted blindly.

## Derived SPX from put-call parity

When index data is unavailable, the index level can be derived from option
prices already owned. For European options, with D the discount factor and F the
forward:

```
C - P = D * (F - K)
```

This is an identity, not a model. Two things follow that are easy to get wrong:

- **It yields the forward, not spot.** Converting needs a carry rate:
  `S = F * e^(-(r-q)T)`. At 7 DTE with r-q near 3% the forward sits about 3.5
  points above spot on a 6000 index, decaying to zero at expiration - so
  ignoring it adds a *drift* that imitates market movement rather than a
  harmless constant offset. With three or more strikes, regressing `C - P` on
  `K` recovers both D and F with no rate assumption at all.
- **Stale legs dominate the error.** At the money the call and put deltas are
  about +0.5 and -0.5, so `d(C-P)/dS` is about 1.0: every point the index moves
  between the two legs' prints becomes a point of error, one for one.

Rather than argue about whether that is good enough, the app measures it. The
SPX Underlying screen compares parity-derived levels against real cached index
minutes and reports bias, RMS, and percentile errors **bucketed by leg
staleness**, plus a carry rate fitted from the data. A large raw bias that
collapses after calibration is a fixable rate assumption; what remains is the
irreducible noise that decides whether parity can support center-touch rules or
only strike placement.

## Entry generation

Entry signal, expiration selection, and placement are separate modules, so one
entry population can be held fixed while management varies - and so a placement
method can be swapped without touching the signal.

### Look-ahead prevention

The rule that governs everything here: **a daily candle does not exist until its
session closes.** A trade entered at 9:35 on Tuesday cannot use Tuesday's daily
bar, which is six and a half hours from being written.

Indicators therefore take the date being traded and discard any bar dated on or
after it, unconditionally. Passing full history is safe by construction rather
than by discipline, and the property is asserted directly: the EMA for a date
must not change when later bars are appended, including absurd ones. The entry
price itself *is* observable at 9:35, so comparing live price against an average
computed through last night's close is what a trader could actually have acted
on.

### Expiration selection

Target DTE with `nearest`, `preferGte`, or `preferLte`, an optional maximum
deviation, and ties broken toward the longer-dated contract. Expirations on or
before the entry date are never selected. Calendar and trading DTE are both
reported and never conflated.

### Placement

Fixed distance, distance in wing widths, and near-wing-outside-the-expected-move.
All resolve to strikes the chain actually lists: if a wing is unlisted the
placement **fails rather than substituting a nearby strike**, since a silently
narrowed wing changes the risk, the maximum value, and every normalized distance
derived from it.

Expected-move placement requires the move to be supplied from measured data. It
is deliberately not estimated internally, because deriving it needs an
at-the-money straddle price at the entry minute.

## Reproducibility

Every run stores its configuration verbatim: date range, entry time, signal,
expiration rule, placement, wing width, pricing model, slippage, missing-data
policy, coverage threshold, and the application version and git commit. A result
that cannot be traced to the assumptions that produced it is not reproducible,
and these numbers are intended to be discussed publicly.

Summaries are **recomputed on load** rather than stored, so a later change to a
metric definition applies to historic runs instead of freezing an old
interpretation alongside the trades.

## Study metrics

Statistics report distributions rather than single numbers wherever a mean would
mislead. Butterfly returns are heavily skewed - many small losses against
occasional large gains - so a **median sits beside every average**, and a study
where the mean trade is positive while the median is negative is telling you
something a single figure would hide.

Two deliberate choices:

- **Ratios that would divide by zero are null, not Infinity.** A profit factor
  with no losses is an unanswerable question, not a large number.
- **Risk-adjusted figures are per-trade ratios, not annualized Sharpe.** The
  sample is a few hundred overlapping trades over a short window; scaling to a
  yearly figure would overstate what the data supports, so they are named
  `returnPerUnitRisk` and `returnPerUnitDownside` instead.

Equity curves order by **exit** rather than entry, since a drawdown is realized
when a trade closes. Both one-contract and equal-risk sizing are supported;
equal-risk is the fairer basis for comparing management rules, because otherwise
a cheap butterfly and an expensive one contribute unequally purely through their
debit rather than through the rule being tested.

## Management rules

Exit strategies are a composable rule engine rather than a fixed list, because
the research question is *which management method wins*, and that comparison is
only valid if every rule is evaluated identically against the same entries.

Available: hold to expiration, fixed profit target, fixed stop, target+stop,
time exit (calendar or trading DTE), center-strike touch, tent entry at a
normalized distance, and trailing profit. Trailing supports both give-back as a
*fraction of peak profit* and give-back in *percentage points from the peak* -
these are genuinely different rules, not two spellings of one.

Rules compose with `combine`, and many rules run against a single reconstructed
series via `simulateAll`, which is the guarantee that no management method ever
sees a different entry population.

### Execution semantics

Minute bars cannot reveal the order of events inside a minute, and the engine
never pretends otherwise:

- **Fills are at the threshold, not the overshoot.** A path that leaps from 2.20
  to 5.00 through a 4.00 target fills at 4.00. Filling at the mark would credit
  the strategy with a gap it never had to earn.
- **A trigger reachable intra-minute but unconfirmed by the mark is reported as
  `ambiguous`.** Reachability is judged against bounds derived from the legs'
  bars. Those bounds are deliberately wider than the butterfly's true range -
  the three legs hit their own extremes at different instants, so no combination
  of leg OHLC recovers the real path - which makes them sound for "could this
  have been touched" and unsound for anything else.
- **When opposing rules are both reachable in the same minute, the adverse one
  is taken** and the result is flagged ambiguous. The engine never silently
  chooses the favorable outcome.
- **Excursions are measured over the held portion only**, so a rule is never
  credited or penalised for a path it exited before.

## SPX underlying data

**Index data is a separate Massive subscription from options.** Without it,
`I:SPX` returns:

```
HTTP 403 - You are not entitled to this data. Please upgrade your plan.
```

This is an entitlement boundary, not a history limit. Massive sells each asset
class independently, and the free **Indices Basic** tier includes minute
aggregates over roughly one year, though it covers a limited set of tickers.

Three sources are supported, all writing into the same local cache:

| Source | History | Notes |
| --- | --- | --- |
| Massive Indices | ~1 year (Basic) | Same API key; needs an Indices subscription |
| Schwab | daily: years; **minute: ~1 month** | Minute history is too shallow for this study |
| CSV import | whatever the file holds | Always available |

Schwab daily was verified complete: 499 sessions returned for 2024-08-19 to
2026-08-14, exactly matching what the trading calendar predicts. Schwab minute
history proved to be about a month, so it cannot drive a year-long study on its
own.

Effective study window is the intersection of what each source covers: options
run two years on Options Basic, so the index source is normally the binding
constraint.

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
