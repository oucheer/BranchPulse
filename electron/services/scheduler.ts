import type { ScanRun, SchedulerJob } from '@shared/types'
import type { StorageService } from './storage'
import type { MonitoringService } from './monitoring'
import type { AuditService } from './audit'
import { parseStringArray, uniqueIds } from './storage'
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
    repositoryIds: repositoryIdsFromRow(row),
    name: String(row.name),
    kind: (row.kind === 'calendar' ? 'calendar' : 'interval') as SchedulerJob['kind'],
    enabled: Number(row.enabled ?? 1) === 1,
    intervalMinutes: Number(row.interval_minutes ?? Number(row.interval_hours ?? 24) * 60),
    daysOfWeek: days,
    time: String(row.time ?? '09:00'),
    startDate: (row.start_date as string | null) ?? null,
    endDate: (row.end_date as string | null) ?? null,
    emailPolicy: ((row.email_policy as SchedulerJob['emailPolicy']) ?? 'none'),
    fetchEnabled: Number(row.fetch_enabled ?? 1) === 1,
    notifyTarget: ((row.notify_target as SchedulerJob['notifyTarget']) ?? 'self'),
    lastRunAt: (row.last_run_at as string | null) ?? null,
    nextRunAt: (row.next_run_at as string | null) ?? null,
    createdAt: String(row.created_at)
  }
}

function repositoryIdsFromRow(row: Record<string, unknown>): string[] {
  const stored = parseStringArray(row.repository_ids_json)
  if (stored.length > 0 || row.repository_ids_json != null) return stored
  const legacy = String(row.repository_id ?? '').trim()
  return legacy ? [legacy] : []
}

function covers(scope: string[], requested: string[]): boolean {
  const allowed = new Set(scope)
  return requested.every((id) => allowed.has(id))
}

function startOfDay(date: Date): Date {
  const d = new Date(date)
  d.setHours(0, 0, 0, 0)
  return d
}

