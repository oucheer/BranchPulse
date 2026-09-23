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
  lastAuthor?: string
  lastAuthorEmail?: string
  lastCommitDate: string
  lastCommitAt?: string | null
  inactiveDays: number
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
    lastAuthor: branch.lastAuthor,
    lastAuthorEmail: branch.lastAuthorEmail,
    lastCommitDate: branch.lastCommitAt ? new Date(branch.lastCommitAt).toLocaleString() : '-',
    lastCommitAt: branch.lastCommitAt,
    inactiveDays: branch.inactiveDays,
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
    stale: '已停更'
  },
  en: {
    active: 'Active',
    stale: 'Stale'
  }
}

function stateLabel(state: string, lang: EmailLang): string {
  return STATE_LABELS[lang][state] ?? state
}

/** 处理期限：从邮件发送当天起算 1 个月，月末日期做钳制以避免跨月溢出。 */
function processingDeadlineParts(now: Date): { year: number; month: number; day: number } {
  const year = now.getFullYear()
  const targetMonthIndex = now.getMonth() + 1
  const targetYear = targetMonthIndex > 11 ? year + 1 : year
  const targetMonth = (targetMonthIndex % 12) + 1
  const lastDay = new Date(targetYear, targetMonth, 0).getDate()
  return { year: targetYear, month: targetMonth, day: Math.min(now.getDate(), lastDay) }
}

