import { EventEmitter } from 'node:events'
import type { QueueStats } from '../shared/queue.js'

/**
 * Provider-agnostic rate-limited request queue.
 *
 * The free Massive "Options Basic" plan allows roughly 5 calls per minute, which
 * is slow enough that download pacing has to be a first-class, observable,
 * pausable thing rather than a sleep() buried in a fetch wrapper. The queue is
 * deliberately not Massive-specific so a second provider can reuse it.
 *
 * Pacing uses a sliding 60-second window: a request may dispatch only when fewer
 * than `requestsPerMinute` dispatches occurred in the trailing minute. That is
 * stricter than a fixed-bucket limiter, which can burst 2x across a boundary.
 */

/** Error shape the default retry classifier understands. */
export class HttpError extends Error {
  readonly status: number
  readonly retryAfterMs: number | null
  readonly body: string | undefined

  constructor(status: number, message: string, opts: { retryAfterMs?: number | null; body?: string } = {}) {
    super(message)
    this.name = 'HttpError'
    this.status = status
    this.retryAfterMs = opts.retryAfterMs ?? null
    this.body = opts.body
  }
}

/** Raised when a task is abandoned because its queue or caller aborted it. */
export class QueueAbortError extends Error {
  constructor(message = 'Request aborted') {
    super(message)
    this.name = 'QueueAbortError'
  }
}

export interface RequestQueueOptions {
  /** Dispatches allowed per trailing 60s. Use 0 or Infinity for unlimited. */
  requestsPerMinute: number
  /** Parallel in-flight requests. Keep at 1 for low-RPM plans. */
  maxConcurrent?: number
  /** Retry attempts after the initial try. */
  maxRetries?: number
  baseRetryDelayMs?: number
  maxRetryDelayMs?: number
  /** Overrides the default transient-error classifier. */
  isRetryable?: (error: unknown) => boolean
}

export type { QueueStats } from '../shared/queue.js'

export interface EnqueueOptions {
  /** Human-readable label surfaced in the queue UI and logs. */
  label?: string
  /** Lower runs first; ties break FIFO. */
  priority?: number
  /** Caller-side cancellation. */
  signal?: AbortSignal
}

interface QueuedTask<T = unknown> {
  id: number
  label: string
  priority: number
  seq: number
  attempts: number
  run: (signal: AbortSignal) => Promise<T>
  resolve: (value: T) => void
  reject: (error: unknown) => void
  signal?: AbortSignal
}

/** 429 and 5xx are transient; network-layer failures usually are too. */
function defaultIsRetryable(error: unknown): boolean {
  if (error instanceof QueueAbortError) return false
  if (error instanceof HttpError) {
    return error.status === 429 || error.status === 408 || error.status >= 500
  }
  if (error instanceof Error) {
    // Undici/node network faults surface as TypeError('fetch failed') with a cause.
    const code = (error as NodeJS.ErrnoException).code
    if (code && ['ECONNRESET', 'ETIMEDOUT', 'ECONNREFUSED', 'EAI_AGAIN', 'ENOTFOUND', 'UND_ERR_CONNECT_TIMEOUT'].includes(code)) {
      return true
    }
    if (error.name === 'AbortError') return false
    if (error.message === 'fetch failed') return true
  }
  return false
}

const sleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new QueueAbortError())
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = (): void => {
      clearTimeout(timer)
      reject(new QueueAbortError())
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })

export class RequestQueue extends EventEmitter {
  private pending: QueuedTask<never>[] = []
  private dispatchTimes: number[] = []
  private inFlight = 0
  private completed = 0
  private failed = 0
  private retried = 0
  private paused = false
  private nextId = 1
  private seqCounter = 0
  private pumping = false
  private pumpTimer: NodeJS.Timeout | null = null
  private abortController = new AbortController()

  private rpm: number
  private readonly maxConcurrent: number
  private readonly maxRetries: number
  private readonly baseRetryDelayMs: number
  private readonly maxRetryDelayMs: number
  private readonly isRetryable: (error: unknown) => boolean

  constructor(options: RequestQueueOptions) {
    super()
    this.setMaxListeners(50)
    this.rpm = normalizeRpm(options.requestsPerMinute)
    this.maxConcurrent = Math.max(1, options.maxConcurrent ?? 1)
    this.maxRetries = options.maxRetries ?? 4
    this.baseRetryDelayMs = options.baseRetryDelayMs ?? 1000
    this.maxRetryDelayMs = options.maxRetryDelayMs ?? 60_000
    this.isRetryable = options.isRetryable ?? defaultIsRetryable
  }

  enqueue<T>(run: (signal: AbortSignal) => Promise<T>, options: EnqueueOptions = {}): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const task: QueuedTask<T> = {
        id: this.nextId++,
        label: options.label ?? 'request',
        priority: options.priority ?? 100,
        seq: this.seqCounter++,
        attempts: 0,
        run,
        resolve,
        reject,
        ...(options.signal ? { signal: options.signal } : {})
      }

      if (options.signal?.aborted) {
        reject(new QueueAbortError())
        return
      }

