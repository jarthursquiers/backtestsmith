import type { StudyRunResult } from '../shared/study.js'
import type { ButterflySeries } from '../domain/butterfly.js'
import type { TradeResult } from '../shared/trade.js'

/**
 * Export formats.
 *
 * CSV is written by hand rather than pulled from a library because the escaping
 * rules are three lines and a dependency here would be the larger liability.
 */

function csvCell(value: unknown): string {
  if (value === null || value === undefined) return ''
  const text = String(value)
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

export function toCsv(rows: readonly (readonly unknown[])[]): string {
  return rows.map((row) => row.map(csvCell).join(',')).join('\n')
}

const TRADE_HEADER = [
  'run_id', 'strategy_id', 'strategy_label',
  'entry_utc', 'entry_underlying', 'expiration', 'direction', 'option_type',
  'lower_strike', 'center_strike', 'upper_strike', 'wing_width', 'quantity',
  // The gauge reading that chose the width, so a banded study can be pivoted on
  // the condition rather than only on the width it produced.
  'gauge_level',
  'entry_debit', 'exit_utc', 'exit_value', 'exit_reason', 'ambiguous',
  'pnl_dollars', 'pnl_pct', 'holding_minutes', 'exit_dte',
  'mfe_pct', 'mae_pct', 'mfe_capture', 'profit_giveback',
  'min_normalized_distance', 'coverage', 'freshness', 'invalid_price_minutes',
  'entry_lower_price', 'entry_center_price', 'entry_upper_price',
  'entry_lower_observed_utc', 'entry_center_observed_utc', 'entry_upper_observed_utc',
  'entry_max_leg_age_ms',
  'exit_lower_price', 'exit_center_price', 'exit_upper_price',
  'exit_lower_observed_utc', 'exit_center_observed_utc', 'exit_upper_observed_utc',
  'exit_max_leg_age_ms'
]

/** Trade-level export, one row per trade per management method. */
export function tradesToCsv(runId: string, trades: readonly TradeResult[]): string {
  const rows: unknown[][] = [TRADE_HEADER]
  for (const t of trades) {
    rows.push([
      runId, t.strategyId, t.strategyLabel,
      new Date(t.entryTimestamp).toISOString(), t.entryUnderlying ?? '',
      t.definition.expiration, t.definition.direction, t.definition.optionType,
      t.definition.lowerStrike, t.definition.centerStrike, t.definition.upperStrike,
      t.definition.wingWidth, t.definition.quantity,
      t.entryIndicators?.gaugeLevel ?? '',
      t.entryDebit, new Date(t.exitTimestamp).toISOString(), t.exitValue,
      t.exitReason, t.ambiguous,
      t.pnlDollars, t.pnlPct, t.holdingMinutes, t.exitDte,
      t.excursions.mfe?.pct ?? '', t.excursions.mae?.pct ?? '',
      t.mfeCaptureRatio ?? '', t.profitGiveback,
      t.minNormalizedDistance ?? '', t.quality.coverage, t.quality.freshness,
      t.quality.invalidPriceMinutes ?? '',
      t.entryAudit?.lower.price ?? '', t.entryAudit?.center.price ?? '', t.entryAudit?.upper.price ?? '',
      t.entryAudit ? new Date(t.entryAudit.lower.observedAt).toISOString() : '',
      t.entryAudit ? new Date(t.entryAudit.center.observedAt).toISOString() : '',
      t.entryAudit ? new Date(t.entryAudit.upper.observedAt).toISOString() : '',
      t.entryAudit?.maxLegAgeMs ?? '',
      t.exitAudit?.lower.price ?? '', t.exitAudit?.center.price ?? '', t.exitAudit?.upper.price ?? '',
      t.exitAudit ? new Date(t.exitAudit.lower.observedAt).toISOString() : '',
      t.exitAudit ? new Date(t.exitAudit.center.observedAt).toISOString() : '',
      t.exitAudit ? new Date(t.exitAudit.upper.observedAt).toISOString() : '',
      t.exitAudit?.maxLegAgeMs ?? ''
    ])
  }
  return toCsv(rows)
}

/** Minute-by-minute lifecycle of a single reconstructed trade. */
export function seriesToCsv(series: ButterflySeries): string {
  const rows: unknown[][] = [[
    'timestamp_utc', 'butterfly_value', 'pnl_dollars', 'pnl_pct',
    'underlying', 'distance_to_center', 'normalized_distance',
    'dte', 'trading_dte', 'minutes_since_entry', 'stale', 'max_leg_age_ms',
    'lower_price', 'center_price', 'upper_price',
    'lower_observed_utc', 'center_observed_utc', 'upper_observed_utc'
  ]]
  for (const o of series.observations) {
    rows.push([
      new Date(o.timestamp).toISOString(), o.butterflyValue, o.pnlDollars, o.pnlPct,
      o.underlyingPrice ?? '', o.distanceToCenter ?? '', o.normalizedDistanceToCenter ?? '',
      o.dte, o.tradingDte, o.minutesSinceEntry, o.stale, o.maxLegAgeMs,
      o.priceAudit?.lower.price ?? '', o.priceAudit?.center.price ?? '', o.priceAudit?.upper.price ?? '',
      o.priceAudit ? new Date(o.priceAudit.lower.observedAt).toISOString() : '',
      o.priceAudit ? new Date(o.priceAudit.center.observedAt).toISOString() : '',
      o.priceAudit ? new Date(o.priceAudit.upper.observedAt).toISOString() : ''
    ])
  }
  return toCsv(rows)
}

/**
 * Complete study export.
 *
 * Includes the configuration and provenance, not just the numbers: a result
 * without the assumptions that produced it cannot be checked by anyone else.
 */
export function studyToJson(run: StudyRunResult): string {
  return JSON.stringify(
    {
      runId: run.runId,
      createdAt: new Date(run.createdAt).toISOString(),
      appVersion: run.appVersion,
      gitCommit: run.gitCommit ?? null,
      config: run.config,
      entryCount: run.entryCount,
      entriesAttempted: run.entriesAttempted,
      skipped: run.skipped,
      summaries: run.summaries,
      trades: run.trades,
      caveats: [
        'Results use one-minute OPRA NBBO quote snapshots supplied by ThetaData. Option legs are marked at the bid/ask midpoint, with configured slippage applied to simulated entry and exit fills; fills are estimates rather than guaranteed executions.',
        'Exits marked ambiguous could not be established from minute bars; the adverse outcome was assumed.',
        'Marks outside the static 0-to-wing-width butterfly bounds are rejected and counted as unpriced minutes.',
        'Entries require fresh same-minute prices for all three legs inside the configured entry window.',
        'Sample sizes here are small enough that differences between management methods may not be distinguishable from chance.'
      ]
    },
    null,
    2
  )
}

/** Filesystem-safe UTC timestamp keeps repeated exports naturally sortable. */
export function studyJsonFilename(runId: string, createdAt: number): string {
  const stamp = new Date(createdAt)
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}Z$/, 'Z')
    .replace('T', '-')
  return `study-${stamp}-${runId}.json`
}