export function computeNextRunAt(job: SchedulerJob, from: Date = new Date()): string {
  if (job.kind === 'interval') {
    const base = job.lastRunAt ? new Date(job.lastRunAt) : from
    const next = new Date(base.getTime() + Math.max(1, job.intervalMinutes) * 60 * 1000)
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

  private listAllJobs(): SchedulerJob[] {
    const rows = this.storage.all<Record<string, unknown>>('SELECT * FROM scheduler_jobs ORDER BY created_at ASC')
    return rows.map(rowToJob)
  }

  listJobs(repositoryIds?: string[]): SchedulerJob[] {
    const jobs = this.listAllJobs()
    if (repositoryIds === undefined) return jobs
    if (repositoryIds.length === 0) return []
    const selected = new Set(uniqueIds(repositoryIds))
    return jobs.filter((job) => job.repositoryIds.some((id) => selected.has(id)))
  }

  saveJob(job: Partial<SchedulerJob> & { id?: string }, repositoryIds?: string[]): SchedulerJob[] {
    const existing = job.id ? this.listAllJobs().find((j) => j.id === job.id) : undefined
    if (repositoryIds !== undefined && existing && !covers(repositoryIds, existing.repositoryIds)) {
      throw new Error('该任务包含未勾选仓库，当前范围为只读。')
    }
    const merged: SchedulerJob = {
      id: existing?.id ?? newId(),
      repositoryIds: job.repositoryIds !== undefined
        ? uniqueIds(job.repositoryIds)
        : uniqueIds(existing?.repositoryIds ?? []),
      name: job.name ?? existing?.name ?? 'Monitoring job',
      kind: job.kind ?? existing?.kind ?? 'interval',
      enabled: job.enabled ?? existing?.enabled ?? true,
      intervalMinutes: job.intervalMinutes ?? existing?.intervalMinutes ?? 1440,
      daysOfWeek: job.daysOfWeek ?? existing?.daysOfWeek ?? [],
      time: job.time ?? existing?.time ?? '09:00',
      startDate: job.startDate !== undefined ? job.startDate : existing?.startDate ?? null,
      endDate: job.endDate !== undefined ? job.endDate : existing?.endDate ?? null,
      emailPolicy: job.emailPolicy ?? existing?.emailPolicy ?? 'none',
      fetchEnabled: job.fetchEnabled ?? existing?.fetchEnabled ?? true,
      notifyTarget: job.notifyTarget ?? existing?.notifyTarget ?? 'self',
      lastRunAt: existing?.lastRunAt ?? null,
      nextRunAt: existing?.nextRunAt ?? null,
      createdAt: existing?.createdAt ?? new Date().toISOString()
    }
    if (repositoryIds !== undefined && !covers(repositoryIds, merged.repositoryIds)) {
      throw new Error('任务范围只能选择当前已勾选的仓库。')
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
          interval_hours: Math.max(1, Math.ceil(merged.intervalMinutes / 60)),
          interval_minutes: merged.intervalMinutes,
          days_json: JSON.stringify(merged.daysOfWeek),
          time: merged.time,
          start_date: merged.startDate,
          end_date: merged.endDate,
          email_policy: merged.emailPolicy,
          fetch_enabled: merged.fetchEnabled ? 1 : 0,
          repository_id: merged.repositoryIds[0] ?? null,
          repository_ids_json: JSON.stringify(merged.repositoryIds),
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
        repository_id: merged.repositoryIds[0] ?? null,
        repository_ids_json: JSON.stringify(merged.repositoryIds),
        name: merged.name,
        kind: merged.kind,
        enabled: merged.enabled ? 1 : 0,
        interval_hours: Math.max(1, Math.ceil(merged.intervalMinutes / 60)),
        interval_minutes: merged.intervalMinutes,
        days_json: JSON.stringify(merged.daysOfWeek),
        time: merged.time,
        start_date: merged.startDate,
        end_date: merged.endDate,
        email_policy: merged.emailPolicy,
        fetch_enabled: merged.fetchEnabled ? 1 : 0,
        notify_target: merged.notifyTarget,
        last_run_at: merged.lastRunAt,
        next_run_at: merged.nextRunAt,
        created_at: merged.createdAt
      })
    }
    this.audit.record('scheduler_job_saved', { id: merged.id, name: merged.name })
    return this.listJobs(repositoryIds)
  }

  deleteJob(id: string, repositoryIds?: string[]): SchedulerJob[] {
    const job = this.listAllJobs().find((candidate) => candidate.id === id)
    if (repositoryIds !== undefined && job && !covers(repositoryIds, job.repositoryIds)) {
      throw new Error('该任务包含未勾选仓库，当前范围为只读。')
    }
    this.storage.delete('scheduler_jobs', 'id = ?', [id])
    this.audit.record('scheduler_job_deleted', { id })
    return this.listJobs(repositoryIds)
  }

  /** Remove every job whose complete scope is covered by the selected repositories. */
  deleteAllJobs(repositoryIds: string[]): SchedulerJob[] {
    const selected = uniqueIds(repositoryIds)
    if (selected.length === 0) return []
    // 只有「至少命中一个勾选仓库」且「完全被勾选仓库覆盖」的任务才会被清空；
    // 空范围任务不属于任何勾选仓库，不参与批量操作。
    const removed = this.listAllJobs().filter((job) => job.repositoryIds.length > 0 && covers(selected, job.repositoryIds))
    for (const job of removed) this.storage.delete('scheduler_jobs', 'id = ?', [job.id])
    this.audit.record('scheduler_jobs_deleted_all', {
      count: removed.length,
      repositoryIds: selected,
      jobIds: removed.map((job) => job.id)
    })
    return this.listJobs(selected)
  }

  /**
   * Enable or disable every job at once. The tray pause/resume entries used to
   * touch only the first match, so schedules pointing at a non-active
   * repository kept firing while the UI reported the scheduler as paused.
   */
  setAllEnabled(enabled: boolean, repositoryIds?: string[]): SchedulerJob[] {
    const scope = uniqueIds(repositoryIds ?? this.storage.selectedRepositoryIds())
    if (scope.length === 0) return []
    const jobs = this.listAllJobs().filter((job) => job.repositoryIds.length > 0 && covers(scope, job.repositoryIds))
    for (const job of jobs) {
      this.storage.update('scheduler_jobs', { enabled: enabled ? 1 : 0 }, 'id = ?', [job.id])
    }
    if (jobs.length > 0) {
      this.audit.record('scheduler_jobs_enabled_changed', { enabled, count: jobs.length, repositoryIds: scope })
    }
    return this.listJobs(scope)
  }

  private monitoringEnabled(repositoryId: string): boolean {
    const row = this.storage.get<Record<string, unknown>>(
      'SELECT * FROM monitoring_rules_repo WHERE repository_id = ?',
      [repositoryId]
    )
    return Number(row?.enabled ?? 1) === 1
  }

  private enabledRepositoryIds(job: SchedulerJob): string[] {
    return job.repositoryIds.filter((repositoryId) => this.monitoringEnabled(repositoryId))
  }

  async runSchedulerJob(id: string, repositoryIds?: string[]): Promise<ScanRun> {
    const job = this.listAllJobs().find((j) => j.id === id)
    if (!job) throw new Error('Scheduler job not found.')
    if (repositoryIds !== undefined && !covers(repositoryIds, job.repositoryIds)) {
      throw new Error('该任务包含未勾选仓库，当前范围为只读。')
    }
    const enabledRepositoryIds = this.enabledRepositoryIds(job)
    if (enabledRepositoryIds.length === 0) throw new Error('所选仓库均已关闭监控。')
    const now = new Date()
    const run = await this.monitoring.runCheckNow({
      trigger: 'scheduler',
      fetch: job.fetchEnabled,
      emailPolicy: job.emailPolicy,
      notifyTarget: job.notifyTarget,
      repositoryIds: enabledRepositoryIds
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
    this.audit.record('scheduler_job_ran', {
      id: job.id,
      name: job.name,
      repositoryIds: enabledRepositoryIds,
      run: run.id
    })
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
    for (const job of this.listAllJobs()) {
      if (!job.enabled) continue
      if (this.enabledRepositoryIds(job).length === 0) continue
      if (job.startDate && new Date(job.startDate).getTime() > now) continue
      if (job.endDate && new Date(job.endDate).getTime() < now) continue
      const next = job.nextRunAt ? new Date(job.nextRunAt).getTime() : 0
      if (next <= now) {
        try {
          await this.runSchedulerJob(job.id)
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err)
          logger.error(`Scheduler job ${job.name} failed`, err)
          this.audit.record('scheduler_job_failed', { id: job.id, name: job.name, error: message }, 'failure')
        }
      }
    }
  }

  calendarRuns(repositoryIds?: string[]): { date: string; status: ScanRun['status']; runs: number }[] {
    if (repositoryIds !== undefined && repositoryIds.length === 0) return []
    const selected = repositoryIds === undefined ? null : new Set(uniqueIds(repositoryIds))
    const rows = this.storage.all<Record<string, unknown>>('SELECT id, started_at, status FROM scan_runs ORDER BY started_at ASC')
    const runIds = this.storage.all<Record<string, unknown>>('SELECT run_id, repository_id FROM scan_run_repositories')
    const byRun = new Map<string, string[]>()
    for (const association of runIds) {
      const runId = String(association.run_id)
      const values = byRun.get(runId) ?? []
      values.push(String(association.repository_id))
      byRun.set(runId, values)
    }
    const map = new Map<string, { status: ScanRun['status']; runs: number }>()
    for (const row of rows) {
      const runId = String(row.id)
      const ids = byRun.get(runId) ?? []
      if (selected && (ids.length === 0 || !ids.every((id) => selected.has(id)))) continue
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
