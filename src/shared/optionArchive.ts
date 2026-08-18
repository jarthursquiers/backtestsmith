export interface OptionArchiveRequest {
  underlying: string
  from: string
  to: string
  /** Maximum calendar DTE to retain for every entry session in the range. */
  maxDte: number
}

export interface OptionArchiveProgress {
  phase: 'discovering' | 'cataloging' | 'downloading' | 'done' | 'paused' | 'failed'
  completed: number
  total: number
  stage: string
  expiration?: string
  ticker?: string
  expirations: number
  contracts: number
  contractDays: number
  /** Contract-days proven complete from a prior archive or study download. */
  cachedContractDays: number
  /** Contract-days completed by API responses during this invocation. */
  downloadedContractDays: number
  apiRequests: number
  elapsedMs: number
  error?: string
}

export interface OptionArchiveStatus {
  running: boolean
  progress: OptionArchiveProgress | null
}

export interface OptionArchiveResult {
  cancelled: boolean
  expirations: number
  contracts: number
  contractDays: number
  apiRequests: number
  elapsedMs: number
}
