import { useMemo, useState } from 'react'
import type { TradeResult } from '../../shared/trade.js'
import { Badge, Card } from './primitives.js'
import { fmtCurrency, fmtPct } from '../lib/format.js'

type SortKey = 'pnlPct' | 'holdingMinutes' | 'capture' | 'giveback'

const EXIT_LABEL: Record<string, string> = {
  expiration: 'expiry',
  profitTarget: 'target',
  stopLoss: 'stop',
  timeExit: 'time',
  centerTouch: 'center',
  tentEntry: 'tent',
  trailingProfit: 'trail',
  endOfData: 'data end'
}

/**
 * Every management method applied to one trade.
 *
 * The point of showing them together is that they share a single reconstructed
 * price path, so differences between rows are caused only by the rules, never by
 * a different entry.
 */
export function ManagementTable({ results }: { results: TradeResult[] }) {
  const [sortKey, setSortKey] = useState<SortKey>('pnlPct')

  const sorted = useMemo(() => {
    const copy = [...results]
    copy.sort((a, b) => {
      switch (sortKey) {
        case 'holdingMinutes':
          return a.holdingMinutes - b.holdingMinutes
        case 'capture':
          return (b.mfeCaptureRatio ?? -Infinity) - (a.mfeCaptureRatio ?? -Infinity)
        case 'giveback':
          return a.profitGiveback - b.profitGiveback
        default:
          return b.pnlPct - a.pnlPct
      }
    })
    return copy
  }, [results, sortKey])

  const ambiguousCount = results.filter((r) => r.ambiguous).length

  const header = (key: SortKey, label: string, className = 'text-right') => (
    <th
      className={`cursor-pointer px-3 py-1.5 font-medium select-none hover:text-ink ${className} ${
        sortKey === key ? 'text-accent' : ''
      }`}
      onClick={() => setSortKey(key)}
    >
      {label}
      {sortKey === key ? ' ↓' : ''}
    </th>
  )

  return (
    <Card
      title="Management comparison"
      subtitle="Every rule applied to this one reconstructed path, so differences come only from the rules themselves."
      actions={
        ambiguousCount > 0 ? (
          <Badge tone="warn">{ambiguousCount} ambiguous</Badge>
        ) : (
          <Badge tone="gain">no ambiguity</Badge>
        )
      }
    >
      <div className="overflow-x-auto rounded-md border border-line">
        <table className="w-full border-collapse text-[11px]">
          <thead className="bg-surface-2">
            <tr className="text-left text-ink-faint">
              <th className="px-3 py-1.5 font-medium">Management</th>
              <th className="px-3 py-1.5 font-medium">Exit</th>
              {header('pnlPct', 'P/L %')}
              <th className="px-3 py-1.5 text-right font-medium">P/L $</th>
              <th className="px-3 py-1.5 text-right font-medium">MFE</th>
              {header('capture', 'Capture')}
              {header('giveback', 'Giveback')}
              {header('holdingMinutes', 'Held')}
              <th className="px-3 py-1.5 text-right font-medium">DTE</th>
            </tr>
          </thead>
          <tbody className="num">
            {sorted.map((r) => (
              <tr
                key={r.strategyId}
                className="border-t border-line-soft hover:bg-surface-2"
                title={r.note ?? undefined}
              >
                <td className="px-3 py-1 text-ink-dim">
                  {r.strategyLabel}
                  {r.ambiguous && <span className="ml-1.5 text-warn" title={r.note}>⚠</span>}
                </td>
                <td className="px-3 py-1 text-ink-faint">{EXIT_LABEL[r.exitReason] ?? r.exitReason}</td>
                <td className={`px-3 py-1 text-right ${r.pnlPct >= 0 ? 'text-gain' : 'text-loss'}`}>
                  {fmtPct(r.pnlPct)}
                </td>
                <td className={`px-3 py-1 text-right ${r.pnlDollars >= 0 ? 'text-gain' : 'text-loss'}`}>
                  {fmtCurrency(r.pnlDollars)}
                </td>
                <td className="px-3 py-1 text-right text-ink-faint">{fmtPct(r.excursions.mfe?.pct)}</td>
                <td className="px-3 py-1 text-right text-ink-dim">
                  {r.mfeCaptureRatio === null ? '—' : `${(r.mfeCaptureRatio * 100).toFixed(0)}%`}
                </td>
                <td className="px-3 py-1 text-right text-ink-faint">{fmtCurrency(r.profitGiveback)}</td>
                <td className="px-3 py-1 text-right text-ink-faint">
                  {Math.floor(r.holdingMinutes / 60)}h {r.holdingMinutes % 60}m
                </td>
                <td className="px-3 py-1 text-right text-ink-faint">{r.exitDte}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <p className="mt-2 text-[10px] leading-relaxed text-ink-faint">
        <span className="text-warn">⚠</span> marks an exit that minute bars cannot fully establish — either the
        trigger was only reachable inside the minute&apos;s possible range, or opposing rules were both
        reachable and the adverse one was assumed. Capture is realized ÷ maximum unrealized profit; giveback is
        the dollars surrendered from the peak. This is a single trade, so nothing here is evidence about a
        method in general.
      </p>
    </Card>
  )
}
