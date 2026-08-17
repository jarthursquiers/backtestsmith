import { useState } from 'react'
import type { ParityValidationResponse } from '../../shared/parity.js'
import { Badge, Button, Card, Field, Input, Notice, Select, Spinner, StatTile } from './primitives.js'
import { fmtInt, fmtPrice, shiftDate, todayEastern } from '../lib/format.js'
import { useAsyncAction } from '../lib/hooks.js'

/**
 * Measures how accurately put-call parity reproduces the real index.
 *
 * Parity is attractive because it needs only option data, which is already
 * owned. Whether it is good enough depends on inputs that are hard to reason
 * about in the abstract, so this compares it against real index minutes and
 * reports the error instead of arguing about it.
 */
export function ParityValidation() {
  const [expiration, setExpiration] = useState(shiftDate(todayEastern(), -7))
  const [from, setFrom] = useState(shiftDate(todayEastern(), -21))
  const [to, setTo] = useState(todayEastern())
  const [strikesPerSide, setStrikesPerSide] = useState('0')
  const [preferredRoot, setPreferredRoot] = useState('SPXW')
  const [maxStaleMinutes, setMaxStaleMinutes] = useState('5')

  const [state, run] = useAsyncAction(
    (): Promise<ParityValidationResponse> =>
      window.api.parity.validate({
        underlying: 'SPX',
        expiration,
        from,
        to,
        strikesPerSide: Number(strikesPerSide) || 0,
        ...(preferredRoot ? { preferredRoot } : {}),
        maxStaleMinutes: Number(maxStaleMinutes) || 5
      })
  )

  const result = state.data
  const report = result?.report
  const best = report?.calibrated ?? report?.raw

  // A point or so of RMS is fine for everything; several points restricts
  // parity to placement only.
  const verdict =
    best === undefined || best === null
      ? null
      : best.rms <= 1
        ? { tone: 'gain' as const, text: 'Accurate enough for all uses, including center-strike touch.' }
        : best.rms <= 3
          ? { tone: 'warn' as const, text: 'Fine for strike placement; treat tent and touch thresholds as approximate.' }
          : { tone: 'loss' as const, text: 'Too noisy for underlying-location rules. Use for placement only, if at all.' }

  return (
    <Card
      title="Validate derived SPX (put-call parity)"
      subtitle="Compares parity-derived index levels against real cached index minutes, so the accuracy question is measured rather than assumed."
      actions={
        <Button variant="primary" onClick={() => void run()} disabled={state.loading}>
          {state.loading && <Spinner />}
          Run validation
        </Button>
      }
    >
      <div className="space-y-3">
        <div className="grid gap-3 md:grid-cols-3 lg:grid-cols-6">
          <Field label="Expiration" hint="Chain supplying the call/put pairs">
            <Input type="date" value={expiration} onChange={(e) => setExpiration(e.target.value)} />
          </Field>
          <Field label="From">
            <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
          </Field>
          <Field label="To">
            <Input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
          </Field>
          <Field label="Extra strikes" hint="0 uses one ATM pair; 2+ enables the regression">
            <Select value={strikesPerSide} onChange={(e) => setStrikesPerSide(e.target.value)}>
              <option value="0">ATM only (2 calls/day)</option>
              <option value="1">±1 strike (6 calls/day)</option>
              <option value="2">±2 strikes (10 calls/day)</option>
            </Select>
          </Field>
          <Field label="Root">
            <Input value={preferredRoot} onChange={(e) => setPreferredRoot(e.target.value)} spellCheck={false} />
          </Field>
          <Field label="Max stale" hint="Minutes a leg price may be carried">
            <Input
              type="number"
              min={0}
              value={maxStaleMinutes}
              onChange={(e) => setMaxStaleMinutes(e.target.value)}
            />
          </Field>
        </div>

        <p className="text-[10px] leading-relaxed text-ink-faint">
          Needs real index minutes already cached for the range — those are the ground truth. Only sessions
          where the chosen expiration was still trading can contribute.
        </p>

        {state.error && <Notice tone="error">{state.error}</Notice>}

        {result && report && (
          <div className="space-y-3">
            {report.sampleCount === 0 ? (
              <Notice tone="warn">
                No comparable minutes were found. Either no real index data is cached for this range, or the
                options for this expiration had no minute where both a call and a put were priced.
              </Notice>
            ) : (
              <>
                {verdict && <Notice tone={verdict.tone === 'gain' ? 'success' : verdict.tone === 'warn' ? 'warn' : 'error'}>{verdict.text}</Notice>}

                <div className="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-6">
                  <StatTile label="Samples" value={fmtInt(report.sampleCount)} hint={`${result.sessionsUsed.length} sessions`} />
                  <StatTile
                    label="Coverage"
                    value={`${(report.coverage * 100).toFixed(1)}%`}
                    hint="of real index minutes"
                    tone={report.coverage >= 0.8 ? 'gain' : report.coverage >= 0.5 ? 'warn' : 'loss'}
                  />
                  <StatTile
                    label="Bias (raw)"
                    value={`${report.raw.bias >= 0 ? '+' : ''}${report.raw.bias.toFixed(2)}`}
                    hint="index points"
                  />
                  <StatTile
                    label="RMS (raw)"
                    value={fmtPrice(report.raw.rms)}
                    tone={report.raw.rms <= 1 ? 'gain' : report.raw.rms <= 3 ? 'warn' : 'loss'}
                  />
                  <StatTile
                    label="RMS (calibrated)"
                    value={report.calibrated ? fmtPrice(report.calibrated.rms) : '—'}
                    hint="after fitting carry"
                    tone={
                      report.calibrated == null
                        ? 'neutral'
                        : report.calibrated.rms <= 1
                          ? 'gain'
                          : report.calibrated.rms <= 3
                            ? 'warn'
                            : 'loss'
                    }
                  />
                  <StatTile
                    label="Fitted carry"
                    value={report.fittedCarryRate !== null ? `${(report.fittedCarryRate * 100).toFixed(2)}%` : '—'}
                    hint="implied r − q"
                  />
                </div>

                <div className="overflow-x-auto rounded-md border border-line">
                  <table className="w-full border-collapse text-[11px]">
                    <thead className="bg-surface-2">
                      <tr className="text-left text-ink-faint">
                        <th className="px-3 py-1.5 font-medium">Leg staleness</th>
                        <th className="px-3 py-1.5 text-right font-medium">Samples</th>
                        <th className="px-3 py-1.5 text-right font-medium">Bias</th>
                        <th className="px-3 py-1.5 text-right font-medium">RMS</th>
                        <th className="px-3 py-1.5 text-right font-medium">Median |err|</th>
                        <th className="px-3 py-1.5 text-right font-medium">p95 |err|</th>
                        <th className="px-3 py-1.5 text-right font-medium">Max |err|</th>
                      </tr>
                    </thead>
                    <tbody className="num">
                      {report.buckets.map((b) => (
                        <tr key={b.label} className="border-t border-line-soft">
                          <td className="px-3 py-1 text-ink-dim">{b.label}</td>
                          <td className="px-3 py-1 text-right">{fmtInt(b.count)}</td>
                          <td className="px-3 py-1 text-right">{b.bias >= 0 ? '+' : ''}{b.bias.toFixed(2)}</td>
                          <td className="px-3 py-1 text-right text-ink">{b.rms.toFixed(2)}</td>
                          <td className="px-3 py-1 text-right text-ink-faint">{b.medianAbs.toFixed(2)}</td>
                          <td className="px-3 py-1 text-right text-ink-faint">{b.p95Abs.toFixed(2)}</td>
                          <td className="px-3 py-1 text-right text-ink-faint">{b.maxAbs.toFixed(2)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>

                <p className="text-[10px] leading-relaxed text-ink-faint">
                  All figures are index points. <strong>Bias</strong> is the mean signed error; a large raw bias
                  that shrinks after calibration is just an uncorrected carry rate and is fixable.{' '}
                  <strong>RMS</strong> is the irreducible part. Error is expected to grow with leg staleness,
                  because at the money a stale leg transfers index movement into the estimate roughly one for
                  one — the staleness table is the most informative row here.
                </p>
              </>
            )}

            <div className="flex flex-wrap items-center gap-2">
              <Badge tone="accent">{result.apiRequests} API requests</Badge>
              <Badge>{report.method === 'regression' ? 'multi-strike regression' : 'single ATM strike'}</Badge>
              {result.strikesRequested.length > 0 && (
                <Badge>strikes {result.strikesRequested[0]}–{result.strikesRequested[result.strikesRequested.length - 1]}</Badge>
              )}
              {result.skipped.length > 0 && <Badge tone="warn">{result.skipped.length} sessions skipped</Badge>}
            </div>

            {result.skipped.length > 0 && (
              <details className="text-[11px]">
                <summary className="cursor-pointer text-ink-dim">Skipped sessions</summary>
                <ul className="num mt-1 space-y-0.5 text-[10px] text-ink-faint">
                  {result.skipped.slice(0, 30).map((s) => (
                    <li key={s.date}>
                      {s.date}: {s.reason}
                    </li>
                  ))}
                </ul>
              </details>
            )}
          </div>
        )}
      </div>
    </Card>
  )
}
