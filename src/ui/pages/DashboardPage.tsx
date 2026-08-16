import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import type { AppInfo } from '../../shared/ipc.js'
import type { SecretStatus } from '../../shared/secrets.js'
import { Badge, Button, Card, PageHeader, Spinner, StatTile } from '../components/primitives.js'
import { fmtBytes, fmtInt } from '../lib/format.js'
import { useAsyncAction, useCacheStats } from '../lib/hooks.js'

export function DashboardPage() {
  const [info, setInfo] = useState<AppInfo | null>(null)
  const [secretStatus, setSecretStatus] = useState<SecretStatus | null>(null)
  const [testState, runTest] = useAsyncAction(() => window.api.massive.testConnection())
  const [cache] = useCacheStats()

  useEffect(() => {
    void window.api.app.info().then(setInfo)
    void window.api.secrets.status().then(setSecretStatus)
  }, [])

  const providerTone = testState.data?.ok ? 'gain' : testState.data ? 'loss' : 'neutral'

  return (
    <>
      <PageHeader
        title="Dashboard"
        description="Local research environment for SPX approximately-7-DTE directional butterflies."
      />

      <div className="flex-1 space-y-4 overflow-y-auto p-6">
        <div className="grid gap-4 lg:grid-cols-3">
          <Card
            title="Massive API"
            actions={
              <Button onClick={() => void runTest()} disabled={testState.loading}>
                {testState.loading && <Spinner />}
                Test
              </Button>
            }
          >
            <div className="space-y-2">
              <div className="flex items-center gap-2">
                <span className="text-[11px] text-ink-dim">Credentials</span>
                {secretStatus?.present ? (
                  <Badge tone="gain">{secretStatus.source === 'env' ? 'Environment' : 'Stored'}</Badge>
                ) : (
                  <Badge tone="warn">Not configured</Badge>
                )}
              </div>
              <div className="flex items-center gap-2">
                <span className="text-[11px] text-ink-dim">Connection</span>
                {testState.data ? (
                  <Badge tone={providerTone}>
                    {testState.data.ok ? `OK · ${testState.data.latencyMs} ms` : 'Failed'}
                  </Badge>
                ) : (
                  <Badge>Untested</Badge>
                )}
              </div>
              {testState.data && !testState.data.ok && (
                <p className="text-[10px] leading-relaxed text-loss">{testState.data.message}</p>
              )}
              {!secretStatus?.present && (
                <Link
                  to="/data"
                  className="inline-block text-[11px] font-medium text-accent underline-offset-2 hover:underline"
                >
                  Add your API key →
                </Link>
              )}
            </div>
          </Card>

          <Card title="Local cache" subtitle="Phase 3">
            <div className="grid grid-cols-2 gap-3">
              <StatTile label="Contracts" value="—" hint="not yet cached" />
              <StatTile label="Minute bars" value="—" hint="not yet cached" />
            </div>
            <p className="mt-3 text-[10px] leading-relaxed text-ink-faint">
              Persistent local storage of downloaded contracts and bars is the next milestone. Until then,
              Contract Explorer requests go straight to Massive each time.
            </p>
          </Card>

          <Card title="Environment">
            <dl className="space-y-1.5 text-[11px]">
              {[
                ['Version', info?.version],
                ['Electron', info?.electronVersion],
                ['Node', info?.nodeVersion],
                ['Platform', info?.platform]
              ].map(([label, value]) => (
                <div key={label} className="flex justify-between gap-3">
                  <dt className="text-ink-faint">{label}</dt>
                  <dd className="num text-ink-dim">{value ?? '—'}</dd>
                </div>
              ))}
            </dl>
          </Card>
        </div>

        <Card title="Build progress" subtitle="The application is being built in verifiable phases.">
          <ol className="space-y-1.5 text-[11px]">
            {[
              { phase: 'Phase 1', label: 'Electron + React + TypeScript skeleton, settings, secure API key', done: true },
              { phase: 'Phase 2', label: 'Massive client, rate limiter, contract lookup, minute aggregates', done: true },
              { phase: 'Phase 3', label: 'Local cache (DuckDB) so backtests never re-call Massive', done: true },
              { phase: 'Phase 4', label: 'SPX underlying history via CSV import (I:SPX not entitled on Options plans)', done: true },
              { phase: 'Phase 5', label: 'Single butterfly reconstruction, minute by minute', done: true },
              { phase: 'Phase 6', label: 'Single-trade management rules', done: false },
              { phase: 'Phase 7', label: 'Automated entry generation (9 EMA, 7 DTE, placement)', done: false },
              { phase: 'Phase 8', label: 'Batch backtester and summary statistics', done: false },
              { phase: 'Phase 9', label: 'Management comparison and equity curves', done: false },
              { phase: 'Phase 10', label: 'MFE / MAE / conditional path analytics', done: false },
              { phase: 'Phase 11', label: 'Generic parameter sweep', done: false }
            ].map((row) => (
              <li key={row.phase} className="flex items-center gap-2.5">
                <span
                  className={`h-1.5 w-1.5 shrink-0 rounded-full ${row.done ? 'bg-gain' : 'bg-line'}`}
                  aria-hidden="true"
                />
                <span className={`num w-16 shrink-0 ${row.done ? 'text-gain' : 'text-ink-faint'}`}>{row.phase}</span>
                <span className={row.done ? 'text-ink-dim' : 'text-ink-faint'}>{row.label}</span>
              </li>
            ))}
          </ol>
        </Card>

        <Card title="Storage locations">
          <dl className="space-y-1.5 text-[11px]">
            {[
              ['Settings', info?.settingsPath],
              ['Data directory', info?.dataDirectory],
              ['User data', info?.userDataPath]
            ].map(([label, value]) => (
              <div key={label} className="flex flex-col gap-0.5">
                <dt className="text-ink-faint">{label}</dt>
                <dd className="num break-all text-ink-dim">{value ?? '—'}</dd>
              </div>
            ))}
          </dl>
        </Card>
      </div>
    </>
  )
}
