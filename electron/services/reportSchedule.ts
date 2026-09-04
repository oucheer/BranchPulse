import type { ReportSchedule, ReportScheduleFrequency } from '@shared/types'
import type { StorageService } from './storage'
import type { ReportService } from './report'
import type { EmailService } from './email'
import type { AuditService } from './audit'
import { newId } from '../utils/ids'

function scheduleFromRow(row: Record<string, unknown>): ReportSchedule {
  return {
    id: String(row.id),
    name: String(row.name ?? 'BranchPulse Report'),
    repositoryId: (row.repository_id as string | null) ?? null,
    frequency: ((row.frequency as ReportScheduleFrequency) ?? 'daily'),
    time: String(row.time ?? '09:00'),
    weekday: Number(row.weekday ?? 1),
    dayOfMonth: Number(row.day_of_month ?? 1),
    runAt: (row.run_at as string | null) ?? null,
    recipients: String(row.recipients ?? ''),
    enabled: Number(row.enabled ?? 1) === 1,
    lastRunAt: (row.last_run_at as string | null) ?? null,
    nextRunAt: (row.next_run_at as string | null) ?? null,
    createdAt: String(row.created_at)
  }
}

export function computeNextReportRunAt(schedule: ReportSchedule, from = new Date()): string | null {
  const [hour, minute] = schedule.time.split(':').map((v) => Number(v) || 0)
  const next = new Date(from)
  next.setHours(hour, minute, 0, 0)

  if (schedule.frequency === 'once') {
    if (!schedule.runAt) return null
    const at = new Date(schedule.runAt)
    return at.getTime() <= from.getTime() ? null : at.toISOString()
  }
  if (schedule.frequency === 'daily') {
    if (next.getTime() <= from.getTime()) next.setDate(next.getDate() + 1)
  } else if (schedule.frequency === 'weekly') {
    const target = Math.max(0, Math.min(6, schedule.weekday))
    const delta = (target - next.getDay() + 7) % 7
    next.setDate(next.getDate() + delta)
    if (next.getTime() <= from.getTime()) next.setDate(next.getDate() + 7)
  } else if (schedule.frequency === 'monthly') {
    const day = Math.max(1, Math.min(31, schedule.dayOfMonth))
    next.setDate(Math.min(day, new Date(next.getFullYear(), next.getMonth() + 1, 0).getDate()))
    if (next.getTime() <= from.getTime()) {
      next.setMonth(next.getMonth() + 1)
      next.setDate(Math.min(day, new Date(next.getFullYear(), next.getMonth() + 1, 0).getDate()))
    }
  }
  return next.toISOString()
}

export class ReportScheduleService {
  private timer: NodeJS.Timeout | null = null
  private running = false

  constructor(
    private readonly storage: StorageService,
    private readonly reportService: ReportService,
    private readonly emailService: EmailService,
    private readonly audit: AuditService
  ) {}

  list(): ReportSchedule[] {
    return this.storage
      .all<Record<string, unknown>>('SELECT * FROM report_schedules ORDER BY created_at ASC')
      .map(scheduleFromRow)
  }

  save(input: Partial<ReportSchedule> & { id?: string }): ReportSchedule[] {
    const now = new Date().toISOString()
    const existing = input.id ? this.list().find((s) => s.id === input.id) : undefined
    const merged: ReportSchedule = {
      id: existing?.id ?? newId(),
      name: input.name?.trim() || existing?.name || '定时报告',
      repositoryId: input.repositoryId !== undefined ? input.repositoryId : existing?.repositoryId ?? null,
      frequency: input.frequency ?? existing?.frequency ?? 'daily',
      time: input.time ?? existing?.time ?? '09:00',
      weekday: input.weekday ?? existing?.weekday ?? 1,
      dayOfMonth: input.dayOfMonth ?? existing?.dayOfMonth ?? 1,
      runAt: input.runAt !== undefined ? input.runAt : existing?.runAt ?? null,
      recipients: input.recipients?.trim() || existing?.recipients || '',
      enabled: input.enabled ?? existing?.enabled ?? true,
      lastRunAt: existing?.lastRunAt ?? null,
      nextRunAt: null,
      createdAt: existing?.createdAt ?? now
    }
    merged.nextRunAt = merged.enabled ? computeNextReportRunAt(merged) : null

    const row = {
      id: merged.id,
      name: merged.name,
      repository_id: merged.repositoryId,
      frequency: merged.frequency,
      time: merged.time,
      weekday: merged.weekday,
      day_of_month: merged.dayOfMonth,
      run_at: merged.runAt,
      recipients: merged.recipients,
      enabled: merged.enabled ? 1 : 0,
      last_run_at: merged.lastRunAt,
      next_run_at: merged.nextRunAt,
      created_at: merged.createdAt
    }
    if (existing) this.storage.update('report_schedules', row, 'id = ?', [merged.id])
    else this.storage.insert('report_schedules', row)
    this.audit.record('report_schedule_saved', { id: merged.id, name: merged.name, frequency: merged.frequency })
    return this.list()
  }

  delete(id: string): ReportSchedule[] {
    this.storage.delete('report_schedules', 'id = ?', [id])
    this.audit.record('report_schedule_deleted', { id })
    return this.list()
  }

  start(): void {
    if (this.timer) return
    this.timer = setInterval(() => void this.tick(), 30_000)
    void this.tick()
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  private async tick(): Promise<void> {
    if (this.running) return
    this.running = true
    try {
      const now = new Date()
      const due = this.list().filter((s) => s.enabled && s.nextRunAt && new Date(s.nextRunAt) <= now)
      for (const schedule of due) {
        try {
          const report = await this.reportService.generateReport(schedule.frequency, 'html', schedule.repositoryId)
          const recipients = schedule.recipients.split(/[,;\s]+/).filter(Boolean)
          if (recipients.length > 0) {
            await this.emailService.sendReportEmail({
              to: recipients,
              subject: `BranchPulse ${schedule.name}`,
              body: `报告已生成：${report.title}\n路径：${report.path}`,
              attachmentPath: report.path
            })
          }
          const nextRunAt = schedule.frequency === 'once' ? null : computeNextReportRunAt(schedule, new Date())
          this.storage.update(
            'report_schedules',
            {
              last_run_at: now.toISOString(),
              next_run_at: nextRunAt,
              enabled: schedule.frequency === 'once' ? 0 : 1
            },
            'id = ?',
            [schedule.id]
          )
          this.audit.record('report_schedule_run', { id: schedule.id, report: report.id, sent: recipients.length })
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err)
          this.audit.record('report_schedule_run', { id: schedule.id, error: message }, 'failure')
        }
      }
    } finally {
      this.running = false
    }
  }
}
