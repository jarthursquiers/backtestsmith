import { useMemo, useState } from 'react'
import type { OptionContract } from '../../domain/contracts.js'
import { isTradingDay, sessionMinuteCount } from '../../core/time/marketTime.js'
import {
  Badge,
  Button,
  Card,
  EmptyState,
  Field,
  Input,
  Notice,
  PageHeader,
  Select,
  Spinner,
  StatTile
} from '../components/primitives.js'
import { BarSeriesChart } from '../charts/BarSeriesChart.js'
import { fmtEasternTime, fmtInt, fmtPrice, shiftDate, todayEastern } from '../lib/format.js'
import { useAsyncAction } from '../lib/hooks.js'

/**
 * Phase 2 verification surface: discover a real expired SPX contract, pull its
 * one-minute aggregates from Massive, and look at the result honestly -
 * including how many minutes had no trade at all.
 */
export function ExplorerPage() {
  const defaultExpiration = shiftDate(todayEastern(), -30)

  const [underlying, setUnderlying] = useState('SPX')
  const [expiration, setExpiration] = useState(defaultExpiration)
  const [contractType, setContractType] = useState<'call' | 'put'>('put')
  const [strikeMin, setStrikeMin] = useState('')
  const [strikeMax, setStrikeMax] = useState('')

  const [selected, setSelected] = useState<OptionContract | null>(null)
  const [barDate, setBarDate] = useState(defaultExpiration)
  const [timespan, setTimespan] = useState<'minute' | 'day'>('minute')

  const [contractsState, findContracts] = useAsyncAction(window.api.massive.getContracts)
  const [barsState, downloadBars, resetBars] = useAsyncAction(window.api.massive.getOptionBars)

  const contracts = contractsState.data ?? []
  const bars = barsState.data?.bars ?? []

  const search = (): void => {
    setSelected(null)
    resetBars()
    void findContracts({
      underlying: underlying.trim().toUpperCase(),
      expirationDate: expiration,
      type: contractType,
      expired: true,
      ...(strikeMin ? { strikeGte: Number(strikeMin) } : {}),
      ...(strikeMax ? { strikeLte: Number(strikeMax) } : {}),
      maxResults: 500
    })
  }

  const selectContract = (contract: OptionContract): void => {
    setSelected(contract)
    resetBars()
    // Default the bar date to the contract's expiration, the densest session.
    setBarDate(contract.expirationDate)
  }

  const fetchBars = (): void => {
    if (!selected) return
    void downloadBars({ ticker: selected.ticker, from: barDate, to: barDate, timespan, multiplier: 1 })
  }

  // Root and settlement are normalized by the provider, so the UI never parses
  // vendor symbols itself.
  const settlement = selected?.settlement ?? null

  const coverage = useMemo(() => {
    if (timespan !== 'minute' || !barsState.data) return null
    const tradingDay = isTradingDay(barDate)
    const expected = tradingDay ? sessionMinuteCount(barDate) : 0
    // Count only bars inside the regular session; Massive may include extended trades.
    const observed = bars.length
    return {
      tradingDay,
      expected,
      observed,
      coveragePct: expected > 0 ? (observed / expected) * 100 : 0
    }
  }, [barsState.data, bars.length, barDate, timespan])

  return (
    <>
      <PageHeader
        title="Contract Explorer"
        description="Look up expired SPX option contracts and pull their historical one-minute aggregates directly from Massive. This is the raw-data view used to verify the provider integration before any backtesting logic runs on top of it."
      />

      <div className="flex-1 space-y-4 overflow-y-auto p-6">
        <Card
          title="1. Find an expired contract"
          subtitle="Queries /v3/reference/options/contracts with expired=true and follows next_url pagination."
          actions={
            <Button variant="primary" onClick={search} disabled={contractsState.loading}>
              {contractsState.loading && <Spinner />}
              Search contracts
            </Button>
          }
        >
          <div className="grid gap-3 md:grid-cols-5">
            <Field label="Underlying">
              <Input value={underlying} onChange={(e) => setUnderlying(e.target.value)} spellCheck={false} />
            </Field>
            <Field label="Expiration" hint="Exact expiration date">
              <Input type="date" value={expiration} onChange={(e) => setExpiration(e.target.value)} />
            </Field>
            <Field label="Type">
              <Select value={contractType} onChange={(e) => setContractType(e.target.value as 'call' | 'put')}>
                <option value="put">Put</option>
                <option value="call">Call</option>
              </Select>
            </Field>
            <Field label="Strike ≥" hint="Optional">
              <Input
                type="number"
                value={strikeMin}
                placeholder="e.g. 5800"
                onChange={(e) => setStrikeMin(e.target.value)}
              />
            </Field>
            <Field label="Strike ≤" hint="Optional">
              <Input
                type="number"
                value={strikeMax}
                placeholder="e.g. 6100"
                onChange={(e) => setStrikeMax(e.target.value)}
              />
            </Field>
          </div>

          {contractsState.error && (
            <div className="mt-3">
              <Notice tone="error">{contractsState.error}</Notice>
            </div>
          )}

          {contractsState.data && (
            <div className="mt-4">
              {contracts.length === 0 ? (
                <EmptyState title="No contracts returned">
                  Massive returned no contracts for {underlying} expiring {expiration}. SPX weeklies expire
                  Mon/Wed/Fri; confirm the date was an actual expiration and falls inside your plan&apos;s
                  history window.
                </EmptyState>
              ) : (
                <>
                  <div className="mb-2 flex items-center gap-2 text-[11px] text-ink-dim">
                    <Badge tone="accent">{contracts.length} contracts</Badge>
                    <span className="text-ink-faint">Select one to download its minute bars.</span>
                  </div>
                  <div className="max-h-72 overflow-y-auto rounded-md border border-line">
                    <table className="w-full border-collapse text-[11px]">
                      <thead className="sticky top-0 bg-surface-2">
                        <tr className="text-left text-ink-faint">
                          <th className="px-3 py-1.5 font-medium">Ticker</th>
                          <th className="px-3 py-1.5 text-right font-medium">Strike</th>
                          <th className="px-3 py-1.5 font-medium">Type</th>
                          <th className="px-3 py-1.5 font-medium">Expiration</th>
                          <th className="px-3 py-1.5 font-medium">Style</th>
                        </tr>
                      </thead>
                      <tbody>
                        {contracts.map((contract) => {
                          const active = selected?.ticker === contract.ticker
                          return (
                            <tr
                              key={contract.ticker}
                              onClick={() => selectContract(contract)}
                              className={`cursor-pointer border-t border-line-soft transition ${
                                active ? 'bg-accent/15 text-accent' : 'hover:bg-surface-2'
                              }`}
                            >
                              <td className="num px-3 py-1.5">{contract.ticker}</td>
                              <td className="num px-3 py-1.5 text-right">{fmtPrice(contract.strike)}</td>
                              <td className="px-3 py-1.5 uppercase">{contract.type}</td>
                              <td className="num px-3 py-1.5">{contract.expirationDate}</td>
                              <td className="px-3 py-1.5 text-ink-faint">{contract.exerciseStyle ?? '—'}</td>
                            </tr>
                          )
                        })}
                      </tbody>
                    </table>
                  </div>
                </>
              )}
            </div>
          )}
        </Card>

        <Card
          title="2. Download minute bars"
          subtitle="Queries /v2/aggs/ticker/{ticker}/range/1/minute/{from}/{to}."
          actions={
            <Button variant="primary" onClick={fetchBars} disabled={!selected || barsState.loading}>
              {barsState.loading && <Spinner />}
              Download bars
            </Button>
          }
        >
          {!selected ? (
            <EmptyState title="No contract selected">
              Search above and pick a contract to enable the bar download.
            </EmptyState>
          ) : (
            <div className="space-y-3">
              <div className="flex flex-wrap items-center gap-2 rounded-md border border-line-soft bg-surface-2 px-3 py-2">
                <span className="num text-[12px] text-ink">{selected.ticker}</span>
                <Badge tone="accent">
                  {selected.type} {fmtPrice(selected.strike)}
                </Badge>
                <Badge>exp {selected.expirationDate}</Badge>
                {settlement && (
                  <Badge tone={settlement === 'am' ? 'warn' : 'neutral'}>
                    {selected.root} · {settlement.toUpperCase()}-settled
                  </Badge>
                )}
              </div>

              {settlement === 'am' && (
                <Notice tone="warn">
                  This is a standard AM-settled SPX contract. Trading stops at the Thursday close and it settles
                  against Friday&apos;s opening prints, so there is no Friday session to observe. Weekly
                  butterflies normally use the PM-settled SPXW root instead.
                </Notice>
              )}

              <div className="grid gap-3 md:grid-cols-3">
                <Field label="Date" hint="Single session; one request per day keeps the 5/min budget predictable.">
                  <Input type="date" value={barDate} onChange={(e) => setBarDate(e.target.value)} />
                </Field>
                <Field label="Timespan">
                  <Select value={timespan} onChange={(e) => setTimespan(e.target.value as 'minute' | 'day')}>
                    <option value="minute">1 minute</option>
                    <option value="day">1 day</option>
                  </Select>
                </Field>
              </div>

              {!isTradingDay(barDate) && (
                <Notice tone="warn">
                  {barDate} is not a trading day (weekend or market holiday). Massive will return no bars.
                </Notice>
              )}

              {barsState.error && <Notice tone="error">{barsState.error}</Notice>}
            </div>
          )}
        </Card>

        {barsState.data && (
          <Card
            title="3. Result"
            subtitle={`${barsState.data.ticker} · ${barsState.data.requestedFrom}`}
            actions={
              <Badge tone={barsState.data.empty ? 'warn' : 'gain'}>
                {barsState.data.empty ? 'No bars' : `${bars.length} bars`}
              </Badge>
            }
          >
            {barsState.data.empty ? (
              <Notice tone="warn">
                Massive returned no bars for this contract on {barsState.data.requestedFrom}. Minute aggregates
                are trade-derived, so this means no qualifying trade occurred — it does <strong>not</strong> mean
                the option was worth zero. The research engine treats these minutes as unobserved.
              </Notice>
            ) : (
              <div className="space-y-4">
                <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
                  <StatTile label="Bars observed" value={fmtInt(bars.length)} />
                  {coverage && (
                    <>
                      <StatTile
                        label="Session minutes"
                        value={coverage.tradingDay ? fmtInt(coverage.expected) : 'n/a'}
                        hint={coverage.tradingDay ? undefined : 'not a trading day'}
                      />
                      <StatTile
                        label="Coverage"
                        value={`${coverage.coveragePct.toFixed(1)}%`}
                        tone={coverage.coveragePct >= 80 ? 'gain' : coverage.coveragePct >= 40 ? 'warn' : 'loss'}
                        hint="minutes with a trade"
                      />
                      <StatTile
                        label="Silent minutes"
                        value={fmtInt(Math.max(0, coverage.expected - coverage.observed))}
                        tone="warn"
                        hint="no qualifying trade"
                      />
                    </>
                  )}
                  <StatTile
                    label="Total volume"
                    value={fmtInt(bars.reduce((sum, b) => sum + (b.volume ?? 0), 0))}
                  />
                </div>

                {coverage && coverage.coveragePct < 80 && coverage.tradingDay && (
                  <Notice tone="info">
                    {(100 - coverage.coveragePct).toFixed(1)}% of regular-session minutes had no qualifying
                    trade. This is normal for individual SPX strikes and is exactly why the engine needs an
                    explicit missing-data policy rather than assuming a price for every minute.
                  </Notice>
                )}

                <BarSeriesChart bars={bars} label="Close" />

                <div className="max-h-80 overflow-y-auto rounded-md border border-line">
                  <table className="w-full border-collapse text-[11px]">
                    <thead className="sticky top-0 bg-surface-2">
                      <tr className="text-left text-ink-faint">
                        <th className="px-3 py-1.5 font-medium">Time (ET)</th>
                        <th className="px-3 py-1.5 text-right font-medium">Open</th>
                        <th className="px-3 py-1.5 text-right font-medium">High</th>
                        <th className="px-3 py-1.5 text-right font-medium">Low</th>
                        <th className="px-3 py-1.5 text-right font-medium">Close</th>
                        <th className="px-3 py-1.5 text-right font-medium">Volume</th>
                        <th className="px-3 py-1.5 text-right font-medium">VWAP</th>
                        <th className="px-3 py-1.5 text-right font-medium">Trades</th>
                      </tr>
                    </thead>
                    <tbody className="num">
                      {bars.map((bar) => (
                        <tr key={bar.timestamp} className="border-t border-line-soft hover:bg-surface-2">
                          <td className="px-3 py-1">{fmtEasternTime(bar.timestamp)}</td>
                          <td className="px-3 py-1 text-right">{fmtPrice(bar.open)}</td>
                          <td className="px-3 py-1 text-right">{fmtPrice(bar.high)}</td>
                          <td className="px-3 py-1 text-right">{fmtPrice(bar.low)}</td>
                          <td className="px-3 py-1 text-right text-ink">{fmtPrice(bar.close)}</td>
                          <td className="px-3 py-1 text-right text-ink-dim">{fmtInt(bar.volume)}</td>
                          <td className="px-3 py-1 text-right text-ink-dim">{fmtPrice(bar.vwap)}</td>
                          <td className="px-3 py-1 text-right text-ink-dim">{fmtInt(bar.transactions)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
          </Card>
        )}
      </div>
    </>
  )
}
