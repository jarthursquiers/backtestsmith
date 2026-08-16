import {
  CartesianGrid,
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis
} from 'recharts'
import type { ButterflyObservation } from '../../domain/butterfly.js'
import type { Excursions } from '../../shared/excursions.js'
import { fmtCurrency, fmtEasternDateTime, fmtPct, fmtPrice } from '../lib/format.js'

/**
 * The two synchronized panes of the trade inspector.
 *
 * Both charts are plotted against the observation index rather than a time axis.
 * Minutes with no priceable observation are absent from the series, and a time
 * axis would draw a straight line across those gaps, implying prices that were
 * never observed. Session boundaries are marked instead so the gaps stay visible.
 */

export interface PathPoint {
  index: number
  timestamp: number
  pnlPct: number
  pnlDollars: number
  butterflyValue: number
  underlyingPrice?: number
  stale: boolean
  dte: number
}

export function toPathPoints(observations: readonly ButterflyObservation[]): PathPoint[] {
  return observations.map((o, index) => ({
    index,
    timestamp: o.timestamp,
    pnlPct: o.pnlPct,
    pnlDollars: o.pnlDollars,
    butterflyValue: o.butterflyValue,
    ...(o.underlyingPrice !== undefined ? { underlyingPrice: o.underlyingPrice } : {}),
    stale: o.stale,
    dte: o.dte
  }))
}

/** Indices where the market date changes, for drawing session dividers. */
function sessionBoundaries(points: readonly PathPoint[]): number[] {
  const out: number[] = []
  for (let i = 1; i < points.length; i++) {
    const previous = new Date(points[i - 1]!.timestamp).toDateString()
    const current = new Date(points[i]!.timestamp).toDateString()
    if (previous !== current) out.push(points[i]!.index)
  }
  return out
}

const AXIS = { fill: '#64748b', fontSize: 10 }
const TOOLTIP_STYLE = {
  background: '#111725',
  border: '1px solid #222d44',
  borderRadius: 6,
  fontSize: 11
}

/** SPX price with the three strikes overlaid. */
export function UnderlyingPathChart({
  points,
  lowerStrike,
  centerStrike,
  upperStrike,
  height = 220
}: {
  points: PathPoint[]
  lowerStrike: number
  centerStrike: number
  upperStrike: number
  height?: number
}) {
  const withPrice = points.filter((p) => p.underlyingPrice !== undefined)
  const boundaries = sessionBoundaries(points)

  if (withPrice.length === 0) {
    return (
      <div
        className="flex items-center justify-center rounded-md border border-dashed border-line text-[11px] text-ink-faint"
        style={{ height }}
      >
        No SPX data cached for this window, so the underlying path cannot be drawn.
      </div>
    )
  }

  return (
    <div style={{ height }}>
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={points} margin={{ top: 8, right: 12, bottom: 4, left: 0 }} syncId="trade">
          <CartesianGrid stroke="#1a2233" strokeDasharray="2 4" vertical={false} />
          <XAxis dataKey="index" tick={AXIS} stroke="#222d44" hide />
          <YAxis tick={AXIS} stroke="#222d44" width={58} domain={['auto', 'auto']} />
          {boundaries.map((index) => (
            <ReferenceLine key={index} x={index} stroke="#2f3d5c" strokeDasharray="3 3" />
          ))}
          {/* The butterfly tent: wings dim, center emphasized. */}
          <ReferenceLine y={lowerStrike} stroke="#475569" strokeDasharray="4 4" />
          <ReferenceLine
            y={centerStrike}
            stroke="#fbbf24"
            strokeDasharray="4 4"
            label={{ value: 'center', fill: '#fbbf24', fontSize: 9, position: 'insideTopRight' }}
          />
          <ReferenceLine y={upperStrike} stroke="#475569" strokeDasharray="4 4" />
          <Tooltip
            contentStyle={TOOLTIP_STYLE}
            labelStyle={{ color: '#94a3bd' }}
            labelFormatter={(index) => {
              const point = points[Number(index)]
              return point ? `${fmtEasternDateTime(point.timestamp)} ET` : ''
            }}
            formatter={(value) => [fmtPrice(typeof value === 'number' ? value : undefined), 'SPX']}
          />
          <Line
            type="linear"
            dataKey="underlyingPrice"
            stroke="#e6ecf7"
            strokeWidth={1.3}
            dot={false}
            connectNulls={false}
            isAnimationActive={false}
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  )
}

