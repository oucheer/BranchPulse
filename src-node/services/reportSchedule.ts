import fs from 'node:fs'
import type { EmailSendResult, ManualSendReportState, ReportSchedule, ReportScheduleFrequency } from '@shared/types'
import type { StorageService } from './storage'
import type { ReportService } from './report'
import type { EmailService } from './email'
import type { AuditService } from './audit'
import type { MonitoringService } from './monitoring'
import {
  collectCreatorAddresses,
  creatorNotificationSection,
  emptyCreatorAddressCollection,
  parseNotifyTarget,
  readEmailLang,
  resolveRecipients,
  type CreatorAddressCollection,
  type EmailIssueRow
} from './email'
import { groupRecipients, parseGroupIds, partitionRecipientTokens, splitRecipientGroupsByDelivery } from '@shared/groups'
import { newId } from '../utils/ids'
import { parseIdArray } from './storage'

function reportCreatorRows(rows: EmailIssueRow[]): EmailIssueRow[] {
  return rows.filter((row) => row.state === 'stale' || row.namingStatus === 'invalid' || Boolean(row.cleanupCandidate))
}

function withCreatorNotes(
  message: string,
  creators: CreatorAddressCollection
): string {
  const notes: string[] = []
  if (creators.accountCreatorRecipients.length > 0) {
    notes.push(`平台账号已验证创始人：${creators.accountCreatorRecipients.slice(0, 3).join('、')}`)
  }
  if (creators.commitCreatorRecipients.length > 0) {
    notes.push(`账号精确绑定提交邮箱的创始人：${creators.commitCreatorRecipients.slice(0, 3).join('、')}`)
  }
  if (creators.fallbackRecipients.length > 0) {
    notes.push(`创始人邮箱无法确认，已改发给最后提交人：${creators.fallbackRecipients.slice(0, 3).join('、')}`)
  }
  if (creators.skipped.length > 0) {
    notes.push(`无有效收件人邮箱已跳过：${creators.skipped.slice(0, 3).join('、')}`)
  }
  return notes.length > 0 ? `${message}（${notes.join('；')}）` : message
}

const REPORT_FOOTER_MARKER = '<hr style="border:none;border-top:1px solid #e2e6ea;margin:18px 0 10px">'

