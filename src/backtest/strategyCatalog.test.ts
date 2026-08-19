import { describe, expect, it } from 'vitest'
import {
  buildStudyConfig,
  defaultStrategyParams,
  describeConfig,
  STRATEGY_CATALOG,
  requireStrategy
} from '../shared/strategyCatalog.js'
import { MANAGEMENT_CATALOG } from '../shared/managementCatalog.js'
import { buildManagementSet, managementCatalogDrift, MANAGEMENT_IDS } from './managementSets.js'

const BASE = {
  from: '2024-01-02',
  to: '2024-03-01',
  pricing: {
    model: 'close' as const,
    slippage: 0.05,
    missingDataMode: 'carryForward' as const,
    maxStaleMinutes: 1
  },
  minimumCoverage: 0.8
}

function configFor(strategyId: string, params: Record<string, string | number | boolean> = {}) {
  const strategy = requireStrategy(strategyId)
  return buildStudyConfig({
    ...BASE,
    strategyId,
    params: { ...defaultStrategyParams(strategy), ...params },
    managements: strategy.defaultManagements
  })
}

describe('management catalogue', () => {
  it('has an executable builder for every listed method and vice versa', () => {
    expect(managementCatalogDrift()).toEqual({ missingBuilder: [], missingCatalogEntry: [] })
  })

  it('has no duplicate ids', () => {
    expect(new Set(MANAGEMENT_IDS).size).toBe(MANAGEMENT_IDS.length)
  })

  it('builds every method, and each carries the id the study configured it with', () => {
    // The run summary matches config ids against trade strategy ids, so a rule
    // that renames itself produces a method with no trades.
    for (const method of MANAGEMENT_CATALOG) {
      const [strategy] = buildManagementSet([method.id])
      expect(strategy!.id).toBe(method.id)
      expect(strategy!.label.length).toBeGreaterThan(0)
    }
  })

  it('rejects an unknown id instead of quietly dropping it', () => {
    expect(() => buildManagementSet(['tp50', 'nonsense'])).toThrow(/nonsense/)
  })
})

describe('strategy catalogue', () => {
  it('has unique ids and at least one parameter each', () => {
    const ids = STRATEGY_CATALOG.map((strategy) => strategy.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const strategy of STRATEGY_CATALOG) {
      expect(strategy.params.length).toBeGreaterThan(0)
      expect(strategy.rules.length).toBeGreaterThan(0)
    }
  })

  it('only defaults to management methods the engine can build', () => {
    for (const strategy of STRATEGY_CATALOG) {
      expect(() => buildManagementSet(strategy.defaultManagements)).not.toThrow()
      expect(strategy.defaultManagements.length).toBeGreaterThan(0)
    }
  })

  it('produces a runnable configuration from defaults for every strategy', () => {
    for (const strategy of STRATEGY_CATALOG) {
      const config = configFor(strategy.id)
      expect(config.strategyId).toBe(strategy.id)
      expect(config.wingWidth).toBeGreaterThan(0)
      expect(config.underlying).toBe('SPX')
      expect(config.from).toBe(BASE.from)
      expect(/^\d{2}:\d{2}$/.test(config.entryTime)).toBe(true)
    }
  })

  it('records only the parameters the chosen placement actually uses', () => {
    const config = configFor('ema-swing-butterfly', { placement: 'fixedDistance', offsetPoints: 80 })

    expect(config.placement).toEqual({ type: 'fixedDistance', offsetPoints: 80 })
    expect(config.strategyParams).toHaveProperty('offsetPoints', 80)
    // Expected-move settings are irrelevant to this placement, so storing them
    // would imply the run used a value it never consulted.
    expect(config.strategyParams).not.toHaveProperty('emBuffer')
    expect(config.strategyParams).not.toHaveProperty('wingsAway')
  })
})

describe('the 0DTE EMA direction strategy', () => {
  it('trades the entry session itself and admits every weekday expiration', () => {
    const config = configFor('ema-0dte-butterfly')

    expect(config.targetDte).toBe(0)
    expect(config.maxDeviation).toBe(0)
    expect(config.expirationWeekdays).toEqual([1, 2, 3, 4, 5])
  })

  it('maps above the EMA to bullish and below to bearish', () => {
    const config = configFor('ema-0dte-butterfly')
    expect(config.entry).toEqual({
      type: 'ema',
      period: 9,
      minimumDistance: 0,
      // The engine reads `invert: false` as "below the average is bearish",
      // which is the stated rule. Asserting it here so a future change to the
      // default cannot silently reverse every trade in the study.
      invert: false
    })
  })

  it('inverts the mapping when the direction is faded', () => {
    const config = configFor('ema-0dte-butterfly', { mode: 'fade' })
    expect(config.entry).toMatchObject({ type: 'ema', invert: true })
  })

  it('carries a minimum distance filter through to the entry rule', () => {
    const config = configFor('ema-0dte-butterfly', { minimumDistance: 20 })
    expect(config.entry).toMatchObject({ minimumDistance: 20 })
  })

  it('places the near wing at the edge of the expected move by default', () => {
    const config = configFor('ema-0dte-butterfly')
    expect(config.placement).toEqual({ type: 'expectedMove', buffer: 0, anchor: 'nearWingOutside' })
  })

  it('offers only management methods that can fire within one session', () => {
    const strategy = requireStrategy('ema-0dte-butterfly')
    expect(strategy.defaultManagements).toContain('at1545')
    expect(strategy.defaultManagements).not.toContain('dte1')
  })

  it('describes itself without needing the catalogue', () => {
    expect(describeConfig(configFor('ema-0dte-butterfly'))).toBe(
      '9 EMA | 0DTE | 25-wide | expected move'
    )
  })
})

describe('the 0DTE opening range strategy', () => {
  it('targets the entry session itself and admits every weekday expiration', () => {
    const config = configFor('orb-0dte-butterfly')

    expect(config.targetDte).toBe(0)
    // Anything other than zero would let a session with no listed same-day
    // expiration be traded as an overnight structure.
    expect(config.maxDeviation).toBe(0)
    expect(config.expirationWeekdays).toEqual([1, 2, 3, 4, 5])
  })

  it('places the near wing at or outside the expected move by default', () => {
    const config = configFor('orb-0dte-butterfly')
    expect(config.placement).toEqual({ type: 'expectedMove', buffer: 0, anchor: 'nearWingOutside' })
  })

  it('carries the opening range rule into the entry configuration', () => {
    const config = configFor('orb-0dte-butterfly', {
      openingRangeMinutes: 30,
      confirmationMinutes: 10,
      cutoffTime: '11:30',
      mode: 'fade'
    })

    expect(config.entry).toEqual({
      type: 'orb',
      openingRangeMinutes: 30,
      confirmationMinutes: 10,
      cutoffTime: '11:30',
      invert: true
    })
    // The nominal entry time is the earliest instant a breakout could confirm.
    expect(config.entryTime).toBe('10:10')
  })

  it('offers only management methods that can fire within one session', () => {
    const strategy = requireStrategy('orb-0dte-butterfly')
    expect(strategy.defaultManagements).toContain('at1545')
    expect(strategy.defaultManagements).toContain('elapsed60m')
    // A day-count exit has nothing to count down on a 0DTE trade.
    expect(strategy.defaultManagements).not.toContain('dte1')
  })

  it('describes itself without needing the catalogue', () => {
    expect(describeConfig(configFor('orb-0dte-butterfly'))).toBe(
      '15m opening range, 5m confirmation | 0DTE | 25-wide | expected move'
    )
  })
})
