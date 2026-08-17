import { useCallback, useEffect, useMemo, useState } from 'react'
import type { SchwabBackfillResult, SchwabConnectionStatus } from '../../shared/schwab.js'
import { Badge, Button, Card, Field, Input, Notice, Select, Spinner, StatTile } from './primitives.js'
import { tradingDaysBetween } from '../../core/time/marketTime.js'
import { fmtInt, shiftDate, todayEastern } from '../lib/format.js'
import { useAsyncAction } from '../lib/hooks.js'

/**
 * Schwab connection and SPX backfill.
 *
 * The desktop authorization flow is deliberately manual: Schwab redirects to a
 * registered `https://127.0.0.1` callback that nothing is listening on, so the
 * browser shows a connection error while the address bar holds the code. Pasting
 * that URL back avoids running a local HTTPS server with a self-signed
 * certificate, which would train the user to click through security warnings.
 */
/**
 * One numbered step in the connection flow.
 *
 * Steps are always rendered, including ones that are not yet reachable. An
 * earlier version hid step 2 until step 1 was saved, which made the
 * authorization step appear not to exist at all.
 */
function StepPanel({
  index,
  title,
  done,
  active,
  children
}: {
  index: number
  title: string
  done: boolean
  active: boolean
  children: React.ReactNode
}) {
  return (
    <div
      className={`rounded-md border p-3 transition ${
        active ? 'border-accent/40 bg-surface-2' : 'border-line-soft bg-surface-2/40'
      }`}
    >
      <div className="mb-2 flex items-center gap-2">
        <span
          className={`num flex h-4 w-4 items-center justify-center rounded-full text-[9px] font-semibold ${
            done
              ? 'bg-gain/20 text-gain'
              : active
                ? 'bg-accent/20 text-accent'
                : 'bg-line text-ink-faint'
          }`}
        >
          {done ? '✓' : index}
        </span>
        <span className={`text-[12px] font-medium ${active || done ? 'text-ink' : 'text-ink-faint'}`}>
          {title}
        </span>
      </div>
      <div className={active || done ? '' : 'opacity-60'}>{children}</div>
    </div>
  )
}

