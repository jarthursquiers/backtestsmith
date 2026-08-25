import {
  describeWingWidth,
  resolveStructure,
  type CalendarConfig,
  type EntryConfig,
  type ExpirationRule,
  type PlacementConfig,
  type StudyConfig,
  type StudyStructure,
  type WingWidthBand,
  type WingWidthConfig
} from './study.js'
import {
  allManagementsFor,
  DEFAULT_CALENDAR_MANAGEMENT_SET,
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
  | (StrategyParamBase & { kind: 'text'; default: string; placeholder?: string })
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
> & {
  entryWeekdays?: number[]
  expirationWeekdays?: number[]
  wingWidthRule?: WingWidthConfig
  /**
   * Set by a strategy that trades something other than a butterfly.
   *
   * The butterfly fields above are still filled in - with values the calendar
   * engine never reads - rather than being made optional. A strategy is the one
   * place that knows what it is building, so it is also the right place to
   * decide what the inert fields say.
   */
  structure?: StudyStructure
  calendar?: CalendarConfig
}

export interface StrategyDefinition {
  id: string
  label: string
  /**
   * The structure this strategy builds. Absent means butterfly.
   *
   * Duplicated from what `build` puts in its slice so the UI can pick the right
   * management catalogue before it has built anything, which it must do to
   * render the selector at all.
   */
  structure?: StudyStructure
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
  /** Optional starting text for Parameter Sweep axis inputs. */
  sweepDefaults?: Record<string, string>
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

/**
 * Wing width, either fixed or scaled by a volatility gauge.
 *
 * The banded form is expressed as two thresholds and three widths rather than
 * as a free-form list, because that is the shape the rule is actually stated in
 * ("20 under 17, 30 to 32, 45 above") and a generic band editor would be a lot
 * of interface for a decision nobody makes in more than three steps. The engine
 * accepts any number of bands; only this form is capped.
 */
const WING_WIDTH_PARAMS: StrategyParam[] = [
  {
    key: 'wingWidthMode',
    label: 'Wing width',
    kind: 'choice',
    default: 'fixed',
    options: [
      { value: 'fixed', label: 'Fixed width' },
      { value: 'vixBands', label: 'Scaled by VIX' }
    ]
  },
  {
    key: 'wingWidth',
    label: 'Wing width',
    kind: 'number',
    default: 25,
    min: 5,
    step: 5,
    hint: 'SPX points from the centre to either wing',
    visibleWhen: { key: 'wingWidthMode', equals: 'fixed' }
  },
  {
    key: 'gaugeTicker',
    label: 'Volatility ticker',
    kind: 'text',
    default: 'I:VIX',
    hint: 'The name the gauge is cached under. Index history uses an I: prefix; a CSV import uses whatever it was imported as',
    visibleWhen: { key: 'wingWidthMode', equals: 'vixBands' }
  },
  {
    key: 'vixLowThreshold',
    label: 'Low VIX below',
    kind: 'number',
    default: 17,
    min: 1,
    step: 1,
    visibleWhen: { key: 'wingWidthMode', equals: 'vixBands' }
  },
  {
    key: 'vixLowWidth',
    label: 'Width below that',
    kind: 'number',
    default: 20,
    min: 5,
    step: 5,
    visibleWhen: { key: 'wingWidthMode', equals: 'vixBands' }
  },
  {
    key: 'vixHighThreshold',
    label: 'High VIX at',
    kind: 'number',
    default: 32,
    min: 1,
    step: 1,
    visibleWhen: { key: 'wingWidthMode', equals: 'vixBands' }
  },
  {
    key: 'vixMidWidth',
    label: 'Width in between',
    kind: 'number',
    default: 30,
    min: 5,
    step: 5,
    visibleWhen: { key: 'wingWidthMode', equals: 'vixBands' }
  },
  {
    key: 'vixHighWidth',
    label: 'Width above that',
    kind: 'number',
    default: 45,
    min: 5,
    step: 5,
    visibleWhen: { key: 'wingWidthMode', equals: 'vixBands' }
  }
]

/** The single width control, for strategies that never vary their width. */
const WING_WIDTH_PARAM: StrategyParam = WING_WIDTH_PARAMS.find((p) => p.key === 'wingWidth')!

/** The same controls, with the banded mode pre-selected. */
function bandedByDefault(params: readonly StrategyParam[]): StrategyParam[] {
  return params.map((param) =>
    param.key === 'wingWidthMode' && param.kind === 'choice'
      ? { ...param, default: 'vixBands' }
      : param
  )
}

/**
 * The wing-width half of a study configuration.
 *
 * `wingWidth` is always populated: for a banded study the runner resolves a
 * width per entry, so the config value is nominal only, and the middle band is
 * the honest choice for it - the width such a study spends most of its time at.
 * Nothing reads it in preference to the rule, and every trade records the width
 * it was actually built with.
 */
function buildWidth(
  params: Record<string, StrategyParamValue>
): { wingWidth: number; wingWidthRule?: WingWidthConfig } {
  if (str(params, 'wingWidthMode', 'fixed') !== 'vixBands') {
    return { wingWidth: num(params, 'wingWidth', 25) }
  }
  const bands: WingWidthBand[] = [
    { below: num(params, 'vixLowThreshold', 17), wingWidth: num(params, 'vixLowWidth', 20) },
    { below: num(params, 'vixHighThreshold', 32), wingWidth: num(params, 'vixMidWidth', 30) },
    { wingWidth: num(params, 'vixHighWidth', 45) }
  ]
  return {
    wingWidth: num(params, 'vixMidWidth', 30),
    wingWidthRule: {
      type: 'volatilityBands',
      ticker: str(params, 'gaugeTicker', 'I:VIX').trim().toUpperCase(),
      bands
    }
  }
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
    ...WING_WIDTH_PARAMS,
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
    ...buildWidth(params)
  })
}

