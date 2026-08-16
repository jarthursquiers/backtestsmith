import { EventEmitter } from 'node:events'
import { LOG_LEVEL_RANK as LEVEL_RANK, type LogLevel, type LogRecord } from '../shared/logging.js'

/**
 * Structured logging with an in-memory ring buffer so the app can show a
 * diagnostics view without reading files off disk. Records are plain objects so
 * they serialize straight over IPC.
 */
export type { LogLevel, LogRecord } from '../shared/logging.js'

export interface LoggerOptions {
  /** Records retained in memory before the oldest are dropped. */
  bufferSize?: number
  minLevel?: LogLevel
  /** Mirror records to the console. Useful in dev, noisy in packaged builds. */
  console?: boolean
}

class LogStore extends EventEmitter {
  private records: LogRecord[] = []
  private nextId = 1
  private bufferSize: number
  private minLevel: LogLevel
  private toConsole: boolean

  constructor(options: LoggerOptions = {}) {
    super()
    this.setMaxListeners(50)
    this.bufferSize = options.bufferSize ?? 5000
    this.minLevel = options.minLevel ?? 'debug'
    // Test runs assert on behavior, not stdout; mirroring there is pure noise.
    this.toConsole = options.console ?? process.env.VITEST === undefined
  }

  setMinLevel(level: LogLevel): void {
    this.minLevel = level
  }

  write(level: LogLevel, scope: string, message: string, data?: Record<string, unknown>): void {
    if (LEVEL_RANK[level] < LEVEL_RANK[this.minLevel]) return

    const record: LogRecord = {
      id: this.nextId++,
      timestamp: Date.now(),
      level,
      scope,
      message,
      ...(data ? { data } : {})
    }

    this.records.push(record)
    if (this.records.length > this.bufferSize) {
      this.records.splice(0, this.records.length - this.bufferSize)
    }

    if (this.toConsole) {
      const line = `[${new Date(record.timestamp).toISOString()}] ${level.toUpperCase()} ${scope}: ${message}`
      const sink = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log
      if (data) sink(line, data)
      else sink(line)
    }

    this.emit('record', record)
  }

  /** Most recent records, oldest first. */
  recent(limit = 500, minLevel: LogLevel = 'debug'): LogRecord[] {
    const filtered = this.records.filter((r) => LEVEL_RANK[r.level] >= LEVEL_RANK[minLevel])
    return filtered.slice(-limit)
  }

  clear(): void {
    this.records = []
    this.emit('cleared')
  }
}

export const logStore = new LogStore()

export interface Logger {
  debug(message: string, data?: Record<string, unknown>): void
  info(message: string, data?: Record<string, unknown>): void
  warn(message: string, data?: Record<string, unknown>): void
  error(message: string, data?: Record<string, unknown>): void
  child(subScope: string): Logger
}

/** Creates a scoped logger, e.g. createLogger('massive.client'). */
export function createLogger(scope: string): Logger {
  return {
    debug: (m, d) => logStore.write('debug', scope, m, d),
    info: (m, d) => logStore.write('info', scope, m, d),
    warn: (m, d) => logStore.write('warn', scope, m, d),
    error: (m, d) => logStore.write('error', scope, m, d),
    child: (subScope: string) => createLogger(`${scope}.${subScope}`)
  }
}
