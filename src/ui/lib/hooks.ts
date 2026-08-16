import { useCallback, useEffect, useRef, useState } from 'react'
import type { QueueStats } from '../../shared/queue.js'
import type { LogRecord } from '../../shared/logging.js'

/**
 * Async action state. Pages use this instead of hand-rolling
 * loading/error/result triples, so every request surfaces its failure.
 */
export interface AsyncState<T> {
  data: T | null
  error: string | null
  loading: boolean
}

export function useAsyncAction<TArgs extends unknown[], TResult>(
  action: (...args: TArgs) => Promise<TResult>
): [AsyncState<TResult>, (...args: TArgs) => Promise<TResult | null>, () => void] {
  const [state, setState] = useState<AsyncState<TResult>>({ data: null, error: null, loading: false })
  const mounted = useRef(true)

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])

  const run = useCallback(
    async (...args: TArgs): Promise<TResult | null> => {
      setState((s) => ({ ...s, loading: true, error: null }))
      try {
        const data = await action(...args)
        if (mounted.current) setState({ data, error: null, loading: false })
        return data
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        if (mounted.current) setState({ data: null, error: message, loading: false })
        return null
      }
    },
    [action]
  )

  const reset = useCallback(() => setState({ data: null, error: null, loading: false }), [])

  return [state, run, reset]
}

/** Live queue stats, seeded from a one-shot fetch then kept fresh by push events. */
export function useQueueStats(): QueueStats | null {
  const [stats, setStats] = useState<QueueStats | null>(null)

  useEffect(() => {
    let active = true
    void window.api.queue.stats().then((s) => {
      if (active) setStats(s)
    })
    const unsubscribe = window.api.queue.onStats(setStats)
    return () => {
      active = false
      unsubscribe()
    }
  }, [])

  return stats
}

/** Rolling in-app log tail for the diagnostics view. */
export function useLogTail(limit = 400): [LogRecord[], () => void] {
  const [records, setRecords] = useState<LogRecord[]>([])

  useEffect(() => {
    let active = true
    void window.api.logs.recent(limit).then((initial) => {
      if (active) setRecords(initial)
    })
    const unsubscribe = window.api.logs.onRecord((record) => {
      setRecords((prev) => {
        const next = [...prev, record]
        return next.length > limit ? next.slice(next.length - limit) : next
      })
    })
    return () => {
      active = false
      unsubscribe()
    }
  }, [limit])

  const clear = useCallback(() => {
    void window.api.logs.clear().then(() => setRecords([]))
  }, [])

  return [records, clear]
}

/** A ticking clock, used for rate-limit countdowns. */
export function useNow(intervalMs = 1000): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), intervalMs)
    return () => clearInterval(timer)
  }, [intervalMs])
  return now
}