/** 所有提醒邮件统一附带的处理期限提示。 */
export function processingDeadlineNotice(lang: EmailLang, now = new Date()): string {
  const { year, month, day } = processingDeadlineParts(now)
  const text = lang === 'zh'
    ? `请在${year}年${String(month).padStart(2, '0')}月${String(day).padStart(2, '0')}号（从邮件发送当天开始计算1个月的时间点）对分支不合规处进行处理。`
    : `Please handle the non-compliant branches within 1 month (by ${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}).`
  return `<p style="margin:14px 0 0;padding:8px 10px;border:1px solid #fed7aa;background:#fff7ed;color:#9a3412;font-size:12px;line-height:1.6">${text}</p>`
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
    <div style="color:#98a2b3;font-size:11px">${lang === 'zh' ? '由 GitManager 自动发送' : 'Sent by GitManager'} · ${formatDateTime(new Date().toISOString(), lang)}</div>
  </div>
</body></html>`
}

/**
 * 表格使用固定布局 + 断词，避免超长分支名把列表撑出外层白色卡片的边界。
 * 列宽由调用方给出，保证长内容换行而不是横向溢出。
 */
function emailTable(headers: string[], rows: string[][], colWidths?: string[]): string {
  if (rows.length === 0) return ''
  const headStyle = 'padding:6px 8px;border:1px solid #e2e6ea;background:#f8fafc;text-align:left;font-size:12px;word-break:break-word;overflow-wrap:anywhere'
  const bodyStyle = 'padding:6px 8px;border:1px solid #e2e6ea;font-size:12px;vertical-align:top;word-break:break-word;overflow-wrap:anywhere'
  const colgroup = colWidths?.length === headers.length
    ? `<colgroup>${colWidths.map((width) => `<col style="width:${width}">`).join('')}</colgroup>`
    : ''
  const thead = `<tr>${headers.map((h) => `<th style="${headStyle}">${h}</th>`).join('')}</tr>`
  const tbody = rows.map((cells) => `<tr>${cells.map((cell) => `<td style="${bodyStyle}">${cell}</td>`).join('')}</tr>`).join('')
  return `<table style="width:100%;table-layout:fixed;border-collapse:collapse;margin-top:6px">${colgroup}${thead}${tbody}</table>`
}

/** 分支名可能非常长，必须允许任意位置断行，否则会撑破外层白色卡片。 */
function branchCell(branch: string): string {
  return `<code style="white-space:normal;word-break:break-all;overflow-wrap:anywhere">${escapeHtml(branch)}</code>`
}

/**
 * 附件报告按仓库分组渲染：每个列表最前面先标出仓库名，列表内不再保留冗余的「仓库」列。
 */
function groupedTables(
  rows: EmailIssueRow[],
  lang: EmailLang,
  headers: string[],
  colWidths: string[],
  buildCells: (row: EmailIssueRow) => string[]
): string {
  const groups = new Map<string, EmailIssueRow[]>()
  for (const row of rows) {
    const key = row.repository || (lang === 'zh' ? '未知仓库' : 'Unknown repository')
    const bucket = groups.get(key)
    if (bucket) bucket.push(row)
    else groups.set(key, [row])
  }
  return [...groups.entries()]
    .map(([repository, groupRows]) => `
      <div style="border:1px solid #e2e6ea;border-left:3px solid #2563eb;border-radius:4px;background:#f8fafc;padding:5px 8px;margin-top:12px;font-size:12px;font-weight:700;color:#344054">${lang === 'zh' ? '仓库' : 'Repository'}：${escapeHtml(repository)}</div>
      ${emailTable(headers, groupRows.map(buildCells), colWidths)}`)
    .join('')
}

function htmlEmailShell(subject: string, body: string, lang: EmailLang = 'zh'): string {
  return `<!DOCTYPE html>
<html lang="${lang === 'zh' ? 'zh-CN' : 'en'}"><head><meta charset="utf-8"></head>
<body style="font-family:'Microsoft YaHei',Arial,sans-serif;color:#20242a;background:#f4f6f8;margin:0;padding:16px">
  <div style="max-width:680px;margin:0 auto;background:#fff;border:1px solid #e2e6ea;border-radius:8px;padding:20px 24px">
    <h2 style="font-size:18px;margin:0 0 12px">${escapeHtml(subject)}</h2>
    ${body}
    ${processingDeadlineNotice(lang)}
    <hr style="border:none;border-top:1px solid #e2e6ea;margin:18px 0 10px">
    <div style="color:#98a2b3;font-size:11px">${lang === 'zh' ? '由 GitManager 自动发送' : 'Sent by GitManager'} · ${formatDateTime(new Date().toISOString(), lang)}</div>
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

/**
 * 单个仓库（或单次汇总）的正文内容。报告主体按仓库分区渲染，
 * 每个分区都复用这里的指标卡、图表与明细表，仓库之间互不混合。
 */
function branchEmailBody(
  data: EmailSummaryData,
  lang: EmailLang,
  kind: 'summary' | 'report' = 'summary'
): { title: string; meta: string; body: string } {
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
        namingInvalid: '命名不规范',
        cleanup: '清理候选',
        attention: '已停更的分支',
        attentionEmpty: '没有已停更的分支，状态健康。',
        branch: '分支',
        repository: '仓库',
        creator: '分支创始人',
        lastAuthor: '最后提交人',
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
        namingInvalid: 'Naming invalid',
        cleanup: 'Cleanup candidates',
        attention: 'Stale branches',
        attentionEmpty: 'No stale branches. All healthy.',
        branch: 'Branch',
        repository: 'Repository',
        creator: 'Creator',
        lastAuthor: 'Last author',
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
    if (row.whitelisted && row.state !== 'active') return lang === 'zh' ? '白名单保留（已停更）' : 'Whitelist retained (stale)'
    if (row.protectedBranch) return lang === 'zh' ? '保护 / 默认分支' : 'Protected / default branch'
    if (row.cleanupCandidate) return lang === 'zh' ? '清理候选' : 'Cleanup candidate'
    return stateLabel(row.state, lang)
  }
  const creatorLabel = (row: EmailIssueRow): string => {
    if (row.creator && row.creator !== 'Unknown') return escapeHtml(row.creator)
    const fallback = row.lastAuthor || (lang === 'zh' ? '未获取' : 'Unavailable')
    return `${escapeHtml(fallback)} (${lang === 'zh' ? '最后提交人，待确认创始人' : 'last author; creator unverified'})`
  }
  const activeCount = data.branches.filter((row) => row.state === 'active').length
  const protectedCount = data.branches.filter((row) => row.protectedBranch).length
  const whitelistedCount = data.branches.filter((row) => row.whitelisted && !row.protectedBranch).length
  const statusSegments = [
    { label: t.active, value: activeCount, color: '#16a34a' },
    { label: t.stale, value: data.branches.filter((row) => row.state === 'stale').length, color: '#f59e0b' },
    { label: lang === 'zh' ? '保护 / 默认分支' : 'Protected / default', value: protectedCount, color: '#2563eb' },
    { label: lang === 'zh' ? '白名单保留' : 'Whitelist retained', value: whitelistedCount, color: '#9333ea' }
  ]
  const stalePercent = data.total ? Math.round((data.stale / data.total) * 100) : 0
  const creatorReviewRows = data.branches.filter((row) => !row.creator || row.creator === 'Unknown')

  const staleIssues = data.branches
    .filter((row) => row.state !== 'active' || row.cleanupCandidate)
    .sort((a, b) => b.inactiveDays - a.inactiveDays)
  const staleCells = (row: EmailIssueRow): string[] => [
    branchCell(row.branch),
    creatorLabel(row),
    escapeHtml(row.lastAuthor || (lang === 'zh' ? '未获取' : 'Unavailable')),
    String(row.inactiveDays),
    escapeHtml(formatDateTime(row.lastCommitAt ?? row.lastCommitDate, lang)),
    statusLabel(row)
  ]

  const namingIssues = data.branches
    .filter((row) => row.namingStatus === 'invalid')
    .sort((a, b) => a.branch.localeCompare(b.branch))
  const namingCells = (row: EmailIssueRow): string[] => [
    branchCell(row.branch),
    creatorLabel(row),
    escapeHtml(row.lastAuthor || (lang === 'zh' ? '未获取' : 'Unavailable')),
    escapeHtml(row.namingRuleName || '-'),
    escapeHtml(row.namingReason || '-')
  ]

  const allIssues = [...data.branches]
    .sort((a, b) => a.repository.localeCompare(b.repository) || a.branch.localeCompare(b.branch))
  const allCells = (row: EmailIssueRow): string[] => [
    branchCell(row.branch),
    creatorLabel(row),
    escapeHtml(row.lastAuthor || (lang === 'zh' ? '未获取' : 'Unavailable')),
    escapeHtml(row.creatorEmail || '-'),
    stateLabel(row.state, lang),
    namingLabel(row.namingStatus, lang),
    String(row.healthScore),
    String(row.inactiveDays),
    escapeHtml(formatDateTime(row.lastCommitAt ?? row.lastCommitDate, lang))
  ]
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
  if (creatorReviewRows.length) {
    sections.push(`<div style="margin-top:14px;border:1px solid #f2c94c;background:#fff9e6;border-radius:6px;padding:10px 12px;color:#7a5b00;font-size:12px">
      <strong>${lang === 'zh' ? '分支创始人需要确认' : 'Creator confirmation required'}</strong>
      <ul style="margin:6px 0 0 18px;padding:0">${creatorReviewRows.map((row) => `<li>${escapeHtml(row.repository)} / ${escapeHtml(row.branch)}：${lang === 'zh' ? `无法找到该分支创始人，最后提交人是${row.lastAuthor || '未获取'}，请其确认该分支情况` : `The branch creator could not be found; the last author is ${row.lastAuthor || 'unavailable'}. Please ask them to confirm this branch.`}</li>`).join('')}</ul>
    </div>`)
  }
  sections.push(`
    <h3 style="font-size:14px;margin:18px 0 4px">${t.attention}</h3>
    ${staleIssues.length ? groupedTables(staleIssues, lang, [t.branch, t.creator, t.lastAuthor, t.inactive, t.lastCommit, t.state], ['24%', '17%', '15%', '10%', '20%', '14%'], staleCells) : `<p style="font-size:12px;color:#6b7280">${t.attentionEmpty}</p>`}`)
  sections.push(`
    <h3 style="font-size:14px;margin:18px 0 4px">${t.namingTitle}</h3>
    ${namingIssues.length ? groupedTables(namingIssues, lang, [t.branch, t.creator, t.lastAuthor, t.rule, t.reason], ['21%', '16%', '14%', '20%', '29%'], namingCells) : `<p style="font-size:12px;color:#6b7280">${t.namingEmpty}</p>`}`)
  sections.push(`
    <h3 style="font-size:14px;margin:18px 0 4px">${t.allTitle}</h3>
    ${groupedTables(allIssues, lang, [t.branch, t.creator, t.lastAuthor, lang === 'zh' ? '邮箱' : 'Email', t.state, t.naming, t.health, t.inactive, t.lastCommit], ['20%', '11%', '11%', '14%', '9%', '9%', '7%', '9%', '10%'], allCells)}`)

  return {
    title: t.title,
    meta: `${data.repositories} ${t.repositories} · ${t.generatedAt} ${formatDateTime(data.generatedAt, lang)}`,
    body: sections.join('')
  }
}