/**
 * The requested long-duration weekly EMA butterfly study.
 *
 * Unlike the daily seven-DTE swing preset, this opens only once per week and
 * places the centre a small fixed distance from the live index level. The
 * direction mapping itself is the standard look-ahead-safe EMA rule shared by
 * the rest of the engine: calls above last night's EMA, puts below it.
 */
const WEEKLY_45_DTE_EMA: StrategyDefinition = {
  id: 'weekly-45dte-ema-butterfly',
  label: 'Weekly 45 DTE EMA butterfly',
  summary: 'Once weekly, place a 50-wide butterfly just above or below ATM according to the daily 9 EMA.',
  rules: [
    'Open one position per week on the configured weekday; if that session is a holiday, use the nearest open session in the same week.',
    'At entry, compare live SPX with the daily 9 EMA computed only from sessions that have already closed.',
    'Above the EMA buys an upside call butterfly; below it buys a downside put butterfly.',
    'Place the centre the configured number of SPX points above or below the live index level, in the direction of the signal.',
    'Use the listed SPXW expiration nearest 45 calendar DTE within the configured tolerance and symmetrical 50-point wings by default.',
    'Compare holding through expiration with profit at +200%, +300%, or +500% of the entry debit. A structurally unreachable target behaves as hold-to-expiration.'
  ],
  horizon: 'multiDay',
  requiresIntradayIndex: false,
  params: [
    {
      key: 'entryWeekday',
      label: 'Open on',
      kind: 'choice',
      default: '1',
      options: [
        { value: '1', label: 'Monday' },
        { value: '2', label: 'Tuesday' },
        { value: '3', label: 'Wednesday' },
        { value: '4', label: 'Thursday' },
        { value: '5', label: 'Friday' }
      ]
    },
    { key: 'entryTime', label: 'Entry time (ET)', kind: 'time', default: '09:35' },
    {
      key: 'entryWindowMinutes',
      label: 'Entry window',
      kind: 'number',
      default: 15,
      min: 0,
      hint: 'Minutes a fill may trail the entry time when prints are sparse'
    },
    { key: 'emaPeriod', label: 'Daily EMA period', kind: 'number', default: 9, min: 2 },
    { key: 'targetDte', label: 'Target DTE', kind: 'number', default: 45, min: 1 },
    {
      key: 'maxDeviation',
      label: 'DTE tolerance',
      kind: 'number',
      default: 3,
      min: 0,
      hint: 'Calendar days either side of 45 DTE allowed when selecting the expiration'
    },
    {
      key: 'offsetPoints',
      label: 'Centre offset from ATM',
      kind: 'number',
      default: 25,
      min: 0,
      step: 5,
      hint: 'Calls are centred this far above live SPX; puts this far below it'
    },
    {
      key: 'wingWidth',
      label: 'Wing width',
      kind: 'number',
      default: 50,
      min: 5,
      step: 5,
      hint: 'SPX points from the centre to either wing; sweep nearby widths to test robustness'
    }
  ],
  defaultManagements: ['hold', 'tp200', 'tp300', 'tp500'],
  sweepAxes: ['profitTarget', 'targetDte', 'wingWidth', 'offsetPoints', 'emaPeriod'],
  sweepDefaults: { profitTarget: '200, 300, 500' },
  build: (params) => {
    const weekday = num(params, 'entryWeekday', 1)
    return {
      entryTime: str(params, 'entryTime', '09:35'),
      entryWindowMinutes: num(params, 'entryWindowMinutes', 15),
      entryWeekdays: [Math.min(5, Math.max(1, Math.round(weekday)))],
      entry: { type: 'ema', period: num(params, 'emaPeriod', 9) },
      targetDte: num(params, 'targetDte', 45),
      expirationRule: 'nearest',
      maxDeviation: num(params, 'maxDeviation', 3),
      expirationWeekdays: [1, 2, 3, 4, 5],
      placement: { type: 'fixedDistance', offsetPoints: num(params, 'offsetPoints', 25) },
      wingWidth: num(params, 'wingWidth', 50)
    }
  }
}

