import fs from 'node:fs'
import type { EmailConfig, EmailGroup, EmailSendResult, ReportSchedule, ReportScheduleFrequency } from '@shared/types'
import type { StorageService } from './storage'
import type { ReportService } from './report'
import type { EmailService } from './email'
import type { AuditService } from './audit'
import type { MonitoringService } from './monitoring'
import {
  collectCreatorAddresses,
  creatorNotificationSection,
  parseNotifyTarget,
  readEmailLang,
  resolveRecipients,
  type EmailIssueRow
} from './email'
import { parseStringArray, uniqueIds } from './storage'
import { newId } from '../utils/ids'

function scheduleRepositoryIds(row: Record<string, unknown>): string[] {
  if (row.repository_ids_json != null) return parseStringArray(row.repository_ids_json)
  const legacy = String(row.repository_id ?? '').trim()
  return legacy ? [legacy] : []
}

function scheduleFromRow(row: Record<string, unknown>): ReportSchedule {
  return {
    id: String(row.id),
    name: String(row.name ?? 'GitManager Report'),
    repositoryIds: scheduleRepositoryIds(row),
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

export function resolveReportRecipients(
  input: string | null | undefined,
  config: Pick<EmailConfig, 'selfEmail' | 'testRecipient' | 'username'>,
  groups: EmailGroup[] = []
): string[] {
  const parsed = parseNotifyTarget(input)
  const selfAddress = (config.selfEmail || config.testRecipient || config.username || '').trim()
  const targetRecipients: string[] = []
  if (parsed.self && selfAddress) targetRecipients.push(selfAddress)
  if (parsed.recipients) targetRecipients.push(...resolveRecipients(parsed.recipients, groups))

  const resolved = [...new Set(targetRecipients.map((recipient) => recipient.trim()).filter(Boolean))]
  if (resolved.length > 0) return resolved

  // 一键发送默认使用本机配置的通知邮箱；显式选择 none 或只选了创始人时不自动补发。
  const normalized = String(input ?? '').trim()
  return !normalized && selfAddress ? [selfAddress] : []
}

/** 报告语境下需要处理的分支：与监控页「需要处理」的口径保持一致。 */
function reportCreatorRows(rows: EmailIssueRow[]): EmailIssueRow[] {
  return rows.filter((row) => row.state === 'stale' || row.namingStatus === 'invalid' || Boolean(row.cleanupCandidate))
}

interface CreatorRecipients {
  /** 分支创始人邮箱：密送到同一封邮件，避免多仓库各发一封。 */
  addresses: string[]
  /** 缺少有效邮箱、无法送达的创始人。 */
  missing: string[]
  fallback: string[]
}

function toCreatorRecipients(collected: { to: string[]; missing: string[]; fallback?: string[] }): CreatorRecipients {
  return { addresses: collected.to, missing: collected.missing, fallback: collected.fallback ?? [] }
}

function coversRepositoryIds(scope: string[], requested: string[]): boolean {
  const allowed = new Set(scope)
  return requested.every((id) => allowed.has(id))
}

/** 把「无法送达的创始人」提示拼进结果文案，避免用户以为全部通知都成功了。 */
function withCreatorNotes(
  message: string,
  creators: { addresses: string[]; missing: string[]; fallback?: string[] },
  creatorsAsTo: boolean
): string {
  const notes: string[] = []
  if (creators.addresses.length > 0) {
    notes.push(
      creatorsAsTo
        ? `创始人邮件已发送给 ${creators.addresses.slice(0, 3).join('、')}`
        : `同一封邮件已密送 ${creators.addresses.length} 位分支创始人`
    )
  }
  if (creators.missing.length > 0) notes.push(`缺少有效邮箱的创始人已跳过：${creators.missing.slice(0, 3).join('、')}`)
  if (creators.fallback?.length) notes.push(`创始人未找到，已改发给最后提交人：${creators.fallback.slice(0, 3).join('、')}`)
  return notes.length > 0 ? `${message}（${notes.join('；')}）` : message
}

/** 报告正文里的页脚分隔线：创始人通知区块插在它之前，保持在白色卡片内。 */
const REPORT_FOOTER_MARKER = '<hr style="border:none;border-top:1px solid #e2e6ea;margin:18px 0 10px">'

/**
 * 邮件正文来自报告文件，只在这里追加「创始人通知范围」区块——
 * 磁盘上的报告文件保持原样，收件人看到的邮件才带上通知说明。
 */
function appendCreatorSection(
  html: string,
  creators: { addresses: string[]; missing: string[]; fallback?: string[] },
  storage: StorageService
): string {
  // 没有创始人通知时连语言都不必读，避免触碰到不需要的存储调用。
  if (creators.addresses.length === 0 && creators.missing.length === 0) return html
  let section = ''
  try {
    section = creatorNotificationSection(creators.addresses, creators.missing, readEmailLang(storage), creators.fallback)
  } catch {
    // 邮件正文的附加区块绝不能因为读语言失败而让整封邮件发不出去。
    return html
  }
  if (!section) return html
  const at = html.lastIndexOf(REPORT_FOOTER_MARKER)
  return at < 0 ? html + section : `${html.slice(0, at)}${section}\n  ${html.slice(at)}`
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
    private readonly audit: AuditService,
    private readonly monitoring?: MonitoringService
  ) {}

  list(repositoryIds?: string[]): ReportSchedule[] {
    const schedules = this.storage
      .all<Record<string, unknown>>('SELECT * FROM report_schedules ORDER BY created_at ASC')
      .map(scheduleFromRow)
    if (repositoryIds === undefined) return schedules
    if (repositoryIds.length === 0) return []
    const selected = new Set(uniqueIds(repositoryIds))
    return schedules.filter((schedule) => schedule.repositoryIds.some((id) => selected.has(id)))
  }

  save(input: Partial<ReportSchedule> & { id?: string }, repositoryIds?: string[]): ReportSchedule[] {
    const now = new Date().toISOString()
    const existing = input.id ? this.list().find((s) => s.id === input.id) : undefined
    if (repositoryIds !== undefined && existing && !coversRepositoryIds(repositoryIds, existing.repositoryIds)) {
      throw new Error('该定时报告包含未勾选仓库，当前范围为只读。')
    }
    const merged: ReportSchedule = {
      id: existing?.id ?? newId(),
      name: input.name?.trim() || existing?.name || '定时报告',
      repositoryIds: input.repositoryIds !== undefined
        ? uniqueIds(input.repositoryIds)
        : uniqueIds(existing?.repositoryIds ?? []),
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
    if (repositoryIds !== undefined && !coversRepositoryIds(repositoryIds, merged.repositoryIds)) {
      throw new Error('定时报告范围只能选择当前已勾选的仓库。')
    }
    merged.nextRunAt = merged.enabled ? computeNextReportRunAt(merged) : null

    const row = {
      id: merged.id,
      name: merged.name,
      repository_id: merged.repositoryIds[0] ?? null,
      repository_ids_json: JSON.stringify(merged.repositoryIds),
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
    return this.list(repositoryIds)
  }

  delete(id: string, repositoryIds?: string[]): ReportSchedule[] {
    const schedule = this.list().find((s) => s.id === id)
    if (repositoryIds !== undefined && schedule && !coversRepositoryIds(repositoryIds, schedule.repositoryIds)) {
      throw new Error('该定时报告包含未勾选仓库，当前范围为只读。')
    }
    this.storage.delete('report_schedules', 'id = ?', [id])
    this.audit.record('report_schedule_deleted', { id })
    return this.list(repositoryIds)
  }

  /**
   * 汇总发送：范围完全来自当前勾选的仓库集合。没有勾选任何仓库时直接失败，
   * 绝不回退成「全部仓库」。
   */
  async sendSelectedRepositoriesReport(
    period = 'manual',
    recipients = 'self',
    repositoryIds?: string[]
  ): Promise<EmailSendResult> {
    const scope = repositoryIds ?? this.storage.selectedRepositoryIds()
    if (scope.length === 0) {
      this.audit.record('report_selected_repositories_sent', { reason: 'no_repository_selected' }, 'failure')
      return { ok: false, message: '未选择仓库：请先在仓库页勾选要汇总的仓库。', emailsSent: 0 }
    }
    const emailConfig = this.emailService.getConfig()
    if (!emailConfig.enabled) {
      this.audit.record('report_selected_repositories_sent', { reason: 'email_disabled', repositoryIds: scope }, 'failure')
      return { ok: false, message: '邮件发送未启用，请先在设置中启用并配置邮箱。', emailsSent: 0 }
    }

    try {
      // Refresh before resolving creator recipients as well as before building
      // the report. Both the branch totals and email addresses must describe
      // the same current scan.
      const refreshed = await this.monitoring?.runCheckNow({
        repositoryIds: [...new Set(scope)],
        fetch: false,
        emailPolicy: 'none',
        notifyTarget: 'none',
        trigger: 'scan_repository',
        bypassEnabledCheck: true
      })
      const requestedScope = new Set(scope)
      if (refreshed && (refreshed.status === 'failed' || !refreshed.repositoryIds || refreshed.repositoryIds.some((id) => !requestedScope.has(id)) || refreshed.repositoryIds.length !== requestedScope.size)) {
        throw new Error(refreshed.error || '部分勾选仓库扫描失败，已停止发送，避免报告混入旧数据。')
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      this.audit.record('report_selected_repositories_sent', { repositoryIds: scope, error: message }, 'failure')
      return { ok: false, message: '勾选仓库汇总发送失败。', technical: message, emailsSent: 0 }
    }

    const resolvedRecipients = resolveReportRecipients(recipients, emailConfig, this.emailService.listGroups())
    const creators = this.collectReportCreators(recipients, scope)
    // 只勾选「通知分支创始人」时创始人就是唯一收件人，邮件依然只发一封。
    const creatorsAsTo = resolvedRecipients.length === 0
    const to = creatorsAsTo ? creators.addresses : resolvedRecipients
    if (to.length === 0 && creators.missing.length > 0) {
      this.audit.record(
        'report_selected_repositories_sent',
        { reason: 'creators_without_email', input: recipients, repositoryIds: scope, missing: creators.missing },
        'failure'
      )
      return {
        ok: false,
        message: `范围内的分支创始人都没有有效邮箱，无法发送：${creators.missing.slice(0, 3).join('、')}`,
        emailsSent: 0
      }
    }
    if (to.length === 0) {
      this.audit.record(
        'report_selected_repositories_sent',
        { reason: 'recipients_empty', input: recipients, repositoryIds: scope },
        'failure'
      )
      return { ok: false, message: '没有可用收件人，请选择收件人或先在设置中填写我的个人邮箱。', emailsSent: 0 }
    }

    try {
      const report = await this.reportService.generateReport(period, 'html', scope)
      const emailPath = report.emailPath && fs.existsSync(report.emailPath) ? report.emailPath : report.path
      const reportHtml = await fs.promises.readFile(emailPath, 'utf8')
      const month = `${report.generatedAt.slice(0, 4)}-${report.generatedAt.slice(5, 7)}`
      const result = await this.emailService.sendReportEmail({
        to,
        bcc: creatorsAsTo ? [] : creators.addresses,
        subject: `【分支健康汇总】勾选仓库（${scope.length} 个） ${month}`,
        body: '',
        html: appendCreatorSection(reportHtml, creators, this.storage),
        attachmentPath: report.path
      })
      const message = withCreatorNotes(result.message, creators, creatorsAsTo)
      this.audit.record(
        'report_selected_repositories_sent',
        {
          report: report.id,
          repositoryIds: scope,
          recipients: result.recipients ?? to,
          creatorRecipients: creatorsAsTo ? [] : creators.addresses,
          creatorsWithoutEmail: creators.missing,
          ok: result.ok
        },
        result.ok ? 'success' : 'failure'
      )
      return { ...result, message }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      this.audit.record(
        'report_selected_repositories_sent',
        { recipients: to, repositoryIds: scope, error: message },
        'failure'
      )
      return { ok: false, message: '勾选仓库汇总发送失败。', technical: message, emailsSent: 0 }
    }
  }

  /**
   * 报告语境下的分支创始人：不逐人逐封，而是把范围内需要处理分支的创始人
   * 去重后放进同一封邮件的密送，实现「一封邮件覆盖多个仓库的多个分支」。
   */
  private collectReportCreators(
    recipients: string,
    scope: string[]
  ): CreatorRecipients {
    const parsed = parseNotifyTarget(recipients)
    if (!parsed.creator) return { addresses: [], missing: [], fallback: [] }
    const summary = this.reportService.getSummaryEmailData(scope)
    const creators = collectCreatorAddresses(reportCreatorRows(summary.branches))
    return toCreatorRecipients(creators)
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
          if (schedule.repositoryIds.length === 0) {
            this.audit.record('report_schedule_skipped', {
              id: schedule.id,
              name: schedule.name,
              reason: 'no_repository_selected'
            }, 'failure')
            continue
          }
          const refreshed = await this.monitoring?.runCheckNow({
            repositoryIds: [...new Set(schedule.repositoryIds)],
            fetch: false,
            emailPolicy: 'none',
            notifyTarget: 'none',
            trigger: 'scan_repository',
            bypassEnabledCheck: true
          })
          const scheduledScope = new Set(schedule.repositoryIds)
          if (refreshed && (refreshed.status === 'failed' || !refreshed.repositoryIds || refreshed.repositoryIds.some((id) => !scheduledScope.has(id)) || refreshed.repositoryIds.length !== scheduledScope.size)) {
            throw new Error(refreshed.error || '部分报告仓库扫描失败，已跳过发送，避免报告混入旧数据。')
          }
          const report = await this.reportService.generateReport(schedule.frequency, 'html', schedule.repositoryIds)
          const emailConfig = this.emailService.getConfig()
          const parsedNotify = parseNotifyTarget(schedule.recipients)
          const selfAddress = emailConfig.selfEmail || emailConfig.testRecipient || emailConfig.username
          // 未选择收件人时，默认发送到本机 Outlook 当前登录账户可配置的通知邮箱。
          const resolvedRecipients = resolveReportRecipients(
            schedule.recipients,
            emailConfig,
            this.emailService.listGroups()
          )
          // 报告只发一封：创始人放进密送，覆盖该任务范围内多个仓库的多个分支。
          const creators = parsedNotify.creator
            ? toCreatorRecipients(
                collectCreatorAddresses(reportCreatorRows(this.reportService.getSummaryEmailData(schedule.repositoryIds).branches))
              )
            : { addresses: [] as string[], missing: [] as string[], fallback: [] as string[] }
          const creatorsAsTo = resolvedRecipients.length === 0
          const recipients = creatorsAsTo ? creators.addresses : resolvedRecipients

          if (!emailConfig.enabled) {
            this.audit.record('report_schedule_email_skipped', {
              id: schedule.id, name: schedule.name, reason: 'email_disabled'
            }, 'failure')
          } else if (recipients.length === 0) {
            this.audit.record('report_schedule_email_skipped', {
              id: schedule.id,
              name: schedule.name,
              // 只勾了创始人却没有一个能送达的邮箱时，失败原因必须说清楚，
              // 否则会被误读成「自己邮箱没配」。
              reason: creatorsAsTo && creators.missing.length > 0
                ? 'creators_without_email'
                : !selfAddress ? 'self_email_missing' : 'recipients_empty',
              input: schedule.recipients
            }, 'failure')
          } else {
            const emailPath = report.emailPath && fs.existsSync(report.emailPath) ? report.emailPath : report.path
            const reportHtml = await fs.promises.readFile(emailPath, 'utf8')
            const month = `${report.generatedAt.slice(0, 4)}-${report.generatedAt.slice(5, 7)}`
            const sent = await this.emailService.sendReportEmail({
              to: recipients,
              bcc: creatorsAsTo ? [] : creators.addresses,
              subject: `【分支健康月报】${month}`,
              body: '',
              html: appendCreatorSection(reportHtml, creators, this.storage),
              attachmentPath: report.path
            })
            this.audit.record('report_schedule_email_sent', {
              id: schedule.id,
              name: schedule.name,
              recipients,
              creatorRecipients: creatorsAsTo ? [] : creators.addresses,
              creatorsWithoutEmail: creators.missing,
              ok: sent.ok
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
