import { useCallback, useEffect, useState } from 'react'
import type { UnderlyingBar } from '../../domain/bars.js'
import type { CsvImportOptions, CsvPreview, UnderlyingCoverageDay } from '../../shared/underlying.js'
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
import { SchwabConnect } from '../components/SchwabConnect.js'
import { MassiveIndexDownload } from '../components/MassiveIndexDownload.js'
import { ParityValidation } from '../components/ParityValidation.js'
import { fmtBytes, fmtEasternDateTime, fmtEasternTime, fmtInt, fmtPrice, shiftDate, todayEastern } from '../lib/format.js'
import { useAsyncAction } from '../lib/hooks.js'

const SPX_TICKER = 'I:SPX'

/**
 * SPX underlying history.
 *
 * Massive's Options plans do not include index data - `I:SPX` returns HTTP 403
 * "not entitled" - so CSV import is the primary acquisition path here rather
 * than a fallback. This screen owns that import and lets a session be charted
 * to confirm the data landed on the right timestamps.
 */
export function UnderlyingPage() {
  const [ticker, setTicker] = useState(SPX_TICKER)
  const [timespan, setTimespan] = useState<'minute' | 'day'>('minute')
  const [timezone, setTimezone] = useState<'market' | 'utc'>('market')
  const [preview, setPreview] = useState<CsvPreview | null>(null)
  const [importMessage, setImportMessage] = useState<string | null>(null)

  const [chartDate, setChartDate] = useState(shiftDate(todayEastern(), -30))
  const [bars, setBars] = useState<UnderlyingBar[]>([])
  const [coverage, setCoverage] = useState<UnderlyingCoverageDay[]>([])

  const options = (): CsvImportOptions => ({ ticker: ticker.trim().toUpperCase(), timespan, timezone })

  const [previewState, runPreview] = useAsyncAction(async () => {
    const filePath = await window.api.underlying.pickFile()
    if (!filePath) return null
    const result = await window.api.underlying.previewCsv(filePath, options())
    setPreview(result)
    setImportMessage(null)
    return result
  })

  const [importState, runImport] = useAsyncAction(async (filePath: string) => {
    const result = await window.api.underlying.importCsv(filePath, options())
    setImportMessage(
      `Imported ${result.imported.toLocaleString()} bars across ${result.distinctDates} sessions` +
        (result.dateRange ? ` (${result.dateRange.from} to ${result.dateRange.to}).` : '.')
    )
    setPreview(null)
    await refreshCoverage()
    return result
  })

  const refreshCoverage = useCallback(async () => {
    const to = todayEastern()
    const from = shiftDate(to, -365 * 4)
    try {
      setCoverage(await window.api.underlying.coverage(ticker.trim().toUpperCase(), from, to))
    } catch {
      setCoverage([])
    }
  }, [ticker])

  useEffect(() => {
    void refreshCoverage()
  }, [refreshCoverage])

  const [chartState, loadChart] = useAsyncAction(async (date: string) => {
    const result = await window.api.underlying.cachedBars(ticker.trim().toUpperCase(), date, date)
    setBars(result)
    return result
  })

  const totalBars = coverage.reduce((sum, day) => sum + day.barCount, 0)
  const sources = [...new Set(coverage.map((c) => c.source))]
  const expectedMinutes = isTradingDay(chartDate) ? sessionMinuteCount(chartDate) : 0

  return (
    <>
      <PageHeader
        title="SPX Underlying"
        description="Historical index levels used for entry price, direction signals, and distance-to-center measurement."
      />

      <div className="flex-1 space-y-4 overflow-y-auto p-6">
        <Notice tone="info">
          Index data is a <strong>separate Massive subscription</strong> from options. Without it{' '}
          <code className="num">I:SPX</code> returns HTTP 403 &ldquo;not entitled&rdquo;. Indices Basic is free
          and includes minute aggregates, so adding it to the same account is usually the shortest path. Schwab
          and CSV import remain available below.
        </Notice>

        <MassiveIndexDownload onDataChanged={() => void refreshCoverage()} />

        <SchwabConnect onDataChanged={() => void refreshCoverage()} />

        <ParityValidation />

        <Card
          title="Cached underlying data"
          subtitle={`Local only. Nothing on this screen calls Massive.`}
          actions={<Button onClick={() => void refreshCoverage()}>Refresh</Button>}
        >
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <StatTile label="Sessions" value={fmtInt(coverage.length)} />
            <StatTile label="Bars" value={fmtInt(totalBars)} />
            <StatTile
              label="Range"
              value={coverage.length > 0 ? coverage[0]!.marketDate : '—'}
              hint={coverage.length > 0 ? `through ${coverage[coverage.length - 1]!.marketDate}` : undefined}
            />
            <StatTile label="Source" value={sources.length > 0 ? sources.join(', ') : '—'} />
          </div>
          {coverage.length === 0 && (
            <p className="mt-3 text-[11px] leading-relaxed text-ink-faint">
              No underlying data cached for {ticker}. Import a CSV below to get started.
            </p>
          )}
        </Card>

        <Card
          title="Import CSV"
          subtitle="Columns are auto-detected. The file is parsed and shown for confirmation before anything is stored."
          actions={
            <Button variant="primary" onClick={() => void runPreview()} disabled={previewState.loading}>
              {previewState.loading && <Spinner />}
              Choose file…
            </Button>
          }
        >
          <div className="space-y-3">
            <div className="grid gap-3 md:grid-cols-3">
              <Field label="Ticker" hint="Stored under this symbol">
                <Input value={ticker} onChange={(e) => setTicker(e.target.value)} spellCheck={false} />
              </Field>
              <Field label="Bar size" hint="Daily drives the EMA; minute drives entry and intraday path">
                <Select value={timespan} onChange={(e) => setTimespan(e.target.value as 'minute' | 'day')}>
                  <option value="minute">1 minute</option>
                  <option value="day">1 day</option>
                </Select>
              </Field>
              <Field
                label="Timestamps are in"
                hint="Applies only to values with no explicit UTC offset"
              >
                <Select value={timezone} onChange={(e) => setTimezone(e.target.value as 'market' | 'utc')}>
                  <option value="market">Eastern market time</option>
                  <option value="utc">UTC</option>
                </Select>
              </Field>
            </div>

            {previewState.error && <Notice tone="error">{previewState.error}</Notice>}
            {importState.error && <Notice tone="error">{importState.error}</Notice>}
            {importMessage && <Notice tone="success">{importMessage}</Notice>}

            {preview && (
              <div className="space-y-3 rounded-md border border-line bg-surface-2 p-3">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="num text-[12px] text-ink">{preview.fileName}</span>
                  <Badge>{fmtBytes(preview.fileBytes)}</Badge>
                  <Badge tone={preview.rowsAccepted > 0 ? 'gain' : 'loss'}>
                    {fmtInt(preview.rowsAccepted)} of {fmtInt(preview.rowsRead)} rows
                  </Badge>
                  <Badge tone="accent">{preview.distinctDates} sessions</Badge>
                  {preview.dateRange && (
                    <Badge>
                      {preview.dateRange.from} → {preview.dateRange.to}
                    </Badge>
                  )}
                </div>

                {preview.warnings.map((warning) => (
                  <Notice key={warning} tone="warn">
                    {warning}
                  </Notice>
                ))}

                {preview.sample.length > 0 && (
                  <div>
                    <p className="mb-1.5 text-[11px] text-ink-dim">
                      Check these timestamps before importing. They are shown in Eastern time — a regular session
                      starts at 09:30.
                    </p>
                    <div className="overflow-x-auto rounded border border-line-soft">
                      <table className="w-full border-collapse text-[11px]">
                        <thead className="bg-surface">
                          <tr className="text-left text-ink-faint">
                            <th className="px-2 py-1 font-medium">Timestamp (ET)</th>
                            <th className="px-2 py-1 text-right font-medium">Open</th>
                            <th className="px-2 py-1 text-right font-medium">High</th>
                            <th className="px-2 py-1 text-right font-medium">Low</th>
                            <th className="px-2 py-1 text-right font-medium">Close</th>
                          </tr>
                        </thead>
                        <tbody className="num">
                          {preview.sample.map((b) => (
                            <tr key={b.timestamp} className="border-t border-line-soft">
                              <td className="px-2 py-0.5">{fmtEasternDateTime(b.timestamp)}</td>
                              <td className="px-2 py-0.5 text-right">{fmtPrice(b.open)}</td>
                              <td className="px-2 py-0.5 text-right">{fmtPrice(b.high)}</td>
                              <td className="px-2 py-0.5 text-right">{fmtPrice(b.low)}</td>
                              <td className="px-2 py-0.5 text-right text-ink">{fmtPrice(b.close)}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                )}

                {preview.skipped.length > 0 && (
                  <details className="text-[11px]">
                    <summary className="cursor-pointer text-warn">
                      {preview.skipped.length} skipped rows
                    </summary>
                    <ul className="num mt-1 space-y-0.5 text-[10px] text-ink-faint">
                      {preview.skipped.map((issue) => (
                        <li key={issue.line}>
                          line {issue.line}: {issue.reason}
                        </li>
                      ))}
                    </ul>
                  </details>
                )}

                <div className="flex gap-2">
                  <Button
                    variant="primary"
                    onClick={() => void runImport(preview.filePath)}
                    disabled={importState.loading || preview.rowsAccepted === 0}
                  >
                    {importState.loading && <Spinner />}
                    Import {fmtInt(preview.rowsAccepted)} bars
                  </Button>
                  <Button onClick={() => setPreview(null)}>Cancel</Button>
                </div>
              </div>
            )}
          </div>
        </Card>

        <Card
          title="Chart a session"
          subtitle="Reads from the local cache only."
          actions={
            <div className="flex items-end gap-2">
              <Input
                type="date"
                value={chartDate}
                onChange={(e) => setChartDate(e.target.value)}
                className="w-40"
              />
              <Button variant="primary" onClick={() => void loadChart(chartDate)} disabled={chartState.loading}>
                {chartState.loading && <Spinner />}
                Load
              </Button>
            </div>
          }
        >
          {!isTradingDay(chartDate) && (
            <Notice tone="warn">{chartDate} is not a trading day (weekend or market holiday).</Notice>
          )}

          {chartState.error && <Notice tone="error">{chartState.error}</Notice>}

          {chartState.data && bars.length === 0 && (
            <EmptyState title="No cached data for this session">
              Import a CSV covering {chartDate}, or pick a date inside the cached range.
            </EmptyState>
          )}

          {bars.length > 0 && (
            <div className="space-y-4">
              <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
                <StatTile label="Bars" value={fmtInt(bars.length)} />
                <StatTile
                  label="Session minutes"
                  value={expectedMinutes > 0 ? fmtInt(expectedMinutes) : 'n/a'}
                />
                <StatTile label="Open" value={fmtPrice(bars[0]!.open)} />
                <StatTile label="Close" value={fmtPrice(bars[bars.length - 1]!.close)} />
                <StatTile
                  label="Range"
                  value={fmtPrice(Math.max(...bars.map((b) => b.high)) - Math.min(...bars.map((b) => b.low)))}
                  hint="high minus low"
                />
              </div>

              <div className="flex flex-wrap gap-2 text-[11px] text-ink-faint">
                <span>
                  First bar <span className="num text-ink-dim">{fmtEasternTime(bars[0]!.timestamp)} ET</span>
                </span>
                <span>
                  Last bar{' '}
                  <span className="num text-ink-dim">
                    {fmtEasternTime(bars[bars.length - 1]!.timestamp)} ET
                  </span>
                </span>
              </div>

              <BarSeriesChart bars={bars} label="SPX" height={300} />
            </div>
          )}
        </Card>
      </div>
    </>
  )
}