function emailDocument(title: string, metaHtml: string, body: string, lang: EmailLang): string {
  return `<!DOCTYPE html>
<html lang="${lang === 'zh' ? 'zh-CN' : 'en'}"><head><meta charset="utf-8"></head>
<body style="font-family:'Microsoft YaHei','Segoe UI',Arial,sans-serif;color:#20242a;background:#f4f6f8;margin:0;padding:16px">
  <div style="max-width:860px;margin:0 auto;background:#fff;border:1px solid #e2e6ea;border-radius:8px;padding:20px 24px">
    <h2 style="font-size:18px;margin:0 0 4px">${title}</h2>
    <div style="color:#6b7280;font-size:12px">${metaHtml}</div>
    ${body}
    ${processingDeadlineNotice(lang)}
    <hr style="border:none;border-top:1px solid #e2e6ea;margin:18px 0 10px">
    <div style="color:#98a2b3;font-size:11px">${lang === 'zh' ? '由 GitManager 自动发送' : 'Sent by GitManager'} · ${escapeHtml(formatDateTime(new Date().toISOString(), lang))}</div>
  </div>
</body></html>`
}

export function buildBranchEmailHtml(data: EmailSummaryData, lang: EmailLang, kind: 'summary' | 'report' = 'summary'): string {
  const { title, meta, body } = branchEmailBody(data, lang, kind)
  return emailDocument(escapeHtml(title), escapeHtml(meta), body, lang)
}

