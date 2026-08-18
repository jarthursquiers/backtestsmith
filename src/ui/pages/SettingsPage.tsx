import { useCallback, useEffect, useState } from 'react'
import type { AppInfo } from '../../shared/ipc.js'
import type { Settings } from '../../shared/settings.js'
import type { DatabaseBackupResult } from '../../shared/cache.js'
import { Button, Card, Field, Input, Notice, PageHeader, Select, Spinner } from '../components/primitives.js'
import { fmtBytes, fmtInt } from '../lib/format.js'

export function SettingsPage() {
  const [settings, setSettings] = useState<Settings | null>(null)
  const [info, setInfo] = useState<AppInfo | null>(null)
  const [saved, setSaved] = useState(false)
  const [backup, setBackup] = useState<DatabaseBackupResult | null>(null)
  const [backupError, setBackupError] = useState<string | null>(null)
  const [backingUp, setBackingUp] = useState(false)

  const load = useCallback(async () => {
    const [current, appInfo] = await Promise.all([window.api.settings.get(), window.api.app.info()])
    setSettings(current)
    setInfo(appInfo)
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const patch = async (update: Parameters<typeof window.api.settings.update>[0]): Promise<void> => {
    const next = await window.api.settings.update(update)
    setSettings(next)
    setSaved(true)
    setTimeout(() => setSaved(false), 1500)
  }

  const reset = async (): Promise<void> => {
    setSettings(await window.api.settings.reset())
  }

  const backupDatabase = async (): Promise<void> => {
    setBackingUp(true)
    setBackupError(null)
    try {
      const result = await window.api.database.backup()
      if (result) setBackup(result)
    } catch (error) {
      setBackupError(error instanceof Error ? error.message : String(error))
    } finally {
      setBackingUp(false)
    }
  }

  if (!settings) return null

  return (
    <>
      <PageHeader
        title="Settings"
        description="Application defaults. Study-level parameters are configured per study and snapshotted with each run for reproducibility."
        actions={
          <div className="flex items-center gap-2">
            {saved && <span className="text-[11px] text-gain">Saved</span>}
            <Button variant="danger" onClick={() => void reset()}>
              Reset to defaults
            </Button>
          </div>
        }
      />

      <div className="flex-1 space-y-4 overflow-y-auto p-6">
        <div className="grid gap-4 lg:grid-cols-2">
          <Card title="Massive provider">
            <div className="space-y-3">
              <Field label="Requests per minute" hint="0 means unlimited. Free Options Basic is about 5.">
                <Input
                  type="number"
                  min={0}
                  value={settings.massive.requestsPerMinute}
                  onChange={(e) => void patch({ massive: { requestsPerMinute: Math.max(0, Number(e.target.value) || 0) } })}
                />
              </Field>
              <Field label="Request timeout (ms)">
                <Input
                  type="number"
                  min={1000}
                  step={1000}
                  value={settings.massive.timeoutMs}
                  onChange={(e) => void patch({ massive: { timeoutMs: Number(e.target.value) || 30000 } })}
                />
              </Field>
              <Field label="Max retries" hint="Applies to HTTP 429, 5xx, and transient network failures.">
                <Input
                  type="number"
                  min={0}
                  max={10}
                  value={settings.massive.maxRetries}
                  onChange={(e) => void patch({ massive: { maxRetries: Number(e.target.value) || 0 } })}
                />
              </Field>
            </div>
          </Card>

          <Card
            title="Research defaults"
            subtitle="Starting values for new studies. Every one is overridable per study."
          >
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Underlying">
                <Input
                  value={settings.research.underlying}
                  onChange={(e) => void patch({ research: { underlying: e.target.value.toUpperCase() } })}
                />
              </Field>
              <Field label="Entry time (ET)" hint="Default 09:35">
                <Input
                  value={settings.research.entryTimeEastern}
                  onChange={(e) => void patch({ research: { entryTimeEastern: e.target.value } })}
                />
              </Field>
              <Field label="Target DTE" hint="Calendar days">
                <Input
                  type="number"
                  min={0}
                  value={settings.research.targetDte}
                  onChange={(e) => void patch({ research: { targetDte: Number(e.target.value) || 0 } })}
                />
              </Field>
              <Field label="Wing width" hint="SPX points">
                <Input
                  type="number"
                  min={1}
                  value={settings.research.wingWidth}
                  onChange={(e) => void patch({ research: { wingWidth: Number(e.target.value) || 25 } })}
                />
              </Field>
            </div>
          </Card>
        </div>

        <div className="grid gap-4 lg:grid-cols-2">
          <Card title="Diagnostics">
            <Field label="Log level" hint="Controls what is recorded, not just what is displayed.">
              <Select
                value={settings.logLevel}
                onChange={(e) => void patch({ logLevel: e.target.value as Settings['logLevel'] })}
              >
                <option value="debug">Debug</option>
                <option value="info">Info</option>
                <option value="warn">Warn</option>
                <option value="error">Error</option>
              </Select>
            </Field>
          </Card>

          <Card title="Storage">
            <div className="space-y-3">
              <Field
                label="Data directory"
                hint="Leave empty to use the default under the application's user-data folder. Takes effect for new downloads."
              >
                <Input
                  value={settings.data.directory}
                  placeholder={info?.dataDirectory ?? ''}
                  onChange={(e) => void patch({ data: { directory: e.target.value } })}
                />
              </Field>
              <Notice tone="info">
                A database backup contains cached option contracts, option minute bars, SPX underlying bars,
                coverage records, saved studies, and forward tests. API keys and broker credentials remain
                separately encrypted and are intentionally excluded.
              </Notice>
              <Button variant="primary" disabled={backingUp} onClick={() => void backupDatabase()}>
                {backingUp && <Spinner />} Create verified database backup...
              </Button>
              <p className="text-[10px] leading-relaxed text-ink-faint">
                Choose your Google Drive folder in the save dialog. The app creates a standalone DuckDB file,
                reopens it independently, verifies table counts, and calculates a SHA-256 checksum before reporting success.
              </p>
              {backupError && <Notice tone="error">{backupError}</Notice>}
              {backup && (
                <Notice tone={backup.referencedTickersMissingContracts === 0 && backup.referencedTickersMissingBars === 0 ? 'success' : 'warn'}>
                  <div className="font-medium">Verified backup created</div>
                  <div className="mt-1 break-all num">{backup.path}</div>
                  <div className="mt-1 break-all num text-[9px]">Manifest: {backup.manifestPath}</div>
                  <div className="mt-2 grid gap-x-4 gap-y-1 sm:grid-cols-2">
                    <span>{fmtBytes(backup.bytes)} database file</span>
                    <span>{fmtInt(backup.optionContracts)} option contracts</span>
                    <span>{fmtInt(backup.optionBars)} option minute bars</span>
                    <span>{fmtInt(backup.underlyingBars)} underlying bars</span>
                    <span>Options: {backup.optionEarliestDate ?? '—'} to {backup.optionLatestDate ?? '—'}</span>
                    <span>Underlying: {backup.underlyingEarliestDate ?? '—'} to {backup.underlyingLatestDate ?? '—'}</span>
                    <span>{fmtInt(backup.studyRuns)} saved studies</span>
                    <span>{fmtInt(backup.forwardTests)} forward tests</span>
                    <span>Study dates: {backup.studyEarliestDate ?? '—'} to {backup.studyLatestDate ?? '—'}</span>
                    <span>{fmtInt(backup.referencedOptionTickers)} study-referenced option tickers</span>
                    <span>{fmtInt(backup.referencedTickersMissingContracts)} referenced contracts missing</span>
                    <span>{fmtInt(backup.referencedTickersMissingBars)} referenced bar series missing</span>
                  </div>
                  <div className="mt-2 break-all num text-[9px]">SHA-256: {backup.sha256}</div>
                </Notice>
              )}
            </div>
          </Card>
        </div>
      </div>
    </>
  )
}
