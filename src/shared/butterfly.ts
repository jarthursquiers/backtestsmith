import type { ButterflySeries, LegPricingModel } from '../domain/butterfly.js'
import type { OptionContract, OptionType } from '../domain/contracts.js'
import type { Excursions } from './excursions.js'

/** Request to reconstruct one butterfly, as issued from the Trade Inspector. */
export interface ReconstructRequest {
  underlying: string
  expiration: string
  optionType: OptionType
  lowerStrike: number
  centerStrike: number
  upperStrike: number
  /** Disambiguates SPX vs SPXW when both list the same strike. */
  preferredRoot?: string
  quantity: number
  /** Eastern market date of entry. */
  entryDate: string
  /** Eastern wall-clock entry time, HH:mm. */
  entryTime: string
  pricingModel: LegPricingModel
  slippage: number
  missingDataMode: 'strict' | 'carryForward'
  maxStaleMinutes: number
}

/** Everything the Trade Inspector needs to draw and explain one trade. */
export interface ReconstructResponse {
  series: ButterflySeries
  excursions: Excursions
  /** Bars actually retrieved per leg, for diagnosing a thin reconstruction. */
  legBarCounts: { lower: number; center: number; upper: number }
  /** True when SPX levels were available for the whole window. */
  hasUnderlying: boolean
}

/** Summary of an option chain, used to populate the strike pickers. */
export interface ChainSummary {
  expiration: string
  contracts: OptionContract[]
  roots: { root: string; settlement: 'am' | 'pm' | undefined; count: number }[]
  strikes: number[]
}