export interface EmailReportPartition {
  repositoryId: string
  repositoryName: string
  data: EmailSummaryData
}

/**
 * 多仓库报告正文：先逐仓独立分区（各自的指标、图表与明细），
 * 最后给出所选范围的总汇总。同名分支在分区内不会跨仓库合并。
 */
export function buildPartitionedReportHtml(
  input: { title: string; generatedAt: string; partitions: EmailReportPartition[]; overall: EmailSummaryData },
  lang: EmailLang
): string {
  const repositoryLabel = lang === 'zh' ? '仓库' : 'Repository'
  const partitionHtml = input.partitions
    .map((partition) => {
      const built = branchEmailBody(partition.data, lang, 'report')
      return `
  <section style="margin-top:20px;border:1px solid #e2e6ea;border-radius:8px;padding:16px 18px">
    <h2 style="font-size:16px;margin:0 0 4px">${escapeHtml(repositoryLabel)}：${escapeHtml(partition.repositoryName || partition.repositoryId)}</h2>
    <div style="color:#6b7280;font-size:12px">${escapeHtml(built.meta)}</div>
    ${built.body}
  </section>`
    })
    .join('')
  const overall = branchEmailBody(input.overall, lang, 'report')
  const overviewTitle = lang === 'zh' ? '管理总览' : 'Executive overview'
  const repositoryRows = input.partitions.map(({ repositoryName, repositoryId, data }) => [
    escapeHtml(repositoryName || repositoryId),
    String(data.total),
    String(data.stale),
    String(data.namingInvalid),
    String(data.cleanupCandidates)
  ])
  const overviewTable = emailTable(
    lang === 'zh' ? ['仓库', '分支总数', '已停更', '命名不规范', '清理候选'] : ['Repository', 'Branches', 'Stale', 'Naming issues', 'Cleanup candidates'],
    repositoryRows
  )
  const repoBars = input.partitions
    .map(({ repositoryName, repositoryId, data }) => ({
      label: repositoryName || repositoryId,
      value: data.stale,
      color: data.stale ? '#c4320a' : '#16a34a'
    }))
    .sort((a, b) => b.value - a.value)
    .slice(0, 10)
  const overviewChart = repoBars.some((item) => item.value > 0)
    ? `<div style="margin-top:12px"><h3 style="font-size:13px;margin:0 0 8px">${lang === 'zh' ? '各仓库已停更分支' : 'Stale branches by repository'}</h3>${hbarSvg(repoBars)}</div>`
    : ''
  const overview = `<section style="margin-top:18px;border:1px solid #e2e6ea;border-radius:8px;padding:14px 16px">
    <h2 style="font-size:16px;margin:0 0 10px">${overviewTitle}</h2>
    <div style="display:flex;gap:8px;margin-bottom:12px">${[
      { value: input.overall.total, label: lang === 'zh' ? '总分支' : 'Branches' },
      { value: input.overall.stale, label: lang === 'zh' ? '已停更' : 'Stale', color: '#b42318' },
      { value: input.overall.namingInvalid, label: lang === 'zh' ? '命名不规范' : 'Naming issues', color: '#b54708' },
      { value: input.overall.cleanupCandidates, label: lang === 'zh' ? '清理候选' : 'Cleanup candidates', color: '#c4320a' }
    ].map((item) => `<div style="flex:1;border:1px solid #e2e6ea;border-radius:6px;padding:9px;text-align:center"><strong style="font-size:20px;color:${item.color ?? '#20242a'}">${item.value}</strong><div style="font-size:11px;color:#6b7280">${item.label}</div></div>`).join('')}</div>
    ${overviewTable}${overviewChart}
    <div style="margin-top:12px">${branchEmailBody(input.overall, lang, 'report').body}</div>
    <p style="font-size:11px;color:#6b7280;margin:8px 0 0">${lang === 'zh' ? `覆盖 ${input.partitions.length} 个勾选仓库；下方为整体图表及逐仓详情。` : `Covers ${input.partitions.length} selected repositories; portfolio charts and repository details follow.`}</p>
  </section>`
  const meta = input.partitions.length
    ? `${escapeHtml(input.title)} · ${escapeHtml(formatDateTime(input.generatedAt, lang))}`
    : escapeHtml(overall.meta)
  return emailDocument(
    escapeHtml(input.title),
    meta,
    `${overview}
  <h2 style="font-size:18px;margin:24px 0 8px">${lang === 'zh' ? '仓库详细情况' : 'Repository details'}</h2>
  ${partitionHtml}`,
    lang
  )
}

