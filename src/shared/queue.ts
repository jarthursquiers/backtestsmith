/** Request-queue telemetry surfaced to the UI. */
export interface QueueStats {
  queued: number
  inFlight: number
  completed: number
  failed: number
  retried: number
  paused: boolean
  requestsPerMinute: number
  /** Epoch ms when the next dispatch may occur, or null if one may go now. */
  nextSlotAt: number | null
}
