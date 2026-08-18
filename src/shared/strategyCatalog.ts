import type { EntryConfig, ExpirationRule, PlacementConfig, StudyConfig } from './study.js'
import {
  allManagementsFor,
  DEFAULT_MANAGEMENT_SET,
  type TradeHorizon
} from './managementCatalog.js'

/**
 * The catalogue of named strategies a study can be run from.
 *
 * A strategy here is an *entry* method plus a structure: when to get in, which
 * way, which expiration, and where the butterfly sits. Exits are deliberately
 * not part of it - the whole research programme is to run one entry population
 * against every management rule at once, and folding an exit into a strategy
 * would beg exactly the question the app exists to answer.
 *
 * ## Why a declarative catalogue
 *
 * Each definition exposes its parameters as data, so a single form renders any
 * strategy and a new one becomes an entry in this file rather than a new screen.
 * The definitions live in `shared` because the renderer builds configurations
 * from them and the main process stores the result; keeping the mapping in one
 * place is what stops the UI and the engine disagreeing about what a strategy
 * means.
 */

export type StrategyParamValue = number | string | boolean

interface StrategyParamBase {
  key: string
  label: string
  hint?: string
  /**
   * Shown only when another parameter holds a given value.
   *
   * Placement methods take different numbers, and showing all of them at once
   * invites a study configured with a value that is quietly ignored.
   */
  visibleWhen?: { key: string; equals: StrategyParamValue }
}

export type StrategyParam =
  | (StrategyParamBase & {
      kind: 'number'
      default: number
      min?: number
      max?: number
      step?: number
    })
  | (StrategyParamBase & { kind: 'time'; default: string })
  | (StrategyParamBase & {
      kind: 'choice'
      default: string
      options: { value: string; label: string }[]
    })
  | (StrategyParamBase & { kind: 'toggle'; default: boolean })

/** The part of a study configuration a strategy is responsible for. */
export type StrategySlice = Pick<
  StudyConfig,
  | 'entryTime'
  | 'entryWindowMinutes'
  | 'entry'
  | 'targetDte'
  | 'expirationRule'
  | 'maxDeviation'
  | 'placement'
  | 'wingWidth'
> & { expirationWeekdays?: number[] }

export interface StrategyDefinition {
  id: string
  label: string
  /** One line, for the picker. */
  summary: string
  /**
   * The rule stated precisely, shown next to the form.
   *
   * A backtest is only worth as much as the reader's certainty about what was
   * tested, and a name is not enough to establish that.
   */
  rules: string[]
  horizon: TradeHorizon
  params: StrategyParam[]
  /** Ticked by default when the strategy is selected. */
  defaultManagements: string[]
  /** Sweep axes worth varying for this strategy, in a sensible order. */
  sweepAxes: string[]
  /** Data this strategy cannot run without, surfaced before a run starts. */
  requiresIntradayIndex: boolean
  build(params: Record<string, StrategyParamValue>): StrategySlice
}

// --- parameter reading -------------------------------------------------------

function num(params: Record<string, StrategyParamValue>, key: string, fallback: number): number {
  const value = Number(params[key])
  return Number.isFinite(value) ? value : fallback
}

function str(params: Record<string, StrategyParamValue>, key: string, fallback: string): string {
  const value = params[key]
  return typeof value === 'string' && value.trim() !== '' ? value : fallback
}

function bool(params: Record<string, StrategyParamValue>, key: string, fallback: boolean): boolean {
  const value = params[key]
  return typeof value === 'boolean' ? value : fallback
}

/** Eastern HH:mm, `minutes` after the 09:30 regular open. */
function afterOpen(minutes: number): string {
  const total = 9 * 60 + 30 + Math.max(0, Math.round(minutes))
  const hour = Math.floor(total / 60) % 24
  return `${String(hour).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`
}

// --- shared parameter fragments ---------------------------------------------

const PLACEMENT_PARAMS: StrategyParam[] = [
  {
    key: 'placement',
    label: 'Placement',
    kind: 'choice',
    default: 'expectedMove',
    options: [
      { value: 'expectedMove', label: 'Against the expected move' },
      { value: 'fixedDistance', label: 'Fixed distance OTM' },
      { value: 'wingWidths', label: 'Wing widths OTM' }
    ]
  },
  {
    key: 'emAnchor',
    label: 'Expected move anchor',
    kind: 'choice',
    default: 'nearWingOutside',
    options: [
      { value: 'nearWingOutside', label: 'Near wing at or outside the line' },
      { value: 'nearestCenter', label: 'Centre rounded to the nearest strike' }
    ],
    hint: 'Anchoring the wing keeps the whole structure beyond the expected move; anchoring the centre keeps it closest to the ideal location',
    visibleWhen: { key: 'placement', equals: 'expectedMove' }
  },
  {
    key: 'emBuffer',
    label: 'Expected move buffer',
    kind: 'number',
    default: 0,
    step: 5,
    hint: 'Extra points beyond the expected move. Zero puts the near wing on the line',
    visibleWhen: { key: 'placement', equals: 'expectedMove' }
  },
  {
    key: 'offsetPoints',
    label: 'Offset',
    kind: 'number',
    default: 100,
    min: 0,
    step: 5,
    hint: 'Points from SPX to the centre',
    visibleWhen: { key: 'placement', equals: 'fixedDistance' }
  },
  {
    key: 'wingsAway',
    label: 'Wings away',
    kind: 'number',
    default: 4,
    min: 0,
    step: 0.5,
    hint: 'Centre distance in wing widths',
    visibleWhen: { key: 'placement', equals: 'wingWidths' }
  }
]

