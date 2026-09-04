import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (value: string) => Buffer.from(value),
    decryptString: (value: Buffer) => value
  }
}))

import { apiBaseUrl, detectRemoteProvider } from '../electron/services/gitlab'

describe('remote providers', () => {
  it('detects supported platforms from service URLs', () => {
    expect(detectRemoteProvider('https://gitlab.example.com')).toBe('gitlab')
    expect(detectRemoteProvider('https://github.com/acme/app')).toBe('github')
    expect(detectRemoteProvider('https://gitee.com/acme/app')).toBe('gitee')
    expect(detectRemoteProvider('https://unknown.example.com', 'gitee')).toBe('gitee')
  })

  it('builds API bases for service roots and project URLs', () => {
    expect(apiBaseUrl('https://gitlab.example.com', 'gitlab')).toBe('https://gitlab.example.com/api/v4')
    expect(apiBaseUrl('https://gitlab.example.com/group/app', 'gitlab')).toBe('https://gitlab.example.com/api/v4')
    expect(apiBaseUrl('https://github.com/acme/app', 'github')).toBe('https://api.github.com')
    expect(apiBaseUrl('https://gitee.com/acme/app', 'gitee')).toBe('https://gitee.com/api/v5')
  })
})

describe('report schedule timing', () => {
  const from = new Date('2026-09-04T10:30:00')
  const base = {
    id: 'schedule-1',
    name: 'report',
    repositoryId: null,
    time: '09:00',
    weekday: 1,
    dayOfMonth: 1,
    runAt: null,
    recipients: '',
    enabled: true,
    lastRunAt: null,
    nextRunAt: null,
    createdAt: '2026-01-01T00:00:00.000Z'
  }

  it('computes daily, weekly, monthly, and one-shot schedules', async () => {
    const { computeNextReportRunAt } = await import('../electron/services/reportSchedule')
    expect(new Date(computeNextReportRunAt({ ...base, frequency: 'daily' }, from) ?? '').getDate()).toBe(5)
    expect(new Date(computeNextReportRunAt({ ...base, frequency: 'weekly', weekday: 1 }, from) ?? '').getDate()).toBe(7)
    expect(new Date(computeNextReportRunAt({ ...base, frequency: 'monthly', dayOfMonth: 15 }, from) ?? '').getDate()).toBe(15)
    expect(computeNextReportRunAt({ ...base, frequency: 'once', runAt: '2026-09-03T09:00:00Z' }, from)).toBeNull()
  })
})
