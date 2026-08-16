import { useCallback, useEffect, useState } from 'react'
import type { AppInfo } from '../../shared/ipc.js'
import type { Settings } from '../../shared/settings.js'
import { Button, Card, Field, Input, Notice, PageHeader, Select } from '../components/primitives.js'

export function SettingsPage() {
  const [settings, setSettings] = useState<Settings | null>(null)
  const [info, setInfo] = useState<AppInfo | null>(null)
  const [saved, setSaved] = useState(false)

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
                The Massive API key is stored separately and encrypted with the OS keystore. It is never written
                to settings.json.
              </Notice>
            </div>
          </Card>
        </div>
      </div>
    </>
  )
}
