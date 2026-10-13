import fs from 'node:fs'
import type { EmailSendResult, ReportSchedule, ReportScheduleFrequency } from '@shared/types'
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
import { groupRecipients, parseGroupIds, partitionRecipientTokens } from '@shared/groups'
import { newId } from '../utils/ids'
import { parseIdArray } from './storage'

function reportCreatorRows(rows: EmailIssueRow[]): EmailIssueRow[] {
  return rows.filter((row) => row.state === 'stale' || row.namingStatus === 'invalid' || Boolean(row.cleanupCandidate))
}

interface CreatorRecipients {
  addresses: string[]
  missing: string[]
  fallback: string[]
}

function toCreatorRecipients(collected: { to: string[]; missing: string[]; fallback?: string[] }): CreatorRecipients {
  return { addresses: collected.to, missing: collected.missing, fallback: collected.fallback ?? [] }
}

function withCreatorNotes(
  message: string,
  creators: CreatorRecipients,
  creatorsAsTo: boolean
): string {
  const notes: string[] = []
  if (creators.addresses.length > 0) {
    notes.push(creatorsAsTo
      ? `创始人邮件已发送给 ${creators.addresses.slice(0, 3).join('、')}`
      : `同一封邮件已密送 ${creators.addresses.length} 位分支创始人`)
  }
  if (creators.missing.length > 0) notes.push(`缺少有效邮箱的创始人已跳过：${creators.missing.slice(0, 3).join('、')}`)
  if (creators.fallback.length > 0) notes.push(`创始人未找到，已改发给最后提交人：${creators.fallback.slice(0, 3).join('、')}`)
  return notes.length > 0 ? `${message}（${notes.join('；')}）` : message
}

const REPORT_FOOTER_MARKER = '<hr style="border:none;border-top:1px solid #e2e6ea;margin:18px 0 10px">'

function appendCreatorSection(
  html: string,
  creators: CreatorRecipients,
  storage: StorageService
): string {
  if (creators.addresses.length === 0 && creators.missing.length === 0) return html
  let section = ''
  try {
    section = creatorNotificationSection(creators.addresses, creators.missing, readEmailLang(storage), creators.fallback)
  } catch {
    return html
  }
  if (!section) return html
  const at = html.lastIndexOf(REPORT_FOOTER_MARKER)
  return at < 0 ? html + section : `${html.slice(0, at)}${section}\n  ${html.slice(at)}`
}

function coversRepositoryIds(scope: string[], requested: string[]): boolean {
  const allowed = new Set(scope)
  return requested.every((id) => allowed.has(id))
}

function readEmailBody(report: { path: string; emailPath?: string }): Promise<string> {
  const emailPath = report.emailPath && fs.existsSync(report.emailPath) ? report.emailPath : report.path
  return fs.promises.readFile(emailPath, 'utf8')
}