type CreatorEmailScenario = 'stale' | 'naming'

function scenarioRowsTable(rows: EmailIssueRow[], lang: EmailLang, scenario: CreatorEmailScenario): string {
  const zh = lang === 'zh'
  const headers = zh
    ? ['仓库', '分支', '分支创始人 / 待确认人', '最后提交人', '最近提交', '未提交天数', scenario === 'naming' ? '不符合原因' : '说明']
    : ['Repository', 'Branch', 'Creator / reviewer', 'Last author', 'Last commit', 'Inactive days', scenario === 'naming' ? 'Reason' : 'Note']
  const creatorLabel = (row: EmailIssueRow): string => row.creator && row.creator !== 'Unknown'
    ? escapeHtml(row.creator)
    : `${escapeHtml(row.lastAuthor || (zh ? '未获取' : 'Unavailable'))} (${zh ? '最后提交人，无法找到创始人，请确认' : 'last author; creator not found, confirmation required'})`
  const tableRows = rows.map((row) => [
    escapeHtml(row.repository || '-'),
    `<code>${escapeHtml(row.branch)}</code>`,
    creatorLabel(row),
    escapeHtml(row.lastAuthor || (zh ? '未获取' : 'Unavailable')),
    escapeHtml(formatDateTime(row.lastCommitAt ?? row.lastCommitDate, lang)),
    String(row.inactiveDays),
    scenario === 'naming'
      ? escapeHtml(row.namingReason || '-')
      : row.whitelisted
        ? (zh ? '白名单分支，仅检查' : 'Whitelisted; inspection only')
        : (zh ? '保护 / 默认分支' : 'Protected / default branch')
  ])
  return emailTable(headers, tableRows)
}

