import { app, safeStorage } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import nodemailer from 'nodemailer'
import type { EmailConfig, EmailGroup, EmailSendResult } from '@shared/types'
import type { StorageService } from './storage'
import type { AuditService } from './audit'
import { logger } from '../utils/logger'
import { newId, nowIso } from '../utils/ids'

const PLAIN_PREFIX = 'plain:'

export interface EmailIssueRow {
  repository: string
  branch: string
  creator: string
  creatorEmail: string
  lastCommitDate: string
  inactiveDays: number
  gracePeriod: number
  namingStatus: string
  mergeStatus: string
  healthScore: number
  state: string
}

export interface EmailSummaryData {
  total: number
  stale: number
  gracePeriod: number
  graceExpired: number
  namingInvalid: number
  merged: number
  cleanupCandidates: number
  repositories: number
  generatedAt: string
}

export function resolveRecipients(input: string, groups: EmailGroup[] = []): string[] {
  const tokens = input
    .split(/[,;\s]+/)
    .map((token) => token.trim().toLowerCase())
    .filter(Boolean)
  const resolved: string[] = []
  for (const token of tokens) {
    const group = groups.find((item) => item.name.trim().toLowerCase() === token)
    if (group) {
      for (const recipient of resolveRecipients(group.recipients, [])) {
        if (!resolved.includes(recipient)) resolved.push(recipient)
      }
    } else if (!resolved.includes(token)) {
      resolved.push(token)
    }
  }
  return resolved
}

export interface ParsedNotifyTarget {
  self: boolean
  creator: boolean
  recipients: string
}

export function parseNotifyTarget(target: string | null | undefined): ParsedNotifyTarget {
  const tokens = String(target ?? '').split(/[,;\s]+/).map((t) => t.trim()).filter(Boolean)
  let self = false
  let creator = false
  const rest: string[] = []
  for (const token of tokens) {
    if (token === 'self') self = true
    else if (token === 'creator') creator = true
    else if (token === 'both') { self = true; creator = true }
    else if (token !== 'none') rest.push(token)
  }
  return { self, creator, recipients: rest.join(', ') }
}

export class EmailService {
  constructor(
    private readonly storage: StorageService,
    private readonly audit: AuditService
  ) {}

  getConfig(): EmailConfig {
    const row = this.storage.get<Record<string, unknown>>('SELECT * FROM email_config WHERE id = 1')
    return {
      server: String(row?.server ?? ''),
      port: Number(row?.port ?? 587),
      username: String(row?.username ?? ''),
      hasPassword: Boolean(row?.password_encrypted && String(row.password_encrypted).length > 0),
      from: String(row?.from_address ?? ''),
      secure: Number(row?.secure ?? 1) === 1,
      tls: Number(row?.tls ?? 0) === 1,
      testRecipient: String(row?.test_recipient ?? row?.username ?? ''),
      selfEmail: String(row?.self_email ?? ''),
      enabled: Number(row?.enabled ?? 0) === 1
    }
  }

  saveConfig(config: EmailConfig & { password?: string }): EmailConfig {
    const current = this.getConfig()
    let encrypted = String(this.storage.get<Record<string, unknown>>('SELECT password_encrypted FROM email_config WHERE id = 1')?.password_encrypted ?? '')
    if (config.password) {
      encrypted = this.encrypt(config.password)
    } else if (current.hasPassword && !encrypted) {
      encrypted = this.encrypt('')
    }
    this.storage.update(
      'email_config',
      {
        server: config.server,
        port: Math.max(1, config.port || 587),
        username: config.username,
        password_encrypted: encrypted,
        from_address: config.from,
        secure: config.secure ? 1 : 0,
        tls: config.tls ? 1 : 0,
        test_recipient: config.testRecipient || config.username,
        self_email: config.selfEmail || '',
        enabled: config.enabled ? 1 : 0
      },
      'id = 1'
    )
    return this.getConfig()
  }

