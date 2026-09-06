import type { ScanRun, SchedulerJob } from '@shared/types'
import type { StorageService } from './storage'
import type { MonitoringService } from './monitoring'
import type { AuditService } from './audit'
import { newId } from '../utils/ids'
import { logger } from '../utils/logger'

const DAY_MS = 24 * 60 * 60 * 1000

function rowToJob(row: Record<string, unknown>): SchedulerJob {
  let days: number[] = []
  try {
    const parsed = JSON.parse(String(row.days_json ?? '[]'))
    if (Array.isArray(parsed)) days = parsed.map(Number).filter((n) => Number.isFinite(n))
  } catch {
    days = []
  }
  return {
    id: String(row.id),
    repositoryId: (row.repository_id as string | null) ?? null,
    name: String(row.name),
    kind: (row.kind === 'calendar' ? 'calendar' : 'interval') as SchedulerJob['kind'],
    enabled: Number(row.enabled ?? 1) === 1,
    intervalHours: Number(row.interval_hours ?? 24),
    daysOfWeek: days,
    time: String(row.time ?? '09:00'),
    startDate: (row.start_date as string | null) ?? null,
    endDate: (row.end_date as string | null) ?? null,
    emailPolicy: ((row.email_policy as SchedulerJob['emailPolicy']) ?? 'none'),
    fetchEnabled: Number(row.fetch_enabled ?? 1) === 1,
    autoDeleteEnabled: Number(row.auto_delete_enabled ?? 0) === 1,
    notifyTarget: ((row.notify_target as SchedulerJob['notifyTarget']) ?? 'self'),
    lastRunAt: (row.last_run_at as string | null) ?? null,
    nextRunAt: (row.next_run_at as string | null) ?? null,
    createdAt: String(row.created_at)
  }
}

function startOfDay(date: Date): Date {
  const d = new Date(date)
  d.setHours(0, 0, 0, 0)
  return d
}

export function computeNextRunAt(job: SchedulerJob, from: Date = new Date()): string {
  if (job.kind === 'interval') {
    const base = job.lastRunAt ? new Date(job.lastRunAt) : from
    const next = new Date(base.getTime() + Math.max(1, job.intervalHours) * 3600 * 1000)
    return next.toISOString()
  }
  const [hour, minute] = (job.time || '09:00').split(':').map(Number)
  const days = job.daysOfWeek.length ? job.daysOfWeek : [1, 2, 3, 4, 5]
  const cursor = new Date(from.getTime() + 60 * 1000)
  for (let i = 0; i < 370; i += 1) {
    const candidate = startOfDay(cursor)
    candidate.setHours(hour || 0, minute || 0, 0, 0)
    if (candidate.getTime() >= from.getTime() && days.includes(candidate.getDay())) {
      return candidate.toISOString()
    }
    cursor.setDate(cursor.getDate() + 1)
  }
  return from.toISOString()
}

export class SchedulerService {
  private timer: NodeJS.Timeout | null = null

  constructor(
    private readonly storage: StorageService,
    private readonly monitoring: MonitoringService,
    private readonly audit: AuditService
  ) {}

  listJobs(): SchedulerJob[] {
    const rows = this.storage.all<Record<string, unknown>>('SELECT * FROM scheduler_jobs ORDER BY created_at ASC')
    return rows.map(rowToJob)
  }

