import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { HttpError, QueueAbortError, RequestQueue } from './requestQueue.js'

/** Flushes pending microtasks so queue state settles between timer advances. */
const tick = async (): Promise<void> => {
  await Promise.resolve()
  await Promise.resolve()
}

describe('RequestQueue pacing', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('dispatches up to the RPM limit immediately, then waits for the window', async () => {
    const queue = new RequestQueue({ requestsPerMinute: 2 })
    const started: number[] = []
    const task = () => {
      started.push(Date.now())
      return Promise.resolve('ok')
    }

    const promises = [
      queue.enqueue(task, { label: 'a' }),
      queue.enqueue(task, { label: 'b' }),
      queue.enqueue(task, { label: 'c' })
    ]

    await tick()
    expect(started).toHaveLength(2) // third is throttled

    await vi.advanceTimersByTimeAsync(60_000)
    await Promise.all(promises)

    expect(started).toHaveLength(3)
    // The third dispatch waits a full minute after the first.
    expect(started[2]! - started[0]!).toBeGreaterThanOrEqual(60_000)
  })

  it('treats a non-positive RPM as unlimited', async () => {
    const queue = new RequestQueue({ requestsPerMinute: 0, maxConcurrent: 10 })
    const started: number[] = []
    const results = await Promise.all(
      Array.from({ length: 25 }, () =>
        queue.enqueue(() => {
          started.push(Date.now())
          return Promise.resolve(1)
        })
      )
    )
    expect(results).toHaveLength(25)
    expect(queue.getStats().nextSlotAt).toBeNull()
  })

  it('reports queue depth and next available slot', async () => {
    const queue = new RequestQueue({ requestsPerMinute: 1 })
    void queue.enqueue(() => Promise.resolve(1))
    void queue.enqueue(() => Promise.resolve(2))
    await tick()

    const stats = queue.getStats()
    expect(stats.queued).toBe(1)
    expect(stats.requestsPerMinute).toBe(1)
    expect(stats.nextSlotAt).not.toBeNull()

    await vi.advanceTimersByTimeAsync(60_000)
  })

  it('applies a raised rate limit to already-queued work', async () => {
    const queue = new RequestQueue({ requestsPerMinute: 1 })
    const started: string[] = []
    const promises = [
      queue.enqueue(() => { started.push('a'); return Promise.resolve(1) }),
      queue.enqueue(() => { started.push('b'); return Promise.resolve(2) })
    ]
    await tick()
    expect(started).toEqual(['a'])

    // Simulates upgrading the Massive plan mid-download.
    queue.setRequestsPerMinute(0)
    await tick()
    expect(started).toEqual(['a', 'b'])
    await Promise.all(promises)
  })
})

describe('RequestQueue retries', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('retries a 429 and honors Retry-After over exponential backoff', async () => {
    const queue = new RequestQueue({ requestsPerMinute: 0, baseRetryDelayMs: 1000 })
    let attempts = 0
    const promise = queue.enqueue(() => {
      attempts++
      if (attempts === 1) {
        return Promise.reject(new HttpError(429, 'Too Many Requests', { retryAfterMs: 30_000 }))
      }
      return Promise.resolve('recovered')
    })

    await tick()
    expect(attempts).toBe(1)

    // Exponential backoff alone would have retried well before 30s.
    await vi.advanceTimersByTimeAsync(5_000)
    expect(attempts).toBe(1)

    await vi.advanceTimersByTimeAsync(26_000)
    await expect(promise).resolves.toBe('recovered')
    expect(attempts).toBe(2)
    expect(queue.getStats().retried).toBe(1)
  })

  it('retries 5xx with exponential backoff and eventually gives up', async () => {
    const queue = new RequestQueue({ requestsPerMinute: 0, maxRetries: 2, baseRetryDelayMs: 100 })
    let attempts = 0
    const promise = queue.enqueue(() => {
      attempts++
      return Promise.reject(new HttpError(503, 'Service Unavailable'))
    })
    const assertion = expect(promise).rejects.toThrow(/Service Unavailable/)

    await vi.advanceTimersByTimeAsync(10_000)
    await assertion

    expect(attempts).toBe(3) // initial try plus 2 retries
    expect(queue.getStats().failed).toBe(1)
  })

  it('does not retry client errors', async () => {
    const queue = new RequestQueue({ requestsPerMinute: 0, baseRetryDelayMs: 10 })
    let attempts = 0
    const promise = queue.enqueue(() => {
      attempts++
      return Promise.reject(new HttpError(401, 'Unauthorized'))
    })
    const assertion = expect(promise).rejects.toThrow(/Unauthorized/)
    await vi.advanceTimersByTimeAsync(5_000)
    await assertion
    expect(attempts).toBe(1)
  })

  it('retries transient network failures', async () => {
    const queue = new RequestQueue({ requestsPerMinute: 0, baseRetryDelayMs: 10 })
    let attempts = 0
    const promise = queue.enqueue(() => {
      attempts++
      if (attempts < 3) return Promise.reject(new TypeError('fetch failed'))
      return Promise.resolve('ok')
    })
    await vi.advanceTimersByTimeAsync(5_000)
    await expect(promise).resolves.toBe('ok')
    expect(attempts).toBe(3)
  })
})

describe('RequestQueue control', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('pauses and resumes dispatch', async () => {
    const queue = new RequestQueue({ requestsPerMinute: 0 })
    queue.pause()

    const started: string[] = []
    const promise = queue.enqueue(() => {
      started.push('ran')
      return Promise.resolve(1)
    })

    await tick()
    expect(started).toHaveLength(0)
    expect(queue.getStats().paused).toBe(true)
    expect(queue.getStats().queued).toBe(1)

    queue.resume()
    await tick()
    await promise
    expect(started).toEqual(['ran'])
    expect(queue.getStats().paused).toBe(false)
  })

  it('runs higher priority work first', async () => {
    const queue = new RequestQueue({ requestsPerMinute: 0, maxConcurrent: 1 })
    queue.pause()
    const order: string[] = []
    const mk = (name: string, priority: number) =>
      queue.enqueue(() => { order.push(name); return Promise.resolve(name) }, { priority, label: name })

    const all = [mk('low', 200), mk('high', 1), mk('mid', 100)]
    queue.resume()
    await vi.advanceTimersByTimeAsync(100)
    await Promise.all(all)

    expect(order).toEqual(['high', 'mid', 'low'])
  })

  it('rejects work cancelled before dispatch', async () => {
    const queue = new RequestQueue({ requestsPerMinute: 0 })
    queue.pause()
    const controller = new AbortController()
    const promise = queue.enqueue(() => Promise.resolve('nope'), { signal: controller.signal })
    controller.abort()
    queue.resume()

    await expect(promise).rejects.toBeInstanceOf(QueueAbortError)
  })

  it('cancelAll drains pending work', async () => {
    const queue = new RequestQueue({ requestsPerMinute: 0 })
    queue.pause()
    const a = queue.enqueue(() => Promise.resolve(1))
    const b = queue.enqueue(() => Promise.resolve(2))
    queue.cancelAll('user stopped download')

    await expect(a).rejects.toThrow(/user stopped download/)
    await expect(b).rejects.toThrow(/user stopped download/)
    expect(queue.getStats().queued).toBe(0)
  })
})