const WING_WIDTH_PARAM: StrategyParam = {
  key: 'wingWidth',
  label: 'Wing width',
  kind: 'number',
  default: 25,
  min: 5,
  step: 5,
  hint: 'SPX points from the centre to either wing'
}

function buildPlacement(params: Record<string, StrategyParamValue>): PlacementConfig {
  switch (str(params, 'placement', 'expectedMove')) {
    case 'fixedDistance':
      return { type: 'fixedDistance', offsetPoints: num(params, 'offsetPoints', 100) }
    case 'wingWidths':
      return { type: 'wingWidths', wingsAway: num(params, 'wingsAway', 4) }
    default:
      return {
        type: 'expectedMove',
        buffer: num(params, 'emBuffer', 0),
        anchor: str(params, 'emAnchor', 'nearWingOutside') === 'nearestCenter'
          ? 'nearestCenter'
          : 'nearWingOutside'
      }
  }
}

// --- the strategies ----------------------------------------------------------

const EMA_SWING: StrategyDefinition = {
  id: 'ema-swing-butterfly',
  label: 'EMA direction swing butterfly',
  summary: 'Daily EMA picks the side; a multi-day butterfly is placed against the expected move.',
  rules: [
    'At the entry time, compare SPX with a daily EMA computed only from sessions that had already closed.',
    'Below the average takes a downside put butterfly, above it takes an upside call butterfly.',
    'The expiration is the listed one closest to the target DTE, within the allowed deviation.',
    'Placement, wing width, and every execution assumption are as configured below.'
  ],
  horizon: 'multiDay',
  requiresIntradayIndex: false,
  params: [
    { key: 'entryTime', label: 'Entry time (ET)', kind: 'time', default: '09:35' },
    {
      key: 'entryWindowMinutes',
      label: 'Entry window',
      kind: 'number',
      default: 15,
      min: 0,
      hint: 'Minutes a fill may trail the entry time when prints are sparse'
    },
    { key: 'emaPeriod', label: 'EMA period', kind: 'number', default: 9, min: 2 },
    {
      key: 'meanReversionOverride',
      label: 'Two-candle mean reversion',
      kind: 'toggle',
      default: false,
      hint: 'Uses the previous close against its EMA, then reverses after two candles wholly on one side when the latest candle turns back toward the average'
    },
    { key: 'targetDte', label: 'Target DTE', kind: 'number', default: 7, min: 1 },
    {
      key: 'maxDeviation',
      label: 'Max deviation',
      kind: 'number',
      default: 2,
      min: 0,
      hint: 'Days either side of the target'
    },
    WING_WIDTH_PARAM,
    ...PLACEMENT_PARAMS
  ],
  defaultManagements: [...DEFAULT_MANAGEMENT_SET],
  sweepAxes: ['profitTarget', 'stopLoss', 'targetDte', 'wingWidth', 'emaPeriod', 'expectedMoveBuffer'],
  build: (params) => ({
    entryTime: str(params, 'entryTime', '09:35'),
    entryWindowMinutes: num(params, 'entryWindowMinutes', 15),
    entry: {
      type: 'ema',
      period: num(params, 'emaPeriod', 9),
      meanReversionOverride: bool(params, 'meanReversionOverride', false)
    },
    targetDte: num(params, 'targetDte', 7),
    expirationRule: 'nearest' as ExpirationRule,
    maxDeviation: num(params, 'maxDeviation', 2),
    placement: buildPlacement(params),
    wingWidth: num(params, 'wingWidth', 25)
  })
}

