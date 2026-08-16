import { useMemo, useState } from 'react'
import { LOG_LEVEL_RANK as LEVEL_RANK, type LogLevel } from '../../shared/logging.js'
import { Button, Card, EmptyState, PageHeader, Select } from '../components/primitives.js'
import { fmtEasternStamp } from '../lib/format.js'
import { useLogTail } from '../lib/hooks.js'

const LEVEL_STYLE: Record<LogLevel, string> = {
  debug: 'text-ink-faint',
  info: 'text-accent',
  warn: 'text-warn',
  error: 'text-loss'
}

export function DiagnosticsPage() {
  const [records, clear] = useLogTail(600)
  const [minLevel, setMinLevel] = useState<LogLevel>('debug')
  const [filter, setFilter] = useState('')

  const visible = useMemo(() => {
    const needle = filter.trim().toLowerCase()
    return records.filter((record) => {
      if (LEVEL_RANK[record.level] < LEVEL_RANK[minLevel]) return false
      if (!needle) return true
      return (
        record.message.toLowerCase().includes(needle) ||
        record.scope.toLowerCase().includes(needle) ||
        JSON.stringify(record.data ?? {}).toLowerCase().includes(needle)
      )
    })
  }, [records, minLevel, filter])

  return (
    <>
      <PageHeader
        title="Diagnostics"
        description="Structured application log: API requests, retries, rate limiting, data gaps, and schema mismatches. API keys are redacted before anything reaches this view."
        actions={
          <div className="flex items-center gap-2">
            <Select
              value={minLevel}
              onChange={(e) => setMinLevel(e.target.value as LogLevel)}
              className="w-28"
            >
              <option value="debug">All</option>
              <option value="info">Info+</option>
              <option value="warn">Warn+</option>
              <option value="error">Errors</option>
            </Select>
            <Button onClick={clear}>Clear</Button>
          </div>
        }
      />

      <div className="flex flex-1 flex-col overflow-hidden p-6">
        <Card
          title={`Log (${visible.length} of ${records.length})`}
          className="flex min-h-0 flex-1 flex-col"
          actions={
            <input
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder="Filter…"
              className="w-56 rounded-md border border-line bg-surface-2 px-2 py-1 text-[11px] outline-none focus:border-accent"
            />
          }
        >
          {visible.length === 0 ? (
            <EmptyState title="No log records match">
              Interact with the Data or Contract Explorer screens to generate activity.
            </EmptyState>
          ) : (
            <div className="max-h-[calc(100vh-260px)] overflow-y-auto rounded-md border border-line bg-ground">
              <table className="w-full border-collapse text-[10.5px]">
                <tbody className="num">
                  {visible.map((record) => (
                    <tr key={record.id} className="border-b border-line-soft align-top hover:bg-surface">
                      <td className="whitespace-nowrap px-2.5 py-1 text-ink-faint">
                        {fmtEasternStamp(record.timestamp)}
                      </td>
                      <td className={`px-2 py-1 uppercase ${LEVEL_STYLE[record.level]}`}>{record.level}</td>
                      <td className="whitespace-nowrap px-2 py-1 text-ink-faint">{record.scope}</td>
                      <td className="px-2 py-1 text-ink-dim">
                        <div>{record.message}</div>
                        {record.data && (
                          <div className="mt-0.5 break-all text-[10px] text-ink-faint">
                            {JSON.stringify(record.data)}
                          </div>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      </div>
    </>
  )
}