  private encrypt(value: string): string {
    if (safeStorage.isEncryptionAvailable()) {
      return safeStorage.encryptString(value).toString('base64')
    }
    logger.warn('safeStorage unavailable; storing email credential obfuscated only')
    return PLAIN_PREFIX + Buffer.from(value, 'utf8').toString('base64')
  }

  getPassword(): string {
    const encrypted = String(this.storage.get<Record<string, unknown>>('SELECT password_encrypted FROM email_config WHERE id = 1')?.password_encrypted ?? '')
    if (!encrypted) return ''
    if (encrypted.startsWith(PLAIN_PREFIX)) {
      return Buffer.from(encrypted.slice(PLAIN_PREFIX.length), 'base64').toString('utf8')
    }
    try {
      return safeStorage.decryptString(Buffer.from(encrypted, 'base64'))
    } catch {
      return ''
    }
  }

  listGroups(): EmailGroup[] {
    return this.storage.all<Record<string, unknown>>('SELECT * FROM email_groups ORDER BY created_at ASC').map((r) => ({
      id: String(r.id),
      name: String(r.name),
      recipients: String(r.recipients),
      createdAt: String(r.created_at)
    }))
  }

  saveGroup(group: Partial<EmailGroup> & { id?: string }): EmailGroup[] {
    const now = nowIso()
    const existing = group.id ? this.storage.get<Record<string, unknown>>('SELECT * FROM email_groups WHERE id = ?', [group.id]) : undefined
    const id = existing ? String(existing.id) : newId()
    const name = String(group.name ?? existing?.name ?? '').trim()
    const recipients = String(group.recipients ?? existing?.recipients ?? '').trim()
    if (!name || !recipients) throw new Error('Group name and recipients are required.')
    this.storage.upsert('email_groups', {
      id,
      name,
      recipients,
      created_at: existing ? String(existing.created_at) : now
    })
    this.audit.record(existing ? 'email_group_updated' : 'email_group_saved', { id, name, recipients })
    return this.listGroups()
  }

  deleteGroup(id: string): EmailGroup[] {
    this.storage.delete('email_groups', 'id = ?', [id])
    this.audit.record('email_group_deleted', { id })
    return this.listGroups()
  }

  getTemplate(kind: string): { subject: string; body: string } {
    const row = this.storage.get<Record<string, unknown>>('SELECT subject, body FROM email_templates WHERE kind = ?', [kind])
    if (row) return { subject: String(row.subject), body: String(row.body) }
    return { subject: 'BranchPulse Notification', body: '{{branch}} needs attention.' }
  }

  renderTemplate(kind: string, data: Record<string, unknown>): { subject: string; body: string } {
    const template = this.getTemplate(kind)
    const render = (input: string): string =>
      input.replace(/\{\{(\w+)\}\}/g, (_, key: string) => {
        const value = data[key]
        return value === undefined || value === null ? '' : String(value)
      })
    return { subject: render(template.subject), body: render(template.body) }
  }

  private buildTransport(config?: EmailConfig) {
    const cfg = config ?? this.getConfig()
    if (!cfg.server && cfg.username) {
      const domain = cfg.username.toLowerCase().split('@').pop() || ''
      const providerMap: Record<string, { server: string; port: number; secure: boolean; requireTls?: boolean }> = {
        'gmail.com': { server: 'smtp.gmail.com', port: 465, secure: true },
        'googlemail.com': { server: 'smtp.gmail.com', port: 465, secure: true },
        'qq.com': { server: 'smtp.qq.com', port: 465, secure: true },
        'foxmail.com': { server: 'smtp.qq.com', port: 465, secure: true },
        '163.com': { server: 'smtp.163.com', port: 465, secure: true },
        '126.com': { server: 'smtp.126.com', port: 465, secure: true },
        'outlook.com': { server: 'smtp.office365.com', port: 587, secure: false, requireTls: true },
        'hotmail.com': { server: 'smtp.office365.com', port: 587, secure: false, requireTls: true },
        'live.com': { server: 'smtp.office365.com', port: 587, secure: false, requireTls: true },
        'icloud.com': { server: 'smtp.mail.me.com', port: 587, secure: false, requireTls: true }
      }
      const provider = providerMap[domain] ?? {
        server: domain ? 'smtp.' + domain : '',
        port: 465,
        secure: true
      }
      cfg.server = provider.server
      cfg.port = provider.port
      cfg.secure = provider.secure
      cfg.tls = provider.requireTls === true
    }
    return nodemailer.createTransport({
      host: cfg.server,
      port: cfg.port,
      secure: cfg.secure,
      requireTLS: cfg.tls,
      auth: cfg.username
        ? {
            user: cfg.username,
            pass: this.getPassword()
          }
        : undefined,
      connectionTimeout: 15000,
      greetingTimeout: 15000,
      socketTimeout: 20000
    })
  }

