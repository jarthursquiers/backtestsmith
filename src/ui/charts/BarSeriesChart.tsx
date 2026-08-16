import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis
} from 'recharts'
import type { OptionBar, UnderlyingBar } from '../../domain/bars.js'
import { fmtEasternDateTime, fmtEasternTime, fmtPrice } from '../lib/format.js'

/**
 * Minute-bar close series.
 *
 * Bars are plotted against their index rather than a continuous time axis, on
 * purpose: minutes with no qualifying trade produce no bar, and a time axis
 * would draw a straight interpolating line across those gaps, visually implying
 * prices that were never observed. The gap count is reported separately instead.
 */
export function BarSeriesChart({
  bars,
  label,
  height = 260
}: {
  bars: (OptionBar | UnderlyingBar)[]
  label: string
  height?: number
}) {
  const data = bars.map((bar, index) => ({
    index,
    timestamp: bar.timestamp,
    close: bar.close,
    high: bar.high,
    low: bar.low
  }))

  return (
    <div style={{ height }}>
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={data} margin={{ top: 8, right: 12, bottom: 4, left: 0 }}>
          <CartesianGrid stroke="#1a2233" strokeDasharray="2 4" vertical={false} />
          <XAxis
            dataKey="index"
            tick={{ fill: '#64748b', fontSize: 10 }}
            stroke="#222d44"
            tickFormatter={(index: number) => {
              const point = data[index]
              return point ? fmtEasternTime(point.timestamp) : ''
            }}
            minTickGap={48}
          />
          <YAxis
            tick={{ fill: '#64748b', fontSize: 10 }}
            stroke="#222d44"
            width={58}
            domain={['auto', 'auto']}
            tickFormatter={(value: number) => value.toFixed(2)}
          />
          <Tooltip
            contentStyle={{
              background: '#111725',
              border: '1px solid #222d44',
              borderRadius: 6,
              fontSize: 11
            }}
            labelStyle={{ color: '#94a3bd' }}
            labelFormatter={(index) => {
              const point = data[Number(index)]
              return point ? fmtEasternDateTime(point.timestamp) + ' ET' : ''
            }}
            formatter={(value) => [fmtPrice(typeof value === 'number' ? value : undefined), label]}
          />
          <Line
            type="linear"
            dataKey="close"
            stroke="#4f9cf9"
            strokeWidth={1.4}
            dot={false}
            isAnimationActive={false}
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  )
}
