import { describe, expect, it, vi } from 'vitest'
import type { ScanRun, SchedulerJob } from '@shared/types'
import type { AuditService } from '../electron/services/audit'
import type { MonitoringService } from '../electron/services/monitoring'
import { computeNextRunAt, SchedulerService } from '../electron/services/scheduler'
import type { StorageService } from '../electron/services/storage'

function sampleJob(overrides: Partial<SchedulerJob> = {}): SchedulerJob {
  return {
    id: 'job-1',
    name: 'Nightly check',
    kind: 'interval',
    enabled: true,
    intervalMinutes: 1440,
    daysOfWeek: [],
    time: '09:00',
    startDate: null,
    endDate: null,
    emailPolicy: 'none',
    fetchEnabled: true,
    autoDeleteEnabled: false,
    notifyTarget: 'self',
    lastRunAt: null,
    nextRunAt: null,
    createdAt: '2026-09-01T00:00:00.000Z',
    ...overrides
  }
}

function jobRow(job: SchedulerJob): Record<string, unknown> {
  return {
    id: job.id,
    name: job.name,
    kind: job.kind,
    enabled: job.enabled ? 1 : 0,
    interval_hours: Math.max(1, Math.ceil(job.intervalMinutes / 60)),
    interval_minutes: job.intervalMinutes,
    days_json: JSON.stringify(job.daysOfWeek),
    time: job.time,
    start_date: job.startDate,
    end_date: job.endDate,
    email_policy: job.emailPolicy,
    fetch_enabled: job.fetchEnabled ? 1 : 0,
    auto_delete_enabled: job.autoDeleteEnabled ? 1 : 0,
    notify_target: job.notifyTarget,
    last_run_at: job.lastRunAt,
    next_run_at: job.nextRunAt,
    created_at: job.createdAt
  }
}

function sampleRun(): ScanRun {
  return {
    id: 'run-1',
    startedAt: '2026-09-03T10:00:00.000Z',
    finishedAt: '2026-09-03T10:00:02.000Z',
    status: 'completed',
    trigger: 'scheduler',
    repositories: 1,
    branches: 4,
    active: 2,
    stale: 1,
    gracePeriod: 0,
    graceExpired: 1,
    merged: 1,
    namingInvalid: 1,
    cleanupCandidates: 1,
    notifications: 2,
    emailsSent: 0,
    error: null,
    activity: [{ at: '2026-09-03T10:00:00.000Z', message: 'done', level: 'success' }]
  }
}

describe('SchedulerService never deletes branches', () => {
  it('runSchedulerJob only invokes the monitoring check', async () => {
    const job = sampleJob()
    const storage = {
      all: vi.fn().mockReturnValue([jobRow(job)]),
      get: vi.fn().mockReturnValue(undefined),
      update: vi.fn(),
      insert: vi.fn(),
      delete: vi.fn()
    } as unknown as StorageService
    const monitoring = {
      runCheckNow: vi.fn().mockResolvedValue(sampleRun())
    } as unknown as MonitoringService
    const audit = { record: vi.fn() } as unknown as AuditService

    const service = new SchedulerService(storage, monitoring, audit)
    const run = await service.runSchedulerJob('job-1')

    expect(run.status).toBe('completed')
    expect(monitoring.runCheckNow).toHaveBeenCalledTimes(1)
    expect(monitoring.runCheckNow).toHaveBeenCalledWith({
      trigger: 'scheduler',
      fetch: true,
      emailPolicy: 'none',
      notifyTarget: 'self',
      autoDelete: false
    })
    expect(storage.delete).not.toHaveBeenCalled()
    expect(storage.update).toHaveBeenCalledTimes(1)
    expect(audit.record).toHaveBeenCalledWith('scheduler_job_ran', expect.objectContaining({ id: 'job-1' }))
  })

  it('exposes no branch deletion path on scheduler or monitoring contracts', () => {
    const storage = {} as StorageService
    const monitoring = {} as MonitoringService
    const audit = {} as AuditService
    const service = new SchedulerService(storage, monitoring, audit)

    expect((service as unknown as Record<string, unknown>).deleteBranch).toBeUndefined()
    expect((monitoring as unknown as Record<string, unknown>).deleteBranch).toBeUndefined()
  })
})

describe('computeNextRunAt', () => {
  it('adds the interval to the last run', () => {
    const job = sampleJob({ intervalMinutes: 1440, lastRunAt: '2026-09-03T10:00:00.000Z' })
    expect(computeNextRunAt(job, new Date('2026-09-03T12:00:00.000Z'))).toBe('2026-09-04T10:00:00.000Z')
  })

  it('clamps the interval to at least one minute', () => {
    const job = sampleJob({ intervalMinutes: 0, lastRunAt: '2026-09-03T10:00:00.000Z' })
    expect(computeNextRunAt(job)).toBe('2026-09-03T10:01:00.000Z')
  })

  it('supports minute-level intervals', () => {
    const job = sampleJob({ intervalMinutes: 5, lastRunAt: '2026-09-03T10:00:00.000Z' })
    expect(computeNextRunAt(job, new Date('2026-09-03T12:00:00.000Z'))).toBe('2026-09-03T10:05:00.000Z')
  })

  it('finds the next matching weekday at the configured time', () => {
    const from = new Date(2026, 8, 7, 12, 0, 0, 0)
    const job = sampleJob({ kind: 'calendar', daysOfWeek: [1], time: '09:00' })
    expect(computeNextRunAt(job, from)).toBe(new Date(2026, 8, 14, 9, 0, 0, 0).toISOString())
  })

  it('skips weekends with the default weekday set', () => {
    const from = new Date(2026, 8, 11, 9, 0, 1, 0)
    const job = sampleJob({ kind: 'calendar', daysOfWeek: [], time: '09:00' })
    expect(computeNextRunAt(job, from)).toBe(new Date(2026, 8, 14, 9, 0, 0, 0).toISOString())
  })
})