  saveJob(job: Partial<SchedulerJob> & { id?: string }): SchedulerJob[] {
    const existing = job.id ? this.listJobs().find((j) => j.id === job.id) : undefined
    const merged: SchedulerJob = {
      id: existing?.id ?? newId(),
      repositoryId: job.repositoryId ?? existing?.repositoryId ?? null,
      name: job.name ?? existing?.name ?? 'Monitoring job',
      kind: job.kind ?? existing?.kind ?? 'interval',
      enabled: job.enabled ?? existing?.enabled ?? true,
      intervalHours: job.intervalHours ?? existing?.intervalHours ?? 24,
      daysOfWeek: job.daysOfWeek ?? existing?.daysOfWeek ?? [],
      time: job.time ?? existing?.time ?? '09:00',
      startDate: job.startDate !== undefined ? job.startDate : existing?.startDate ?? null,
      endDate: job.endDate !== undefined ? job.endDate : existing?.endDate ?? null,
      emailPolicy: job.emailPolicy ?? existing?.emailPolicy ?? 'none',
      fetchEnabled: job.fetchEnabled ?? existing?.fetchEnabled ?? true,
      autoDeleteEnabled: job.autoDeleteEnabled ?? existing?.autoDeleteEnabled ?? false,
      notifyTarget: job.notifyTarget ?? existing?.notifyTarget ?? 'self',
      lastRunAt: existing?.lastRunAt ?? null,
      nextRunAt: existing?.nextRunAt ?? null,
      createdAt: existing?.createdAt ?? new Date().toISOString()
    }
    if (!merged.nextRunAt) {
      merged.nextRunAt = computeNextRunAt(merged)
    }
    if (existing) {
      this.storage.update(
        'scheduler_jobs',
        {
          name: merged.name,
          kind: merged.kind,
          enabled: merged.enabled ? 1 : 0,
          interval_hours: merged.intervalHours,
          days_json: JSON.stringify(merged.daysOfWeek),
          time: merged.time,
          start_date: merged.startDate,
          end_date: merged.endDate,
          email_policy: merged.emailPolicy,
          fetch_enabled: merged.fetchEnabled ? 1 : 0,
          repository_id: merged.repositoryId ?? null,
          auto_delete_enabled: merged.autoDeleteEnabled ? 1 : 0,
          notify_target: merged.notifyTarget,
          last_run_at: merged.lastRunAt,
          next_run_at: merged.nextRunAt
        },
        'id = ?',
        [merged.id]
      )
    } else {
      this.storage.insert('scheduler_jobs', {
        id: merged.id,
        repository_id: merged.repositoryId ?? null,
        name: merged.name,
        kind: merged.kind,
        enabled: merged.enabled ? 1 : 0,
        interval_hours: merged.intervalHours,
        days_json: JSON.stringify(merged.daysOfWeek),
        time: merged.time,
        start_date: merged.startDate,
        end_date: merged.endDate,
        email_policy: merged.emailPolicy,
        fetch_enabled: merged.fetchEnabled ? 1 : 0,
        auto_delete_enabled: merged.autoDeleteEnabled ? 1 : 0,
        notify_target: merged.notifyTarget,
        last_run_at: merged.lastRunAt,
        next_run_at: merged.nextRunAt,
        created_at: merged.createdAt
      })
    }
    this.audit.record('scheduler_job_saved', { id: merged.id, name: merged.name })
    return this.listJobs()
  }

  deleteJob(id: string): SchedulerJob[] {
    this.storage.delete('scheduler_jobs', 'id = ?', [id])
    this.audit.record('scheduler_job_deleted', { id })
    return this.listJobs()
  }

  async runSchedulerJob(id: string): Promise<ScanRun> {
    const job = this.listJobs().find((j) => j.id === id)
    if (!job) throw new Error('Scheduler job not found.')
    const now = new Date()
    const run = await this.monitoring.runCheckNow({
      trigger: 'scheduler',
      fetch: job.fetchEnabled,
      emailPolicy: job.emailPolicy,
      notifyTarget: job.notifyTarget,
      autoDelete: job.autoDeleteEnabled,
      ...(job.repositoryId ? { repositoryIds: [job.repositoryId] } : {})
    })
    this.storage.update(
      'scheduler_jobs',
      {
        last_run_at: now.toISOString(),
        next_run_at: computeNextRunAt({ ...job, lastRunAt: now.toISOString() }, now)
      },
      'id = ?',
      [id]
    )
    this.audit.record('scheduler_job_ran', { id: job.id, name: job.name, run: run.id })
    return run
  }

  start(): void {
    if (this.timer) return
    this.timer = setInterval(() => {
      void this.tick()
    }, 30 * 1000)
    void this.tick()
    logger.info('Scheduler started (30s heartbeat).')
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
  }

  private async tick(): Promise<void> {
    const now = Date.now()
    for (const job of this.listJobs()) {
      if (!job.enabled) continue
      if (job.startDate && new Date(job.startDate).getTime() > now) continue
      if (job.endDate && new Date(job.endDate).getTime() < now) continue
      const next = job.nextRunAt ? new Date(job.nextRunAt).getTime() : 0
      if (next <= now) {
        try {
          await this.runSchedulerJob(job.id)
        } catch (err) {
          logger.error(`Scheduler job ${job.name} failed`, err)
        }
      }
    }
  }

  calendarRuns(): { date: string; status: ScanRun['status']; runs: number }[] {
    const rows = this.storage.all<Record<string, unknown>>('SELECT started_at, status FROM scan_runs ORDER BY started_at ASC')
    const map = new Map<string, { status: ScanRun['status']; runs: number }>()
    for (const row of rows) {
      const date = String(row.started_at).slice(0, 10)
      const status = (row.status as ScanRun['status']) ?? 'completed'
      const existing = map.get(date) ?? { status: status as ScanRun['status'], runs: 0 }
      existing.runs += 1
      if (status === 'failed') existing.status = 'failed'
      else if (status === 'running' && existing.status !== 'failed') existing.status = 'running'
      map.set(date, existing)
    }
    return Array.from(map.entries()).map(([date, value]) => ({ date, ...value }))
  }
}

export function dayLabel(date: Date): string {
  return startOfDay(date).toISOString().slice(0, 10)
}

export { DAY_MS }
