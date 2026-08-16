import { DateTime } from 'luxon'

/**
 * Display formatting. Every timestamp shown in this application is rendered in
 * Eastern market time regardless of where the machine is, so that what the user
 * reads matches what the research engine computed.
 */
const ZONE = 'America/New_York'

export function fmtEasternTime(timestampMs: number): string {
  return DateTime.fromMillis(timestampMs, { zone: ZONE }).toFormat('HH:mm')
}

export function fmtEasternDateTime(timestampMs: number): string {
  return DateTime.fromMillis(timestampMs, { zone: ZONE }).toFormat('yyyy-MM-dd HH:mm:ss')
}

export function fmtEasternStamp(timestampMs: number): string {
  return DateTime.fromMillis(timestampMs, { zone: ZONE }).toFormat('HH:mm:ss.SSS')
}

export function fmtDate(timestampMs: number): string {
  return DateTime.fromMillis(timestampMs, { zone: ZONE }).toFormat('yyyy-MM-dd')
}

/** Option prices carry two decimals; index levels usually two as well. */
export function fmtPrice(value: number | undefined, digits = 2): string {
  if (value === undefined || !Number.isFinite(value)) return '—'
  return value.toFixed(digits)
}

export function fmtInt(value: number | undefined): string {
  if (value === undefined || !Number.isFinite(value)) return '—'
  return Math.round(value).toLocaleString('en-US')
}

export function fmtCurrency(value: number | undefined, digits = 2): string {
  if (value === undefined || !Number.isFinite(value)) return '—'
  const sign = value < 0 ? '-' : ''
  return `${sign}$${Math.abs(value).toLocaleString('en-US', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits
  })}`
}

export function fmtPct(value: number | undefined, digits = 1): string {
  if (value === undefined || !Number.isFinite(value)) return '—'
  return `${value >= 0 ? '+' : ''}${value.toFixed(digits)}%`
}

export function fmtBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1)
  return `${(bytes / 1024 ** i).toFixed(i === 0 ? 0 : 1)} ${units[i]}`
}

/** Renders a short relative duration, e.g. "in 42s". */
export function fmtCountdown(targetMs: number | null, nowMs: number): string {
  if (targetMs === null) return 'now'
  const delta = Math.max(0, targetMs - nowMs)
  if (delta < 1000) return 'now'
  const seconds = Math.ceil(delta / 1000)
  if (seconds < 60) return `${seconds}s`
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`
}

/** Today's date in Eastern time, as YYYY-MM-DD, for date-input defaults. */
export function todayEastern(): string {
  return DateTime.now().setZone(ZONE).toFormat('yyyy-MM-dd')
}

export function shiftDate(date: string, days: number): string {
  return DateTime.fromISO(date, { zone: ZONE }).plus({ days }).toFormat('yyyy-MM-dd')
}
