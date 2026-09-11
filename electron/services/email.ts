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
  whitelisted?: boolean
  protectedBranch?: boolean
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
  thresholdHint?: string
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
    cleanupCandidate: branch.cleanupCandidate,
    whitelisted: branch.protection.whitelisted,
    protectedBranch: branch.protection.protected || branch.protection.isDefault
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

function htmlEmailShell(subject: string, body: string, lang: EmailLang = 'zh'): string {
  return `<!DOCTYPE html>
<html lang="${lang === 'zh' ? 'zh-CN' : 'en'}"><head><meta charset="utf-8"></head>
<body style="font-family:'Microsoft YaHei',Arial,sans-serif;color:#20242a;background:#f4f6f8;margin:0;padding:16px">
  <div style="max-width:680px;margin:0 auto;background:#fff;border:1px solid #e2e6ea;border-radius:8px;padding:20px 24px">
    <h2 style="font-size:18px;margin:0 0 12px">${escapeHtml(subject)}</h2>
    ${body}
    <hr style="border:none;border-top:1px solid #e2e6ea;margin:18px 0 10px">
    <div style="color:#98a2b3;font-size:11px">${lang === 'zh' ? '由 BranchPulse 自动发送' : 'Sent by BranchPulse'} · ${formatDateTime(new Date().toISOString(), lang)}</div>
  </div>
</body></html>`
}

function statCards(cards: Array<{ value: string | number; label: string; color?: string }>): string {
  const cells = cards.map((card) => `
    <td style="border:1px solid #e2e6ea;border-radius:6px;padding:10px 6px;text-align:center;width:12.5%">
      <div style="font-size:20px;font-weight:700;color:${card.color ?? '#20242a'}">${escapeHtml(card.value)}</div>
      <div style="font-size:11px;color:#6b7280;margin-top:2px">${escapeHtml(card.label)}</div>
    </td>`).join('')
  return `<table style="width:100%;border-collapse:separate;border-spacing:4px 0"><tr>${cells}</tr></table>`
}

function donutSvg(segments: Array<{ label: string; value: number; color: string }>, centerLabel: string, centerSub: string): string {
  const total = segments.reduce((sum, segment) => sum + segment.value, 0)
  const size = 230
  const thickness = 34
  const radius = (size - thickness) / 2
  const circumference = 2 * Math.PI * radius
  const cx = size / 2
  const cy = cx
  let offset = 0
  const arcs = segments.filter((segment) => segment.value > 0).map((segment) => {
    const dash = (segment.value / total) * circumference
    const svg = `<circle cx="${cx}" cy="${cy}" r="${radius}" fill="none" stroke="${segment.color}" stroke-width="${thickness}" stroke-dasharray="${dash.toFixed(2)} ${(circumference - dash).toFixed(2)}" stroke-dashoffset="${offset.toFixed(2)}" transform="rotate(-90 ${cx} ${cy})"><title>${escapeHtml(segment.label)}：${segment.value} 个</title></circle>`
    offset -= dash
    return svg
  }).join('')
  return `<svg viewBox="0 0 ${size} ${size}" role="img" aria-label="分支状态分布图"><circle cx="${cx}" cy="${cy}" r="${radius}" fill="none" stroke="#eef2f6" stroke-width="${thickness}"/>${arcs}<text x="${cx}" y="${cy - 4}" text-anchor="middle" style="font-size:28px;font-weight:700;fill:#20242a">${escapeHtml(centerLabel)}</text><text x="${cx}" y="${cy + 18}" text-anchor="middle" style="font-size:11px;fill:#6b7280">${escapeHtml(centerSub)}</text></svg>`
}