const ORB_ZERO_DTE: StrategyDefinition = {
  id: 'orb-0dte-butterfly',
  label: 'Opening range breakout 0DTE butterfly',
  summary: 'The first candle to close outside the opening range sets both the side and the entry minute.',
  rules: [
    'Mark the high and low of the session opening range - by default the first 15 minutes.',
    'Once that range has closed, watch each following candle - by default 5 minutes long.',
    'The first candle to close below the range takes a bearish butterfly; the first to close above it takes a bullish one.',
    'Entry is the minute bar after that candle closed, so nothing inside the confirming candle is traded on.',
    'The butterfly expires the same session, and its near wing is placed at the expected move measured from the at-the-money straddle at entry.',
    'A session with no qualifying close before the cutoff is not traded.'
  ],
  horizon: 'intraday',
  requiresIntradayIndex: true,
  params: [
    {
      key: 'openingRangeMinutes',
      label: 'Opening range',
      kind: 'number',
      default: 15,
      min: 1,
      step: 5,
      hint: 'Minutes from the 09:30 open that form the range'
    },
    {
      key: 'confirmationMinutes',
      label: 'Confirmation candle',
      kind: 'number',
      default: 5,
      min: 1,
      hint: 'Length of the candle whose close must break the range'
    },
    {
      key: 'cutoffTime',
      label: 'Breakout cutoff (ET)',
      kind: 'time',
      default: '12:00',
      hint: 'After this the session is left alone: a midday break is a different phenomenon from an opening drive'
    },
    {
      key: 'mode',
      label: 'Direction',
      kind: 'choice',
      default: 'follow',
      options: [
        { value: 'follow', label: 'Follow the breakout' },
        { value: 'fade', label: 'Fade the breakout' }
      ],
      hint: 'A butterfly bets on where price stops, so both readings of the signal are worth measuring'
    },
    {
      key: 'entryWindowMinutes',
      label: 'Entry window',
      kind: 'number',
      default: 10,
      min: 0,
      hint: 'Minutes the fill may trail the confirming close while waiting for priceable legs'
    },
    WING_WIDTH_PARAM,
    ...PLACEMENT_PARAMS
  ],
  defaultManagements: allManagementsFor('intraday'),
  sweepAxes: [
    'profitTarget',
    'stopLoss',
    'wingWidth',
    'openingRangeMinutes',
    'confirmationMinutes',
    'expectedMoveBuffer'
  ],
  build: (params) => {
    const openingRangeMinutes = num(params, 'openingRangeMinutes', 15)
    const confirmationMinutes = num(params, 'confirmationMinutes', 5)
    const entry: EntryConfig = {
      type: 'orb',
      openingRangeMinutes,
      confirmationMinutes,
      cutoffTime: str(params, 'cutoffTime', '12:00'),
      invert: str(params, 'mode', 'follow') === 'fade'
    }
    return {
      // Nominal only: the breakout resolver replaces this with the minute the
      // confirming candle actually closed. It is set to the earliest instant a
      // breakout could possibly be confirmed so the stored config reads true.
      entryTime: afterOpen(openingRangeMinutes + confirmationMinutes),
      entryWindowMinutes: num(params, 'entryWindowMinutes', 10),
      entry,
      targetDte: 0,
      expirationRule: 'nearest' as ExpirationRule,
      // Zero, so a session whose own expiration is somehow unlisted is skipped
      // rather than quietly traded as an overnight structure.
      maxDeviation: 0,
      expirationWeekdays: [1, 2, 3, 4, 5],
      placement: buildPlacement(params),
      wingWidth: num(params, 'wingWidth', 25)
    }
  }
}

const FIXED_ZERO_DTE: StrategyDefinition = {
  id: 'fixed-0dte-butterfly',
  label: 'Fixed-time 0DTE butterfly',
  summary: 'Same structure and expiration as the breakout study, entered at a set time every session.',
  rules: [
    'Enter at the configured time on every session, always on the configured side.',
    'The butterfly expires the same session and is placed exactly as the breakout study places it.',
    'This exists as a control: if a signal-triggered entry does not beat a fixed one, the signal is not doing any work.'
  ],
  horizon: 'intraday',
  requiresIntradayIndex: false,
  params: [
    {
      key: 'direction',
      label: 'Direction',
      kind: 'choice',
      default: 'bearish',
      options: [
        { value: 'bearish', label: 'Always bearish (downside put fly)' },
        { value: 'bullish', label: 'Always bullish (upside call fly)' }
      ]
    },
    { key: 'entryTime', label: 'Entry time (ET)', kind: 'time', default: '09:50' },
    { key: 'entryWindowMinutes', label: 'Entry window', kind: 'number', default: 10, min: 0 },
    WING_WIDTH_PARAM,
    ...PLACEMENT_PARAMS
  ],
  defaultManagements: allManagementsFor('intraday'),
  sweepAxes: ['profitTarget', 'stopLoss', 'wingWidth', 'expectedMoveBuffer'],
  build: (params) => ({
    entryTime: str(params, 'entryTime', '09:50'),
    entryWindowMinutes: num(params, 'entryWindowMinutes', 10),
    entry: {
      type: 'fixed',
      direction: str(params, 'direction', 'bearish') === 'bullish' ? 'bullish' : 'bearish'
    },
    targetDte: 0,
    expirationRule: 'nearest' as ExpirationRule,
    maxDeviation: 0,
    expirationWeekdays: [1, 2, 3, 4, 5],
    placement: buildPlacement(params),
    wingWidth: num(params, 'wingWidth', 25)
  })
}

