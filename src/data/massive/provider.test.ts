import { describe, expect, it, vi } from 'vitest'
import { RequestQueue } from '../requestQueue.js'
import { MassiveClient, MassiveSchemaError, redact } from './client.js'
import { MassiveProvider } from './provider.js'

/** Builds a provider wired to a scripted fetch, with rate limiting disabled. */
function makeProvider(handler: (url: string) => { status?: number; body: unknown; headers?: Record<string, string> }) {
  const calls: string[] = []
  const fetchImpl = vi.fn(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = String(input)
    calls.push(url)
    const { status = 200, body, headers = {} } = handler(url)
    // Assert auth is applied on every call.
    const auth = new Headers(init?.headers).get('Authorization')
    if (auth !== 'Bearer test-key') throw new Error(`missing bearer auth, got: ${auth}`)
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json', ...headers }
    })
  }) as unknown as typeof fetch

  const queue = new RequestQueue({ requestsPerMinute: 0, maxRetries: 0 })
  const client = new MassiveClient({ apiKey: 'test-key', queue, fetchImpl })
  return { provider: new MassiveProvider(client), calls, client, queue }
}

describe('contract discovery', () => {
  it('requests expired contracts and normalizes them', async () => {
    const { provider, calls } = makeProvider(() => ({
      body: {
        status: 'OK',
        results: [
          {
            ticker: 'O:SPXW250620P05900000',
            underlying_ticker: 'SPX',
            contract_type: 'put',
            strike_price: 5900,
            expiration_date: '2025-06-20',
            exercise_style: 'european',
            shares_per_contract: 100,
            primary_exchange: 'CBOE'
          }
        ]
      }
    }))

    const contracts = await provider.getContracts({
      underlying: 'SPX',
      expirationDate: '2025-06-20',
      type: 'put',
      expired: true
    })

    expect(contracts).toEqual([
      {
        ticker: 'O:SPXW250620P05900000',
        underlying: 'SPX',
        expirationDate: '2025-06-20',
        strike: 5900,
        type: 'put',
        exerciseStyle: 'european',
        sharesPerContract: 100,
        primaryExchange: 'CBOE',
        // Decoded from the symbol so the engine never re-parses vendor tickers.
        root: 'SPXW',
        settlement: 'pm'
      }
    ])

    const url = calls[0]!
    expect(url).toContain('/v3/reference/options/contracts')
    expect(url).toContain('underlying_ticker=SPX')
    expect(url).toContain('expiration_date=2025-06-20')
    expect(url).toContain('contract_type=put')
    expect(url).toContain('expired=true')
  })

  it('defaults to expired=true because research only queries the past', async () => {
    const { provider, calls } = makeProvider(() => ({ body: { status: 'OK', results: [] } }))
    await provider.getContracts({ underlying: 'SPX' })
    expect(calls[0]).toContain('expired=true')
  })

  it('follows next_url pagination', async () => {
    let page = 0
    const { provider, calls } = makeProvider(() => {
      page++
      const mk = (strike: number) => ({
        ticker: `O:SPXW250620P0${strike}000`,
        underlying_ticker: 'SPX',
        contract_type: 'put',
        strike_price: strike,
        expiration_date: '2025-06-20'
      })
      if (page === 1) {
        return {
          body: {
            status: 'OK',
            results: [mk(5900)],
            next_url: 'https://api.massive.com/v3/reference/options/contracts?cursor=abc'
          }
        }
      }
      return { body: { status: 'OK', results: [mk(5910)] } }
    })

    const contracts = await provider.getContracts({ underlying: 'SPX', expirationDate: '2025-06-20' })
    expect(contracts.map((c) => c.strike)).toEqual([5900, 5910])
    expect(calls).toHaveLength(2)
    expect(calls[1]).toContain('cursor=abc')
  })

  it('leaves settlement undefined for roots it cannot classify', async () => {
    const { provider } = makeProvider(() => ({
      body: {
        status: 'OK',
        results: [
          {
            ticker: 'O:SPY251219C00650000',
            underlying_ticker: 'SPY',
            contract_type: 'call',
            strike_price: 650,
            expiration_date: '2025-12-19'
          }
        ]
      }
    }))
    const [contract] = await provider.getContracts({ underlying: 'SPY' })
    expect(contract?.root).toBe('SPY')
    // SPY settlement is not inferable from the root, so we decline to guess.
    expect(contract?.settlement).toBeUndefined()
  })

  it('marks standard AM-settled SPX contracts distinctly from SPXW weeklies', async () => {
    const { provider } = makeProvider(() => ({
      body: {
        status: 'OK',
        results: [
          {
            ticker: 'O:SPX250620C06000000',
            underlying_ticker: 'SPX',
            contract_type: 'call',
            strike_price: 6000,
            expiration_date: '2025-06-20'
          }
        ]
      }
    }))
    const [contract] = await provider.getContracts({ underlying: 'SPX' })
    expect(contract?.root).toBe('SPX')
    expect(contract?.settlement).toBe('am')
  })

  it('drops non-standard contract types instead of guessing', async () => {
    const { provider } = makeProvider(() => ({
      body: {
        status: 'OK',
        results: [
          {
            ticker: 'O:SPXW250620X05900000',
            underlying_ticker: 'SPX',
            contract_type: 'other',
            strike_price: 5900,
            expiration_date: '2025-06-20'
          }
        ]
      }
    }))
    expect(await provider.getContracts({ underlying: 'SPX' })).toEqual([])
  })
})

