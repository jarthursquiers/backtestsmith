import { describe, expect, it } from 'vitest'
import type { OptionContract } from '../../domain/contracts.js'
import type { MarketDate } from '../../core/time/marketTime.js'
import type { OptionArchiveProgress } from '../../shared/optionArchive.js'
import { archiveExpirationRange, archiveQuoteDates, runOptionArchive, type OptionArchiveSource } from './archive.js'

const request = { underlying: 'SPX', from: '2025-06-16', to: '2025-06-20', maxDte: 2 }

function contract(ticker: string, expirationDate: string): OptionContract {
  return {
    ticker,
    underlying: 'SPX',
    expirationDate,
    strike: 6000,
    type: ticker.endsWith('C') ? 'call' : 'put'
  }
}

describe('option archive planning', () => {
  it('extends expiration discovery by max DTE', () => {
    expect(archiveExpirationRange(request)).toEqual({ from: '2025-06-16', to: '2025-06-22' })
  })

  it('keeps only trading sessions within the entry range and DTE envelope', () => {
    expect(archiveQuoteDates(request, '2025-06-18')).toEqual(['2025-06-16', '2025-06-17', '2025-06-18'])
    // June 19 is a market holiday.
    expect(archiveQuoteDates(request, '2025-06-20')).toEqual(['2025-06-18', '2025-06-20'])
  })
})

describe('runOptionArchive', () => {
  it('skips covered contract-days and downloads only missing chunks', async () => {
    const calls: { root: string; date: string }[] = []
    let finalProgress: OptionArchiveProgress | null = null
    const chains = new Map<MarketDate, OptionContract[]>([
      ['2025-06-18', [contract('O:SPXW250618C', '2025-06-18'), contract('O:SPXW250618P', '2025-06-18')]],
      ['2025-06-20', [contract('O:SPXW250620C', '2025-06-20'), contract('O:SPXW250620P', '2025-06-20')]]
    ])
    const source: OptionArchiveSource = {
      listExpirations: async () => ['2025-06-13', '2025-06-18', '2025-06-20', '2025-06-23'],
      getContracts: async (_underlying, expiration) => chains.get(expiration) ?? [],
      isExpirationDayCovered: async (_contracts, date) => date === '2025-06-16' || date === '2025-06-18',
      archiveExpirationDay: async (contracts, date) => { calls.push({ root: contracts[0]!.root ?? 'SPX', date }) },
      requestCount: () => calls.length
    }

    const result = await runOptionArchive(request, source, {
      onProgress: (progress) => { finalProgress = progress }
    })

    expect(result).toMatchObject({ cancelled: false, expirations: 2, contracts: 4, contractDays: 10 })
    expect(calls).toEqual([
      { root: 'SPX', date: '2025-06-17' },
      { root: 'SPX', date: '2025-06-20' }
    ])
    expect(finalProgress).toMatchObject({
      phase: 'done', completed: 10, total: 10,
      cachedContractDays: 6, downloadedContractDays: 4
    })
  })
})
