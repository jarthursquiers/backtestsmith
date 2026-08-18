import { nextTradingDay, tradingDaysBetween } from '../core/time/marketTime.js'

export interface ForwardRangePlan {
  from: string
  to: string
  sessions: number
  remainingAfterRun: number
}

/**
 * Chooses the next contiguous prospective batch without crossing the declared
 * sample size or treating an incomplete/future session as evidence.
 */
export function planForwardRange(input: {
  startDate: string
  lastCompletedDate?: string
  completedSessions: number
  targetSessions: number
  through: string
  latestCompletedDate: string
}): ForwardRangePlan {
  const remaining = input.targetSessions - input.completedSessions
  if (remaining <= 0) throw new Error('This forward test has no remaining sessions.')

  const from = input.lastCompletedDate ? nextTradingDay(input.lastCompletedDate) : input.startDate
  const availableThrough = input.through > input.latestCompletedDate
    ? input.latestCompletedDate
    : input.through
  if (availableThrough < from) {
    throw new Error(`No new forward sessions are available yet. The next eligible session is ${from}.`)
  }

  const eligible = tradingDaysBetween(from, availableThrough)
  if (eligible.length === 0) {
    throw new Error(`There are no trading sessions between ${from} and ${availableThrough}.`)
  }
  const sessions = Math.min(eligible.length, remaining)
  return {
    from,
    to: eligible[sessions - 1]!,
    sessions,
    remainingAfterRun: remaining - sessions
  }
}