describe('option bars', () => {
  it('maps compact aggregate fields onto the internal model', async () => {
    const { provider, calls } = makeProvider(() => ({
      body: {
        ticker: 'O:SPXW250620P05900000',
        status: 'OK',
        resultsCount: 2,
        results: [
          { t: 1750427700000, o: 2.0, h: 2.4, l: 1.9, c: 2.2, v: 120, vw: 2.15, n: 8 },
          { t: 1750427760000, o: 2.2, h: 2.6, l: 2.1, c: 2.5, v: 80, vw: 2.4, n: 5 }
        ]
      }
    }))

    const result = await provider.getOptionBars({
      ticker: 'O:SPXW250620P05900000',
      from: '2025-06-20',
      to: '2025-06-20'
    })

    expect(result.empty).toBe(false)
    expect(result.reportedCount).toBe(2)
    expect(result.bars[0]).toEqual({
      ticker: 'O:SPXW250620P05900000',
      timestamp: 1750427700000,
      open: 2.0,
      high: 2.4,
      low: 1.9,
      close: 2.2,
      volume: 120,
      vwap: 2.15,
      transactions: 8
    })

    const url = calls[0]!
    expect(url).toContain('/v2/aggs/ticker/O%3ASPXW250620P05900000/range/1/minute/2025-06-20/2025-06-20')
    expect(url).toContain('sort=asc')
    expect(url).toContain('limit=50000')
  })

  it('reports an omitted results array as empty, never as zero prices', async () => {
    // Massive omits `results` entirely when no qualifying trade occurred.
    const { provider } = makeProvider(() => ({
      body: { ticker: 'O:SPXW250620P05900000', status: 'OK', resultsCount: 0, queryCount: 0 }
    }))

    const result = await provider.getOptionBars({
      ticker: 'O:SPXW250620P05900000',
      from: '2025-06-20',
      to: '2025-06-20'
    })

    expect(result.empty).toBe(true)
    expect(result.bars).toEqual([])
    // Critically: no synthetic zero-priced bar was invented.
    expect(result.bars.some((b) => b.close === 0)).toBe(false)
  })

  it('leaves index volume undefined rather than defaulting to zero', async () => {
    const { provider } = makeProvider(() => ({
      body: { ticker: 'I:SPX', status: 'OK', results: [{ t: 1750427700000, o: 6000, h: 6005, l: 5998, c: 6002 }] }
    }))

    const result = await provider.getUnderlyingBars({ ticker: 'I:SPX', from: '2025-06-20', to: '2025-06-20' })
    expect(result.bars[0]?.volume).toBeUndefined()
    expect(result.bars[0]?.close).toBe(6002)
  })
})

describe('error handling', () => {
  it('surfaces a clear message for a rejected API key', async () => {
    const { provider } = makeProvider(() => ({
      status: 401,
      body: { status: 'ERROR', message: 'Unknown API key' }
    }))
    const status = await provider.testConnection()
    expect(status.ok).toBe(false)
    expect(status.message).toMatch(/rejected the API key/)
    expect(status.message).toMatch(/Unknown API key/)
  })

  it('distinguishes a plan entitlement failure from a bad key', async () => {
    const { provider } = makeProvider(() => ({
      status: 403,
      body: { status: 'ERROR', message: 'You are not entitled to this data.' }
    }))
    await expect(
      provider.getUnderlyingBars({ ticker: 'I:SPX', from: '2025-06-16', to: '2025-06-20' })
    ).rejects.toThrow(/plan does not include this data/)
  })

  it('reports a healthy connection with latency', async () => {
    const { provider } = makeProvider(() => ({ body: { status: 'OK', results: [] } }))
    const status = await provider.testConnection()
    expect(status.ok).toBe(true)
    expect(status.message).toBe('Connected')
    expect(status.latencyMs).toBeGreaterThanOrEqual(0)
  })

  it('raises a schema error instead of coercing an unexpected payload', async () => {
    const { provider } = makeProvider(() => ({
      body: { status: 'OK', results: [{ t: 'not-a-number', o: 1, h: 1, l: 1, c: 1 }] }
    }))
    await expect(
      provider.getOptionBars({ ticker: 'O:SPXW250620P05900000', from: '2025-06-20', to: '2025-06-20' })
    ).rejects.toBeInstanceOf(MassiveSchemaError)
  })

  it('fails clearly when no API key is configured', async () => {
    const queue = new RequestQueue({ requestsPerMinute: 0 })
    const client = new MassiveClient({ apiKey: '', queue })
    const provider = new MassiveProvider(client)
    await expect(provider.getContracts({ underlying: 'SPX' })).rejects.toThrow(/No Massive API key/)
  })
})

describe('secret redaction', () => {
  it('never lets a key reach logs', () => {
    expect(redact('https://api.massive.com/v3?apiKey=super-secret&limit=1')).toBe(
      'https://api.massive.com/v3?apiKey=***&limit=1'
    )
    expect(redact('Authorization: Bearer super-secret')).toBe('Authorization: Bearer ***')
  })
})