/** One message per creator, with every selected repository and issue type included. */
export function creatorDigestEmail(
  rows: EmailIssueRow[],
  lang: EmailLang,
  thresholdHint?: string
): { subject: string; html: string } {
  const zh = lang === 'zh'
  const stale = [...rows].filter((row) => row.state === 'stale').sort((a, b) => b.inactiveDays - a.inactiveDays)
  const naming = [...rows].filter((row) => row.namingStatus === 'invalid').sort((a, b) => b.inactiveDays - a.inactiveDays)
  const subject = zh
    ? `【GitManager】分支异常汇总：${stale.length} 个停更，${naming.length} 个命名不规范`
    : `GitManager branch issues: ${stale.length} stale, ${naming.length} naming`
  const staleSection = stale.length
    ? `<h2 style="font-size:16px;margin:20px 0 8px">${zh ? `已停更分支（${stale.length}）` : `Stale branches (${stale.length})`}</h2>${thresholdHint ? `<p style="color:#6b7280;font-size:12px">${escapeHtml(thresholdHint)}</p>` : ''}${scenarioRowsTable(stale, lang, 'stale')}`
    : ''
  const namingSection = naming.length
    ? `<h2 style="font-size:16px;margin:20px 0 8px">${zh ? `命名不规范分支（${naming.length}）` : `Naming issues (${naming.length})`}</h2><p>${zh ? '请按仓库命名规范修改后重新推送。' : 'Rename these branches to match the repository rules and push again.'}</p>${scenarioRowsTable(naming, lang, 'naming')}`
    : ''
  const repositories = [...new Set(rows.map((row) => row.repository).filter(Boolean))]
  const intro = zh
    ? `您在 ${repositories.length} 个勾选仓库中有 ${rows.length} 个分支需要处理。异常已合并在本邮件中。`
    : `You have ${rows.length} branches requiring attention across ${repositories.length} selected repositories. All issues are combined in this email.`
  return { subject, html: htmlEmailShell(subject, `<p>${escapeHtml(intro)}</p>${staleSection}${namingSection}`, lang) }
}

/** 同一封邮件可能覆盖多个仓库，正文必须点明仓库名，否则创始人不知道是哪个远程仓。 */
function repositoryContext(rows: EmailIssueRow[], lang: EmailLang): string {
  const zh = lang === 'zh'
  const names = [...new Set(rows.map((row) => (row.repository || '').trim()).filter(Boolean))]
  if (names.length === 0) return ''
  const list = names.map((name) => `「${escapeHtml(name)}」`).join('、')
  return zh ? `（仓库：${list}）` : ` (repositories: ${names.map((name) => escapeHtml(name)).join(', ')})`
}

export function creatorScenarioEmail(rows: EmailIssueRow[], scenario: CreatorEmailScenario, lang: EmailLang, thresholdHint?: string): { subject: string; html: string } {
  const zh = lang === 'zh'
  const count = rows.length
  const repoContext = repositoryContext(rows, lang)
  const gitCommands = `<pre style="background:#f1f5f9;padding:8px;border-radius:6px;font-size:12px">git branch -m &lt;old&gt; &lt;new&gt;\ngit push -u origin &lt;new&gt;\ngit push origin --delete &lt;old&gt;</pre>`
  const namingRules = zh
    ? '<p>规范：feature|bugfix|hotfix|release|chore|docs/xxx，或 main / develop。分支描述建议使用小写字母、数字、短横线，不能包含空格。</p>'
    : '<p>Naming convention: feature|bugfix|hotfix|release|chore|docs/xxx, or main / develop.</p>'

  if (scenario === 'naming') {
    const subject = zh
      ? `【GitManager】${count} 个分支命名不符合规范，请修改`
      : `GitManager: ${count} branch${count === 1 ? '' : 'es'} need renaming`
    const body = zh
      ? `<p>以下 ${count} 个分支命名不符合规范${repoContext}，请按规范重命名后重新推送：</p>${gitCommands}${namingRules}${scenarioRowsTable(rows, lang, scenario)}`
      : `<p>The following ${count} branch${count === 1 ? '' : 'es'}${repoContext} do not follow the naming rules:</p>${gitCommands}${namingRules}${scenarioRowsTable(rows, lang, scenario)}`
    return { subject, html: htmlEmailShell(subject, body, lang) }
  }

  const subject = zh
    ? `【GitManager】${count} 个分支已停更，请及时处理`
    : `GitManager: ${count} stale branch${count === 1 ? '' : 'es'} need attention`
  const body = zh
    ? `<p>以下 ${count} 个分支已停更${repoContext}。为避免进入清理候选，请合并、归档或继续提交：</p>${thresholdHint ? `<p style="color:#6b7280;font-size:12px">${escapeHtml(thresholdHint)}</p>` : ''}${scenarioRowsTable(rows, lang, scenario)}`
    : `<p>The following ${count} stale branch${count === 1 ? '' : 'es'}${repoContext} need attention. Merge, archive, or push a new commit:</p>${scenarioRowsTable(rows, lang, scenario)}`
  return { subject, html: htmlEmailShell(subject, body, lang) }
}

