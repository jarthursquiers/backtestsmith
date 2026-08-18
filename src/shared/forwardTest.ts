import type { ManagementSummary, StudyConfig } from './study.js'

export type ForwardTestState = 'active' | 'complete'

/** Immutable definition and accumulated progress for one prospective test. */
export interface ForwardTestSummary {
  forwardTestId: string
  name: string
  createdAt: number
  /** First market session that was not known when the test was locked. */
  startDate: string
  targetSessions: number
  state: ForwardTestState
  /** Configuration frozen at creation. Dates are replaced for each forward batch. */
  config: StudyConfig
  /** SHA-256 of the date-independent locked configuration. */
  configHash: string
  appVersion: string
  gitCommit?: string
  completedSessions: number
  acceptedEntries: number
  skippedSessions: number
  runCount: number
  /** Latest entry date whose maximum permitted expiration has fully passed. */
  latestMatureEntryDate: string
  lastCompletedDate?: string
}

export interface ForwardTestRunSummary {
  runId: string
  from: string
  to: string
  sessions: number
  createdAt: number
  acceptedEntries: number
  skippedSessions: number
}

export interface ForwardTestDetail {
  test: ForwardTestSummary
  runs: ForwardTestRunSummary[]
  /** Metrics recomputed over every attached forward run, never the source backtest. */
  summaries: ManagementSummary[]
}

export interface CreateForwardTestRequest {
  sourceRunId: string
  name: string
  /** Deliberately small: each locked test should represent a predeclared hypothesis. */
  managements: string[]
  targetSessions: number
}

export interface ForwardRunPlan {
  forwardTestId: string
  from: string
  to: string
  sessions: number
  remainingAfterRun: number
  config: StudyConfig
}
