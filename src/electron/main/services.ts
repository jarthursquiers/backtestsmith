import { statSync } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'
import { CachedProvider } from '../../data/cachedProvider.js'
import { MassiveClient } from '../../data/massive/client.js'
import { MassiveProvider } from '../../data/massive/provider.js'
import { RequestQueue } from '../../data/requestQueue.js'
import type { OptionsHistoricalDataProvider } from '../../data/provider.js'
import { Database } from '../../database/duckdb.js'
import { MarketDataStore } from '../../database/marketDataStore.js'
import type { CacheStats } from '../../shared/cache.js'
import { createLogger, logStore } from '../../services/logger.js'
import { SecretStore } from '../../services/secrets.js'
import { SettingsStore, resolveDataDirectory } from '../../services/settings.js'

const log = createLogger('app')

/**
 * Composition root. Every long-lived service is constructed once here and
 * shared, so the rate-limit queue is genuinely global - two screens issuing
 * requests still respect one 5-calls-per-minute budget.
 */
export interface AppServices {
  settings: SettingsStore
  secrets: SecretStore
  queue: RequestQueue
  client: MassiveClient
  /** Cache-first provider. Everything in the app should use this, not `upstream`. */
  provider: OptionsHistoricalDataProvider
  /** The raw Massive provider, retained for connectivity checks and diagnostics. */
  upstream: MassiveProvider
  database: Database
  store: MarketDataStore
  dataDirectory: string
  cacheStats(): Promise<CacheStats>
  applySettings(): void
}

let services: AppServices | null = null

export function getServices(): AppServices {
  if (!services) throw new Error('Services accessed before initialization')
  return services
}

export async function initServices(): Promise<AppServices> {
  const userData = app.getPath('userData')
  const settings = new SettingsStore(join(userData, 'settings.json'))
  const secrets = new SecretStore(join(userData, 'massive-api-key.bin'))

  const current = settings.read()
  logStore.setMinLevel(current.logLevel)

  const queue = new RequestQueue({
    requestsPerMinute: current.massive.requestsPerMinute,
    maxConcurrent: 1,
    maxRetries: current.massive.maxRetries
  })

  const client = new MassiveClient({
    apiKey: secrets.getApiKey() ?? '',
    queue,
    timeoutMs: current.massive.timeoutMs
  })

  const upstream = new MassiveProvider(client)
  const dataDirectory = resolveDataDirectory(current, userData)

  const database = new Database(join(dataDirectory, 'market-data.duckdb'))
  await database.open()
  const store = new MarketDataStore(database)

  const provider = new CachedProvider(upstream, store)

  services = {
    settings,
    secrets,
    queue,
    client,
    provider,
    upstream,
    database,
    store,
    dataDirectory,
    async cacheStats(): Promise<CacheStats> {
      let bytes = 0
      try {
        bytes = statSync(database.path).size
      } catch {
        // The file does not exist until the first write; zero is correct then.
      }
      return store.stats(bytes)
    },
    applySettings(): void {
      const next = settings.read()
      logStore.setMinLevel(next.logLevel)
      queue.setRequestsPerMinute(next.massive.requestsPerMinute)
      client.setApiKey(secrets.getApiKey() ?? '')
    }
  }

  const keyStatus = secrets.status()
  log.info('services initialized', {
    userData,
    dataDirectory,
    database: database.path,
    requestsPerMinute: current.massive.requestsPerMinute,
    apiKey: keyStatus.present ? `present (${keyStatus.source})` : 'not configured'
  })

  return services
}

export async function disposeServices(): Promise<void> {
  if (!services) return
  await services.database.close()
  services = null
}