function appendCreatorSection(
  html: string,
  creators: CreatorAddressCollection,
  storage: StorageService
): string {
  if (creators.to.length === 0 && creators.skipped.length === 0) return html
  let section = ''
  try {
    section = creatorNotificationSection(creators, readEmailLang(storage))
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
  private manualSendRunning = false
  private manualSendStartedAt: string | null = null
  private manualSendFinishedAt: string | null = null
  private manualSendLastResult: EmailSendResult | null = null

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
   * 汇总发送：报告只发一封；勾选创始人时，范围内需要处理分支的创始人放进收件人，
   * 而不是按人拆成多封邮件。普通收件人与组名收件人保持当前 Web 版行为。
   */
  async sendSelectedRepositoriesReport(
    period = 'manual',
    recipients = 'self',
    repositoryIds?: string[],
    groupIds?: string[]
  ): Promise<EmailSendResult> {
    if (this.manualSendRunning) {
      return {
        ok: false,
        message: '已有一次发送正在进行，请等待它完成后再试。',
        emailsSent: 0
      }
    }
    this.manualSendRunning = true
    this.manualSendStartedAt = new Date().toISOString()
    const scope = repositoryIds ?? []
    if (scope.length === 0) {
      this.manualSendRunning = false
      this.manualSendFinishedAt = new Date().toISOString()
      this.manualSendLastResult = { ok: false, message: '未选择仓库：请先在仓库页勾选要汇总的仓库。', emailsSent: 0 }
      this.audit.record('report_selected_repositories_sent', { reason: 'no_repository_selected' }, 'failure')
      return this.manualSendLastResult
    }
    const emailConfig = this.emailService.getConfig()
    if (!emailConfig.enabled) {
      this.manualSendRunning = false
      this.manualSendFinishedAt = new Date().toISOString()
      this.manualSendLastResult = { ok: false, message: '邮件发送未启用，请先在设置中启用并配置邮箱。', emailsSent: 0 }
      this.audit.record('report_selected_repositories_sent', { reason: 'email_disabled', repositoryIds: scope }, 'failure')
      return this.manualSendLastResult
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
      this.manualSendRunning = false
      this.manualSendFinishedAt = new Date().toISOString()
      this.manualSendLastResult = { ok: false, message: '勾选仓库汇总发送失败。', technical: message, emailsSent: 0 }
      this.audit.record('report_selected_repositories_sent', { repositoryIds: scope, error: message }, 'failure')
      return this.manualSendLastResult
    }

    const parsedNotify = parseNotifyTarget(recipients || 'self')
    const plainGroups = parsedNotify.recipients || ''
    const { matched: allGroupTargets, plain } = partitionRecipientTokens(plainGroups, this.emailService.listGroups())
    const { to: groupToTargets, cc: groupCcTargets } = splitRecipientGroupsByDelivery(allGroupTargets)
    const selfAddress = emailConfig.selfEmail || emailConfig.testRecipient || emailConfig.username
    const to: string[] = []
    if (parsedNotify.self && selfAddress) to.push(selfAddress)
    if (plain) to.push(...resolveRecipients(plain, []))
    const resolvedRecipients = [...new Set(to.map((recipient) => recipient.trim()).filter(Boolean))]
    const creators = parsedNotify.creator
      ? collectCreatorAddresses(reportCreatorRows(this.reportService.getSummaryEmailData(scope).branches))
      : emptyCreatorAddressCollection()
    const groupToRecipients = [
      ...new Set(groupToTargets.flatMap((group) => groupRecipients(group)))
    ]
    const mainRecipients = [
      ...new Set([...resolvedRecipients, ...creators.to, ...groupToRecipients])
    ]
    const groupCcRecipients = [...new Set(groupCcTargets.flatMap((group) => groupRecipients(group)))]
    if (mainRecipients.length === 0 && creators.missing.length > 0) {
      this.manualSendRunning = false
      this.manualSendFinishedAt = new Date().toISOString()
      this.manualSendLastResult = {
        ok: false,
        message: `范围内没有可用的创始人或最后提交人邮箱，无法发送：${creators.skipped.slice(0, 3).join('、')}`,
        emailsSent: 0
      }
      this.audit.record(
        'report_selected_repositories_sent',
        { reason: 'creators_without_email', input: recipients, repositoryIds: scope, missing: creators.skipped },
        'failure'
      )
      return this.manualSendLastResult
    }
    if (mainRecipients.length === 0 && groupCcRecipients.length === 0) {
      this.manualSendRunning = false
      this.manualSendFinishedAt = new Date().toISOString()
      this.manualSendLastResult = { ok: false, message: '没有可用收件人，请选择收件人或先在设置中填写我的个人邮箱。', emailsSent: 0 }
      this.audit.record(
        'report_selected_repositories_sent',
        { reason: 'recipients_empty', input: recipients, repositoryIds: scope },
        'failure'
      )
      return this.manualSendLastResult
    }
    const toHeader = mainRecipients.length > 0 ? mainRecipients : groupCcRecipients
    const ccHeader = mainRecipients.length > 0 ? groupCcRecipients : []

    try {
      const report = await this.reportService.generateReport(period, 'html', groupIds, scope)
      const reportHtml = await readEmailBody(report)
      const month = `${report.generatedAt.slice(0, 4)}-${report.generatedAt.slice(5, 7)}`
      const result = await this.emailService.sendReportEmail({
        to: toHeader,
        cc: ccHeader,
        subject: `【分支健康汇总】${month}`,
        body: '',
        html: appendCreatorSection(reportHtml, creators, this.storage),
        attachmentPath: report.path
      })
      const message = withCreatorNotes(result.message, creators)
      this.audit.record(
        'report_selected_repositories_sent',
        {
          report: report.id,
          repositoryIds: scope,
          ...(groupIds?.length ? { groupIds } : {}),
          recipients: result.recipients ?? toHeader,
          creatorRecipients: creators.to,
          ...(ccHeader.length > 0 ? { cc: ccHeader } : {}),
          creatorFallbackRecipients: creators.fallbackRecipients,
          creatorsWithoutEmail: creators.skipped,
          ok: result.ok
        },
        result.ok ? 'success' : 'failure'
      )
      this.manualSendRunning = false
      this.manualSendFinishedAt = new Date().toISOString()
      this.manualSendLastResult = { ...result, message }
      return this.manualSendLastResult
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      this.manualSendRunning = false
      this.manualSendFinishedAt = new Date().toISOString()
      this.manualSendLastResult = { ok: false, message: '勾选仓库汇总发送失败。', technical: message, emailsSent: 0 }
      this.audit.record(
        'report_selected_repositories_sent',
        { recipients: toHeader, repositoryIds: scope, error: message },
        'failure'
      )
      return this.manualSendLastResult
    }
  }

  getManualSendReportState(): ManualSendReportState {
    return {
      running: this.manualSendRunning,
      startedAt: this.manualSendStartedAt,
      finishedAt: this.manualSendFinishedAt,
      lastResult: this.manualSendLastResult
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
          const parsedNotify = parseNotifyTarget(schedule.recipients || 'self')
          const selfAddress = emailConfig.selfEmail || emailConfig.testRecipient || emailConfig.username
          const creators = parsedNotify.creator
            ? collectCreatorAddresses(reportCreatorRows(
                this.reportService.getSummaryEmailData(schedule.repositoryIds).branches
              ))
            : emptyCreatorAddressCollection()
          const targetRecipients: string[] = []
          if (parsedNotify.self && selfAddress) targetRecipients.push(selfAddress)
          // 组名 token 表示「这份报告也发给这个组的组员」：内容与发给普通收件人的报告
          // 完全一致（都受「分组范围」收窄）。要让组员只收到本组数据，请把该组填进
          // 定时任务的「分组范围」，那时生成的报告本身就只含该组分支。
          // 收件人用途的组并入同一封报告邮件；抄送用途的组合并进抄送。
          const { matched: allGroupTargets, plain } = partitionRecipientTokens(
            parsedNotify.recipients,
            this.emailService.listGroups()
          )
          const { to: groupToTargets, cc: groupCcTargets } = splitRecipientGroupsByDelivery(allGroupTargets)
          if (plain) {
            targetRecipients.push(...resolveRecipients(plain, []))
          }
          const resolvedRecipients = [...new Set(targetRecipients.map((recipient) => recipient.trim()).filter(Boolean))]
          // 未选择任何收件人时才默认发给自己；只勾了组名时不该再给配置邮箱发一份整仓报告。
          // 创始人始终进入收件人，收件人用途的组也并入同一封报告邮件。
          const groupToRecipients = [
            ...new Set(groupToTargets.flatMap((group) => groupRecipients(group)))
          ]
          const recipients = [
            ...new Set([...resolvedRecipients, ...creators.to, ...groupToRecipients])
          ]
          const groupCcRecipients = [...new Set(groupCcTargets.flatMap((group) => groupRecipients(group)))]

          if (!emailConfig.enabled) {
            this.audit.record('report_schedule_email_skipped', {
              id: schedule.id, name: schedule.name, reason: 'email_disabled'
            }, 'failure')
          } else {
            if (recipients.length === 0 && groupCcRecipients.length === 0) {
              this.audit.record('report_schedule_email_skipped', {
                id: schedule.id,
                name: schedule.name,
                reason: !selfAddress ? 'self_email_missing' : 'recipients_empty',
                input: schedule.recipients,
                creatorsWithoutEmail: creators.skipped
              }, 'failure')
            }
            const auditedGroups = [
              ...groupToTargets.map((group) => ({ group, delivery: 'to' as const })),
              ...groupCcTargets.map((group) => ({ group, delivery: 'cc' as const }))
            ]
            for (const { group, delivery } of auditedGroups) {
              if (groupRecipients(group).length === 0) {
                this.audit.record('report_schedule_group_email_skipped', {
                  id: schedule.id, group: group.name, delivery, reason: 'group_members_missing'
                }, 'failure')
              }
            }
            if (recipients.length > 0 || groupCcRecipients.length > 0) {
              const reportHtml = await readEmailBody(report)
              const month = `${report.generatedAt.slice(0, 4)}-${report.generatedAt.slice(5, 7)}`
              const send = async (to: string[], cc: string[] = []): Promise<void> => {
                await this.emailService.sendReportEmail({
                  to,
                  cc,
                  subject: `【分支健康月报】${month}`,
                  body: '',
                  html: appendCreatorSection(reportHtml, creators, this.storage),
                  attachmentPath: report.path
                })
              }
              const toHeader = recipients.length > 0 ? recipients : groupCcRecipients
              const ccHeader = recipients.length > 0 ? groupCcRecipients : []
              await send(toHeader, ccHeader)
              this.audit.record('report_schedule_creator_recipients', {
                id: schedule.id,
                accountCreatorRecipients: creators.accountCreatorRecipients,
                commitCreatorRecipients: creators.commitCreatorRecipients,
                verifiedCreatorRecipients: creators.verifiedCreatorRecipients,
                fallbackRecipients: creators.fallback,
                skipped: creators.skipped
              }, creators.skipped.length > 0 ? 'failure' : 'success')
              for (const { group, delivery } of auditedGroups) {
                const members = groupRecipients(group)
                if (members.length === 0) continue
                this.audit.record('report_schedule_group_email_sent', {
                  id: schedule.id, group: group.name, delivery, sent: members.length
                }, 'success')
              }
            }
          }
          // Derive the next run from the schedule's intended time, not from the
          // actual completion time: a scan that takes 3 minutes must not push
          // tomorrow's 09:00 delivery to 09:03 and drift further every day.
          const nextRunAt = schedule.frequency === 'once' ? null : computeNextReportRunAt(schedule, new Date(schedule.nextRunAt ?? now))
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
