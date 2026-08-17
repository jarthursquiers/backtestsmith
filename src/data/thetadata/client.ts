import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createInterface } from 'node:readline'
import { createLogger } from '../../services/logger.js'

const log = createLogger('thetadata.client')

interface BridgeResponse {
  id: number
  ok: boolean
  result?: unknown
  error?: string
}

export class ThetaDataClient {
  private process: ChildProcessWithoutNullStreams | null = null
  private nextId = 1
  private completed = 0
  private lastStderr = ''
  private pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>()

  constructor(
    private apiKey: string,
    private readonly bridgePath: string
  ) {}

  setApiKey(key: string): void {
    if (key === this.apiKey) return
    this.apiKey = key
    this.close()
  }

  hasApiKey(): boolean {
    return this.apiKey.trim().length > 0
  }

  get completedRequests(): number {
    return this.completed
  }

  request<T>(operation: string, payload: Record<string, unknown> = {}, signal?: AbortSignal): Promise<T> {
    if (!this.hasApiKey()) return Promise.reject(new Error('No ThetaData API key configured. Add it on the Data screen.'))
    const child = this.ensureProcess()
    const id = this.nextId++

    return new Promise<T>((resolve, reject) => {
      const timeoutMs = 90_000
      const timer = setTimeout(() => {
        if (!this.pending.has(id)) return
        this.pending.delete(id)
        this.close()
        reject(new Error(`ThetaData ${operation} request timed out after 90 seconds`))
      }, timeoutMs)
      timer.unref?.()
      const onAbort = (): void => {
        clearTimeout(timer)
        this.pending.delete(id)
        this.close()
        reject(new Error('ThetaData request cancelled'))
      }
      signal?.addEventListener('abort', onAbort, { once: true })
      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer)
          signal?.removeEventListener('abort', onAbort)
          resolve(value as T)
        },
        reject: (error) => {
          clearTimeout(timer)
          signal?.removeEventListener('abort', onAbort)
          reject(error)
        }
      })
      child.stdin.write(`${JSON.stringify({ id, operation, payload })}\n`)
    })
  }

  close(): void {
    const child = this.process
    this.process = null
    if (child && !child.killed) child.kill()
    this.failPending(new Error('ThetaData helper stopped'))
  }

  private ensureProcess(): ChildProcessWithoutNullStreams {
    if (this.process && !this.process.killed) return this.process

    const child = spawn('py', ['-3.12', '-u', this.bridgePath], {
      env: { ...process.env, THETADATA_API_KEY: this.apiKey },
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe']
    })
    this.process = child

    createInterface({ input: child.stdout }).on('line', (line) => {
      let response: BridgeResponse
      try {
        response = JSON.parse(line) as BridgeResponse
      } catch {
        log.warn('invalid helper response', { line: line.slice(0, 300) })
        return
      }
      const pending = this.pending.get(response.id)
      if (!pending) return
      this.pending.delete(response.id)
      this.completed++
      if (response.ok) pending.resolve(response.result)
      else pending.reject(new Error(response.error ?? 'ThetaData request failed'))
    })
    createInterface({ input: child.stderr }).on('line', (line) => {
      this.lastStderr = line.slice(0, 500)
      log.debug('helper', { message: line })
    })
    child.on('error', (error) => {
      this.process = null
      this.failPending(new Error(`Could not start ThetaData helper: ${error.message}`))
    })
    child.on('exit', (code) => {
      if (this.process === child) this.process = null
      const detail = this.lastStderr ? `: ${this.lastStderr}` : ''
      this.failPending(new Error(`ThetaData helper exited${code === null ? '' : ` with code ${code}`}${detail}`))
    })
    return child
  }

  private failPending(error: Error): void {
    for (const pending of this.pending.values()) pending.reject(error)
    this.pending.clear()
  }
}