  async testConnection(config?: EmailConfig): Promise<EmailSendResult> {
    try {
      const transport = this.buildTransport(config)
      await transport.verify()
      this.audit.record('email_connection_test', { server: config?.server ?? this.getConfig().server }, 'success')
      return { ok: true, message: 'SMTP connection and authentication succeeded.' }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      this.audit.record('email_connection_test', { error: message }, 'failure')
      return {
        ok: false,
        message: 'Unable to connect to the SMTP server. Check host, port, credentials and TLS settings.',
        technical: message
      }
    }
  }

  async sendTestEmail(config?: EmailConfig): Promise<EmailSendResult> {
    const cfg = config ?? this.getConfig()
    if (!cfg.testRecipient) {
      return { ok: false, message: 'Set a test recipient before sending a test email.' }
    }
    try {
      const transport = this.buildTransport(cfg)
      await transport.sendMail({
        from: cfg.from || cfg.username || 'BranchPulse',
        to: cfg.testRecipient,
        subject: 'BranchPulse Test Email',
        text: 'This is a test email from BranchPulse. SMTP, authentication and delivery are working.'
      })
      this.audit.record('email_test_sent', { to: cfg.testRecipient }, 'success')
      return { ok: true, message: 'Test email sent successfully.', recipients: [cfg.testRecipient], emailsSent: 1 }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      this.audit.record('email_test_sent', { error: message }, 'failure')
      return {
        ok: false,
        message: 'Test email failed to send.',
        technical: message
      }
    }
  }

  async sendSummaryEmail(data: EmailSummaryData, config?: EmailConfig, recipients?: string[]): Promise<EmailSendResult> {
    const cfg = config ?? this.getConfig()
    const fallback = resolveRecipients(cfg.testRecipient || cfg.username)
    const recipientList = recipients?.length ? recipients : fallback
    const recipient = recipientList.join(', ')
    if (!cfg.enabled || !recipient) {
      return { ok: false, message: 'Email is disabled or no recipient is configured.', emailsSent: 0 }
    }
    const rendered = this.renderTemplate('summary', { ...data, recipient })
    try {
      const transport = this.buildTransport(cfg)
      await transport.sendMail({
        from: cfg.from || cfg.username || 'BranchPulse',
        to: recipient,
        subject: rendered.subject,
        text: rendered.body
      })
      this.audit.record('email_summary_sent', { to: recipient }, 'success')
      return { ok: true, message: 'Summary email sent.', recipients: [recipient], emailsSent: 1 }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      this.audit.record('email_summary_sent', { error: message }, 'failure')
      return { ok: false, message: 'Summary email failed.', technical: message, emailsSent: 0 }
    }
  }

