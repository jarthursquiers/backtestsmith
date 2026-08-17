import { useMemo, useState } from 'react'
import type { SchwabBackfillResult } from '../../shared/schwab.js'
import { tradingDaysBetween } from '../../core/time/marketTime.js'
import { Button, Card, Field, Input, Notice, Select, Spinner, StatTile } from './primitives.js'
import { fmtInt, shiftDate, todayEastern } from '../lib/format.js'
import { useAsyncAction } from '../lib/hooks.js'

/**
 * Downloads index history from Massive.
 *
 * Requires an Indices subscription, which is separate from Options. The free
 * Indices Basic tier includes minute aggregates but covers a limited set of
 * tickers, so whether SPX is available can only be settled by asking.
 */
export function MassiveIndexDownload({ onDataChanged }: { onDataChanged: () => void }) {
  const [ticker, setTicker] = useState('I:SPX')
  const [timespan, setTimespan] = useState<'minute' | 'day'>('minute')
  const [from, setFrom] = useState(shiftDate(todayEastern(), -365))
  const [to, setTo] = useState(todayEastern())
  const [last, setLast] = useState<SchwabBackfillResult | null>(null)

  const [state, run] = useAsyncAction(async () => {
    const result = await window.api.underlying.downloadMassive({ ticker, from, to, timespan })
    setLast(result)
    onDataChanged()
    return result
  })

  const expectedSessions = useMemo(() => {
    try {
      return tradingDaysBetween(from, to).length
    } catch {
      return null
    }
  }, [from, to])

  // Rough pacing estimate: one request per ~21 sessions, at the configured limit.
  const estimatedRequests = expectedSessions ? Math.ceil(expectedSessions / 21) : null
  const notEntitled = state.error?.includes('403') || state.error?.includes('plan does not include')

  return (
    <Card
      title="Download from Massive"
      subtitle="Uses your existing Massive key. Requires an Indices subscription, which is separate from Options."
      actions={
        <Button variant="primary" onClick={() => void run()} disabled={state.loading}>
          {state.loading && <Spinner />}
          Download
        </Button>
      }
    >
      <div className="space-y-3">
        <div className="grid gap-3 md:grid-cols-4">
          <Field label="Ticker" hint="Index tickers use an I: prefix">
            <Input value={ticker} onChange={(e) => setTicker(e.target.value)} spellCheck={false} />
          </Field>
          <Field label="Bar size">
            <Select value={timespan} onChange={(e) => setTimespan(e.target.value as 'minute' | 'day')}>
              <option value="minute">1 minute</option>
              <option value="day">1 day</option>
            </Select>
          </Field>
          <Field label="From">
            <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
          </Field>
          <Field label="To">
            <Input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
          </Field>
        </div>

        {estimatedRequests !== null && !last && (
          <p className="text-[10px] leading-relaxed text-ink-faint">
            About {fmtInt(estimatedRequests)} requests for {fmtInt(expectedSessions ?? 0)} sessions, split into
            ~21-session chunks. At 5 calls/minute that is roughly {Math.ceil(estimatedRequests / 5)} minutes.
            Months already cached are skipped, so an interrupted download can simply be re-run.
          </p>
        )}

        {notEntitled && (
          <Notice tone="warn">
            Massive rejected this as not entitled. Index data is a separate subscription from Options — the free
            Indices Basic tier includes minute aggregates, but covers a limited set of tickers, so SPX may
            require a paid indices tier. Nothing was cached, so retrying after subscribing costs nothing.
          </Notice>
        )}

        {state.error && !notEntitled && <Notice tone="error">{state.error}</Notice>}

        {last && (
          <>
            <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
              <StatTile
                label="Bars written"
                value={fmtInt(last.barsWritten)}
                tone={last.barsWritten > 0 ? 'gain' : 'loss'}
              />
              <StatTile
                label="Sessions"
                value={fmtInt(last.sessionsWritten)}
                hint={expectedSessions !== null ? `of ${fmtInt(expectedSessions)} expected` : undefined}
                tone={
                  expectedSessions === null || last.sessionsWritten === 0
                    ? 'neutral'
                    : last.sessionsWritten >= expectedSessions
                      ? 'gain'
                      : 'warn'
                }
              />
              <StatTile
                label="Returned range"
                value={last.dateRange?.from ?? '—'}
                hint={last.dateRange ? `through ${last.dateRange.to}` : undefined}
              />
              <StatTile label="Requests" value={fmtInt(last.requests)} />
            </div>

            {last.barsWritten > 0 && expectedSessions !== null && last.sessionsWritten < expectedSessions && (
              <Notice tone="warn">
                {fmtInt(expectedSessions - last.sessionsWritten)} of {fmtInt(expectedSessions)} expected sessions
                returned no data. For minute bars that usually marks the edge of the plan&apos;s history window.
              </Notice>
            )}
          </>
        )}
      </div>
    </Card>
  )
}