export const STRATEGY_CATALOG: readonly StrategyDefinition[] = [
  ORB_ZERO_DTE,
  EMA_SWING,
  FIXED_ZERO_DTE
]

export const DEFAULT_STRATEGY_ID = ORB_ZERO_DTE.id

export function findStrategy(id: string): StrategyDefinition | undefined {
  return STRATEGY_CATALOG.find((strategy) => strategy.id === id)
}

/** Throws rather than falling back, so a typo is not silently run as something else. */
export function requireStrategy(id: string): StrategyDefinition {
  const strategy = findStrategy(id)
  if (!strategy) throw new Error(`Unknown strategy "${id}"`)
  return strategy
}

export function defaultStrategyParams(strategy: StrategyDefinition): Record<string, StrategyParamValue> {
  return Object.fromEntries(strategy.params.map((param) => [param.key, param.default]))
}

/** Whether a parameter is relevant given the values of the others. */
export function isParamVisible(
  param: StrategyParam,
  params: Record<string, StrategyParamValue>
): boolean {
  if (!param.visibleWhen) return true
  return params[param.visibleWhen.key] === param.visibleWhen.equals
}

export interface StudyConfigOptions {
  strategyId: string
  params: Record<string, StrategyParamValue>
  from: string
  to: string
  managements: string[]
  pricing: StudyConfig['pricing']
  minimumCoverage: number
  underlying?: string
  preferredRoot?: string
  quantity?: number
}

/**
 * Builds a complete study configuration from a named strategy.
 *
 * Everything the strategy owns comes from its own `build`; everything shared -
 * dates, execution assumptions, the management set - is supplied by the caller.
 * Both halves land in one object that is stored verbatim with the run, and the
 * strategy id travels with it so the run can say what it was.
 */
export function buildStudyConfig(options: StudyConfigOptions): StudyConfig {
  const strategy = requireStrategy(options.strategyId)
  const merged = { ...defaultStrategyParams(strategy), ...options.params }
  // Parameters that the current shape of the form hides are dropped rather than
  // recorded, so a stored config never implies a value the run did not use.
  const effective = Object.fromEntries(
    strategy.params.filter((param) => isParamVisible(param, merged)).map((param) => [param.key, merged[param.key]!])
  )
  const slice = strategy.build(merged)

  return {
    underlying: options.underlying ?? 'SPX',
    from: options.from,
    to: options.to,
    ...slice,
    preferredRoot: options.preferredRoot ?? 'SPXW',
    quantity: options.quantity ?? 1,
    pricing: options.pricing,
    minimumCoverage: options.minimumCoverage,
    managements: options.managements,
    strategyId: strategy.id,
    strategyParams: effective
  }
}

/**
 * One-line description of what a stored configuration actually traded.
 *
 * Reads the resolved config rather than the strategy id, so a run made before a
 * strategy existed - or one whose parameters were edited - still describes
 * itself honestly.
 */
export function describeEntry(config: StudyConfig): string {
  switch (config.entry.type) {
    case 'ema':
      return `${config.entry.period} EMA${config.entry.meanReversionOverride ? ' + two-candle override' : ''}`
    case 'fixed':
      return `always ${config.entry.direction}`
    case 'orb':
      return (
        `${config.entry.openingRangeMinutes}m opening range, ` +
        `${config.entry.confirmationMinutes}m confirmation` +
        `${config.entry.invert ? ', faded' : ''}`
      )
  }
}

/** Short summary of a configuration, for run lists and forward-test headers. */
export function describeConfig(config: StudyConfig): string {
  const dte = config.targetDte === 0 ? '0DTE' : `${config.targetDte} DTE`
  return `${describeEntry(config)} | ${dte} | ${config.wingWidth}-wide | ${describePlacement(config.placement)}`
}

export function describePlacement(placement: PlacementConfig): string {
  switch (placement.type) {
    case 'fixedDistance':
      return `${placement.offsetPoints} pts OTM`
    case 'wingWidths':
      return `${placement.wingsAway} wing widths OTM`
    case 'expectedMove':
      return (
        `expected move${placement.buffer ? ` +${placement.buffer}` : ''}` +
        `${placement.anchor === 'nearestCenter' ? ' (centre anchored)' : ''}`
      )
  }
}

/** The horizon a stored configuration belongs to, for filtering management methods. */
export function configHorizon(config: Pick<StudyConfig, 'targetDte'>): TradeHorizon {
  return config.targetDte === 0 ? 'intraday' : 'multiDay'
}
