import { app, safeStorage } from 'electron'
import fs from 'node:fs'
import { spawn } from 'node:child_process'
import path from 'node:path'
import type { BranchSummary, EmailConfig, EmailGroup, EmailSendResult } from '@shared/types'
import type { StorageService } from './storage'
import type { AuditService } from './audit'
import { logger } from '../utils/logger'
import { newId, nowIso } from '../utils/ids'

const PLAIN_PREFIX = 'plain:'
const OUTLOOK_TIMEOUT_MS = 120_000

export interface EmailIssueRow {
  repository: string
  branch: string
  creator: string
  creatorEmail: string
  lastCommitDate: string
  lastCommitAt?: string | null
  inactiveDays: number
  gracePeriod: number
  namingStatus: string
  namingRuleName?: string
  namingReason?: string
  mergeStatus: string
  healthScore: number
  state: string
  cleanupCandidate?: boolean
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
  branches: EmailIssueRow[]
}

export type EmailLang = 'en' | 'zh'

export function readEmailLang(storage: StorageService): EmailLang {
  const row = storage.get<Record<string, unknown>>('SELECT language FROM app_settings WHERE id = 1')
  return row?.language === 'zh' ? 'zh' : 'en'
}

export function toEmailIssueRow(branch: BranchSummary): EmailIssueRow {
  return {
    repository: branch.repositoryName,
    branch: branch.displayName,
    creator: branch.creator.name,
    creatorEmail: branch.creator.email,
    lastCommitDate: branch.lastCommitAt ? new Date(branch.lastCommitAt).toLocaleString() : '-',
    lastCommitAt: branch.lastCommitAt,
    inactiveDays: branch.inactiveDays,
    gracePeriod: branch.gracePeriodDays,
    namingStatus: branch.naming.status,
    namingRuleName: branch.naming.ruleName,
    namingReason: branch.naming.reason,
    mergeStatus: branch.merged ? 'merged' : 'not merged',
    healthScore: branch.health.score,
    state: branch.state,
    cleanupCandidate: branch.cleanupCandidate
  }
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

function escapeHtml(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function formatDateTime(value: string | null | undefined, lang: EmailLang): string {
  if (!value) return '-'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return date.toLocaleString(lang === 'zh' ? 'zh-CN' : 'en-US', {
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit'
  })
}

const STATE_LABELS: Record<EmailLang, Record<string, string>> = {
  zh: {
    active: '活跃',
    stale: '已停更',
    grace_period: '宽限期内',
    grace_expired: '宽限期已过'
  },
  en: {
    active: 'Active',
    stale: 'Stale',
    grace_period: 'Grace period',
    grace_expired: 'Grace expired'
  }
}

function stateLabel(state: string, lang: EmailLang): string {
  return STATE_LABELS[lang][state] ?? state
}

function namingLabel(status: string, lang: EmailLang): string {
  if (lang === 'zh') {
    if (status === 'invalid') return '<span style="color:#b42318">不规范</span>'
    if (status === 'excluded') return '豁免'
    return '合规'
  }
  if (status === 'invalid') return '<span style="color:#b42318">Invalid</span>'
  if (status === 'excluded') return 'Excluded'
  return 'Valid'
}

function textToHtml(subject: string, body: string, lang: EmailLang = 'zh'): string {
  const content = body
    .split(/\r?\n/)
    .map((line) => `<p style="margin:0 0 7px">${escapeHtml(line) || '&nbsp;'}</p>`)
    .join('')
  return `<!DOCTYPE html>
<html lang="${lang === 'zh' ? 'zh-CN' : 'en'}"><head><meta charset="utf-8"></head>
<body style="font-family:'Microsoft YaHei',Arial,sans-serif;color:#20242a;background:#f4f6f8;margin:0;padding:16px">
  <div style="max-width:680px;margin:0 auto;background:#fff;border:1px solid #e2e6ea;border-radius:8px;padding:20px 24px">
    <h2 style="font-size:18px;margin:0 0 12px">${escapeHtml(subject)}</h2>
    ${content}
    <hr style="border:none;border-top:1px solid #e2e6ea;margin:18px 0 10px">
    <div style="color:#98a2b3;font-size:11px">${lang === 'zh' ? '由 BranchPulse 自动发送' : 'Sent by BranchPulse'} · ${formatDateTime(new Date().toISOString(), lang)}</div>
  </div>
</body></html>`
}

function emailTable(headers: string[], rows: string[][]): string {
  if (rows.length === 0) return ''
  const thead = `<tr>${headers.map((h) => `<th style="padding:6px 8px;border:1px solid #e2e6ea;background:#f8fafc;text-align:left;font-size:12px">${h}</th>`).join('')}</tr>`
  const tbody = rows.map((cells) => `<tr>${cells.map((cell) => `<td style="padding:6px 8px;border:1px solid #e2e6ea;font-size:12px">${cell}</td>`).join('')}</tr>`).join('')
  return `<table style="width:100%;border-collapse:collapse;margin-top:8px">${thead}${tbody}</table>`
}

function statCards(cards: Array<{ value: string | number; label: string; color?: string }>): string {
  const cells = cards.map((card) => `
    <td style="border:1px solid #e2e6ea;border-radius:6px;padding:10px 6px;text-align:center;width:12.5%">
      <div style="font-size:20px;font-weight:700;color:${card.color ?? '#20242a'}">${escapeHtml(card.value)}</div>
      <div style="font-size:11px;color:#6b7280;margin-top:2px">${escapeHtml(card.label)}</div>
    </td>`).join('')
  return `<table style="width:100%;border-collapse:separate;border-spacing:4px 0"><tr>${cells}</tr></table>`
}

function stackedBar(segments: Array<{ label: string; value: number; color: string }>, lang: EmailLang): string {
  const total = segments.reduce((sum, segment) => sum + segment.value, 0)
  const barCells = total > 0
    ? segments.filter((s) => s.value > 0).map((segment, index, list) => {
        const radiusStart = index === 0 ? 'border-radius:4px 0 0 4px;' : ''
        const radiusEnd = index === list.length - 1 ? 'border-radius:0 4px 4px 0;' : ''
        return `<td style="background:${segment.color};width:${(segment.value / total * 100).toFixed(2)}%;height:16px;${radiusStart}${radiusEnd}"></td>`
      }).join('')
    : '<td style="background:#eef2f6;width:100%;height:16px;border-radius:4px"></td>'
  const legend = segments.filter((s) => s.value > 0).map((segment) =>
    `<span style="display:inline-block;margin:0 12px 4px 0;font-size:11px;color:#4b5563"><span style="display:inline-block;width:9px;height:9px;border-radius:2px;background:${segment.color};margin-right:4px"></span>${escapeHtml(segment.label)} ${segment.value}</span>`
  ).join('')
  const emptyText = lang === 'zh' ? '暂无分支数据' : 'No branch data'
  return `
    <table style="width:100%;border-collapse:collapse"><tr>${barCells}</tr></table>
    <div style="margin-top:6px">${legend || `<span style="font-size:11px;color:#6b7280">${emptyText}</span>`}</div>`
}

export function buildBranchEmailHtml(data: EmailSummaryData, lang: EmailLang, kind: 'summary' | 'report' = 'summary'): string {
  const t = lang === 'zh'
    ? {
        title: kind === 'report' ? '分支健康报告' : '分支治理汇总',
        repositories: '个仓库',
        generatedAt: '生成时间',
        chart: '分支状态分布',
        stats: '关键指标',
        total: '总分支',
        active: '活跃',
        stale: '已停更',
        gracePeriod: '宽限期内',
        graceExpired: '宽限期已过',
        namingInvalid: '命名不规范',
        cleanup: '清理候选',
        attention: `需要处理的分支`,
        attentionEmpty: '没有需要处理的分支，状态健康。',
        branch: '分支',
        repository: '仓库',
        creator: '创始人',
        inactive: '未提交天数',
        lastCommit: '最新提交',
        state: '状态',
        naming: '命名',
        rule: '违反规则',
        reason: '原因',
        namingTitle: '命名不规范的分支',
        namingEmpty: '没有命名不规范分支。',
        allTitle: '所有分支一览',
        health: '健康分',
        yes: '是',
        no: '否'
      }
    : {
        title: kind === 'report' ? 'Branch Health Report' : 'Branch Governance Summary',
        repositories: 'repositories',
        generatedAt: 'Generated at',
        chart: 'Branch status distribution',
        stats: 'Key metrics',
        total: 'Total',
        active: 'Active',
        stale: 'Stale',
        gracePeriod: 'Grace period',
        graceExpired: 'Grace expired',
        namingInvalid: 'Naming invalid',
        cleanup: 'Cleanup candidates',
        attention: 'Branches needing attention',
        attentionEmpty: 'No branches need attention. All healthy.',
        branch: 'Branch',
        repository: 'Repository',
        creator: 'Creator',
        inactive: 'Inactive days',
        lastCommit: 'Last commit',
        state: 'State',
        naming: 'Naming',
        rule: 'Violated rule',
        reason: 'Reason',
        namingTitle: 'Naming violations',
        namingEmpty: 'No naming violations.',
        allTitle: 'All branches overview',
        health: 'Health',
        yes: 'Yes',
        no: 'No'
      }

  const sections: string[] = []
  const stateCount = (state: string): number => data.branches.filter((row) => row.state === state).length
  const activeCount = stateCount('active')
  sections.push(`
    <h3 style="font-size:14px;margin:18px 0 8px">${t.chart}</h3>
    ${stackedBar([
      { label: t.active, value: activeCount, color: '#16a34a' },
      { label: t.gracePeriod, value: stateCount('grace_period'), color: '#3b82f6' },
      { label: t.stale, value: stateCount('stale'), color: '#f59e0b' },
      { label: t.graceExpired, value: stateCount('grace_expired'), color: '#dc2626' }
    ], lang)}`)
  sections.push(`
    <h3 style="font-size:14px;margin:18px 0 8px">${t.stats}</h3>
    ${statCards([
      { value: data.total, label: t.total },
      { value: activeCount, label: t.active, color: '#087443' },
      { value: data.stale, label: t.stale, color: '#b54708' },
      { value: data.gracePeriod, label: t.gracePeriod, color: '#2563eb' },
      { value: data.graceExpired, label: t.graceExpired, color: '#b42318' },
      { value: data.namingInvalid, label: t.namingInvalid, color: '#b42318' },
      { value: data.cleanupCandidates, label: t.cleanup }
    ])}`)

  const attentionRows = data.branches
    .filter((row) => row.state === 'stale' || row.state === 'grace_expired' || row.cleanupCandidate)
    .sort((a, b) => b.inactiveDays - a.inactiveDays)
    .map((row) => [
      `<code>${escapeHtml(row.branch)}</code>`,
      escapeHtml(row.repository),
      escapeHtml(row.creator || '-'),
      String(row.inactiveDays),
      escapeHtml(formatDateTime(row.lastCommitAt ?? row.lastCommitDate, lang)),
      stateLabel(row.state, lang) + (row.cleanupCandidate ? (lang === 'zh' ? ' · 清理候选' : ' · cleanup') : '')
    ])
  sections.push(`
    <h3 style="font-size:14px;margin:18px 0 4px">${t.attention}</h3>
    ${attentionRows.length ? emailTable([t.branch, t.repository, t.creator, t.inactive, t.lastCommit, t.state], attentionRows) : `<p style="font-size:12px;color:#6b7280">${t.attentionEmpty}</p>`}`)

  const namingRows = data.branches
    .filter((row) => row.namingStatus === 'invalid')
    .sort((a, b) => a.branch.localeCompare(b.branch))
    .map((row) => [
      `<code>${escapeHtml(row.branch)}</code>`,
      escapeHtml(row.repository),
      escapeHtml(row.creator || '-'),
      escapeHtml(row.namingRuleName || '-'),
      escapeHtml(row.namingReason || '-')
    ])
  sections.push(`
    <h3 style="font-size:14px;margin:18px 0 4px">${t.namingTitle}</h3>
    ${namingRows.length ? emailTable([t.branch, t.repository, t.creator, t.rule, t.reason], namingRows) : `<p style="font-size:12px;color:#6b7280">${t.namingEmpty}</p>`}`)

  const allRows = [...data.branches]
    .sort((a, b) => a.repository.localeCompare(b.repository) || a.branch.localeCompare(b.branch))
    .map((row) => [
      `<code>${escapeHtml(row.branch)}</code>`,
      escapeHtml(row.repository),
      escapeHtml(row.creator || '-'),
      stateLabel(row.state, lang),
      namingLabel(row.namingStatus, lang),
      String(row.healthScore),
      String(row.inactiveDays),
      escapeHtml(formatDateTime(row.lastCommitAt ?? row.lastCommitDate, lang))
    ])
  sections.push(`
    <h3 style="font-size:14px;margin:18px 0 4px">${t.allTitle}</h3>
    ${emailTable([t.branch, t.repository, t.creator, t.state, t.naming, t.health, t.inactive, t.lastCommit], allRows)}`)

  return `<!DOCTYPE html>
<html lang="${lang === 'zh' ? 'zh-CN' : 'en'}"><head><meta charset="utf-8"></head>
<body style="font-family:'Microsoft YaHei','Segoe UI',Arial,sans-serif;color:#20242a;background:#f4f6f8;margin:0;padding:16px">
  <div style="max-width:860px;margin:0 auto;background:#fff;border:1px solid #e2e6ea;border-radius:8px;padding:20px 24px">
    <h2 style="font-size:18px;margin:0 0 4px">${t.title}</h2>
    <div style="color:#6b7280;font-size:12px">${data.repositories} ${t.repositories} · ${t.generatedAt} ${escapeHtml(formatDateTime(data.generatedAt, lang))}</div>
    ${sections.join('')}
    <hr style="border:none;border-top:1px solid #e2e6ea;margin:18px 0 10px">
    <div style="color:#98a2b3;font-size:11px">${lang === 'zh' ? '由 BranchPulse 自动发送' : 'Sent by BranchPulse'} · ${escapeHtml(formatDateTime(new Date().toISOString(), lang))}</div>
  </div>
</body></html>`
}

function validRecipients(recipients: string[]): string[] {
  return [...new Set(recipients.map((recipient) => recipient.trim()).filter(Boolean))]
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
        test_recipient: config.testRecipient || config.selfEmail || config.username,
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

  private async runOutlookScript(script: string, payload?: Record<string, unknown>): Promise<string> {
    if (process.platform !== 'win32') throw new Error('本机 Outlook 发送仅支持 Windows。')
    const scriptPath = path.join(app.getPath('temp'), `branchpulse-outlook-${newId()}.ps1`)
    const payloadPath = payload ? path.join(app.getPath('temp'), `branchpulse-outlook-${newId()}.json`) : ''
    if (payload) fs.writeFileSync(payloadPath, Buffer.from(JSON.stringify(payload, null, 2), 'utf8'))
    const args = payload ? [payloadPath] : []
    // Windows PowerShell 5.1 requires UTF-8 BOM to parse non-ASCII content correctly.
    fs.writeFileSync(scriptPath, Buffer.concat([Buffer.from([0xEF, 0xBB, 0xBF]), Buffer.from(script, 'utf8')]))
    try {
      return await new Promise<string>((resolve, reject) => {
        const child = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', scriptPath, ...args], { windowsHide: true })
        let stdout = ''
        let stderr = ''
        let settled = false
        const timer = setTimeout(() => {
          settled = true
          child.kill()
          reject(new Error('Outlook 发送超时。请确认 Outlook 已启动并允许程序发送邮件。'))
        }, OUTLOOK_TIMEOUT_MS)
        child.stdout.on('data', (chunk) => { stdout += String(chunk) })
        child.stderr.on('data', (chunk) => { stderr += String(chunk) })
        child.on('error', (err) => {
          if (settled) return
          clearTimeout(timer)
          settled = true
          reject(err instanceof Error ? err : new Error(String(err)))
        })
        child.on('close', (code) => {
          if (settled) return
          clearTimeout(timer)
          settled = true
          if (code === 0) resolve(stdout.trim())
          else reject(new Error(stderr.trim() || `本机 Outlook 操作失败，退出码 ${code ?? 'unknown'}。`))
        })
      })
    } finally {
      fs.rmSync(scriptPath, { force: true })
      if (payloadPath) fs.rmSync(payloadPath, { force: true })
    }
  }

  private async verifyOutlook(): Promise<void> {
    await this.runOutlookScript([
      "$ErrorActionPreference = 'Stop'",
      'try {',
      '  $outlook = New-Object -ComObject Outlook.Application',
      '  Write-Output OK',
      '  exit 0',
      '} catch {',
      '  Write-Error $_',
      '  exit 1',
      '}'
    ].join("\r\n"))
  }

  private async sendWithOutlook(input: { to: string[]; subject: string; body: string; html?: string; lang?: EmailLang; attachments?: string[] }): Promise<void> {
    const recipients = validRecipients(input.to)
    if (recipients.length === 0) throw new Error('收件人为空。')
    const script = [
      "$ErrorActionPreference = 'Stop'",
      'try {',
      '  $outlook = New-Object -ComObject Outlook.Application',
      '  $mail = $outlook.CreateItem(0)',
      '  $payload = Get-Content -LiteralPath $args[0] -Raw -Encoding UTF8 | ConvertFrom-Json',
      '  $recipients = @($payload.recipients | Where-Object { $_ -and $_.Trim() })',
      '  if ($recipients.Count -eq 0) { throw "收件人为空。" }',
      '  $mail.To = (($recipients | ForEach-Object { [string]$_ }) -join "; ")',
      '  $mail.Subject = [string]$payload.subject',
      '  $mail.HTMLBody = [string]$payload.htmlBody',
      '  if ($payload.attachments) {',
      '    foreach ($path in @($payload.attachments)) {',
      '      if ($path -and (Test-Path -LiteralPath $path)) {',
      '        [void]$mail.Attachments.Add((Resolve-Path -LiteralPath $path).Path)',
      '      }',
      '    }',
      '  }',
      '  $mail.Send()',
      '  exit 0',
      '} catch {',
      '  Write-Error $_',
      '  exit 1',
      '}'
    ].join("\r\n")
    await this.runOutlookScript(script, {
      recipients,
      subject: input.subject,
      htmlBody: input.html ?? textToHtml(input.subject, input.body, input.lang),
      attachments: input.attachments ?? []
    })
  }

  async testConnection(config?: EmailConfig): Promise<EmailSendResult> {
    void config
    try {
      await this.verifyOutlook()
      this.audit.record('email_connection_test', { transport: 'local-outlook' }, 'success')
      return { ok: true, message: '本机 Outlook 可用。' }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      this.audit.record('email_connection_test', { transport: 'local-outlook', error: message }, 'failure')
      return {
        ok: false,
        message: '无法访问本机 Outlook。请确认 Outlook 已安装并至少打开过一次。',
        technical: message
      }
    }
  }

  async sendTestEmail(config?: EmailConfig): Promise<EmailSendResult> {
    const cfg = config ?? this.getConfig()
    const lang = readEmailLang(this.storage)
    const testRecipient = cfg.testRecipient || cfg.selfEmail
    if (!testRecipient) {
      return { ok: false, message: 'Set a test recipient before sending a test email.' }
    }
    try {
      await this.sendWithOutlook({
        to: [testRecipient],
        subject: lang === 'zh' ? 'BranchPulse 测试邮件' : 'BranchPulse Test Email',
        body: lang === 'zh'
          ? '这是来自 BranchPulse 的测试邮件，本机 Outlook 发送正常。'
          : 'This is a test email from BranchPulse. Local Outlook delivery is working.',
        lang
      })
      this.audit.record('email_test_sent', { to: testRecipient }, 'success')
      return { ok: true, message: 'Test email sent successfully.', recipients: [testRecipient], emailsSent: 1 }
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
    const lang = readEmailLang(this.storage)
    const fallback = resolveRecipients(cfg.testRecipient || cfg.selfEmail || cfg.username)
    const recipientList = recipients?.length ? recipients : fallback
    const recipient = recipientList.join(', ')
    if (!cfg.enabled || !recipient) {
      this.audit.record('email_summary_skipped', {
        to: recipient || undefined,
        reason: !cfg.enabled ? 'email_disabled' : 'recipients_empty'
      }, 'failure')
      return { ok: false, message: 'Email is disabled or no recipient is configured.', emailsSent: 0 }
    }
    try {
      await this.sendWithOutlook({
        to: recipientList,
        subject: lang === 'zh' ? 'BranchPulse 分支治理汇总' : 'BranchPulse Branch Summary',
        body: '',
        html: buildBranchEmailHtml(data, lang, 'summary')
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
    const lang = readEmailLang(this.storage)
    if (!cfg.enabled) return { ok: false, message: lang === 'zh' ? '邮件发送未启用。' : 'Email sending is disabled.', emailsSent: 0 }
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
    for (const [key, branchRows] of groups) {
      const first = branchRows[0]
      const to = String(first.creatorEmail || first.creator || '').trim()
      if (!to || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) {
        skipped.push(first.creator ? `${first.creator}（无有效邮箱）` : String(key))
        void key
        continue
      }
      const sortedRows = [...branchRows].sort((a, b) => b.inactiveDays - a.inactiveDays)
      const issueRows = sortedRows.map((row) => [
        `<code>${escapeHtml(row.branch)}</code>`,
        escapeHtml(row.repository),
        String(row.inactiveDays),
        escapeHtml(formatDateTime(row.lastCommitAt ?? row.lastCommitDate, lang)),
        stateLabel(row.state, lang) + (row.cleanupCandidate ? (lang === 'zh' ? ' · 清理候选' : ' · cleanup') : ''),
        namingLabel(row.namingStatus, lang)
      ])
      const issueTable = emailTable(
        lang === 'zh'
          ? ['分支', '仓库', '未提交天数', '最新提交', '状态', '命名']
          : ['Branch', 'Repository', 'Inactive days', 'Last commit', 'State', 'Naming'],
        issueRows
      )
      const body = lang === 'zh'
        ? `<p>以下 ${branchRows.length} 个分支需要处理，请归档或继续提交：</p>${issueTable}`
        : `<p>The following ${branchRows.length} branch${branchRows.length > 1 ? 'es' : ''} need attention. Please merge, archive, or push a new commit:</p>${issueTable}`
      try {
        await this.sendWithOutlook({
          to: [to],
          subject: lang === 'zh'
            ? `【分支治理】${branchRows.length} 个分支需要处理`
            : `BranchPulse: ${branchRows.length} branch${branchRows.length > 1 ? 'es' : ''} need attention`,
          body,
          html: body,
          lang
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
      const configHint = '请确认本机 Outlook 已安装、已登录并保持可用。'
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
    html?: string
    attachmentPath: string
  }): Promise<EmailSendResult> {
    const cfg = this.getConfig()
    if (!cfg.enabled) return { ok: false, message: '邮件发送未启用。', emailsSent: 0 }
    try {
      if (!fs.existsSync(input.attachmentPath)) throw new Error(`Report file not found: ${input.attachmentPath}`)
      await this.sendWithOutlook({
        to: input.to,
        subject: input.subject,
        body: input.body,
        html: input.html,
        attachments: [input.attachmentPath]
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



