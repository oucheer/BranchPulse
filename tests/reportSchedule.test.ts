import { describe, expect, it } from 'vitest'
import type { ReportSchedule } from '@shared/types'
import { computeNextReportRunAt } from '../electron/services/reportSchedule'

function schedule(overrides: Partial<ReportSchedule> = {}): ReportSchedule {
  return {
    id: 'schedule-1',
    name: 'Daily report',
    repositoryId: null,
    frequency: 'daily',
    time: '09:00',
    weekday: 1,
    dayOfMonth: 1,
    runAt: null,
    recipients: '',
    enabled: true,
    lastRunAt: null,
    nextRunAt: null,
    createdAt: '2026-09-01T00:00:00.000Z',
    ...overrides
  }
}

describe('computeNextReportRunAt', () => {
  it('schedules the next daily occurrence after the current time', () => {
    const from = new Date(2026, 8, 7, 21, 0, 0, 0)
    expect(computeNextReportRunAt(schedule(), from)).toBe(new Date(2026, 8, 8, 9, 0, 0, 0).toISOString())
  })

  it('supports weekly local time', () => {
    const from = new Date(2026, 8, 7, 21, 0, 0, 0)
    const weekly = schedule({ frequency: 'weekly', weekday: 1, time: '09:00' })
    expect(computeNextReportRunAt(weekly, from)).toBe(new Date(2026, 8, 14, 9, 0, 0, 0).toISOString())
  })

  it('supports monthly local time', () => {
    const from = new Date(2026, 8, 7, 21, 0, 0, 0)
    const monthly = schedule({ frequency: 'monthly', dayOfMonth: 10, time: '09:00' })
    expect(computeNextReportRunAt(monthly, from)).toBe(new Date(2026, 8, 10, 9, 0, 0, 0).toISOString())
  })
})
