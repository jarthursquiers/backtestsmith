/** API key state, safe to send to the renderer: never includes the key itself. */
export interface SecretStatus {
  present: boolean
  source: 'env' | 'stored' | 'none'
  /** True when the OS keystore is usable; false means we refuse to persist. */
  encryptionAvailable: boolean
  /** Safe-to-display fingerprint, e.g. "abcd...wxyz". Never the full key. */
  hint: string | null
}