      this.pending.push(task as unknown as QueuedTask<never>)
      this.pending.sort((a, b) => a.priority - b.priority || a.seq - b.seq)
      this.emitStats()
      this.pump()
    })
  }

  pause(): void {
    if (this.paused) return
    this.paused = true
    this.emit('paused')
    this.emitStats()
  }

  resume(): void {
    if (!this.paused) return
    this.paused = false
    this.emit('resumed')
    this.emitStats()
    this.pump()
  }

  isPaused(): boolean {
    return this.paused
  }

  /** Changes pacing at runtime, e.g. after upgrading the Massive plan. */
  setRequestsPerMinute(rpm: number): void {
    this.rpm = normalizeRpm(rpm)
    this.emitStats()
    this.pump()
  }

  getRequestsPerMinute(): number {
    return this.rpm
  }

  /** Rejects every queued task and signals in-flight requests to abort. */
  cancelAll(reason = 'Queue cancelled'): void {
    const pending = this.pending
    this.pending = []
    for (const task of pending) task.reject(new QueueAbortError(reason))
    this.abortController.abort()
    this.abortController = new AbortController()
    this.emitStats()
  }

  getStats(): QueueStats {
    return {
      queued: this.pending.length,
      inFlight: this.inFlight,
      completed: this.completed,
      failed: this.failed,
      retried: this.retried,
      paused: this.paused,
      requestsPerMinute: this.rpm,
      nextSlotAt: this.nextSlotAt()
    }
  }

  private emitStats(): void {
    this.emit('stats', this.getStats())
  }

  /** Epoch ms when a dispatch slot frees up, or null if one is available now. */
  private nextSlotAt(): number | null {
    if (!Number.isFinite(this.rpm) || this.rpm <= 0) return null
    const cutoff = Date.now() - 60_000
    const recent = this.dispatchTimes.filter((t) => t > cutoff)
    if (recent.length < this.rpm) return null
    // The oldest dispatch in the window falls out 60s after it happened.
    const oldest = recent[recent.length - this.rpm]
    return oldest === undefined ? null : oldest + 60_000
  }

  private pump(): void {
    if (this.pumping) return
    this.pumping = true
    try {
      this.drain()
    } finally {
      this.pumping = false
    }
  }

  private drain(): void {
    if (this.paused) return

    while (this.pending.length > 0 && this.inFlight < this.maxConcurrent) {
      // Drop tasks whose caller aborted while they waited.
      const head = this.pending[0]
      if (!head) return
      if (head.signal?.aborted) {
        this.pending.shift()
        head.reject(new QueueAbortError())
        this.emitStats()
        continue
      }

      const slot = this.nextSlotAt()
      if (slot !== null) {
        this.scheduleWake(slot - Date.now())
        this.emitStats()
        return
      }

      this.pending.shift()
      this.dispatchTimes.push(Date.now())
      // Keep the window array bounded.
      const cutoff = Date.now() - 60_000
      this.dispatchTimes = this.dispatchTimes.filter((t) => t > cutoff)
      void this.execute(head)
    }
    this.emitStats()
  }

  private scheduleWake(delayMs: number): void {
    if (this.pumpTimer) return
    this.pumpTimer = setTimeout(() => {
      this.pumpTimer = null
      this.pump()
    }, Math.max(10, delayMs))
    // Never hold the Electron main process open on a pacing timer.
    this.pumpTimer.unref?.()
  }

  private async execute(task: QueuedTask<never>): Promise<void> {
    this.inFlight++
    this.emit('request:start', { id: task.id, label: task.label, attempt: task.attempts + 1 })
    this.emitStats()

    const signal = task.signal
      ? AbortSignal.any([task.signal, this.abortController.signal])
      : this.abortController.signal

    try {
      task.attempts++
      const result = await task.run(signal)
      this.completed++
      this.inFlight--
      this.emit('request:success', { id: task.id, label: task.label, attempts: task.attempts })
      task.resolve(result as never)
      this.emitStats()
      this.pump()
    } catch (error) {
      this.inFlight--
      const canRetry = task.attempts <= this.maxRetries && this.isRetryable(error) && !signal.aborted

      if (canRetry) {
        this.retried++
        const delay = this.retryDelay(task.attempts, error)
        this.emit('request:retry', {
          id: task.id,
          label: task.label,
          attempt: task.attempts,
          delayMs: delay,
          error: error instanceof Error ? error.message : String(error)
        })
        this.emitStats()
        try {
          await sleep(delay, signal)
          // Re-queue at the front of its priority band so retries do not starve.
          task.seq = -1 * this.seqCounter++
          this.pending.push(task)
          this.pending.sort((a, b) => a.priority - b.priority || a.seq - b.seq)
          this.pump()
        } catch {
          this.failed++
          task.reject(new QueueAbortError('Aborted during retry backoff'))
          this.emitStats()
        }
        return
      }

      this.failed++
      this.emit('request:failure', {
        id: task.id,
        label: task.label,
        attempts: task.attempts,
        error: error instanceof Error ? error.message : String(error)
      })
      task.reject(error)
      this.emitStats()
      this.pump()
    }
  }

  /**
   * Exponential backoff with full jitter, except when the server sent an
   * explicit Retry-After, which always wins.
   */
  private retryDelay(attempt: number, error: unknown): number {
    if (error instanceof HttpError && error.retryAfterMs != null && error.retryAfterMs > 0) {
      return Math.min(error.retryAfterMs, this.maxRetryDelayMs)
    }
    const exponential = Math.min(this.baseRetryDelayMs * 2 ** (attempt - 1), this.maxRetryDelayMs)
    return Math.round(exponential * (0.5 + Math.random() * 0.5))
  }
}

function normalizeRpm(rpm: number): number {
  if (!Number.isFinite(rpm) || rpm <= 0) return Number.POSITIVE_INFINITY
  return rpm
}