function validRecipients(recipients: string[]): string[] {
  return [...new Set(recipients.map((recipient) => recipient.trim()).filter(Boolean))]
}

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

/**
 * 报告/汇总邮件的分支创始人收件人：把范围内所有需要处理分支的创始人邮箱去重，
 * 让同一封邮件同时覆盖多个仓库的多个分支，而不是逐人逐分支重复发送。
 */
export function collectCreatorAddresses(rows: EmailIssueRow[]): { to: string[]; missing: string[]; fallback: string[] } {
  const to: string[] = []
  const missing: string[] = []
  const fallbackAddresses: string[] = []
  const seenAddr = new Set<string>()
  const seenMissing = new Set<string>()
  for (const row of rows) {
    const creatorKnown = Boolean(row.creator && row.creator !== 'Unknown')
    const creatorAddress = String(row.creatorEmail ?? '').trim()
    const fallbackAddress = String(row.lastAuthorEmail ?? '').trim()
    const address = creatorKnown ? creatorAddress : fallbackAddress
    const key = address.toLowerCase()
    if (address && EMAIL_PATTERN.test(address)) {
      if (!seenAddr.has(key)) {
        seenAddr.add(key)
        to.push(address)
        if (!creatorKnown) fallbackAddresses.push(address)
      }
      continue
    }
    const name = String(row.creator ?? '').trim()
    const missingLabel = creatorKnown
      ? (name || address || '未知创始人')
      : `${row.lastAuthor || '未获取最后提交人'}（无法找到创始人）`
    if (!seenMissing.has(missingLabel)) {
      seenMissing.add(missingLabel)
      missing.push(missingLabel)
    }
  }
  return { to, missing, fallback: fallbackAddresses }
}

/**
 * 报告邮件里的「创始人通知范围」区块：把同一封密送覆盖到的创始人、
 * 以及因缺少邮箱没能送达的创始人写清楚，收件人一眼能看出通知了谁。
 */
