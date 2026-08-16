/** Log contract shared by the main process emitter and the renderer viewer. */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

export const LOG_LEVEL_RANK: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40
}

export interface LogRecord {
  id: number
  timestamp: number
  level: LogLevel
  /** Subsystem emitting the record, e.g. "massive.client", "backtest". */
  scope: string
  message: string
  /** Arbitrary structured detail; must stay JSON-serializable for IPC. */
  data?: Record<string, unknown>
}
