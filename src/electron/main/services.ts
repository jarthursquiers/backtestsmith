import { join } from 'node:path'
import { app } from 'electron'
import { MassiveClient } from '../../data/massive/client.js'
import { MassiveProvider } from '../../data/massive/provider.js'
import { RequestQueue } from '../../data/requestQueue.js'
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
  provider: MassiveProvider
  dataDirectory: string
  /** Re-reads settings and applies anything that affects live services. */
  applySettings(): void
}

let services: AppServices | null = null

export function getServices(): AppServices {
  if (!services) throw new Error('Services accessed before initialization')
  return services
}

export function initServices(): AppServices {
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

  const provider = new MassiveProvider(client)
  const dataDirectory = resolveDataDirectory(current, userData)

  services = {
    settings,
    secrets,
    queue,
    client,
    provider,
    dataDirectory,
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
    requestsPerMinute: current.massive.requestsPerMinute,
    apiKey: keyStatus.present ? `present (${keyStatus.source})` : 'not configured'
  })

  return services
}
