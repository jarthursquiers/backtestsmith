import { NavLink, Navigate, Route, HashRouter as Router, Routes } from 'react-router-dom'
import { useEffect, useState } from 'react'
import type { AppInfo } from '../shared/ipc.js'
import { QueueIndicator } from './components/QueueIndicator.js'
import { DashboardPage } from './pages/DashboardPage.js'
import { DataPage } from './pages/DataPage.js'
import { ExplorerPage } from './pages/ExplorerPage.js'
import { DiagnosticsPage } from './pages/DiagnosticsPage.js'
import { SettingsPage } from './pages/SettingsPage.js'
import { PlannedPage } from './pages/PlannedPage.js'

interface NavItem {
  to: string
  label: string
  /** Set when the section is not yet implemented, so the nav never over-promises. */
  phase?: string
}

const NAV_GROUPS: { heading: string; items: NavItem[] }[] = [
  {
    heading: 'Overview',
    items: [
      { to: '/dashboard', label: 'Dashboard' },
      { to: '/data', label: 'Data' }
    ]
  },
  {
    heading: 'Research',
    items: [
      { to: '/explorer', label: 'Contract Explorer' },
      { to: '/strategy', label: 'Strategy', phase: 'Phase 7' },
      { to: '/run', label: 'Run Study', phase: 'Phase 8' },
      { to: '/results', label: 'Results', phase: 'Phase 8' },
      { to: '/compare', label: 'Compare', phase: 'Phase 9' },
      { to: '/trade', label: 'Trade Inspector', phase: 'Phase 5' }
    ]
  },
  {
    heading: 'System',
    items: [
      { to: '/diagnostics', label: 'Diagnostics' },
      { to: '/settings', label: 'Settings' }
    ]
  }
]

function Sidebar({ info }: { info: AppInfo | null }) {
  return (
    <aside className="flex w-52 shrink-0 flex-col border-r border-line bg-surface">
      <div className="border-b border-line-soft px-4 py-3.5">
        <div className="text-[13px] font-semibold tracking-tight text-ink">Backtestsmith</div>
        <div className="mt-0.5 text-[10px] text-ink-faint">SPX butterfly research</div>
      </div>

      <nav className="flex-1 overflow-y-auto px-2 py-3">
        {NAV_GROUPS.map((group) => (
          <div key={group.heading} className="mb-4">
            <div className="px-2 pb-1.5 text-[9px] font-semibold uppercase tracking-widest text-ink-faint">
              {group.heading}
            </div>
            {group.items.map((item) => (
              <NavLink
                key={item.to}
                to={item.to}
                className={({ isActive }) =>
                  `flex items-center justify-between rounded-md px-2 py-1.5 text-[12px] transition ${
                    isActive
                      ? 'bg-accent/15 font-medium text-accent'
                      : 'text-ink-dim hover:bg-surface-2 hover:text-ink'
                  }`
                }
              >
                <span>{item.label}</span>
                {item.phase && (
                  <span className="rounded bg-line-soft px-1 py-px text-[9px] text-ink-faint">{item.phase}</span>
                )}
              </NavLink>
            ))}
          </div>
        ))}
      </nav>

      <div className="border-t border-line-soft px-4 py-2.5">
        <QueueIndicator />
        <div className="num mt-2 text-[10px] text-ink-faint">
          v{info?.version ?? '—'}
          {info?.gitCommit ? ` · ${info.gitCommit.slice(0, 7)}` : ''}
        </div>
      </div>
    </aside>
  )
}

export function App() {
  const [info, setInfo] = useState<AppInfo | null>(null)

  useEffect(() => {
    void window.api.app.info().then(setInfo).catch(() => setInfo(null))
  }, [])

  return (
    <Router>
      <div className="flex h-full">
        <Sidebar info={info} />
        <main className="flex min-w-0 flex-1 flex-col overflow-hidden">
          <Routes>
            <Route path="/" element={<Navigate to="/dashboard" replace />} />
            <Route path="/dashboard" element={<DashboardPage />} />
            <Route path="/data" element={<DataPage />} />
            <Route path="/explorer" element={<ExplorerPage />} />
            <Route path="/diagnostics" element={<DiagnosticsPage />} />
            <Route path="/settings" element={<SettingsPage />} />
            <Route
              path="/strategy"
              element={
                <PlannedPage
                  title="Strategy"
                  phase="Phase 7"
                  description="Entry time, target DTE, 9 EMA direction rule, butterfly placement, wing width, pricing model, and missing-data policy."
                />
              }
            />
            <Route
              path="/run"
              element={
                <PlannedPage
                  title="Run Study"
                  phase="Phase 8"
                  description="Configure one management rule or a parameter sweep, then run the batch backtester over a date range."
                />
              }
            />
            <Route
              path="/results"
              element={
                <PlannedPage
                  title="Results"
                  phase="Phase 8"
                  description="Summary metrics, equity curve, drawdown, and the aggregate research charts."
                />
              }
            />
            <Route
              path="/compare"
              element={
                <PlannedPage
                  title="Compare"
                  phase="Phase 9"
                  description="Run one identical entry population through many management methods and compare risk-adjusted outcomes."
                />
              }
            />
            <Route
              path="/trade"
              element={
                <PlannedPage
                  title="Trade Inspector"
                  phase="Phase 5"
                  description="Per-trade SPX and butterfly P/L charts with strike overlays, MFE/MAE markers, and synchronized hover."
                />
              }
            />
            <Route path="*" element={<Navigate to="/dashboard" replace />} />
          </Routes>
        </main>
      </div>
    </Router>
  )
}