function scheduleFromRow(row: Record<string, unknown>): ReportSchedule {
  return {
    id: String(row.id),
    name: String(row.name ?? 'GitManager Report'),
    repositoryIds: parseIdArray(row.repository_ids_json),
    frequency: ((row.frequency as ReportScheduleFrequency) ?? 'daily'),
    time: String(row.time ?? '09:00'),
    weekday: Number(row.weekday ?? 1),
    dayOfMonth: Number(row.day_of_month ?? 1),
    runAt: (row.run_at as string | null) ?? null,
    recipients: String(row.recipients ?? ''),
    groupIds: parseGroupIds(row.group_ids),
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
    private readonly audit: AuditService,
    private readonly monitoring?: MonitoringService
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
      repositoryIds: input.repositoryIds ?? existing?.repositoryIds ?? [],
      frequency: input.frequency ?? existing?.frequency ?? 'daily',
      time: input.time ?? existing?.time ?? '09:00',
      weekday: input.weekday ?? existing?.weekday ?? 1,
      dayOfMonth: input.dayOfMonth ?? existing?.dayOfMonth ?? 1,
      runAt: input.runAt !== undefined ? input.runAt : existing?.runAt ?? null,
      recipients: input.recipients?.trim() || existing?.recipients || '',
      groupIds: input.groupIds ?? existing?.groupIds ?? [],
      enabled: input.enabled ?? existing?.enabled ?? true,
      lastRunAt: existing?.lastRunAt ?? null,
      nextRunAt: null,
      createdAt: existing?.createdAt ?? now
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
      group_ids: JSON.stringify(merged.groupIds),
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

  /**
   * 汇总发送：报告只发一封；勾选创始人时，范围内需要处理分支的创始人放进密送，
   * 而不是按人拆成多封邮件。普通收件人与组名收件人保持当前 Web 版行为。
   */
  async sendSelectedRepositoriesReport(
    period = 'manual',
    recipients = 'self',
    repositoryIds?: string[],
    groupIds?: string[]
  ): Promise<EmailSendResult> {
    const scope = repositoryIds ?? []
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
      const refreshed = await this.monitoring?.runCheckNow({
        repositoryIds: [...new Set(scope)],
        fetch: false,
        emailPolicy: 'none',
        notifyTarget: 'none',
        trigger: 'scan_repository',
        bypassEnabledCheck: true
      })
      const requestedScope = new Set(scope)
      if (refreshed && (refreshed.status === 'failed' || !refreshed.repositoryIds
        || refreshed.repositoryIds.some((id) => !requestedScope.has(id))
        || refreshed.repositoryIds.length !== requestedScope.size)) {
        throw new Error(refreshed.error || '部分勾选仓库扫描失败，已停止发送，避免报告混入旧数据。')
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      this.audit.record('report_selected_repositories_sent', { repositoryIds: scope, error: message }, 'failure')
      return { ok: false, message: '勾选仓库汇总发送失败。', technical: message, emailsSent: 0 }
    }

    const parsedNotify = parseNotifyTarget(recipients || 'self')
    const plainGroups = parsedNotify.recipients || ''
    const { matched: groupTargets, plain } = partitionRecipientTokens(plainGroups, this.emailService.listGroups())
    const selfAddress = emailConfig.selfEmail || emailConfig.testRecipient || emailConfig.username
    const to: string[] = []
    if (parsedNotify.self && selfAddress) to.push(selfAddress)
    if (plain) to.push(...resolveRecipients(plain, []))
    const resolvedRecipients = [...new Set(to.map((recipient) => recipient.trim()).filter(Boolean))]
    const creators = parsedNotify.creator
      ? toCreatorRecipients(collectCreatorAddresses(reportCreatorRows(this.reportService.getSummaryEmailData(scope).branches)))
      : { addresses: [], missing: [], fallback: [] }
    const creatorsAsTo = resolvedRecipients.length === 0
    const mainRecipients = creatorsAsTo ? creators.addresses : resolvedRecipients
    if (mainRecipients.length === 0 && creators.missing.length > 0) {
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
    if (mainRecipients.length === 0 && groupTargets.length === 0) {
      this.audit.record(
        'report_selected_repositories_sent',
        { reason: 'recipients_empty', input: recipients, repositoryIds: scope },
        'failure'
      )
      return { ok: false, message: '没有可用收件人，请选择收件人或先在设置中填写我的个人邮箱。', emailsSent: 0 }
    }

    try {
      const report = await this.reportService.generateReport(period, 'html', groupIds, scope)
      const reportHtml = await readEmailBody(report)
      const month = `${report.generatedAt.slice(0, 4)}-${report.generatedAt.slice(5, 7)}`
      const result = await this.emailService.sendReportEmail({
        to: mainRecipients,
        bcc: creatorsAsTo ? [] : creators.addresses,
        subject: `【分支健康汇总】${month}`,
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
          ...(groupIds?.length ? { groupIds } : {}),
          recipients: result.recipients ?? mainRecipients,
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
        { recipients: mainRecipients, repositoryIds: scope, error: message },
        'failure'
      )
      return { ok: false, message: '勾选仓库汇总发送失败。', technical: message, emailsSent: 0 }
    }
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
          const refreshed = await this.monitoring?.runCheckNow({
            repositoryIds: [...new Set(schedule.repositoryIds)],
            fetch: false,
            emailPolicy: 'none',
            notifyTarget: 'none',
            trigger: 'scan_repository',
            bypassEnabledCheck: true
          })
          const scheduledScope = new Set(schedule.repositoryIds)
          if (refreshed && (refreshed.status === 'failed' || !refreshed.repositoryIds
            || refreshed.repositoryIds.some((id) => !scheduledScope.has(id))
            || refreshed.repositoryIds.length !== scheduledScope.size)) {
            throw new Error(refreshed.error || '部分报告仓库扫描失败，已跳过发送，避免报告混入旧数据。')
          }
          const report = await this.reportService.generateReport(schedule.frequency, 'html', schedule.groupIds, schedule.repositoryIds)
          const emailConfig = this.emailService.getConfig()
          const parsedNotify = parseNotifyTarget(schedule.recipients)
          const selfAddress = emailConfig.selfEmail || emailConfig.testRecipient || emailConfig.username
          const creators = parsedNotify.creator
            ? toCreatorRecipients(collectCreatorAddresses(reportCreatorRows(
                this.reportService.getSummaryEmailData(schedule.repositoryIds).branches
              )))
            : { addresses: [] as string[], missing: [] as string[], fallback: [] as string[] }
          const targetRecipients: string[] = []
          if (parsedNotify.self && selfAddress) targetRecipients.push(selfAddress)
          // 组名 token 表示「这份报告也发给这个组的组员」：内容与发给普通收件人的报告
          // 完全一致（都受「分组范围」收窄）。要让组员只收到本组数据，请把该组填进
          // 定时任务的「分组范围」，那时生成的报告本身就只含该组分支。
          // 每个组单独发信，避免组与组之间互相看到对方的成员邮箱。
          const { matched: groupTargets, plain } = partitionRecipientTokens(
            parsedNotify.recipients,
            this.emailService.listGroups()
          )
          if (plain) {
            targetRecipients.push(...resolveRecipients(plain, []))
          }
          const resolvedRecipients = [...new Set(targetRecipients.map((recipient) => recipient.trim()).filter(Boolean))]
          // 未选择任何收件人时才默认发给自己；只勾了组名时不该再给配置邮箱发一份整仓报告。
          // 只勾创始人时，创始人就是主收件人；选了普通收件人或组时创始人仍放入密送。
          const creatorsAsTo = resolvedRecipients.length === 0 && groupTargets.length === 0
            && creators.addresses.length > 0
          const recipients = creatorsAsTo
            ? creators.addresses
            : resolvedRecipients.length > 0 || groupTargets.length > 0
              ? resolvedRecipients
              : selfAddress ? [selfAddress] : []

          if (!emailConfig.enabled) {
            this.audit.record('report_schedule_email_skipped', {
              id: schedule.id, name: schedule.name, reason: 'email_disabled'
            }, 'failure')
          } else {
            if (recipients.length === 0 && groupTargets.length === 0) {
              this.audit.record('report_schedule_email_skipped', {
                id: schedule.id,
                name: schedule.name,
                reason: !selfAddress ? 'self_email_missing' : 'recipients_empty',
                input: schedule.recipients
              }, 'failure')
            }
            if (recipients.length > 0 || groupTargets.length > 0) {
              const reportHtml = await readEmailBody(report)
              const month = `${report.generatedAt.slice(0, 4)}-${report.generatedAt.slice(5, 7)}`
              const send = async (to: string[]): Promise<void> => {
                await this.emailService.sendReportEmail({
                  to,
                  bcc: creatorsAsTo ? [] : creators.addresses,
                  subject: `【分支健康月报】${month}`,
                  body: '',
                  html: appendCreatorSection(reportHtml, creators, this.storage),
                  attachmentPath: report.path
                })
              }
              if (recipients.length > 0) await send(recipients)
              for (const group of groupTargets) {
                const members = groupRecipients(group)
                if (members.length === 0) {
                  this.audit.record('report_schedule_group_email_skipped', {
                    id: schedule.id, group: group.name, reason: 'group_members_missing'
                  }, 'failure')
                  continue
                }
                try {
                  await send(members)
                  this.audit.record('report_schedule_group_email_sent', {
                    id: schedule.id, group: group.name, sent: members.length
                  }, 'success')
                } catch (err) {
                  const message = err instanceof Error ? err.message : String(err)
                  this.audit.record('report_schedule_group_email_skipped', {
                    id: schedule.id, group: group.name, reason: 'send_failed', message
                  }, 'failure')
                }
              }
            }
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