  async sendCreatorEmails(rows: EmailIssueRow[], config?: EmailConfig): Promise<EmailSendResult> {
    const cfg = config ?? this.getConfig()
    if (!cfg.enabled) return { ok: false, message: '邮件发送未启用。', emailsSent: 0 }
    const groups = new Map<string, EmailIssueRow[]>()
    for (const row of rows) {
      const key = (row.creatorEmail || row.creator || 'unknown').trim().toLowerCase()
      const list = groups.get(key) ?? []
      list.push(row)
      groups.set(key, list)
    }
    const recipients: string[] = []
    const skipped: string[] = []
    let sent = 0
    let failed = 0
    const failures: string[] = []
    const transport = this.buildTransport(cfg)
    for (const [key, branchRows] of groups) {
      const first = branchRows[0]
      const to = String(first.creatorEmail || first.creator || '').trim()
      if (!to || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) {
        skipped.push(first.creator ? `${first.creator}（无有效邮箱）` : String(key))
        void key
        continue
      }
      const body = branchRows
        .map((r) => {
          const rendered = this.renderTemplate('stale', {
            ...r,
            creator: first.creator,
            creator_email: first.creatorEmail
          })
          return `${rendered.subject}\n\n${rendered.body}`
        })
        .join('\n\n---\n\n')
      try {
        await transport.sendMail({
          from: cfg.from || cfg.username || 'BranchPulse',
          to,
          subject: `BranchPulse: ${branchRows.length} branch${branchRows.length > 1 ? 'es' : ''} need attention`,
          text: body
        })
        recipients.push(to)
        sent += 1
      } catch (err) {
        failed += 1
        const message = err instanceof Error ? err.message : String(err)
        failures.push(`${to}: ${message}`)
        logger.warn(`creator email send failed: ${to} ${message}`)
      }
      void key
    }
    const details = failures.slice(0, 3).join('; ')
    if (failed > 0) {
      this.audit.record('email_creator_sent', { recipients, count: sent, failed, errors: failures }, sent > 0 ? 'success' : 'failure')
      const configHint = cfg.server
        ? ''
        : 'SMTP 服务器未配置。请在设置中填写发件邮箱后保存；特殊服务商请在设置的 SMTP 服务器中手动填写。'
      const suffix = details ? ` 失败原因：${details}` : configHint
      return {
        ok: sent > 0,
        message: sent > 0
          ? `已发送 ${sent} 封创始人邮件，${failed} 封失败。${suffix}`
          : `创始人邮件发送失败（共 ${failed} 封）。${suffix}` ,
        technical: failures.join('\n'),
        emailsSent: sent
      }
    }
    this.audit.record('email_creator_sent', { recipients, count: sent, skipped }, 'success')
    const skipText = skipped.length > 0 ? `；${skipped.length} 个创始人缺少有效邮箱已跳过：${skipped.slice(0, 3).join('、')}` : ''
    return {
      ok: sent > 0,
      message: sent > 0 ? `已发送 ${sent} 封创始人邮件。${skipText}` : `没有可发送的创始人邮件。${skipText}`,
      recipients,
      emailsSent: sent
    }
  }

  async sendReportEmail(input: {
    to: string[]
    subject: string
    body: string
    attachmentPath: string
  }): Promise<EmailSendResult> {
    const cfg = this.getConfig()
    if (!cfg.enabled) return { ok: false, message: '邮件发送未启用。', emailsSent: 0 }
    try {
      if (!fs.existsSync(input.attachmentPath)) throw new Error(`Report file not found: ${input.attachmentPath}`)
      const transport = this.buildTransport(cfg)
      await transport.sendMail({
        from: cfg.from || cfg.username || 'BranchPulse',
        to: input.to.join(', '),
        subject: input.subject,
        text: input.body,
        attachments: [{
          filename: path.basename(input.attachmentPath),
          path: input.attachmentPath
        }]
      })
      this.audit.record('email_report_sent', { recipients: input.to, report: path.basename(input.attachmentPath) }, 'success')
      return { ok: true, message: '报告邮件发送成功。', recipients: input.to, emailsSent: input.to.length }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      logger.error('Report email failed', message)
      this.audit.record('email_report_sent', { recipients: input.to, error: message }, 'failure')
      return { ok: false, message: '报告邮件发送失败。', technical: message, emailsSent: 0 }
    }
  }
}

void app

