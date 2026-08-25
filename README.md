# Backtestsmith

A local desktop research application for studying historical SPX option trades.

The central research question it exists to answer:

> Given a consistent method for entering a position, what management method
> produces the best risk-adjusted results?

The first entry method studied was a 9 EMA rule at approximately 7 DTE on a
butterfly. Entry methods are now a catalogue - see [Strategies](#strategies) -
so the same question can be asked of a 0DTE opening range breakout, or of
anything added later, against an identical set of exit rules. A second
structure, the [double calendar](#double-calendars), is studied by a parallel
engine that shares the statistics but not the assumptions.

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
| 9 | Management comparison and equity curves | Done |
| 10 | MFE / MAE / conditional path analytics | Done |
| 11 | Generic parameter sweep | Done |
| 12 | Exports, analytics charts, diagnostics | Done |
| 13 | Strategy catalogue, signal-triggered entries, 0DTE opening range breakout | Done |
| 14 | Double calendar engine and study, run off the local quote archive | Done |

## Getting started

```bash
npm install
npm run dev
```

Then open **Data**, paste a Massive API key, and press **Test connection**.
Get a key at <https://massive.com/dashboard/keys>.

For quote-quality option pricing, install the official ThetaData client once:

```powershell
py -3.12 -m pip install -r requirements-thetadata.txt
```

Then paste the ThetaData Options Value API key into **Data → ThetaData option
quotes** and press **Test ThetaData**. `Run Study` automatically replaces
trade-derived option bars with one-minute NBBO bid/ask quotes when a required
day is not already cached from ThetaData. Option roots, expirations, and strikes
also come from ThetaData; Massive is retained only for SPX cash-index history. The key is encrypted with the Windows
keystore and is never written to the database or logs.

To preserve a research universe before ending a ThetaData subscription, use
**Data → Archive SPX options for offline research**. The archive enumerates both
SPX and SPXW contracts and stores every one-minute NBBO contract-day usable by
an entry between 0 and 60 calendar DTE. It fetches a complete root/expiration
session at a time, records contracts with no quotes as confirmed empty, and is
safe to pause and resume. Resume checks the coverage ledger first and makes no
API request for a block already archived by ThetaData. You can leave the Data
screen and return without losing the Pause control. After it finishes, enable **Offline only** on Run
Study to prove a strategy uses DuckDB exclusively. Back up the database from
Settings before removing provider access.

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
| `npm run study:calendar` | Run the double calendar study off the local archive |

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

The selected policy also applies at entry. In carry-forward mode, a package may
therefore fill at 09:36 from leg quotes observed at 09:35/09:36/09:35, provided
the configured age limit permits it. The entry is recorded at 09:36, with every
leg's original timestamp and age preserved; a future quote is never assigned to
an earlier fill. Strict mode continues to require all three quotes in the same
minute.

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

## Strategies

A **strategy** is an entry method plus a structure: when to get in, which way,
which expiration, and where the butterfly sits. Exits are deliberately *not*
part of a strategy - the whole research programme is to run one entry population
against every management rule at once, and folding an exit into a strategy would
beg the question the app exists to answer.

Strategies are declared in `src/shared/strategyCatalog.ts`, which exposes each
one's parameters as data. The Run Study and Parameter Sweep screens render that
declaration, so **adding a strategy is one entry in that file** and no UI work.
The shipped set:

| Strategy | Entry | Expiration |
| --- | --- | --- |
| EMA swing butterfly, VIX-scaled width | Price against a daily EMA, with the wing width set by VIX | Target DTE, default 7 |
| Weekly 45 DTE EMA butterfly | Once weekly; calls just above ATM when SPX is above its daily 9 EMA, puts just below when it is below | Nearest listed expiration to 45 DTE |
| EMA direction 0DTE butterfly | Price against a daily EMA at a fixed morning time | Same session |
| Opening range breakout 0DTE butterfly | First candle to close outside the session's opening range | Same session |
| EMA direction swing butterfly | Price against a daily EMA at a fixed time | Target DTE, default 7 |
| Fixed-time 0DTE butterfly | A set time, always one side. A control for the signal-driven studies | Same session |

The weekly 45 DTE preset defaults to Monday entries (shifting to the nearest
open session on holiday weeks), a centre 25 SPX points from the live index, and
50-point symmetrical wings. Its default comparison is hold-to-expiration versus
profits of +200%, +300%, and +500% of the entry debit. Centre offset and wing
width remain sweepable so the result can be tested for robustness around those
starting values.

The two 0DTE strategies place identical structures and differ only in how they
choose the side and the minute, which is what makes them directly comparable:
run both over one range and any difference is attributable to the signal rather
than to the trade construction.

Every run stores `strategyId` and the parameter values it was built from, so a
stored result can say what it was rather than leaving a reader to infer intent
from a scattering of numbers. Parameters the chosen placement does not consult
are dropped rather than recorded, so a config never implies a value the run
never used.

### Volatility-scaled wing width

Any strategy can set its wing width from a volatility gauge instead of fixing
it. The width is chosen per entry from bands over the gauge - by default 20
points below VIX 17, 30 from 17 to 32, and 45 above - and the shipped
**EMA swing butterfly, VIX-scaled width** is the 7 DTE study with that mode
already selected.

This is not the same question a wing-width sweep asks. A sweep asks which single
width was best over the sample; a banded rule asks whether adapting the width to
conditions beats any single width, and no number of swept values answers that.

Bands are half-open and the last is unbounded, so every possible reading lands in
exactly one band: `below: 17` means the 20-wide band covers everything under 17
and a reading of exactly 17 belongs to the next band up. An invalid list - gapped,
out of order, or with a bounded final band - fails the run rather than sizing
some trades by a rule nobody wrote.

The gauge is read at the entry minute, which is observable then. A missing
reading carries forward from earlier in the same session, then falls back to the
**previous** session's close; the entry day's close is never consulted, since
that would be hours of hindsight applied to the size of every trade. A session
with no reading at all is skipped rather than traded at a nominal width, because
a run labelled VIX-scaled must not quietly contain trades that were not.

The gauge ticker is a parameter rather than derived, since the cache is keyed by
whatever name the data was imported under and guessing wrong would skip every
session for a reason that looks like missing history. Each trade records the
gauge level beside the width it produced, and both reach the trade CSV as
`gauge_level` and `wing_width`.

### EMA direction, 0DTE

Compare SPX at the entry time against a daily EMA built only from sessions that
had already closed. **Above the average takes a bullish upside call butterfly;
below it takes a bearish downside put butterfly.** The near wing sits at the
edge of the expected move, and the structure expires the same session.

Unlike the breakout rule there is no trigger to wait for, so every session with
a signal is traded and nothing is skipped for want of one. It also needs no
intraday index bars: the EMA is built from daily closes and the entry level
falls back to put-call parity, so it runs over any range with daily history.

Two knobs are worth the attention:

- **Minimum distance from the EMA** (default 0, meaning trade every session).
  Early in the session price sits close to the previous close, so on days the
  index is resting on the average the side is close to a coin flip. A positive
  value sits those days out.
- **Direction** can be inverted, for the same reason the breakout rule can be
  faded: a butterfly pays where price *stops*, not where it goes, so "above the
  EMA is bullish" and "above the EMA is bearish" are both defensible readings
  and the data should settle it.

The default entry time is 09:35, matching the swing study's convention rather
than the breakout study's median entry near 09:55. If the two 0DTE studies are
being compared directly, set them to the same clock time first.

### Opening range breakout, 0DTE

Mark the high and low of the session's opening range (default: the first 15
minutes). Once it closes, watch each following candle (default: 5 minutes). The
first to **close** below the range takes a bearish butterfly; the first to close
above takes a bullish one. A wick through the level is not a signal - that is
the point of waiting for a candle to complete.

Entry is the minute bar *after* the confirming candle closed. A candle covering
09:45-09:49 has not closed until 09:50:00, so 09:50 is the earliest bar a trader
could act on; attributing the entry to the candle's own last bar would hand the
strategy a minute of hindsight on every trade.

The near wing is placed at the expected move, measured from the at-the-money
straddle at entry. Direction can be **faded** rather than followed: a butterfly
is a bet on where price *stops*, so both readings of the signal are worth
measuring, and which is right is a research question rather than an assumption.

The rule needs real intraday index bars and refuses to run without them. Where
a single entry-minute *level* can be recovered from put-call parity, an opening
range is a claim about a whole window of the session, and reconstructing that
from option prints would be inventing the signal rather than measuring it. The
preflight blocks such a run outright.

The **breakout cutoff** (default 12:00 ET) is a deliberate imposition, not part
of the rule as stated: a midday break of the opening range is a different
phenomenon from an opening drive, and a 0DTE butterfly entered near the close is
not the same trade. It is a parameter, so widen or tighten it as the research
requires.

## Entry generation

Entry signal, expiration selection, and placement are separate modules, so one
entry population can be held fixed while management varies - and so a placement
method can be swapped without touching the signal.

Most rules enter at a configured clock time. A signal-triggered rule instead
implements `resolveEntryTiming`, choosing its own minute from that session's
intraday bars and reporting a reason when there is no trade to take. The runner
resolves that before fetching any option chain, so a session with no signal
costs nothing.

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
deviation, and ties broken toward the longer-dated contract. Calendar and
trading DTE are both reported and never conflated.

Expirations before the entry date are never selected, and the entry date itself
only when the caller passes `allowSameDay` - which the runner does for a 0DTE
study and nothing else. A same-day expiration is a different instrument with
different risk: for a DTE-targeted study substituting one would be a corruption,
while for a 0DTE study it is the entire point. A 0DTE study also probes every
weekday for a listed chain rather than the historic Monday/Wednesday/Friday set,
and pins its maximum deviation to zero so a session whose own expiration is
unlisted is skipped rather than quietly traded overnight.

### Placement

Fixed distance, distance in wing widths, and placement against the expected
move. The expected-move method takes an **anchor**, because the two ways of
snapping to listed strikes are genuinely different structures:

- `nearestCenter` rounds the centre to the closest strike, keeping the butterfly
  nearest its ideal location but possibly leaving the near wing a few points
  *inside* the expected move.
- `nearWingOutside` snaps the near wing itself to the first listed strike at or
  beyond the move, so the whole structure sits outside it, at the cost of
  pushing the centre slightly further out. This is what "the near wing just
  touches the expected move line" means, and it is the 0DTE default.

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

## Conditional path analysis

The question a summary table cannot answer: *given that a butterfly already
reached +50%, how often does it go on to +100%, and how often does it hand the
gain back and finish a loser?* Those conditional probabilities describe what
managing the trade is worth, which is the point of the study.

Two details make the answers trustworthy:

- **Give-back is measured after the threshold, not overall.** A trade that dipped
  badly early and then rallied has a deep maximum adverse excursion but never
  gave anything back after reaching the level. Distinguishing them requires the
  lowest return *following* first touch, which is captured while the path is
  walked.
- **Every proportion carries a Wilson confidence interval.** Conditioning shrinks
  the sample fast, and with a few hundred trades the difference between 60% and
  70% frequently is not distinguishable. The interval is displayed beside the
  figure so it cannot be read as precision it does not have.

## Parameter sweeps

Any configuration axis can be swept, and the cost depends on which:

The Parameter Sweep screen has explicit start, end, and increment controls for
target DTE and fixed wing width. Enabling both runs their Cartesian product as
one sweep - for example, DTE 3 through 9 by 2 and widths 10 through 30 by 5
produce 20 entry combinations in one queued run and one results table. The live
estimate shows that combination count before the run starts.

- **Management axes are nearly free.** Profit targets and stops run against an
  already-reconstructed price path, so a hundred targets cost one data pass and a
  hundred cheap simulations. They fold into the management set rather than
  multiplying the run count. Sweep-generated numeric thresholds are not limited
  to the curated checkboxes used by ordinary studies, so values such as a +400%
  target or -35% stop are valid.
- **Entry axes force a refetch.** Target DTE, wing width, entry time, and
  placement change which contracts are traded, so each combination reconstructs
  from scratch.

The estimated cost is shown before a sweep starts, because the difference is
between a run that finishes in seconds and one that runs overnight.

A sweep is an optimizer, and optimizers overfit. The screen says so, and the
recommended use is to treat any result as a hypothesis and check it on a period
that was not swept.

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
day-count exit (calendar or trading DTE), **Eastern wall-clock exit**, **elapsed
time in trade**, center-strike touch, tent entry at a normalized distance, and
trailing profit. Trailing supports both give-back as a *fraction of peak profit*
and give-back in *percentage points from the peak* - these are genuinely
different rules, not two spellings of one. A wall-clock exit and an elapsed-time
exit are likewise different questions once entries are signal-triggered and no
longer all happen at the same time of day.

The list of methods lives once, in `src/shared/managementCatalog.ts`, which the
UI renders and `managementSets.ts` resolves into executable rules; a test holds
the two halves in agreement, and the configured id is stamped onto the resolved
rule so a run's summaries can never match against a name the rule renamed itself
out of. Each method is tagged with the trade **horizons** it can fire on, and a
study offers only the applicable ones - a day-count exit has nothing to count
down on a 0DTE trade, and a wall-clock exit fires on the first afternoon of a
seven-day one. A method that cannot fire is not a neutral extra: it silently
reports itself as hold-to-expiration and pads the comparison with a duplicate.

Because management is simulated against an already-reconstructed path, selecting
every applicable method costs no extra data - which is why the 0DTE strategies
select all of them by default.

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
  bars and intersected with the package's static zero-to-wing-width bounds.
  The raw leg-derived bounds are deliberately wider than the butterfly's true range -
  the three legs hit their own extremes at different instants, so no combination
  of leg OHLC recovers the real path - which makes them sound for "could this
  have been touched" and unsound for anything else.
- **When opposing rules are both reachable in the same minute, the adverse one
  is taken** and the result is flagged ambiguous. The engine never silently
  chooses the favorable outcome.
- **Excursions are measured over the held portion only**, so a rule is never
  credited or penalised for a path it exited before.

## Double calendars

A second structure, studied by a parallel engine rather than by stretching the
butterfly one. A double calendar sells a put and a call at roughly 30 delta in a
near expiration and buys the same two strikes in a later one, so it is four
legs across two expirations, entered for a net debit, and it profits while the
index stays between its short strikes.

It gets its own domain type, reconstruction, exits and runner
(`domain/doubleCalendar.ts`, `backtest/reconstructCalendar.ts`,
`backtest/calendarExits.ts`, `backtest/calendarStudy.ts`) for one substantive
reason. Every validity check in the butterfly path rests on the position's value
being bounded by its wing width: entry debits are refused outside it, marks are
rejected outside it, intra-minute reachability is clamped to it, and a profit
target above it is known in advance to be unfillable. A calendar has no such
ceiling - only its maximum *loss* is knowable at entry - so reusing that path
would have meant disabling the checks that make it trustworthy. Statistics are
shared: `computeMetrics` takes a structural `MetricsTrade` that both result
types satisfy, so expectancy and drawdown cannot drift between the two.

### Choosing the strikes

Butterflies are placed by distance, which is observable. Calendars are placed by
delta, which is not, so `backtest/optionMath.ts` supplies Black-76 and an
implied-volatility solve. The model assumption is kept as small as it can be:

1. The forward and the discount factor are recovered from **put-call parity**
   across the quoted chain - arithmetic on observed prices, so no interest rate
   and no dividend yield is assumed. The fitted discount factor is capped at one,
   since quote noise occasionally puts it slightly above, which would be a
   negative rate.
2. Each strike's implied volatility is solved from **its own midpoint**, so the
   SPX skew is carried rather than averaged away. A single at-the-money
   volatility across the chain misplaces the 30-delta put by six to ten strikes.

Both strikes are chosen from the **shared** ladder of the two expirations. SPX
does not list the same strikes in each - the nearer weekly carries five-point
strikes considerably further out than the expiration a week behind it - so
selecting from the front chain alone picks strikes the back month never listed.

### Execution, and why it dominates

Four legs means four bid-ask spreads crossed on entry and four more on exit, on
a structure whose entire edge is a few points of decay. Friction is therefore
modelled against the **quoted** spread rather than as a flat allowance, and each
observation carries two values:

- `midValue`, the package midpoint - what the position is worth.
- `netValue`, the midpoint less exit friction and commissions - what closing it
  right now would actually realize.

**Every management rule is evaluated against `netValue`**, so a "+25% target"
means the trader banked 25% rather than that a theoretical mark touched it. All
percentages are of the **entry debit**, which is the capital genuinely at risk;
a calendar has no defined maximum profit for a "percent of max" to refer to.

### Reading a one-per-minute quote archive

The archive samples the NBBO once a minute, and two artifacts in it will destroy
a study that takes each sample at face value. Both are handled in
`reconstructCalendar.ts` and both have regression tests.

- **A zero offer is not a price.** The 09:30 snapshot is stored as `0.00` bid,
  `0.00` offer on every contract - the state before the opening rotation posts
  quotes. Read as a price it makes the package worth nothing, which is an
  instant total loss; left in, *every* stop in the study fires at 09:30 on the
  first morning after entry and nowhere else.
- **A single sample is a poor estimate of executable width.** A contract quoted
  0.50 wide all session shows 4.70 in one minute and 0.70 either side, because
  the sample caught a market maker mid-reprice. Its midpoint is wrong too. Fills
  are therefore charged against a **trailing** 15-minute median of the leg's own
  quoted width - trailing, not centred, because a centred window would price a
  fill using quotes from after it - and a snapshot more than 2.5x wider than that
  running width is rejected as a mark entirely, counted against data quality like
  any minute that could not be quoted.

### Management rules

Resolved by parsing the id rather than from a curated table, since the question
here includes targets the butterfly catalogue would not contain: `hold`, `tp25`,
`sl50`, `tp25-sl50`, `dte7` (days to the front expiration), `day5` (sessions
held), `trail25-50pct`, and `breach` - close when the index reaches a short
strike, optionally offset (`breach-25` arms 25 points inside it). Any two
compose with `+`, as in `tp25-sl50+breach`. `breach` is the calendar's structural
rule and the inverse of the butterfly's centre touch: a butterfly wants the index
to arrive, a calendar wants it to stay away.

The horizon is the front expiration, closed at 15:45 rather than carried into
settlement - a double calendar held through its short legs' expiration is no
longer a double calendar.

### Running it

The study reads the cached DuckDB archive directly, read-only, and never calls a
provider (`data/archiveSource.ts`). Every contract it needs is already cached,
so a miss is a gap in the archive rather than a cue to fetch - and four contracts
per trade across every session of their lives would take days at five API calls
a minute.

```bash
npm run study:calendar -- --from 2025-08-25 --to 2026-07-27   --scenarios core,delta,dte,friction,weekday,daily
```

`core` is Monday entries at 30 delta into 14/21 DTE; the other groups vary one
thing each so the headline choice can be judged rather than trusted. Results
print as a table per scenario and are written to `studies/`.

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

For the strategy layer specifically:

- `openingRange.test.ts` - the range spans exactly its window, a wick through the
  level is not a signal, the first qualifying candle wins rather than the largest
  break, and entry never lands inside the confirming candle.
- `orbStudy.test.ts` - the whole 0DTE path end to end against a synthetic market
  with every minute priced, so anything the study skips is a decision the rules
  made rather than an artefact of missing data.
- `strategyCatalog.test.ts` - every catalogued management method has an
  executable builder and keeps the id it was configured with, and every strategy
  produces a runnable configuration from its own defaults.
- `intradayExits.test.ts` - wall-clock and elapsed-time exits, including that
  neither fills on a carried-forward mark.