/** Butterfly P/L with entry, MFE, MAE, and optional target/stop lines. */
export function PnlPathChart({
  points,
  excursions,
  profitTargetPct,
  stopLossPct,
  height = 240
}: {
  points: PathPoint[]
  excursions: Excursions
  profitTargetPct?: number
  stopLossPct?: number
  height?: number
}) {
  const boundaries = sessionBoundaries(points)
  const mfeIndex = excursions.mfe
    ? points.find((p) => p.timestamp === excursions.mfe!.timestamp)?.index
    : undefined
  const maeIndex = excursions.mae
    ? points.find((p) => p.timestamp === excursions.mae!.timestamp)?.index
    : undefined

  return (
    <div style={{ height }}>
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={points} margin={{ top: 8, right: 12, bottom: 4, left: 0 }} syncId="trade">
          <CartesianGrid stroke="#1a2233" strokeDasharray="2 4" vertical={false} />
          <XAxis
            dataKey="index"
            tick={AXIS}
            stroke="#222d44"
            minTickGap={56}
            tickFormatter={(index: number) => {
              const point = points[index]
              return point ? `${point.dte}d` : ''
            }}
          />
          <YAxis
            tick={AXIS}
            stroke="#222d44"
            width={58}
            domain={['auto', 'auto']}
            tickFormatter={(v: number) => `${v.toFixed(0)}%`}
          />
          {boundaries.map((index) => (
            <ReferenceLine key={index} x={index} stroke="#2f3d5c" strokeDasharray="3 3" />
          ))}
          {/* Break-even: the line every management rule is measured against. */}
          <ReferenceLine y={0} stroke="#64748b" />
          {profitTargetPct !== undefined && (
            <ReferenceLine
              y={profitTargetPct}
              stroke="#34d399"
              strokeDasharray="5 3"
              label={{ value: `+${profitTargetPct}%`, fill: '#34d399', fontSize: 9, position: 'insideTopLeft' }}
            />
          )}
          {stopLossPct !== undefined && (
            <ReferenceLine
              y={-Math.abs(stopLossPct)}
              stroke="#f87171"
              strokeDasharray="5 3"
              label={{ value: `-${Math.abs(stopLossPct)}%`, fill: '#f87171', fontSize: 9, position: 'insideBottomLeft' }}
            />
          )}
          {mfeIndex !== undefined && <ReferenceLine x={mfeIndex} stroke="#34d399" strokeOpacity={0.5} />}
          {maeIndex !== undefined && <ReferenceLine x={maeIndex} stroke="#f87171" strokeOpacity={0.5} />}
          <Tooltip
            contentStyle={TOOLTIP_STYLE}
            labelStyle={{ color: '#94a3bd' }}
            labelFormatter={(index) => {
              const point = points[Number(index)]
              if (!point) return ''
              return `${fmtEasternDateTime(point.timestamp)} ET · ${point.dte} DTE${point.stale ? ' · stale' : ''}`
            }}
            formatter={(value, _name, item) => {
              const point = item?.payload as PathPoint | undefined
              return [
                `${fmtPct(typeof value === 'number' ? value : undefined)}  (${fmtCurrency(point?.pnlDollars)} · mark ${fmtPrice(point?.butterflyValue)})`,
                'P/L'
              ]
            }}
          />
          <Line
            type="linear"
            dataKey="pnlPct"
            stroke="#4f9cf9"
            strokeWidth={1.5}
            dot={false}
            isAnimationActive={false}
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  )
}