const EMA_SWING_VIX_WIDTH: StrategyDefinition = {
  id: 'ema-swing-vix-width-butterfly',
  label: 'EMA swing butterfly, VIX-scaled width',
  summary: 'The 7 DTE swing study, with the wing width set each day by where VIX is trading.',
  rules: [
    'Identical to the EMA direction swing butterfly in every respect except how wide the structure is.',
    'At entry, read the volatility gauge and take the wing width from the band that level falls in.',
    'The gauge is read at the entry minute. Where that minute is missing it carries forward from earlier in the session, then falls back to the previous session close - never the entry day close, which would be hours of hindsight applied to the size of every trade.',
    'A session with no gauge reading at all is skipped rather than traded at a nominal width.',
    'Each trade records the width it was built with and the gauge level that chose it, so the rule can be judged after the fact.'
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
    // The same controls every strategy has, defaulted to the banded mode: this
    // entry exists precisely to make that the one-click configuration, and
    // switching it back to fixed reproduces the plain swing study exactly.
    ...bandedByDefault(WING_WIDTH_PARAMS),
    ...PLACEMENT_PARAMS
  ],
  defaultManagements: [...DEFAULT_MANAGEMENT_SET],
  sweepAxes: ['profitTarget', 'stopLoss', 'targetDte', 'emaPeriod', 'expectedMoveBuffer'],
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
    ...buildWidth(params)
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

const EMA_ZERO_DTE: StrategyDefinition = {
  id: 'ema-0dte-butterfly',
  label: 'EMA direction 0DTE butterfly',
  summary: 'The daily EMA picks the side each morning; a same-session butterfly sits at the edge of the expected move.',
  rules: [
    'At the entry time, compare SPX with a daily EMA built only from sessions that had already closed.',
    'Above the average takes a bullish upside call butterfly; below it takes a bearish downside put butterfly.',
    'The butterfly expires the same session, and its near wing sits at the edge of the expected move measured from the at-the-money straddle at entry.',
    'Every session with a signal is traded - there is no breakout to wait for, so nothing is skipped for want of a trigger.'
  ],
  horizon: 'intraday',
  // The EMA needs only daily closes, and the entry level falls back to
  // put-call parity, so unlike the breakout rule this one can run on sessions
  // with no cached index minutes.
  requiresIntradayIndex: false,
  params: [
    { key: 'entryTime', label: 'Entry time (ET)', kind: 'time', default: '09:35' },
    {
      key: 'entryWindowMinutes',
      label: 'Entry window',
      kind: 'number',
      default: 10,
      min: 0,
      hint: 'Minutes a fill may trail the entry time while waiting for priceable legs'
    },
    { key: 'emaPeriod', label: 'EMA period', kind: 'number', default: 9, min: 2 },
    {
      key: 'minimumDistance',
      label: 'Minimum distance from EMA',
      kind: 'number',
      default: 0,
      min: 0,
      step: 5,
      hint: 'SPX points. Zero trades every session; a positive value sits out the days price is resting on the average, where the side is close to a coin flip'
    },
    {
      key: 'mode',
      label: 'Direction',
      kind: 'choice',
      default: 'follow',
      options: [
        { value: 'follow', label: 'Above the EMA is bullish' },
        { value: 'fade', label: 'Above the EMA is bearish (inverted)' }
      ],
      hint: 'A butterfly pays where price stops rather than where it goes, so the inverted reading is worth measuring too'
    },
    WING_WIDTH_PARAM,
    ...PLACEMENT_PARAMS
  ],
  defaultManagements: allManagementsFor('intraday'),
  sweepAxes: ['profitTarget', 'stopLoss', 'wingWidth', 'emaPeriod', 'expectedMoveBuffer'],
  build: (params) => ({
    entryTime: str(params, 'entryTime', '09:35'),
    entryWindowMinutes: num(params, 'entryWindowMinutes', 10),
    entry: {
      type: 'ema',
      period: num(params, 'emaPeriod', 9),
      minimumDistance: num(params, 'minimumDistance', 0),
      invert: str(params, 'mode', 'follow') === 'fade'
    },
    targetDte: 0,
    expirationRule: 'nearest' as ExpirationRule,
    // Zero, so a session whose own expiration is unlisted is skipped rather
    // than quietly traded as an overnight structure.
    maxDeviation: 0,
    expirationWeekdays: [1, 2, 3, 4, 5],
    placement: buildPlacement(params),
    wingWidth: num(params, 'wingWidth', 25)
  })
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

/**
 * The double calendar.
 *
 * The catalogue's first non-butterfly structure, and it stretches the shape of
 * a "strategy" in one way worth naming: its entry rule is a schedule rather
 * than a signal. There is no direction to pick, because the position is neutral
 * by construction - it wants the index to sit still between its short strikes -
 * so the entry configuration is a weekday and a clock time, and everything that
 * would be a *placement* decision for a butterfly is a delta instead.
 *
 * The butterfly fields in the slice are filled with inert values the calendar
 * engine never reads. They are not optional because dozens of call sites read
 * them unconditionally today, and making them nullable to serve one strategy
 * would push a null check into all of them.
 */
const DOUBLE_CALENDAR: StrategyDefinition = {
  id: 'double-calendar',
  label: 'Double calendar',
  structure: 'doubleCalendar',
  summary: 'Weekly put and call calendars at a target delta, sharing one pair of expirations.',
  rules: [
    'On the scheduled weekday, at the entry time, sell a put and a call in the near expiration and buy the same two strikes in the far one.',
    'Both strikes are chosen by delta, measured on the short expiration from the implied volatility of each strike, and taken from the ladder both expirations list.',
    'The forward and discount factor come from put-call parity across the quoted chain, so no interest rate is assumed.',
    'Targets and stops are a percentage of the debit paid, which is the capital at risk; a calendar has no defined maximum profit.',
    'Rules evaluate on what closing the position would realize after crossing four spreads, not on the midpoint.',
    'Any position still open is closed on the front expiration day at the configured time, never carried into settlement.'
  ],
  horizon: 'multiDay',
  // The index level anchors the chain search at the entry minute, and the
  // strike-breach rules read it for every minute of the path.
  requiresIntradayIndex: true,
  params: [
    { key: 'entryTime', label: 'Entry time (ET)', kind: 'time', default: '10:00' },
    {
      key: 'entryWindowMinutes',
      label: 'Entry window',
      kind: 'number',
      default: 30,
      min: 0,
      max: 120,
      step: 5,
      hint: 'Minutes past the entry time a fill may drift while waiting for quotes'
    },
    {
      key: 'entryWeekday',
      label: 'Open on',
      kind: 'choice',
      default: '1',
      options: [
        { value: '1', label: 'Monday' },
        { value: '2', label: 'Tuesday' },
        { value: '3', label: 'Wednesday' },
        { value: '4', label: 'Thursday' },
        { value: '5', label: 'Friday' },
        { value: '0', label: 'Every session (overlapping)' }
      ],
      hint: 'One position a week. A holiday shifts that week to its first open session rather than skipping it'
    },
    {
      key: 'targetDelta',
      label: 'Short strike delta',
      kind: 'number',
      default: 30,
      min: 5,
      max: 50,
      step: 1,
      hint: 'Absolute delta for both shorts, in whole points. Closer to the money concentrates the decay a calendar earns from'
    },
    {
      key: 'frontDte',
      label: 'Short expiration DTE',
      kind: 'number',
      default: 14,
      min: 1,
      max: 90,
      step: 1
    },
    {
      key: 'backDte',
      label: 'Long expiration DTE',
      kind: 'number',
      default: 21,
      min: 2,
      max: 120,
      step: 1,
      hint: 'Must be later than the short. A wider gap between the two is a materially different trade, not a tuned one'
    },
    {
      key: 'maxDteDeviation',
      label: 'DTE tolerance',
      kind: 'number',
      default: 3,
      min: 0,
      max: 10,
      step: 1,
      hint: 'How far a listed expiration may sit from either target before the session is skipped'
    },
    {
      key: 'horizonTime',
      label: 'Close by (ET)',
      kind: 'time',
      default: '15:45',
      hint: 'On the short expiration day. A double calendar carried through the settlement of its shorts is a different structure'
    },
    {
      key: 'spreadFraction',
      label: 'Spread paid',
      kind: 'number',
      default: 0.5,
      min: 0,
      max: 1,
      step: 0.1,
      hint: 'Share of the package spread given up on each fill. 0 is the midpoint, 1 pays the full offer. Four legs make this the dominant assumption'
    },
    {
      key: 'commissionPerContract',
      label: 'Commission per contract',
      kind: 'number',
      default: 1.3,
      min: 0,
      step: 0.05,
      hint: 'Per side. Four contracts a lot, so eight per round trip'
    }
  ],
  // Management is simulated against an already-reconstructed path, so every
  // rule costs the same data as one. There is no reason to offer a subset.
  defaultManagements: [...DEFAULT_CALENDAR_MANAGEMENT_SET],
  sweepAxes: ['profitTarget', 'stopLoss', 'targetDelta', 'frontDte', 'backDte', 'spreadFraction'],
  build: (params) => {
    const weekday = num(params, 'entryWeekday', 1)
    const frontDte = num(params, 'frontDte', 14)
    return {
      entryTime: str(params, 'entryTime', '10:00'),
      entryWindowMinutes: num(params, 'entryWindowMinutes', 30),
      // A calendar has no direction to choose. `fixed` is the catalogue's
      // no-signal entry, and the direction it names is never read.
      entry: { type: 'fixed', direction: 'bearish' },
      targetDte: frontDte,
      expirationRule: 'nearest',
      maxDeviation: num(params, 'maxDteDeviation', 3),
      // Inert for this structure; see the note on StrategySlice.
      placement: { type: 'fixedDistance', offsetPoints: 0 },
      wingWidth: 0,
      structure: 'doubleCalendar',
      calendar: {
        root: 'SPXW',
        targetDelta: num(params, 'targetDelta', 30) / 100,
        frontTargetDte: frontDte,
        backTargetDte: num(params, 'backDte', 21),
        maxDteDeviation: num(params, 'maxDteDeviation', 3),
        entryWeekdays: weekday >= 1 && weekday <= 5 ? [weekday] : [],
        horizonTime: str(params, 'horizonTime', '15:45'),
        spreadFraction: num(params, 'spreadFraction', 0.5),
        commissionPerContract: num(params, 'commissionPerContract', 1.3)
      }
    }
  }
}

export const STRATEGY_CATALOG: readonly StrategyDefinition[] = [
  EMA_SWING_VIX_WIDTH,
  WEEKLY_45_DTE_EMA,
  EMA_ZERO_DTE,
  ORB_ZERO_DTE,
  EMA_SWING,
  FIXED_ZERO_DTE,
  DOUBLE_CALENDAR
]

export const DEFAULT_STRATEGY_ID = EMA_SWING_VIX_WIDTH.id

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
  if (resolveStructure(config) === 'doubleCalendar' && config.calendar) {
    const calendar = config.calendar
    const schedule = calendar.entryWeekdays.length === 0
      ? 'every session'
      : calendar.entryWeekdays.map((day) => ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][day] ?? `day ${day}`).join('/')
    return (
      `${Math.round(calendar.targetDelta * 100)}Δ double calendar | ` +
      `${calendar.frontTargetDte}/${calendar.backTargetDte} DTE | ${schedule} at ${config.entryTime} ET`
    )
  }
  const dte = config.targetDte === 0 ? '0DTE' : `${config.targetDte} DTE`
  const schedule = config.entryWeekdays && config.entryWeekdays.length > 0
    ? ` | weekly ${config.entryWeekdays.map((day) => ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][day] ?? `day ${day}`).join('/')}`
    : ''
  return `${describeEntry(config)} | ${dte} | ${describeWingWidth(config)} | ${describePlacement(config.placement)}${schedule}`
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
