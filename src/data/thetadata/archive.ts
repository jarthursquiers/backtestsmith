import type { OptionContract } from '../../domain/contracts.js'
import type { MarketDate } from '../../core/time/marketTime.js'
import { addCalendarDays, tradingDaysBetween } from '../../core/time/marketTime.js'
import type {
  OptionArchiveProgress,
  OptionArchiveRequest,
  OptionArchiveResult
} from '../../shared/optionArchive.js'

export interface OptionArchiveSource {
  listExpirations(underlying: string, signal?: AbortSignal): Promise<MarketDate[]>
  getContracts(underlying: string, expiration: MarketDate, signal?: AbortSignal): Promise<OptionContract[]>
  isExpirationDayCovered(contracts: OptionContract[], date: MarketDate): Promise<boolean>
  archiveExpirationDay(contracts: OptionContract[], date: MarketDate, signal?: AbortSignal): Promise<void>
  requestCount(): number
}

export interface OptionArchiveHooks {
  signal?: AbortSignal
  onProgress?: (progress: OptionArchiveProgress) => void
}

export function archiveExpirationRange(request: OptionArchiveRequest): { from: MarketDate; to: MarketDate } {
  return {
    from: request.from,
    to: addCalendarDays(request.to, request.maxDte)
  }
}

/** Sessions on which this contract can be used by an entry in the requested DTE envelope. */
export function archiveQuoteDates(
  request: OptionArchiveRequest,
  expiration: MarketDate
): MarketDate[] {
  const first = request.from > addCalendarDays(expiration, -request.maxDte)
    ? request.from
    : addCalendarDays(expiration, -request.maxDte)
  const last = request.to < expiration ? request.to : expiration
  return first > last ? [] : tradingDaysBetween(first, last)
}

export function validateOptionArchiveRequest(request: OptionArchiveRequest): void {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(request.from) || !/^\d{4}-\d{2}-\d{2}$/.test(request.to)) {
    throw new Error('Archive dates must use YYYY-MM-DD.')
  }
  if (request.from > request.to) throw new Error('Archive start must be on or before its end.')
  if (!Number.isInteger(request.maxDte) || request.maxDte < 0 || request.maxDte > 365) {
    throw new Error('Maximum DTE must be an integer between 0 and 365.')
  }
  if (!request.underlying.trim()) throw new Error('An option underlying is required.')
}

/**
 * Resumable SPX option archive. Coverage is checked before every complete
 * root/expiration/session request, and every successful response is committed
 * atomically. Pausing loses at most the one response currently in flight.
 */
export async function runOptionArchive(
  request: OptionArchiveRequest,
  source: OptionArchiveSource,
  hooks: OptionArchiveHooks = {}
): Promise<OptionArchiveResult> {
  validateOptionArchiveRequest(request)
  const startedAt = Date.now()
  const requestsAtStart = source.requestCount()
  let completed = 0
  let contractCount = 0
  let contractDays = 0
  let cachedContractDays = 0
  let downloadedContractDays = 0

  const report = (
    phase: OptionArchiveProgress['phase'],
    stage: string,
    total: number,
    extra: Pick<OptionArchiveProgress, 'expiration' | 'ticker'> = {}
  ): void => hooks.onProgress?.({
    phase,
    completed,
    total,
    stage,
    ...extra,
    expirations: expirations.length,
    contracts: contractCount,
    contractDays,
    cachedContractDays,
    downloadedContractDays,
    apiRequests: source.requestCount() - requestsAtStart,
    elapsedMs: Date.now() - startedAt
  })

  // Declared before report is first called so progress construction stays in
  // one place without maintaining a second partially populated shape.
  let expirations: MarketDate[] = []
  report('discovering', 'listing SPX expirations', 1)
  const available = await source.listExpirations(request.underlying, hooks.signal)
  const range = archiveExpirationRange(request)
  expirations = [...new Set(available)]
    .filter((date) => /^\d{4}-\d{2}-\d{2}$/.test(date) && date >= range.from && date <= range.to)
    .sort()
  if (expirations.length === 0) {
    throw new Error(`ThetaData returned no ${request.underlying} expirations between ${range.from} and ${range.to}.`)
  }

  completed = 0
  for (const expiration of expirations) {
    if (hooks.signal?.aborted) break
    report('cataloging', `cataloging ${expiration}`, expirations.length, { expiration })
    const contracts = await source.getContracts(request.underlying, expiration, hooks.signal)
    const unique = new Set(contracts.map((contract) => contract.ticker))
    contractCount += unique.size
    contractDays += unique.size * archiveQuoteDates(request, expiration).length
    completed++
  }

  if (hooks.signal?.aborted) {
    report('paused', 'archive paused while cataloging; completed coverage is retained', expirations.length)
    return result(true)
  }

  if (contractCount === 0) {
    throw new Error('ThetaData returned no SPX/SPXW contracts for the archive expiration range.')
  }

  completed = 0
  for (const expiration of expirations) {
    if (hooks.signal?.aborted) break
    const quoteDates = archiveQuoteDates(request, expiration)
    const contracts = await source.getContracts(request.underlying, expiration, hooks.signal)
    const unique = [...new Map(contracts.map((contract) => [contract.ticker, contract])).values()]

    const byRoot = new Map<string, OptionContract[]>()
    for (const contract of unique) {
      const root = contract.root ?? request.underlying.toUpperCase()
      const bucket = byRoot.get(root)
      if (bucket) bucket.push(contract)
      else byRoot.set(root, [contract])
    }

    for (const [root, rootContracts] of byRoot) {
      for (const date of quoteDates) {
        if (hooks.signal?.aborted) break
        const covered = await source.isExpirationDayCovered(rootContracts, date)
        if (covered) cachedContractDays += rootContracts.length
        else {
          await source.archiveExpirationDay(rootContracts, date, hooks.signal)
          downloadedContractDays += rootContracts.length
        }
        completed += rootContracts.length
        report('downloading', `${covered ? 'verified' : 'archived'} ${root} ${expiration} on ${date}`, contractDays, {
          expiration,
          ticker: root
        })
      }
    }
  }

  if (hooks.signal?.aborted) {
    report('paused', 'archive paused; completed coverage is retained', contractDays)
    return result(true)
  }

  completed = contractDays
  report('done', 'archive complete', contractDays)
  return result(false)

  function result(cancelled: boolean): OptionArchiveResult {
    return {
      cancelled,
      expirations: expirations.length,
      contracts: contractCount,
      contractDays: completed,
      apiRequests: source.requestCount() - requestsAtStart,
      elapsedMs: Date.now() - startedAt
    }
  }
}
