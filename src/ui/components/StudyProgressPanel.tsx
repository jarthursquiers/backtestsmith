import { useEffect, useRef, useState } from 'react'
import type { StudyProgress } from '../../shared/study.js'
import { Badge, Card, Notice, StatTile } from './primitives.js'
import { fmtInt } from '../lib/format.js'
import { useQueueStats } from '../lib/hooks.js'

/**
 * Live study status.
 *
 * Deliberately owns its own subscription rather than receiving progress as a
 * prop. Progress arrives every few hundred milliseconds, and driving it from a
 * parent's state re-rendered the whole configuration form - dozens of inputs and
 * chips - on every tick, which is what made the page jitter. Isolating it here
 * means only this card repaints.
 */

function humanDuration(ms: number | undefined): string {
  if (ms === undefined) return '—'
  const total = Math.round(ms / 1000)
  const minutes = Math.floor(total / 60)
  const seconds = total % 60
  return minutes > 0 ? `${minutes}m ${String(seconds).padStart(2, '0')}s` : `${seconds}s`
}

const PHASE_LABEL: Record<StudyProgress['phase'], string> = {
  preparing: 'Preparing data',
  preflight: 'Checking data',
  entries: 'Generating entries',
  saving: 'Saving',
  done: 'Complete',
  cancelled: 'Cancelled',
  failed: 'Failed'
}

export function StudyProgressPanel() {
  const [progress, setProgress] = useState<StudyProgress | null>(null)
  /** Wall-clock tick, so elapsed keeps counting between provider updates. */
  const [, setTick] = useState(0)
  const lastUpdate = useRef<number>(Date.now())
  const queue = useQueueStats()

  useEffect(() => {
    return window.api.study.onProgress((next) => {
      lastUpdate.current = Date.now()
      setProgress(next)
    })
  }, [])

  useEffect(() => {
    // Provider requests can be long-running, so keep elapsed time moving even
    // when no new progress event has arrived.
    const timer = setInterval(() => setTick((t) => t + 1), 1000)
    return () => clearInterval(timer)
  }, [])

  if (!progress) return null

  const running = progress.phase === 'preparing' || progress.phase === 'entries' || progress.phase === 'preflight'
  const percent = progress.total > 0 ? (progress.completed / progress.total) * 100 : 0
  const sinceUpdate = Date.now() - lastUpdate.current
  const elapsed = (progress.elapsedMs ?? 0) + (running ? sinceUpdate : 0)

  /*
   * A long gap is only a provider wait when there is actually upstream work in
   * flight. Saying so unconditionally sent readers looking for a network
   * problem during phases that never touch the network - preflight reads the
   * local cache, and a slow one means a slow query, not a slow provider.
   */
  const upstreamBusy = (queue?.inFlight ?? 0) > 0 || (queue?.queued ?? 0) > 0
  const stalled = sinceUpdate > 30_000

  const reasons = Object.entries(progress.skipReasons ?? {}).sort((a, b) => b[1] - a[1])
  const everythingSkipped = progress.skipped > 0 && progress.tradesGenerated === 0

  return (
    <Card
      title={`Study: ${PHASE_LABEL[progress.phase]}`}
      subtitle={progress.stage ? `${progress.currentDate ?? ''} · ${progress.stage}` : progress.currentDate}
      actions={
        <div className="flex items-center gap-2">
          {running && (
            <Badge tone={stalled ? 'warn' : 'accent'}>
              {!stalled
                ? 'running'
                : upstreamBusy
                  ? `waiting for provider · ${Math.round(sinceUpdate / 1000)}s`
                  : `working · ${Math.round(sinceUpdate / 1000)}s`}
            </Badge>
          )}
          {progress.phase === 'done' && <Badge tone="gain">complete</Badge>}
          {progress.phase === 'failed' && <Badge tone="loss">failed</Badge>}
          {progress.phase === 'cancelled' && <Badge tone="warn">cancelled</Badge>}
        </div>
      }
    >
      <div className="space-y-3">
        {progress.error && <Notice tone="error">{progress.error}</Notice>}

        <div className="h-1.5 w-full overflow-hidden rounded-full bg-line">
          <div
            className={`h-full ${progress.phase === 'failed' ? 'bg-loss' : 'bg-accent'}`}
            style={{ width: `${Math.min(100, percent)}%` }}
          />
        </div>

        <div className="grid grid-cols-2 gap-3 md:grid-cols-6">
          <StatTile label="Session" value={`${progress.completed}/${progress.total}`} />
          <StatTile
            label="Entries"
            value={fmtInt(progress.tradesGenerated)}
            tone={progress.tradesGenerated > 0 ? 'gain' : 'neutral'}
          />
          <StatTile
            label="Skipped"
            value={fmtInt(progress.skipped)}
            tone={progress.skipped > 0 ? 'warn' : 'neutral'}
          />
          <StatTile label="Requests" value={fmtInt(progress.apiRequests ?? 0)} hint="upstream calls" />
          <StatTile label="Elapsed" value={humanDuration(elapsed)} />
          <StatTile
            label="Remaining"
            value={running ? humanDuration(progress.estimatedRemainingMs) : '—'}
            hint="estimated"
          />
        </div>

        {/*
          Shown during the run, not buried afterwards. A study that skips
          everything should be diagnosable in its first seconds.
        */}
        {reasons.length > 0 && (
          <div>
            <div className="mb-1.5 flex items-center gap-2">
              <span className="text-[11px] font-medium text-ink-dim">Why sessions were skipped</span>
              {everythingSkipped && <Badge tone="loss">nothing is being traded</Badge>}
            </div>
            <div className="overflow-hidden rounded-md border border-line">
              <table className="w-full border-collapse text-[11px]">
                <tbody className="num">
                  {reasons.map(([reason, count]) => (
                    <tr key={reason} className="border-b border-line-soft last:border-0">
                      <td className="w-14 px-3 py-1 text-right text-warn">{count}</td>
                      <td className="px-3 py-1 text-ink-dim">{reason}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {(progress.recentSkips?.length ?? 0) > 0 && (
          <div>
            <div className="mb-1.5 text-[11px] font-medium text-ink-dim">Recent skip details</div>
            <div className="max-h-36 space-y-1 overflow-y-auto rounded-md border border-line bg-ground p-2 num text-[10px] leading-relaxed text-ink-faint">
              {progress.recentSkips!.map((item) => (
                <div key={`${item.date}-${item.reason}`}>
                  <span className="text-warn">{item.date}</span>: {item.reason}
                </div>
              ))}
            </div>
          </div>
        )}

        {everythingSkipped && (
          <Notice tone="warn">
            Every session so far has been skipped, so this run will produce nothing. The reason above is the
            whole story — fix that and re-run rather than waiting for it to finish.
          </Notice>
        )}

        {running && (
          <p className="text-[10px] leading-relaxed text-ink-faint">
            Cached ranges are read locally; missing ranges are downloaded and verified automatically. A long gap
            means an upstream request is still running. Progress is also written to the terminal, prefixed{' '}
            <code className="num">[study]</code>.
          </p>
        )}
      </div>
    </Card>
  )
}
