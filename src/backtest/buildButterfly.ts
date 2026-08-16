import type { OptionContract, OptionType, SettlementStyle } from '../domain/contracts.js'
import type { ButterflyDefinition } from '../domain/butterfly.js'

/**
 * Resolves three strikes into a concrete three-leg butterfly.
 *
 * The hard part is not arithmetic, it is picking the right contract. On
 * third-Friday monthly expirations SPX lists **two** contracts at every strike:
 * the AM-settled monthly (root SPX) and the PM-settled weekly (root SPXW). They
 * are different instruments - the AM-settled one stops trading at the Thursday
 * close - so choosing by strike alone silently corrupts any late-DTE or
 * hold-to-expiration result. Root selection is therefore explicit and a tie is
 * an error rather than a coin flip.
 */

export class ButterflyBuildError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ButterflyBuildError'
  }
}

export interface BuildButterflyRequest {
  underlying: string
  expiration: string
  optionType: OptionType
  lowerStrike: number
  centerStrike: number
  upperStrike: number
  /**
   * Which option root to use when several exist at the same strike, e.g. 'SPXW'
   * for PM-settled weeklies. Required whenever the chain is ambiguous.
   */
  preferredRoot?: string
  quantity?: number
}

/** Picks the single contract at a strike, disambiguating by root when needed. */
export function selectContract(
  contracts: readonly OptionContract[],
  strike: number,
  type: OptionType,
  preferredRoot?: string
): OptionContract {
  const atStrike = contracts.filter((c) => c.strike === strike && c.type === type)

  if (atStrike.length === 0) {
    throw new ButterflyBuildError(`No ${type} contract found at strike ${strike}.`)
  }

  // An explicit root is honored or refused - never substituted. Returning a
  // different root than asked for is the silent swap this module exists to
  // prevent, and it stays silent even when only one contract happens to exist.
  if (preferredRoot) {
    const wanted = preferredRoot.toUpperCase()
    const match = atStrike.find((c) => (c.root ?? '').toUpperCase() === wanted)
    if (match) return match
    throw new ButterflyBuildError(
      `No ${wanted} contract at strike ${strike}; available roots: ${roots(atStrike)}.`
    )
  }

  if (atStrike.length === 1) return atStrike[0]!

  throw new ButterflyBuildError(
    `Strike ${strike} is ambiguous: ${atStrike.length} ${type} contracts exist with roots ${roots(atStrike)}. ` +
      'Choose a root, since AM- and PM-settled contracts behave differently.'
  )
}

function roots(contracts: readonly OptionContract[]): string {
  return contracts.map((c) => c.root ?? '(unknown)').join(', ')
}

/**
 * Assembles a butterfly definition, validating the geometry.
 *
 * Direction is inferred from the option type, which is the convention this study
 * uses: downside/bearish butterflies are built from puts, upside/bullish ones
 * from calls.
 */
export function buildButterfly(
  request: BuildButterflyRequest,
  contracts: readonly OptionContract[]
): ButterflyDefinition {
  const { lowerStrike, centerStrike, upperStrike } = request

  if (!(lowerStrike < centerStrike && centerStrike < upperStrike)) {
    throw new ButterflyBuildError(
      `Strikes must be strictly increasing, received ${lowerStrike}/${centerStrike}/${upperStrike}.`
    )
  }

  const lowerWidth = centerStrike - lowerStrike
  const upperWidth = upperStrike - centerStrike
  if (lowerWidth !== upperWidth) {
    throw new ButterflyBuildError(
      `Only symmetrical butterflies are supported; wings are ${lowerWidth} and ${upperWidth} points wide.`
    )
  }

  const lower = selectContract(contracts, lowerStrike, request.optionType, request.preferredRoot)
  const center = selectContract(contracts, centerStrike, request.optionType, request.preferredRoot)
  const upper = selectContract(contracts, upperStrike, request.optionType, request.preferredRoot)

  // A butterfly whose legs settle differently is not a butterfly.
  const settlements = new Set([lower.settlement, center.settlement, upper.settlement])
  if (settlements.size > 1) {
    throw new ButterflyBuildError(
      'The selected legs do not share a settlement style, so they are not the same instrument family.'
    )
  }

  return {
    underlying: request.underlying,
    direction: request.optionType === 'put' ? 'bearish' : 'bullish',
    optionType: request.optionType,
    expiration: request.expiration,
    lowerStrike,
    centerStrike,
    upperStrike,
    lowerTicker: lower.ticker,
    centerTicker: center.ticker,
    upperTicker: upper.ticker,
    wingWidth: lowerWidth,
    quantity: request.quantity ?? 1
  }
}

/** Distinct roots present in a chain, for populating a root selector. */
export function availableRoots(contracts: readonly OptionContract[]): {
  root: string
  settlement: SettlementStyle | undefined
  count: number
}[] {
  const byRoot = new Map<string, { settlement: SettlementStyle | undefined; count: number }>()
  for (const c of contracts) {
    const root = c.root ?? '(unknown)'
    const existing = byRoot.get(root)
    if (existing) existing.count++
    else byRoot.set(root, { settlement: c.settlement, count: 1 })
  }
  return [...byRoot.entries()]
    .map(([root, info]) => ({ root, ...info }))
    .sort((a, b) => b.count - a.count)
}