export function SchwabConnect({ onDataChanged }: { onDataChanged: () => void }) {
  const [status, setStatus] = useState<SchwabConnectionStatus | null>(null)
  const [clientId, setClientId] = useState('')
  const [clientSecret, setClientSecret] = useState('')
  const [redirectUri, setRedirectUri] = useState('https://127.0.0.1:5173/callback')
  const [redirectedUrl, setRedirectedUrl] = useState('')
  const [editingCredentials, setEditingCredentials] = useState(false)

  const [ticker, setTicker] = useState('I:SPX')
  const [timespan, setTimespan] = useState<'minute' | 'day'>('day')
  const [from, setFrom] = useState(shiftDate(todayEastern(), -30))
  const [to, setTo] = useState(todayEastern())
  const [lastBackfill, setLastBackfill] = useState<SchwabBackfillResult | null>(null)

  const refresh = useCallback(async () => {
    setStatus(await window.api.schwab.status())
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const [saveState, saveCredentials] = useAsyncAction(async () => {
    const next = await window.api.schwab.setCredentials({ clientId, clientSecret, redirectUri })
    setStatus(next)
    setClientSecret('')
    setEditingCredentials(false)
    return next
  })

  const [authUrlState, startAuth] = useAsyncAction(() => window.api.schwab.authorizeUrl())

  const [completeState, completeAuth] = useAsyncAction(async () => {
    const next = await window.api.schwab.completeAuth(redirectedUrl)
    setStatus(next)
    setRedirectedUrl('')
    return next
  })

  const [testState, runTest] = useAsyncAction(() => window.api.schwab.test())

  const [backfillState, runBackfill] = useAsyncAction(async () => {
    const result = await window.api.schwab.backfill({ ticker, from, to, timespan })
    setLastBackfill(result)
    onDataChanged()
    return result
  })

  /*
   * Expected sessions come from the trading calendar, not the calendar dates.
   * Comparing a requested start of, say, a Saturday against the first returned
   * bar on the following Monday looks like missing history but is not.
   */
  const expectedSessions = useMemo(() => {
    try {
      return tradingDaysBetween(from, to).length
    } catch {
      return null
    }
  }, [from, to])

  const firstExpectedSession = useMemo(() => {
    try {
      return tradingDaysBetween(from, to)[0] ?? null
    } catch {
      return null
    }
  }, [from, to])

  const daysUntilReauth =
    status?.refreshTokenExpiresAt != null
      ? Math.max(0, Math.floor((status.refreshTokenExpiresAt - Date.now()) / 86_400_000))
      : null

  return (
    <div className="space-y-4">
      <Card
        title="Schwab connection"
        subtitle="Supplies SPX index history, which the Massive Options plans do not include."
        actions={
          status?.connected ? (
            <div className="flex gap-2">
              <Button onClick={() => void runTest()} disabled={testState.loading}>
                {testState.loading && <Spinner />}
                Test
              </Button>
              <Button
                variant="danger"
                onClick={() => void window.api.schwab.disconnect().then(setStatus)}
              >
                Disconnect
              </Button>
            </div>
          ) : null
        }
      >
        <div className="space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-[11px] text-ink-dim">Status</span>
            {status?.connected ? (
              <Badge tone="gain">Connected</Badge>
            ) : status?.hasCredentials ? (
              <Badge tone="warn">Not authorized</Badge>
            ) : (
              <Badge tone="warn">No credentials</Badge>
            )}
            {status?.clientIdHint && <Badge>{status.clientIdHint}</Badge>}
            {status?.credentialsFromEnv && <Badge tone="accent">from environment</Badge>}
            {daysUntilReauth !== null && status?.connected && (
              <Badge tone={daysUntilReauth <= 1 ? 'loss' : daysUntilReauth <= 2 ? 'warn' : 'neutral'}>
                re-auth in {daysUntilReauth}d
              </Badge>
            )}
          </div>

          {status?.connected && (
            <Notice tone="info">
              Schwab refresh tokens last 7 days and refreshing does not extend that, so you will need to
              reconnect weekly. That mostly does not matter here: SPX history is downloaded once into the local
              cache and reused from then on.
            </Notice>
          )}

          {testState.data && (
            <Notice tone={testState.data.ok ? 'success' : 'error'}>{testState.data.message}</Notice>
          )}

          {!status?.connected && (
            <div className="space-y-3">
              {/*
                Both steps are always visible. Hiding step 2 until step 1 was
                saved made the authorization step look like it did not exist.
              */}
              <StepPanel
                index={1}
                title="Application credentials"
                done={Boolean(status?.hasCredentials)}
                active={!status?.hasCredentials || editingCredentials}
              >
                {status?.hasCredentials && !editingCredentials ? (
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-[11px] text-ink-dim">
                      Saved for client {status.clientIdHint}
                    </span>
                    <span className="num text-[10px] text-ink-faint">{status.redirectUri}</span>
                    {/* Without this there is no way to correct a mistyped key. */}
                    <Button onClick={() => setEditingCredentials(true)}>Change</Button>
                  </div>
                ) : (
                  <div className="space-y-3">
                    <div className="grid gap-3 md:grid-cols-3">
                      <Field label="Client ID">
                        <Input value={clientId} onChange={(e) => setClientId(e.target.value)} spellCheck={false} />
                      </Field>
                      <Field label="Client secret" hint="Encrypted with the OS keystore; never logged">
                        <Input
                          type="password"
                          value={clientSecret}
                          onChange={(e) => setClientSecret(e.target.value)}
                          spellCheck={false}
                        />
                      </Field>
                      <Field label="Callback URL" hint="Must exactly match one registered for the app">
                        <Input
                          value={redirectUri}
                          onChange={(e) => setRedirectUri(e.target.value)}
                          spellCheck={false}
                        />
                      </Field>
                    </div>
                    <div className="flex items-center gap-2">
                      <Button
                        variant="primary"
                        onClick={() => void saveCredentials()}
                        disabled={saveState.loading || !clientId.trim() || !clientSecret.trim()}
                      >
                        {saveState.loading && <Spinner />}
                        Save credentials
                      </Button>
                      {editingCredentials && (
                        <Button onClick={() => setEditingCredentials(false)}>Cancel</Button>
                      )}
                    </div>
                    {saveState.error && <Notice tone="error">{saveState.error}</Notice>}
                  </div>
                )}
              </StepPanel>

              <StepPanel
                index={2}
                title="Authorize with Schwab"
                done={false}
                active={Boolean(status?.hasCredentials) && !editingCredentials}
              >
                {!status?.hasCredentials ? (
                  <p className="text-[11px] text-ink-faint">
                    Save your application credentials above to enable this step.
                  </p>
                ) : (
                  <div className="space-y-3">
                    <p className="text-[11px] leading-relaxed text-ink-dim">
                      This opens Schwab in your browser to approve access. You will be redirected to{' '}
                      <code className="num">{status.redirectUri}</code>, which will fail to load &mdash; that is
                      expected, since nothing is listening there. Copy the whole address from the browser and
                      paste it below.
                    </p>

                    <Button variant="primary" onClick={() => void startAuth()} disabled={authUrlState.loading}>
                      {authUrlState.loading && <Spinner />}
                      Open Schwab authorization
                    </Button>

                    {authUrlState.error && <Notice tone="error">{authUrlState.error}</Notice>}

                    <Field label="Redirected URL" hint="Paste the full address bar contents after approving">
                      <Input
                        value={redirectedUrl}
                        onChange={(e) => setRedirectedUrl(e.target.value)}
                        placeholder="https://127.0.0.1:5173/callback?code=...&session=..."
                        spellCheck={false}
                      />
                    </Field>

                    <Button
                      variant="primary"
                      onClick={() => void completeAuth()}
                      disabled={completeState.loading || redirectedUrl.trim().length === 0}
                    >
                      {completeState.loading && <Spinner />}
                      Complete connection
                    </Button>

                    {completeState.error && <Notice tone="error">{completeState.error}</Notice>}
                  </div>
                )}
              </StepPanel>
            </div>
          )}
        </div>
      </Card>

      {status?.connected && (
        <Card
          title="Download SPX history"
          subtitle="Fetches from Schwab and stores into the local cache. Minute requests are split into 10-day windows automatically."
          actions={
            <Button variant="primary" onClick={() => void runBackfill()} disabled={backfillState.loading}>
              {backfillState.loading && <Spinner />}
              Download
            </Button>
          }
        >
          <div className="space-y-3">
            <div className="grid gap-3 md:grid-cols-4">
              <Field label="Ticker" hint="Stored under this symbol">
                <Input value={ticker} onChange={(e) => setTicker(e.target.value)} spellCheck={false} />
              </Field>
              <Field label="Bar size">
                <Select value={timespan} onChange={(e) => setTimespan(e.target.value as 'minute' | 'day')}>
                  <option value="day">1 day</option>
                  <option value="minute">1 minute</option>
                </Select>
              </Field>
              <Field label="From">
                <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
              </Field>
              <Field label="To">
                <Input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
              </Field>
            </div>

            {backfillState.error && <Notice tone="error">{backfillState.error}</Notice>}

            {lastBackfill && (
              <>
                <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
                  <StatTile
                    label="Bars written"
                    value={fmtInt(lastBackfill.barsWritten)}
                    tone={lastBackfill.barsWritten > 0 ? 'gain' : 'loss'}
                  />
                  <StatTile
                    label="Sessions"
                    value={fmtInt(lastBackfill.sessionsWritten)}
                    hint={expectedSessions !== null ? `of ${fmtInt(expectedSessions)} expected` : undefined}
                    tone={
                      expectedSessions === null || lastBackfill.sessionsWritten === 0
                        ? 'neutral'
                        : lastBackfill.sessionsWritten >= expectedSessions
                          ? 'gain'
                          : 'warn'
                    }
                  />
                  <StatTile
                    label="Returned range"
                    value={lastBackfill.dateRange?.from ?? '—'}
                    hint={lastBackfill.dateRange ? `through ${lastBackfill.dateRange.to}` : undefined}
                  />
                  <StatTile label="Requests" value={fmtInt(lastBackfill.requests)} />
                </div>

                {lastBackfill.barsWritten === 0 && (
                  <Notice tone="warn">
                    Schwab returned no data for this range. For minute bars this usually means the range is
                    outside Schwab&apos;s retention window rather than that the index did not trade. Nothing was
                    recorded as a confirmed empty session, so a later retry is still possible.
                  </Notice>
                )}

                {/*
                  Only a start later than the first *trading day* in the range
                  indicates missing history. A requested start on a weekend or
                  holiday is not a shortfall.
                */}
                {lastBackfill.dateRange &&
                  firstExpectedSession !== null &&
                  lastBackfill.dateRange.from > firstExpectedSession && (
                    <Notice tone="warn">
                      The first trading day in this range is {firstExpectedSession}, but the earliest data
                      returned was {lastBackfill.dateRange.from}. That is where Schwab&apos;s history for this
                      bar size appears to start.
                    </Notice>
                  )}

                {lastBackfill.barsWritten > 0 &&
                  expectedSessions !== null &&
                  lastBackfill.sessionsWritten >= expectedSessions && (
                    <Notice tone="success">
                      Complete: {fmtInt(lastBackfill.sessionsWritten)} sessions returned, matching every trading
                      day the calendar expects in this range.
                    </Notice>
                  )}
              </>
            )}
          </div>
        </Card>
      )}
    </div>
  )
}