function hbarSvg(items: Array<{ label: string; value: number; color?: string }>, suffix = ' 天'): string {
  const width = 560
  const rowHeight = 30
  const labelWidth = 190
  const barArea = width - labelWidth - 82
  const maxValue = Math.max(1, ...items.map((item) => item.value))
  const rows = items.map((item, index) => {
    const y = index * rowHeight + 10
    const barWidth = Math.max(2, (item.value / maxValue) * barArea)
    const color = item.color ?? '#c4320a'
    return `<text x="0" y="${y + 11}" style="font-size:11px;fill:#374151">${escapeHtml(item.label)}</text><rect x="${labelWidth}" y="${y}" width="${barWidth.toFixed(1)}" height="14" rx="3" fill="${color}"><title>${escapeHtml(item.label)}：${item.value}${suffix}</title></rect><text x="${(labelWidth + barWidth + 6).toFixed(1)}" y="${y + 11}" style="font-size:11px;fill:#6b7280">${item.value}${escapeHtml(suffix)}</text>`
  }).join('')
  return `<svg viewBox="0 0 ${width} ${items.length * rowHeight + 16}" role="img" aria-label="最久未提交分支">${rows}</svg>`
}

function stackedSvg(segments: Array<{ label: string; value: number; color: string }>): string {
  const total = segments.reduce((sum, segment) => sum + segment.value, 0)
  if (total <= 0) return ''
  const width = 560
  let x = 0
  const rects = segments.filter((segment) => segment.value > 0).map((segment) => {
    const w = Math.max(1, (segment.value / total) * width)
    const svg = `<rect x="${x.toFixed(1)}" y="4" width="${w.toFixed(1)}" height="16" fill="${segment.color}"><title>${escapeHtml(segment.label)}：${segment.value} 个（${((segment.value / total) * 100).toFixed(1)}%）</title></rect>`
    x += w
    return svg
  }).join('')
  return `<svg viewBox="0 0 ${width} 42" role="img" aria-label="占比条形图">${rects}</svg>`
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

  const metricCards = (cards: Array<{ value: string | number; label: string; color?: string }>): string => cards.map((card) => `
    <div style="flex:1;border:1px solid #e2e6ea;border-radius:8px;padding:12px;text-align:center">
      <div style="font-size:26px;font-weight:700;color:${card.color ?? '#20242a'}">${escapeHtml(card.value)}</div>
      <div style="color:#6b7280;font-size:12px;margin-top:4px">${escapeHtml(card.label)}</div>
    </div>`).join('')
  const statusLabel = (row: EmailIssueRow): string => {
    if (row.whitelisted && row.state !== 'active') return lang === 'zh' ? '白名单保留（宽限期已过）' : 'Whitelist retained (expired)'
    if (row.protectedBranch) return lang === 'zh' ? '保护 / 默认分支' : 'Protected / default branch'
    if (row.cleanupCandidate) return lang === 'zh' ? '清理候选' : 'Cleanup candidate'
    return stateLabel(row.state, lang)
  }
  const activeCount = data.branches.filter((row) => row.state === 'active').length
  const gracePeriodCount = data.branches.filter((row) => row.state === 'grace_period').length
  const graceExpiredCount = data.branches.filter((row) => row.state === 'grace_expired').length
  const protectedCount = data.branches.filter((row) => row.protectedBranch).length
  const whitelistedCount = data.branches.filter((row) => row.whitelisted && !row.protectedBranch).length
  const statusSegments = [
    { label: t.active, value: activeCount, color: '#16a34a' },
    { label: t.gracePeriod, value: gracePeriodCount, color: '#f59e0b' },
    { label: t.graceExpired, value: graceExpiredCount, color: '#dc2626' },
    { label: lang === 'zh' ? '保护 / 默认分支' : 'Protected / default', value: protectedCount, color: '#2563eb' },
    { label: lang === 'zh' ? '白名单保留' : 'Whitelist retained', value: whitelistedCount, color: '#9333ea' }
  ]
  const stalePercent = data.total ? Math.round((data.stale / data.total) * 100) : 0

  const staleRows = data.branches
    .filter((row) => row.state !== 'active' || row.cleanupCandidate)
    .sort((a, b) => b.inactiveDays - a.inactiveDays)
    .map((row) => [
      `<code>${escapeHtml(row.branch)}</code>`,
      escapeHtml(row.repository),
      escapeHtml(row.creator || '-'),
      String(row.inactiveDays),
      escapeHtml(formatDateTime(row.lastCommitAt ?? row.lastCommitDate, lang)),
      statusLabel(row)
    ])

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

  const allRows = [...data.branches]
    .sort((a, b) => a.repository.localeCompare(b.repository) || a.branch.localeCompare(b.branch))
    .map((row) => [
      `<code>${escapeHtml(row.branch)}</code>`,
      escapeHtml(row.repository),
      escapeHtml(row.creator || '-'),
      escapeHtml(row.creatorEmail || '-'),
      stateLabel(row.state, lang),
      namingLabel(row.namingStatus, lang),
      String(row.healthScore),
      String(row.inactiveDays),
      escapeHtml(formatDateTime(row.lastCommitAt ?? row.lastCommitDate, lang))
    ])
  const topOldest = [...data.branches]
    .sort((a, b) => b.inactiveDays - a.inactiveDays)
    .slice(0, 10)
    .map((row, index, list) => ({
      label: row.branch,
      value: row.inactiveDays,
      color: ['#b42318', '#c4320a', '#d92d20', '#e5484d', '#ef6820', '#f97066'][Math.min(5, Math.floor((index / Math.max(1, list.length)) * 6))]
    }))
  const complianceSegments = [
    { label: lang === 'zh' ? '合规' : 'Compliant', value: Math.max(0, data.total - data.namingInvalid), color: '#16a34a' },
    { label: lang === 'zh' ? '不规范' : 'Non-compliant', value: data.namingInvalid, color: '#dc2626' }
  ]
  const sections: string[] = []
  sections.push(`
    <div style="display:flex;gap:12px;margin:16px 0">${metricCards([
      { value: data.total, label: t.total },
      { value: data.stale, label: t.stale, color: '#b42318' },
      { value: `${stalePercent}%`, label: lang === 'zh' ? '已停更占比' : 'Stale percent', color: '#b54708' },
      { value: data.namingInvalid, label: t.namingInvalid, color: '#b54708' }
    ])}</div>
    ${data.thresholdHint ? `<div style="color:#6b7280;font-size:12px">${escapeHtml(data.thresholdHint)}</div>` : ''}
    <div style="height:10px;background:#eef2f6;border-radius:5px;overflow:hidden;margin:10px 0 4px"><div style="width:${stalePercent}%;height:100%;background:#c4320a"></div></div>`)
  sections.push(`
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-top:18px">
      <div style="border:1px solid #e2e6ea;border-radius:8px;padding:14px">
        <h3 style="font-size:14px;margin:0 0 10px">${t.chart}</h3>
        ${donutSvg(statusSegments, String(data.total), lang === 'zh' ? '总分支数' : 'Total branches')}
        <div style="display:flex;flex-wrap:wrap;gap:8px 14px;margin-top:10px">${statusSegments.map((segment) => `<span style="font-size:11px;color:#4b5563"><span style="display:inline-block;width:10px;height:10px;border-radius:2px;background:${segment.color};margin-right:5px"></span>${escapeHtml(segment.label)} ${segment.value}</span>`).join('')}</div>
      </div>
      <div style="border:1px solid #e2e6ea;border-radius:8px;padding:14px">
        <h3 style="font-size:14px;margin:0 0 10px">${lang === 'zh' ? '最久未提交 TOP 10' : 'Oldest branches'}</h3>
        ${topOldest.length ? hbarSvg(topOldest) : `<p style="color:#6b7280;font-size:12px">${lang === 'zh' ? '暂无分支' : 'No branches'}</p>`}
      </div>
      <div style="grid-column:1/-1;border:1px solid #e2e6ea;border-radius:8px;padding:14px">
        <h3 style="font-size:14px;margin:0 0 10px">${lang === 'zh' ? '命名合规占比' : 'Naming compliance'}</h3>
        ${stackedSvg(complianceSegments)}
        <p style="color:#6b7280;font-size:11px;margin:8px 0 0">${lang === 'zh' ? `合规 ${Math.max(0, data.total - data.namingInvalid)} 个 · 不规范 ${data.namingInvalid} 个` : `Compliant ${data.total - data.namingInvalid} · Non-compliant ${data.namingInvalid}`}</p>
      </div>
    </div>`)
  sections.push(`
    <h3 style="font-size:14px;margin:18px 0 4px">${t.attention}</h3>
    ${staleRows.length ? emailTable([t.branch, t.repository, t.creator, t.inactive, t.lastCommit, t.state], staleRows) : `<p style="font-size:12px;color:#6b7280">${t.attentionEmpty}</p>`}`)
  sections.push(`
    <h3 style="font-size:14px;margin:18px 0 4px">${t.namingTitle}</h3>
    ${namingRows.length ? emailTable([t.branch, t.repository, t.creator, t.rule, t.reason], namingRows) : `<p style="font-size:12px;color:#6b7280">${t.namingEmpty}</p>`}`)
  sections.push(`
    <h3 style="font-size:14px;margin:18px 0 4px">${t.allTitle}</h3>
    ${emailTable([t.branch, t.repository, t.creator, lang === 'zh' ? '邮箱' : 'Email', t.state, t.naming, t.health, t.inactive, t.lastCommit], allRows)}`)

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

type CreatorEmailScenario = 'stale' | 'grace_expired' | 'idle' | 'naming'

function scenarioRowsTable(rows: EmailIssueRow[], lang: EmailLang, scenario: CreatorEmailScenario): string {
  const zh = lang === 'zh'
  const headers = zh
    ? ['分支', '提交作者', '最近提交', '未提交天数', scenario === 'naming' ? '不符合原因' : '说明']
    : ['Branch', 'Author', 'Last commit', 'Inactive days', scenario === 'naming' ? 'Reason' : 'Note']
  const tableRows = rows.map((row) => [
    `<code>${escapeHtml(row.branch)}</code>`,
    escapeHtml(row.creator || '-'),
    escapeHtml(formatDateTime(row.lastCommitAt ?? row.lastCommitDate, lang)),
    String(row.inactiveDays),
    scenario === 'naming'
      ? escapeHtml(row.namingReason || '-')
      : row.whitelisted
        ? (zh ? '白名单分支，仅提醒不删除' : 'Whitelisted; reminder only')
        : (zh ? '保护 / 默认分支' : 'Protected / default branch')
  ])
  return emailTable(headers, tableRows)
}

function creatorScenarioEmail(rows: EmailIssueRow[], scenario: CreatorEmailScenario, lang: EmailLang, thresholdHint?: string): { subject: string; html: string } {
  const zh = lang === 'zh'
  const count = rows.length
  const gitCommands = `<pre style="background:#f1f5f9;padding:8px;border-radius:6px;font-size:12px">git branch -m &lt;old&gt; &lt;new&gt;\ngit push -u origin &lt;new&gt;\ngit push origin --delete &lt;old&gt;</pre>`
  const namingRules = zh
    ? '<p>规范：feature|bugfix|hotfix|release|chore|docs/xxx，或 main / develop。分支描述建议使用小写字母、数字、短横线，不能包含空格。</p>'
    : '<p>Naming convention: feature|bugfix|hotfix|release|chore|docs/xxx, or main / develop.</p>'

  if (scenario === 'naming') {
    const subject = zh
      ? `【BranchPulse】${count} 个分支命名不符合规范，请修改`
      : `BranchPulse: ${count} branch${count === 1 ? '' : 'es'} need renaming`
    const body = zh
      ? `<p>以下 ${count} 个分支命名不符合规范，请按规范重命名后重新推送：</p>${gitCommands}${namingRules}${scenarioRowsTable(rows, lang, scenario)}`
      : `<p>The following ${count} branch${count === 1 ? '' : 'es'} do not follow the naming rules:</p>${gitCommands}${namingRules}${scenarioRowsTable(rows, lang, scenario)}`
    return { subject, html: htmlEmailShell(subject, body, lang) }
  }

  if (scenario === 'grace_expired') {
    const subject = zh
      ? `【BranchPulse】${count} 个分支宽限期已过，请尽快处理`
      : `BranchPulse: ${count} branch${count === 1 ? '' : 'es'} past the grace period`
    const body = zh
      ? `<p>以下 ${count} 个分支宽限期已过。如需保留，请尽快 push 新提交或回复保留说明；如无需保留，请及时清理。</p>${thresholdHint ? `<p style="color:#6b7280;font-size:12px">${escapeHtml(thresholdHint)}</p>` : ''}${scenarioRowsTable(rows, lang, scenario)}`
      : `<p>The following ${count} branch${count === 1 ? '' : 'es'} ${count === 1 ? 'has' : 'have'} passed the grace period. Push a new commit if it should be retained.</p>${scenarioRowsTable(rows, lang, scenario)}`
    return { subject, html: htmlEmailShell(subject, body, lang) }
  }

  if (scenario === 'idle') {
    const subject = zh
      ? `【BranchPulse】${count} 个分支长时间无提交，请确认去留`
      : `BranchPulse: Confirm ${count} inactive branch${count === 1 ? '' : 'es'}`
    const body = zh
      ? `<p>以下 ${count} 个分支长时间没有 commit 记录：</p><ul><li>如还需要保留：请回复说明保留理由，并尽快 push 一次新提交或归档。</li><li>如无需保留：请删除该分支，避免被自动回收。</li></ul>${scenarioRowsTable(rows, lang, scenario)}`
      : `<p>The following ${count} branch${count === 1 ? '' : 'es'} have been inactive for a long time:</p><ul><li>To retain: reply with the reason and push a new commit.</li><li>To retire: delete the branch.</li></ul>${scenarioRowsTable(rows, lang, scenario)}`
    return { subject, html: htmlEmailShell(subject, body, lang) }
  }

  const subject = zh
    ? `【BranchPulse】${count} 个分支已停更，请及时处理`
    : `BranchPulse: ${count} stale branch${count === 1 ? '' : 'es'} need attention`
  const body = zh
    ? `<p>以下 ${count} 个分支已进入已停更状态。为避免进入清理候选，请合并、归档或继续提交：</p>${thresholdHint ? `<p style="color:#6b7280;font-size:12px">${escapeHtml(thresholdHint)}</p>` : ''}${scenarioRowsTable(rows, lang, scenario)}`
    : `<p>The following ${count} stale branch${count === 1 ? '' : 'es'} need attention. Merge, archive, or push a new commit:</p>${scenarioRowsTable(rows, lang, scenario)}`
  return { subject, html: htmlEmailShell(subject, body, lang) }
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

  async sendCreatorEmails(
    rows: EmailIssueRow[],
    config?: EmailConfig,
    options?: { thresholdHint?: string }
  ): Promise<EmailSendResult> {
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
        continue
      }
      const scenarios: Array<[CreatorEmailScenario, EmailIssueRow[]]> = [
        ['stale', branchRows.filter((row) => row.state === 'grace_period')],
        ['grace_expired', branchRows.filter((row) => row.state === 'grace_expired')],
        ['idle', branchRows.filter((row) => row.state === 'stale')],
        ['naming', branchRows.filter((row) => row.namingStatus === 'invalid')]
      ]
      for (const [scenario, scenarioBranchRows] of scenarios) {
        if (scenarioBranchRows.length === 0) continue
        const sortedRows = [...scenarioBranchRows].sort((a, b) => b.inactiveDays - a.inactiveDays)
        const email = creatorScenarioEmail(sortedRows, scenario, lang, options?.thresholdHint)
        try {
          await this.sendWithOutlook({ to: [to], subject: email.subject, body: '', html: email.html, lang })
          recipients.push(to)
          sent += 1
        } catch (err) {
          failed += 1
          const message = err instanceof Error ? err.message : String(err)
          failures.push(`${to}: ${message}`)
          logger.warn(`creator email send failed: ${to} ${message}`)
        }
      }
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



