import { fmtCountdown } from '../lib/format.js'
import { useNow, useQueueStats } from '../lib/hooks.js'

/**
 * Always-visible rate-limit status.
 *
 * On the free 5-calls-per-minute plan the user needs to know at a glance whether
 * the app is working, waiting on the limiter, or paused - otherwise a throttled
 * download is indistinguishable from a hang.
 */
export function QueueIndicator() {
  const stats = useQueueStats()
  const now = useNow(1000)

  if (!stats) {
    return <div className="text-[10px] text-ink-faint">Queue starting…</div>
  }

  const busy = stats.inFlight > 0
  const waiting = stats.queued > 0 && stats.nextSlotAt !== null
  const unlimited = !Number.isFinite(stats.requestsPerMinute)

  const state = stats.paused
    ? { label: 'Paused', dot: 'bg-warn' }
    : busy
      ? { label: 'Requesting', dot: 'bg-accent animate-pulse' }
      : waiting
        ? { label: `Throttled ${fmtCountdown(stats.nextSlotAt, now)}`, dot: 'bg-warn' }
        : { label: 'Idle', dot: 'bg-ink-faint' }

  return (
    <div className="space-y-1">
      <div className="flex items-center gap-1.5">
        <span className={`h-1.5 w-1.5 rounded-full ${state.dot}`} />
        <span className="text-[10px] font-medium text-ink-dim">{state.label}</span>
      </div>
      <div className="num flex items-center gap-2 text-[10px] text-ink-faint">
        <span title="Queued requests">Q {stats.queued}</span>
        <span title="Completed requests">✓ {stats.completed}</span>
        {stats.failed > 0 && (
          <span className="text-loss" title="Failed requests">
            ✕ {stats.failed}
          </span>
        )}
        <span title="Configured requests per minute">{unlimited ? '∞' : `${stats.requestsPerMinute}`}/m</span>
      </div>
    </div>
  )
}