export function creatorNotificationSection(
  addresses: string[],
  missing: string[],
  lang: EmailLang,
  fallbackAddresses: string[] = []
): string {
  if (addresses.length === 0 && missing.length === 0 && fallbackAddresses.length === 0) return ''
  const zh = lang === 'zh'
  const title = zh ? '分支创始人通知范围' : 'Branch creators notified'
  const noted = addresses.length
    ? zh
      ? `<p style="font-size:12px;margin:6px 0 0">本邮件已密送以下 ${addresses.length} 位分支创始人：${escapeHtml(addresses.join('、'))}</p>`
      : `<p style="font-size:12px;margin:6px 0 0">This email BCCs ${addresses.length} branch creator(s): ${escapeHtml(addresses.join(', '))}</p>`
    : ''
  const skipped = missing.length
    ? zh
      ? `<p style="font-size:12px;margin:6px 0 0;color:#b54708">因缺少有效邮箱未通知（请补充邮箱后重试）：${escapeHtml(missing.join('、'))}</p>`
      : `<p style="font-size:12px;margin:6px 0 0;color:#b54708">Not notified (missing email): ${escapeHtml(missing.join(', '))}</p>`
    : ''
  const fallback = fallbackAddresses.length
    ? zh
      ? `<p style="font-size:12px;margin:6px 0 0;color:#b54708">因无法找到分支创始人，以下最后提交人邮箱作为回退收件人：${escapeHtml(fallbackAddresses.join('、'))}。邮件正文已标明需其确认分支情况。</p>`
      : `<p style="font-size:12px;margin:6px 0 0;color:#b54708">The creator could not be found, so these last-author addresses were used as fallback recipients: ${escapeHtml(fallbackAddresses.join(', '))}. The email identifies the branches that need confirmation.</p>`
    : ''
    return `
  <section style="margin-top:20px;border:1px solid #e2e6ea;border-radius:8px;padding:14px 18px">
    <h3 style="font-size:14px;margin:0">${title}</h3>
    ${noted}
    ${fallback}
    ${skipped}
  </section>`
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
    return { subject: 'GitManager Notification', body: '{{branch}} needs attention.' }
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
    const scriptPath = path.join(app.getPath('temp'), `gitmanager-outlook-${newId()}.ps1`)
    const payloadPath = payload ? path.join(app.getPath('temp'), `gitmanager-outlook-${newId()}.json`) : ''
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

  private async sendWithOutlook(input: {
    to: string[]
    cc?: string[]
    bcc?: string[]
    subject: string
    body: string
    html?: string
    lang?: EmailLang
    attachments?: string[]
  }): Promise<void> {
    const recipients = validRecipients(input.to)
    if (recipients.length === 0) throw new Error('收件人为空。')
    const cc = validRecipients(input.cc ?? [])
    const bcc = validRecipients(input.bcc ?? [])
    const script = [
      "$ErrorActionPreference = 'Stop'",
      'try {',
      '  $outlook = New-Object -ComObject Outlook.Application',
      '  $mail = $outlook.CreateItem(0)',
      '  $payload = Get-Content -LiteralPath $args[0] -Raw -Encoding UTF8 | ConvertFrom-Json',
      '  $recipients = @($payload.recipients | Where-Object { $_ -and $_.Trim() })',
      '  if ($recipients.Count -eq 0) { throw "收件人为空。" }',
      '  $mail.To = (($recipients | ForEach-Object { [string]$_ }) -join "; ")',
      '  $cc = @($payload.cc | Where-Object { $_ -and $_.Trim() })',
      '  if ($cc.Count -gt 0) { $mail.CC = (($cc | ForEach-Object { [string]$_ }) -join "; ") }',
      '  $bcc = @($payload.bcc | Where-Object { $_ -and $_.Trim() })',
      '  if ($bcc.Count -gt 0) { $mail.BCC = (($bcc | ForEach-Object { [string]$_ }) -join "; ") }',
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
      cc,
      bcc,
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
        subject: lang === 'zh' ? 'GitManager 测试邮件' : 'GitManager Test Email',
        body: lang === 'zh'
          ? '这是来自 GitManager 的测试邮件，本机 Outlook 发送正常。'
          : 'This is a test email from GitManager. Local Outlook delivery is working.',
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
        subject: lang === 'zh' ? 'GitManager 分支治理汇总' : 'GitManager Branch Summary',
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
      const creatorKnown = Boolean(row.creator && row.creator !== 'Unknown')
      const target = creatorKnown ? row.creatorEmail : row.lastAuthorEmail
      const key = (target || row.creator || row.lastAuthor || 'unknown').trim().toLowerCase()
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
      const creatorKnown = Boolean(first.creator && first.creator !== 'Unknown')
      const to = String(creatorKnown ? first.creatorEmail : first.lastAuthorEmail || '').trim()
      if (!to || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) {
        skipped.push(creatorKnown
          ? (first.creator ? `${first.creator}（无有效邮箱）` : String(key))
          : `${first.lastAuthor || '未获取最后提交人'}（无法找到创始人且最后提交人无有效邮箱）`)
        continue
      }
      const issueRows = branchRows.filter((row) => row.state === 'stale' || row.namingStatus === 'invalid')
      if (issueRows.length === 0) continue
      const email = creatorDigestEmail(issueRows, lang, options?.thresholdHint)
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
    cc?: string[]
    bcc?: string[]
    subject: string
    body: string
    html?: string
    attachmentPath: string
  }): Promise<EmailSendResult> {
    const cfg = this.getConfig()
    if (!cfg.enabled) return { ok: false, message: '邮件发送未启用。', emailsSent: 0 }
    try {
      if (!fs.existsSync(input.attachmentPath)) throw new Error(`Report file not found: ${input.attachmentPath}`)
      // 多仓库只发一封：创始人放入密送，收件人之间互相看不到邮箱。
      await this.sendWithOutlook({
        to: input.to,
        cc: input.cc,
        bcc: input.bcc,
        subject: input.subject,
        body: input.body,
        html: input.html,
        attachments: [input.attachmentPath]
      })
      this.audit.record(
        'email_report_sent',
        {
          recipients: input.to,
          cc: input.cc ?? [],
          bcc: input.bcc ?? [],
          report: path.basename(input.attachmentPath)
        },
        'success'
      )
      return { ok: true, message: '报告邮件发送成功。', recipients: input.to, emailsSent: input.to.length }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      logger.error('Report email failed', message)
      this.audit.record('email_report_sent', { recipients: input.to, cc: input.cc ?? [], bcc: input.bcc ?? [], error: message }, 'failure')
      return { ok: false, message: '报告邮件发送失败。', technical: message, emailsSent: 0 }
    }
  }
}



