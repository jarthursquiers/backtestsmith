import { describe, expect, it } from 'vitest'
import { planForwardRange } from './forwardTest.js'

describe('locked forward range planning', () => {
  it('starts after the last attached batch and skips weekends', () => {
    expect(planForwardRange({
      startDate: '2026-08-18',
      lastCompletedDate: '2026-08-21', // Friday
      completedSessions: 4,
      targetSessions: 60,
      through: '2026-08-26',
      latestCompletedDate: '2026-08-26'
    })).toEqual({
      from: '2026-08-24',
      to: '2026-08-26',
      sessions: 3,
      remainingAfterRun: 53
    })
  })

  it('caps the final batch at the predeclared session target', () => {
    const plan = planForwardRange({
      startDate: '2026-08-18',
      completedSessions: 58,
      targetSessions: 60,
      through: '2026-09-30',
      latestCompletedDate: '2026-09-30'
    })
    expect(plan.sessions).toBe(2)
    expect(plan.to).toBe('2026-08-19')
    expect(plan.remainingAfterRun).toBe(0)
  })

  it('never plans through an incomplete or future market date', () => {
    const plan = planForwardRange({
      startDate: '2026-08-18',
      completedSessions: 0,
      targetSessions: 60,
      through: '2026-08-28',
      latestCompletedDate: '2026-08-20'
    })
    expect(plan.to).toBe('2026-08-20')
    expect(plan.sessions).toBe(3)
  })

  it('explains when the prospective start has not arrived', () => {
    expect(() => planForwardRange({
      startDate: '2026-08-18',
      completedSessions: 0,
      targetSessions: 60,
      through: '2026-08-17',
      latestCompletedDate: '2026-08-17'
    })).toThrow('next eligible session is 2026-08-18')
  })
})
