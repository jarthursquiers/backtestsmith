import { useCallback, useEffect, useState } from 'react'
import type { SecretStatus } from '../../shared/secrets.js'
import type { Settings } from '../../shared/settings.js'
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
  const [settings, setSettings] = useState<Settings | null>(null)
  const [saveMessage, setSaveMessage] = useState<{ ok: boolean; text: string } | null>(null)

  const stats = useQueueStats()
  const now = useNow(1000)
  const [cache, refreshCache] = useCacheStats()
  const [confirmClear, setConfirmClear] = useState(false)

  const refresh = useCallback(async () => {
    const [status, current] = await Promise.all([window.api.secrets.status(), window.api.settings.get()])
    setSecretStatus(status)
    setSettings(current)
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const [testState, runTest] = useAsyncAction(() => window.api.massive.testConnection())

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

  const envManaged = secretStatus?.source === 'env'
  const unlimited = stats !== null && !Number.isFinite(stats.requestsPerMinute)

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
            subtitle="The free Options Basic plan allows roughly 5 calls per minute. Raise this after upgrading."
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
                  value={settings?.massive.requestsPerMinute ?? 5}
                  onChange={(e) => void setRpm(Math.max(0, Number(e.target.value) || 0))}
                />
              </Field>

              <div className="flex flex-wrap gap-1.5">
                {[5, 100, 0].map((preset) => (
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
                5/min matches the free tier. 100/min or unlimited suits Options Starter and above. Exceeding the
                real limit is handled gracefully — HTTP 429 responses are retried using the server&apos;s
                Retry-After header.
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
            subtitle="Downloaded data is stored in DuckDB and reused indefinitely. Massive is called only for ranges the cache has never been asked about."
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
                  value={cache?.earliestDate ? `${cache.earliestDate}` : '�'}
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
                A day recorded as <em>confirmed empty</em> is one Massive was asked about and returned no bars
                for. That is tracked deliberately, so a contract that did not trade is never re-requested.
              </p>
            </div>
          </Card>

          <Card title="SPX underlying import" subtitle="Planned for Phase 4">
            <p className="text-[11px] leading-relaxed text-ink-faint">
              SPX index history will come from Massive&apos;s indices endpoint (ticker <code className="num">I:SPX</code>),
              with CSV import as a fallback if index access needs a separate subscription.
            </p>
          </Card>
        </div>
      </div>
    </>
  )
}
