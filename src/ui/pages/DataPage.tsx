import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import type { SecretStatus } from '../../shared/secrets.js'
import type { Settings } from '../../shared/settings.js'
import type { OptionArchiveProgress } from '../../shared/optionArchive.js'
import {
  Badge,
  Button,
  Card,
  Field,
  Input,
  Notice,
  PageHeader,
  Spinner,
  StatTile
} from '../components/primitives.js'
import { fmtBytes, fmtCountdown, fmtInt } from '../lib/format.js'
import { useAsyncAction, useCacheStats, useNow, useQueueStats } from '../lib/hooks.js'

export function DataPage() {
  const [keyInput, setKeyInput] = useState('')
  const [secretStatus, setSecretStatus] = useState<SecretStatus | null>(null)
  const [thetaKeyInput, setThetaKeyInput] = useState('')
  const [thetaStatus, setThetaStatus] = useState<SecretStatus | null>(null)
  const [thetaMessage, setThetaMessage] = useState<{ ok: boolean; text: string } | null>(null)
  const [archiveFrom, setArchiveFrom] = useState('2025-08-19')
  const [archiveTo, setArchiveTo] = useState('2026-08-10')
  const [archiveProgress, setArchiveProgress] = useState<OptionArchiveProgress | null>(null)
  const [settings, setSettings] = useState<Settings | null>(null)
  const [saveMessage, setSaveMessage] = useState<{ ok: boolean; text: string } | null>(null)

  const stats = useQueueStats()
  const now = useNow(1000)
  const [cache, refreshCache] = useCacheStats()
  const [confirmClear, setConfirmClear] = useState(false)

  const refresh = useCallback(async () => {
    const [status, theta, current, archive] = await Promise.all([
      window.api.secrets.status(), window.api.theta.status(), window.api.settings.get(),
      window.api.theta.archiveStatus()
    ])
    setSecretStatus(status)
    setThetaStatus(theta)
    setSettings(current)
    setArchiveProgress(archive.progress)
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  useEffect(() => window.api.theta.onArchiveProgress(setArchiveProgress), [])

  const [testState, runTest] = useAsyncAction(() => window.api.massive.testConnection())
  const [thetaTest, runThetaTest] = useAsyncAction(() => window.api.theta.testConnection())
  const [archiveState, runArchive] = useAsyncAction(async () => {
    const result = await window.api.theta.archive({
      underlying: 'SPX', from: archiveFrom, to: archiveTo, maxDte: 60
    })
    await refreshCache()
    return result
  })

  const saveKey = async (): Promise<void> => {
    const result = await window.api.secrets.setApiKey(keyInput)
    setSaveMessage({ ok: result.ok, text: result.message })
    if (result.ok) setKeyInput('')
    await refresh()
  }

  const clearKey = async (): Promise<void> => {
    await window.api.secrets.clear()
    setSaveMessage({ ok: true, text: 'Stored API key removed.' })
    await refresh()
  }

  const setRpm = async (value: number): Promise<void> => {
    const next = await window.api.settings.update({ massive: { requestsPerMinute: value } })
    setSettings(next)
  }

  const saveThetaKey = async (): Promise<void> => {
    const result = await window.api.theta.setApiKey(thetaKeyInput)
    setThetaMessage({ ok: result.ok, text: result.message })
    if (result.ok) setThetaKeyInput('')
    await refresh()
  }

  const clearThetaKey = async (): Promise<void> => {
    await window.api.theta.clear()
    setThetaMessage({ ok: true, text: 'Stored ThetaData API key removed.' })
    await refresh()
  }

  const envManaged = secretStatus?.source === 'env'
  const unlimited = stats !== null && !Number.isFinite(stats.requestsPerMinute)
  const archiveRunning = archiveProgress !== null &&
    ['discovering', 'cataloging', 'downloading'].includes(archiveProgress.phase)

  return (
    <>
      <PageHeader
        title="Data"
        description="Massive.com credentials, request pacing, and the local historical cache."
        actions={
          <Button variant="primary" onClick={() => void runTest()} disabled={testState.loading}>
            {testState.loading && <Spinner />}
            Test connection
          </Button>
        }
      />

      <div className="flex-1 space-y-4 overflow-y-auto p-6">
        <Card
          title="ThetaData option quotes"
          subtitle="Primary option-price source. One-minute NBBO bid/ask quotes replace sparse trade aggregates."
          actions={
            <Button variant="primary" onClick={() => void runThetaTest()} disabled={thetaTest.loading || !thetaStatus?.present}>
              {thetaTest.loading && <Spinner />} Test ThetaData
            </Button>
          }
        >
          <div className="space-y-3">
            {thetaTest.error && <Notice tone="error">{thetaTest.error}</Notice>}
            {thetaTest.data && <Notice tone={thetaTest.data.ok ? 'success' : 'error'}>{thetaTest.data.message}</Notice>}
            <div className="flex items-center gap-2">
              <span className="text-[11px] text-ink-dim">Status</span>
              {thetaStatus?.present ? (
                <Badge tone="gain">{thetaStatus.source === 'env' ? 'From environment' : 'Stored'} · {thetaStatus.hint}</Badge>
              ) : <Badge tone="warn">Not configured</Badge>}
            </div>
            <Field label="API key" hint="Generated in the ThetaData user portal. It is encrypted with DPAPI and never shown again.">
              <Input
                type="password"
                value={thetaKeyInput}
                autoComplete="off"
                spellCheck={false}
                placeholder={thetaStatus?.present ? '•••••••••••••••• (replace)' : 'Paste your ThetaData API key'}
                onChange={(e) => setThetaKeyInput(e.target.value)}
              />
            </Field>
            <div className="flex items-center gap-2">
              <Button variant="primary" onClick={() => void saveThetaKey()} disabled={!thetaKeyInput.trim()}>Save key</Button>
              <Button variant="danger" onClick={() => void clearThetaKey()} disabled={!thetaStatus?.present || thetaStatus.source === 'env'}>Clear stored key</Button>
            </div>
            {thetaMessage && <Notice tone={thetaMessage.ok ? 'success' : 'error'}>{thetaMessage.text}</Notice>}
            <p className="text-[10px] leading-relaxed text-ink-faint">
              Run Study gets option roots, strikes, contracts, and missing NBBO quotes from ThetaData automatically. Massive is used only for your cached SPX cash-index history.
            </p>

            <div className="border-t border-line pt-3">
              <div className="mb-2 text-[12px] font-medium text-ink">Archive SPX options for offline research</div>
              <div className="grid gap-3 md:grid-cols-3">
                <Field label="Entry range from">
                  <Input type="date" value={archiveFrom} disabled={archiveRunning} onChange={(event) => setArchiveFrom(event.target.value)} />
                </Field>
                <Field label="Entry range to">
                  <Input type="date" value={archiveTo} disabled={archiveRunning} onChange={(event) => setArchiveTo(event.target.value)} />
                </Field>
                <Field label="DTE envelope" hint="Calendar days">
                  <Input value="0–60 DTE" disabled />
                </Field>
              </div>

              <Notice tone="warn">
                This catalogs every listed SPX/SPXW call and put, then downloads every one-minute NBBO
                contract-day usable by a 0–60 DTE entry in the range. The universe can be extremely large;
                progress is resumable. Pause keeps every completed root/expiration/session block; Resume checks
                DuckDB first and requests only blocks whose ThetaData NBBO coverage is missing.
              </Notice>

              <div className="mt-3 flex items-center gap-2">
                {archiveRunning ? (
                  <Button variant="danger" onClick={() => void window.api.theta.cancelArchive()}>Pause archive</Button>
                ) : (
                  <Button
                    variant="primary"
                    onClick={() => void runArchive()}
                    disabled={!thetaStatus?.present || !archiveFrom || !archiveTo || archiveFrom > archiveTo}
                  >
                    {archiveProgress?.phase === 'paused' ? 'Resume archive' : 'Archive 0–60 DTE'}
                  </Button>
                )}
                {archiveProgress && (
                  <Badge tone={archiveProgress.phase === 'failed' ? 'loss' : archiveProgress.phase === 'done' ? 'gain' : 'accent'}>
                    {archiveProgress.phase}
                  </Badge>
                )}
              </div>

              {archiveState.error && <div className="mt-3"><Notice tone="error">{archiveState.error}</Notice></div>}
              {archiveProgress && (
                <div className="mt-3 space-y-2 rounded-md border border-line bg-ground p-3">
                  <div className="flex justify-between gap-3 text-[11px] text-ink-dim">
                    <span>{archiveProgress.stage}</span>
                    <span className="num">
                      {fmtInt(archiveProgress.completed)} / {fmtInt(archiveProgress.total)}
                    </span>
                  </div>
                  <div className="h-1.5 overflow-hidden rounded-full bg-line">
                    <div
                      className="h-full bg-accent"
                      style={{
                        width: `${archiveProgress.total > 0
                          ? Math.min(100, archiveProgress.completed / archiveProgress.total * 100)
                          : 0}%`
                      }}
                    />
                  </div>
                  <div className="grid grid-cols-2 gap-2 md:grid-cols-3 xl:grid-cols-6">
                    <StatTile label="Expirations" value={fmtInt(archiveProgress.expirations)} />
                    <StatTile label="Contracts" value={fmtInt(archiveProgress.contracts)} />
                    <StatTile label="Already cached" value={fmtInt(archiveProgress.cachedContractDays)} />
                    <StatTile label="Downloaded now" value={fmtInt(archiveProgress.downloadedContractDays)} />
                    <StatTile
                      label="Remaining"
                      value={fmtInt(Math.max(0, archiveProgress.total - archiveProgress.completed))}
                      hint={`${fmtInt(archiveProgress.contractDays)} total`}
                    />
                    <StatTile label="API requests" value={fmtInt(archiveProgress.apiRequests)} />
                  </div>
                  {archiveProgress.error && <Notice tone="error">{archiveProgress.error}</Notice>}
                </div>
              )}
            </div>
          </div>
        </Card>

        {testState.error && <Notice tone="error">{testState.error}</Notice>}
        {testState.data && (
          <Notice tone={testState.data.ok ? 'success' : 'error'}>
            {testState.data.ok
              ? `Connected to Massive in ${testState.data.latencyMs} ms. Credentials are valid.`
              : testState.data.message}
          </Notice>
        )}

        <div className="grid gap-4 lg:grid-cols-2">
          <Card
            title="Massive API key"
            subtitle="Stored encrypted with the OS keystore (DPAPI on Windows). Never written to settings.json or logs."
          >
            <div className="space-y-3">
              <div className="flex items-center gap-2">
                <span className="text-[11px] text-ink-dim">Status</span>
                {secretStatus?.present ? (
                  <Badge tone="gain">
                    {secretStatus.source === 'env' ? 'From environment' : 'Stored'} · {secretStatus.hint}
                  </Badge>
                ) : (
                  <Badge tone="warn">Not configured</Badge>
                )}
              </div>

              {envManaged && (
                <Notice tone="info">
                  MASSIVE_API_KEY is set in the environment and takes precedence over any stored key. Unset it
                  to manage the key from this screen.
                </Notice>
              )}

              {secretStatus && !secretStatus.encryptionAvailable && (
                <Notice tone="warn">
                  OS encryption is unavailable on this machine, so the key cannot be saved to disk. Set the
                  MASSIVE_API_KEY environment variable instead.
                </Notice>
              )}

              <Field
                label="API key"
                hint={
                  <>
                    Get one at massive.com/dashboard/keys. The value is write-only here — it is never read back
                    into this field.
                  </>
                }
              >
                <Input
                  type="password"
                  value={keyInput}
                  autoComplete="off"
                  spellCheck={false}
                  placeholder={secretStatus?.present ? '•••••••••••••••• (replace)' : 'Paste your Massive API key'}
                  onChange={(e) => setKeyInput(e.target.value)}
                />
              </Field>

              <div className="flex items-center gap-2">
                <Button variant="primary" onClick={() => void saveKey()} disabled={keyInput.trim().length === 0}>
                  Save key
                </Button>
                <Button
                  variant="danger"
                  onClick={() => void clearKey()}
                  disabled={!secretStatus?.present || envManaged}
                >
                  Clear stored key
                </Button>
              </div>

              {saveMessage && (
                <Notice tone={saveMessage.ok ? 'success' : 'error'}>{saveMessage.text}</Notice>
              )}
            </div>
          </Card>

          <Card
            title="Request pacing"
            subtitle="Set this to match the most restrictive Massive plan used by this app."
          >
            <div className="space-y-3">
              <Field
                label="Requests per minute"
                hint="Enforced with a sliding 60-second window across the whole application. Use 0 for unlimited."
              >
                <Input
                  type="number"
                  min={0}
                  max={10000}
                  value={settings?.massive.requestsPerMinute ?? 0}
                  onChange={(e) => void setRpm(Math.max(0, Number(e.target.value) || 0))}
                />
              </Field>

              <div className="flex flex-wrap gap-1.5">
                {[0, 5, 100].map((preset) => (
                  <Button
                    key={preset}
                    onClick={() => void setRpm(preset)}
                    className={settings?.massive.requestsPerMinute === preset ? 'border-accent text-accent' : ''}
                  >
                    {preset === 0 ? 'Unlimited' : `${preset}/min`}
                  </Button>
                ))}
              </div>

              <p className="text-[10px] leading-relaxed text-ink-faint">
                Unlimited matches the paid Massive Indices plan used by studies. Finite presets remain available
                for diagnostics. HTTP 429 responses still back off automatically using Retry-After.
              </p>
            </div>
          </Card>
        </div>

        <Card
          title="Request queue"
          subtitle="Every Massive call in the application flows through one shared, pausable queue."
          actions={
            <div className="flex gap-2">
              {stats?.paused ? (
                <Button variant="primary" onClick={() => void window.api.queue.resume()}>
                  Resume
                </Button>
              ) : (
                <Button onClick={() => void window.api.queue.pause()}>Pause</Button>
              )}
              <Button
                variant="danger"
                onClick={() => void window.api.queue.cancelAll()}
                disabled={!stats || stats.queued === 0}
              >
                Cancel queued
              </Button>
            </div>
          }
        >
          <div className="grid grid-cols-2 gap-3 md:grid-cols-6">
            <StatTile label="Queued" value={stats?.queued ?? '—'} />
            <StatTile label="In flight" value={stats?.inFlight ?? '—'} />
            <StatTile label="Completed" value={stats?.completed ?? '—'} tone="gain" />
            <StatTile
              label="Failed"
              value={stats?.failed ?? '—'}
              tone={stats && stats.failed > 0 ? 'loss' : 'neutral'}
            />
            <StatTile label="Retried" value={stats?.retried ?? '—'} tone={stats && stats.retried > 0 ? 'warn' : 'neutral'} />
            <StatTile
              label="Next slot"
              value={unlimited ? '∞' : fmtCountdown(stats?.nextSlotAt ?? null, now)}
              hint={stats?.paused ? 'paused' : undefined}
              tone={stats?.paused ? 'warn' : 'neutral'}
            />
          </div>
        </Card>

        <div className="grid gap-4 lg:grid-cols-2">
          <Card
            title="Local cache"
            subtitle="Downloaded data is stored in DuckDB and reused indefinitely. Providers are called only for missing coverage."
            actions={
              confirmClear ? (
                <div className="flex gap-2">
                  <Button
                    variant="danger"
                    onClick={() => {
                      void window.api.cache.clear().then(() => {
                        setConfirmClear(false)
                        void refreshCache()
                      })
                    }}
                  >
                    Confirm delete
                  </Button>
                  <Button onClick={() => setConfirmClear(false)}>Cancel</Button>
                </div>
              ) : (
                <div className="flex gap-2">
                  <Button onClick={() => void refreshCache()}>Refresh</Button>
                  <Button
                    variant="danger"
                    onClick={() => setConfirmClear(true)}
                    disabled={!cache || cache.optionBars + cache.optionContracts === 0}
                  >
                    Delete cache
                  </Button>
                </div>
              )
            }
          >
            <div className="space-y-3">
              <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
                <StatTile label="Contracts" value={fmtInt(cache?.optionContracts ?? 0)} />
                <StatTile
                  label="Option bars"
                  value={fmtInt(cache?.optionBars ?? 0)}
                  hint={cache ? `${fmtInt(cache.distinctOptionTickers)} tickers` : undefined}
                />
                <StatTile label="Underlying bars" value={fmtInt(cache?.underlyingBars ?? 0)} />
                <StatTile label="On disk" value={fmtBytes(cache?.databaseBytes ?? 0)} />
              </div>

              <div className="grid grid-cols-2 gap-3 md:grid-cols-3">
                <StatTile
                  label="Contract-days held"
                  value={fmtInt(cache?.coveredOptionDays ?? 0)}
                  hint="days already downloaded"
                />
                <StatTile
                  label="Confirmed empty"
                  value={fmtInt(cache?.emptyOptionDays ?? 0)}
                  tone={cache && cache.emptyOptionDays > 0 ? 'warn' : 'neutral'}
                  hint="no qualifying trades"
                />
                <StatTile
                  label="Date range"
                  value={cache?.earliestDate ? `${cache.earliestDate}` : '—'}
                  hint={cache?.latestDate ? `through ${cache.latestDate}` : undefined}
                />
              </div>

              {confirmClear && (
                <Notice tone="warn">
                  This permanently deletes all cached contracts and bars. Re-downloading them is limited by your
                  Massive rate limit, which on the free tier is roughly 5 calls per minute.
                </Notice>
              )}

              <p className="text-[10px] leading-relaxed text-ink-faint">
                A day recorded as <em>confirmed empty</em> is one a provider was asked about and returned no bars
                for. That is tracked deliberately, so a contract that did not trade is never re-requested.
              </p>
            </div>
          </Card>

          <Card
            title="SPX underlying"
            subtitle="Index history for entry price, direction, and distance-to-center"
            actions={
              <Link
                to="/underlying"
                className="inline-flex items-center rounded-md border border-accent/50 bg-accent/15 px-2.5 py-1.5 text-[12px] font-medium text-accent transition hover:bg-accent/25"
              >
                Open SPX Underlying
              </Link>
            }
          >
            <div className="space-y-2">
              <Notice tone="info">
                Massive&apos;s Options plans do not include index data &mdash;{' '}
                <code className="num">I:SPX</code> returns HTTP 403 &ldquo;not entitled&rdquo;. SPX comes from
                Schwab instead, with CSV import as an alternative.
              </Notice>
              <p className="text-[11px] leading-relaxed text-ink-faint">
                Connect Schwab and download SPX history on the SPX Underlying screen. The Massive index path is
                implemented and isolated, so upgrading that plan would enable it with no code changes.
              </p>
            </div>
          </Card>
        </div>
      </div>
    </>
  )
}
