import { useMemo, useState } from 'react'
import type { ChainSummary, ReconstructRequest, ReconstructResponse } from '../../shared/butterfly.js'
import { isTradingDay } from '../../core/time/marketTime.js'
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
import { PnlPathChart, UnderlyingPathChart, toPathPoints } from '../charts/ButterflyPathChart.js'
import {
  fmtCurrency,
  fmtEasternDateTime,
  fmtEasternTime,
  fmtInt,
  fmtPct,
  fmtPrice,
  shiftDate,
  todayEastern
} from '../lib/format.js'
import { useAsyncAction } from '../lib/hooks.js'
import { ManagementTable } from '../components/ManagementTable.js'

/**
 * Phase 5: reconstruct one butterfly minute by minute and look at it honestly.
 *
 * This is the screen that proves the engine works before any batch backtesting
 * is layered on, so it surfaces data quality as prominently as P/L.
 */
export function TradeInspectorPage() {
  const [underlying] = useState('SPX')
  const [expiration, setExpiration] = useState(shiftDate(todayEastern(), -30))
  const [optionType, setOptionType] = useState<'put' | 'call'>('put')
  const [preferredRoot, setPreferredRoot] = useState('')

  const [entryDate, setEntryDate] = useState(shiftDate(todayEastern(), -37))
  const [entryTime, setEntryTime] = useState('09:35')
  const [centerStrike, setCenterStrike] = useState('')
  const [wingWidth, setWingWidth] = useState('25')
  const [quantity, setQuantity] = useState('1')

  const [pricingModel, setPricingModel] = useState<'close' | 'ohlc4' | 'hl2'>('close')
  const [slippage, setSlippage] = useState('0.05')
  const [missingDataMode, setMissingDataMode] = useState<'strict' | 'carryForward'>('carryForward')
  const [maxStaleMinutes, setMaxStaleMinutes] = useState('5')

  const [targetPct, setTargetPct] = useState('100')
  const [stopPct, setStopPct] = useState('50')

  const [chainState, loadChain] = useAsyncAction(
    (): Promise<ChainSummary> => window.api.butterfly.chain(underlying, expiration, optionType)
  )
  const [runState, run] = useAsyncAction(
    (request: ReconstructRequest): Promise<ReconstructResponse> => window.api.butterfly.reconstruct(request)
  )

  const chain = chainState.data
  const center = Number(centerStrike)
  const width = Number(wingWidth)
  const strikes = useMemo(() => {
    if (!chain) return { lower: NaN, upper: NaN }
    return { lower: center - width, upper: center + width }
  }, [chain, center, width])

  const submit = (): void => {
    void run({
      underlying,
      expiration,
      optionType,
      lowerStrike: strikes.lower,
      centerStrike: center,
      upperStrike: strikes.upper,
      ...(preferredRoot ? { preferredRoot } : {}),
      quantity: Number(quantity) || 1,
      entryDate,
      entryTime,
      pricingModel,
      slippage: Number(slippage) || 0,
      missingDataMode,
      maxStaleMinutes: Number(maxStaleMinutes) || 5
    })
  }

  const result = runState.data
  const points = useMemo(() => (result ? toPathPoints(result.series.observations) : []), [result])
  const last = result?.series.observations[result.series.observations.length - 1]

  const strikesAvailable =
    chain && Number.isFinite(strikes.lower) && Number.isFinite(strikes.upper)
      ? [strikes.lower, center, strikes.upper].every((k) => chain.strikes.includes(k))
      : false

  return (
    <>
      <PageHeader
        title="Trade Inspector"
        description="Reconstruct a single butterfly minute by minute from its three legs, and inspect the path, excursions, and data quality behind it."
      />

      <div className="flex-1 space-y-4 overflow-y-auto p-6">
        <Card
          title="1. Choose an expiration"
          subtitle="Loads the option chain so strikes and roots can be validated before anything is downloaded."
          actions={
            <Button variant="primary" onClick={() => void loadChain()} disabled={chainState.loading}>
              {chainState.loading && <Spinner />}
              Load chain
            </Button>
          }
        >
          <div className="grid gap-3 md:grid-cols-4">
            <Field label="Underlying">
              <Input value={underlying} readOnly />
            </Field>
            <Field label="Expiration">
              <Input type="date" value={expiration} onChange={(e) => setExpiration(e.target.value)} />
            </Field>
            <Field label="Option type" hint="Puts build the downside fly, calls the upside">
              <Select value={optionType} onChange={(e) => setOptionType(e.target.value as 'put' | 'call')}>
                <option value="put">Put (bearish)</option>
                <option value="call">Call (bullish)</option>
              </Select>
            </Field>
            <Field label="Root" hint="Required when SPX and SPXW both list a strike">
              <Select value={preferredRoot} onChange={(e) => setPreferredRoot(e.target.value)}>
                <option value="">Auto (fails if ambiguous)</option>
                {chain?.roots.map((r) => (
                  <option key={r.root} value={r.root}>
                    {r.root} · {r.settlement?.toUpperCase() ?? '?'}-settled ({r.count})
                  </option>
                ))}
              </Select>
            </Field>
          </div>

          {chainState.error && (
            <div className="mt-3">
              <Notice tone="error">{chainState.error}</Notice>
            </div>
          )}

          {chain && (
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <Badge tone="accent">{chain.contracts.length} contracts</Badge>
              <Badge>{chain.strikes.length} strikes</Badge>
              {chain.roots.map((r) => (
                <Badge key={r.root} tone={r.settlement === 'am' ? 'warn' : 'neutral'}>
                  {r.root} · {r.settlement?.toUpperCase() ?? '?'}
                </Badge>
              ))}
              {chain.roots.length > 1 && !preferredRoot && (
                <span className="text-[11px] text-warn">
                  Two roots present — choose one, or the build will refuse rather than guess.
                </span>
              )}
            </div>
          )}
        </Card>

        <Card
          title="2. Define the butterfly"
          subtitle="Symmetrical three-leg structure. Strikes are validated against the loaded chain."
          actions={
            <Button
              variant="primary"
              onClick={submit}
              disabled={runState.loading || !chain || !Number.isFinite(center) || center <= 0}
            >
              {runState.loading && <Spinner />}
              Reconstruct
            </Button>
          }
        >
          <div className="grid gap-3 md:grid-cols-4 lg:grid-cols-6">
            <Field label="Entry date">
              <Input type="date" value={entryDate} onChange={(e) => setEntryDate(e.target.value)} />
            </Field>
            <Field label="Entry time (ET)">
              <Input value={entryTime} onChange={(e) => setEntryTime(e.target.value)} placeholder="09:35" />
            </Field>
            <Field label="Center strike">
              <Input
                type="number"
                value={centerStrike}
                onChange={(e) => setCenterStrike(e.target.value)}
                placeholder="e.g. 5875"
              />
            </Field>
            <Field label="Wing width">
              <Select value={wingWidth} onChange={(e) => setWingWidth(e.target.value)}>
                {[10, 15, 20, 25, 30, 50].map((w) => (
                  <option key={w} value={w}>
                    {w} points
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Quantity">
              <Input type="number" min={1} value={quantity} onChange={(e) => setQuantity(e.target.value)} />
            </Field>
            <Field label="Legs" hint="Lower / center / upper">
              <Input
                readOnly
                value={
                  Number.isFinite(strikes.lower) && Number.isFinite(strikes.upper) && center > 0
                    ? `${strikes.lower} / ${center} / ${strikes.upper}`
                    : '—'
                }
              />
            </Field>
          </div>

          {chain && center > 0 && !strikesAvailable && (
            <div className="mt-3">
              <Notice tone="warn">
                One or more of {strikes.lower}/{center}/{strikes.upper} is not listed for this expiration.
                Available strikes near the center:{' '}
                <span className="num">
                  {chain.strikes
                    .filter((k) => Math.abs(k - center) <= width * 2)
                    .slice(0, 12)
                    .join(', ') || 'none nearby'}
                </span>
              </Notice>
            </div>
          )}

          {!isTradingDay(entryDate) && (
            <div className="mt-3">
              <Notice tone="warn">{entryDate} is not a trading day.</Notice>
            </div>
          )}

          <div className="mt-4 grid gap-3 md:grid-cols-4 lg:grid-cols-6">
            <Field label="Pricing model" hint="How each leg price is read from its bar">
              <Select
                value={pricingModel}
                onChange={(e) => setPricingModel(e.target.value as 'close' | 'ohlc4' | 'hl2')}
              >
                <option value="close">Close</option>
                <option value="ohlc4">OHLC average</option>
                <option value="hl2">High/low midpoint</option>
              </Select>
            </Field>
            <Field label="Slippage" hint="Price points, against you">
              <Input type="number" step="0.05" value={slippage} onChange={(e) => setSlippage(e.target.value)} />
            </Field>
            <Field label="Missing data" hint="What to do when a leg did not trade">
              <Select
                value={missingDataMode}
                onChange={(e) => setMissingDataMode(e.target.value as 'strict' | 'carryForward')}
              >
                <option value="carryForward">Carry forward</option>
                <option value="strict">Strict (all three fresh)</option>
              </Select>
            </Field>
            <Field label="Max stale" hint="Minutes a price may be carried">
              <Input
                type="number"
                min={1}
                value={maxStaleMinutes}
                disabled={missingDataMode === 'strict'}
                onChange={(e) => setMaxStaleMinutes(e.target.value)}
              />
            </Field>
            <Field label="Target line" hint="Chart overlay only">
              <Input type="number" value={targetPct} onChange={(e) => setTargetPct(e.target.value)} />
            </Field>
            <Field label="Stop line" hint="Chart overlay only">
              <Input type="number" value={stopPct} onChange={(e) => setStopPct(e.target.value)} />
            </Field>
          </div>

          {runState.error && (
            <div className="mt-3">
              <Notice tone="error">{runState.error}</Notice>
            </div>
          )}
        </Card>

        {!result && !runState.loading && (
          <EmptyState title="No trade reconstructed yet">
            Load a chain, set a center strike and wing width, then press Reconstruct. On a cold cache this costs
            three Massive requests; afterwards it is served entirely from local data.
          </EmptyState>
        )}

        {result && (
          <>
            <Card title="Trade" subtitle={`${result.series.definition.centerTicker}`}>
              <div className="grid grid-cols-2 gap-3 md:grid-cols-4 lg:grid-cols-7">
                <StatTile label="Direction" value={result.series.definition.direction} />
                <StatTile
                  label="Entry"
                  value={fmtEasternTime(result.series.entryTimestamp)}
                  hint={fmtEasternDateTime(result.series.entryTimestamp).slice(0, 10)}
                />
                <StatTile label="Entry debit" value={fmtPrice(result.series.entryDebit)} hint="per butterfly" />
                <StatTile
                  label="Entry SPX"
                  value={result.series.entryUnderlying ? fmtPrice(result.series.entryUnderlying) : '—'}
                />
                <StatTile
                  label="Final P/L"
                  value={fmtPct(last?.pnlPct)}
                  hint={fmtCurrency(last?.pnlDollars)}
                  tone={(last?.pnlDollars ?? 0) >= 0 ? 'gain' : 'loss'}
                />
                <StatTile
                  label="MFE"
                  value={fmtPct(result.excursions.mfe?.pct)}
                  hint={`${result.excursions.mfe?.dte ?? '—'} DTE`}
                  tone="gain"
                />
                <StatTile
                  label="MAE"
                  value={fmtPct(result.excursions.mae?.pct)}
                  hint={`${result.excursions.mae?.dte ?? '—'} DTE`}
                  tone="loss"
                />
              </div>

              {result.series.warnings.length > 0 && (
                <div className="mt-3 space-y-2">
                  {result.series.warnings.map((w) => (
                    <Notice key={w} tone="warn">
                      {w}
                    </Notice>
                  ))}
                </div>
              )}
            </Card>

            <Card
              title="Data quality"
              subtitle="Aggregate bars are not continuous quotes, so every result carries how much of it rests on observed prices."
            >
              <div className="grid grid-cols-2 gap-3 md:grid-cols-4 lg:grid-cols-6">
                <StatTile
                  label="Coverage"
                  value={`${(result.series.quality.coverage * 100).toFixed(1)}%`}
                  tone={
                    result.series.quality.coverage >= 0.8
                      ? 'gain'
                      : result.series.quality.coverage >= 0.5
                        ? 'warn'
                        : 'loss'
                  }
                  hint="minutes priced"
                />
                <StatTile
                  label="Fresh"
                  value={`${(result.series.quality.freshness * 100).toFixed(1)}%`}
                  hint="all three traded"
                  tone={result.series.quality.freshness >= 0.5 ? 'gain' : 'warn'}
                />
                <StatTile label="Priced" value={fmtInt(result.series.quality.pricedMinutes)} />
                <StatTile label="Carried" value={fmtInt(result.series.quality.staleMinutes)} tone="warn" />
                <StatTile label="Unpriced" value={fmtInt(result.series.quality.unpricedMinutes)} tone="loss" />
                <StatTile
                  label="Longest gap"
                  value={`${result.series.quality.longestStaleRunMinutes}m`}
                  hint="consecutive"
                />
              </div>

              <div className="mt-3 grid grid-cols-3 gap-3">
                {(['lower', 'center', 'upper'] as const).map((role) => (
                  <div key={role} className="rounded border border-line-soft bg-surface-2 px-3 py-2">
                    <div className="text-[10px] uppercase tracking-wider text-ink-faint">{role} leg</div>
                    <div className="num mt-0.5 text-[12px] text-ink">
                      {fmtInt(result.legBarCounts[role])} bars
                    </div>
                    <div className="text-[10px] text-ink-faint">
                      absent {fmtInt(result.series.quality.missingByLeg[role])} min
                    </div>
                  </div>
                ))}
              </div>
            </Card>

            <ManagementTable results={result.managements} />

            <Card
              title="Path"
              subtitle="SPX with the tent overlaid, and butterfly P/L below. Hovering is synchronized across both."
            >
              <div className="space-y-2">
                <UnderlyingPathChart
                  points={points}
                  lowerStrike={result.series.definition.lowerStrike}
                  centerStrike={result.series.definition.centerStrike}
                  upperStrike={result.series.definition.upperStrike}
                />
                <PnlPathChart
                  points={points}
                  excursions={result.excursions}
                  {...(Number(targetPct) ? { profitTargetPct: Number(targetPct) } : {})}
                  {...(Number(stopPct) ? { stopLossPct: Number(stopPct) } : {})}
                />
                <p className="text-[10px] leading-relaxed text-ink-faint">
                  Plotted against observation index rather than clock time: minutes with no priceable observation
                  are absent, and a time axis would draw a straight line across them, implying prices that were
                  never seen. Dashed vertical lines mark session boundaries; the x-axis is labelled in DTE.
                </p>
              </div>
            </Card>
          </>
        )}
      </div>
    </>
  )
}
