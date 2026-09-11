import fs from 'node:fs'
import path from 'node:path'
import type { AuditEntry, AuditExportResult } from '@shared/types'
import type { AuditService } from './audit'

function csvCell(value: unknown): string {
  return `"${String(value ?? '').replace(/"/g, '""').replace(/\r?\n/g, '\\n')}"`
}

export async function exportAuditLogs(
  audit: AuditService,
  directory: string,
  format: 'csv' | 'json' | 'txt'
): Promise<AuditExportResult> {
  try {
    const entries = audit.listAll()
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    const outputPath = path.join(directory, `branchpulse-audit-${stamp}.${format}`)
    fs.mkdirSync(directory, { recursive: true })

    if (format === 'json') {
      await fs.promises.writeFile(outputPath, JSON.stringify(entries, null, 2), 'utf8')
    } else if (format === 'txt') {
      await fs.promises.writeFile(outputPath, formatTxt(entries), 'utf8')
    } else {
      const header = ['time', 'action', 'result', 'detail']
      const rows = entries.map((entry) => [entry.at, entry.action, entry.result, JSON.stringify(entry.detail)])
      const content = [header, ...rows].map((row) => row.map(csvCell).join(',')).join('\n')
      await fs.promises.writeFile(outputPath, content, 'utf8')
    }

    return { ok: true, path: outputPath, count: entries.length }
  } catch (err) {
    return {
      ok: false,
      path: '',
      count: 0,
      error: err instanceof Error ? err.message : String(err)
    }
  }
}

const detailLabels: Record<string, string> = {
  repository: '仓库', repositoryName: '仓库名称', repositoryId: '仓库 ID', url: '仓库地址', path: '本地路径',
  branch: '分支', name: '名称', pattern: '匹配模式', type: '类型', mode: '模式',
  reason: '原因', error: '错误', technical: '技术细节', result: '结果', targetType: '目标类型',
  trigger: '触发方式', branches: '分支总数', stale: '已停更分支', graceExpired: '宽限期已过分支',
  namingInvalid: '命名不规范', deleted: '已删除', notifications: '通知数',
  emailsSent: '已发送邮件', to: '收件人', recipients: '收件人', count: '数量',
  failed: '失败数', errors: '错误列表', id: 'ID', priority: '优先级', enabled: '启用',
  description: '描述', frequency: '频率', format: '格式', period: '报告周期',
  transport: '发送通道', schedule: '计划', run: '巡检记录', report: '报告', sent: '已发送',
  skipped: '已跳过', autoDelete: '自动删除', staleThresholdDays: '未提交阈值数值',
  gracePeriodDays: '宽限期数值', staleThresholdUnit: '未提交阈值单位', gracePeriodUnit: '宽限期单位'
}

function formatDetailValue(value: unknown): string {
  if (value === null || value === undefined) return '—'
  if (typeof value === 'boolean') return value ? '是' : '否'
  if (Array.isArray(value)) return value.map((item) => String(item)).join('、') || '—'
  if (typeof value === 'object') return JSON.stringify(value)
  return String(value)
}

function formatTxt(entries: AuditEntry[]): string {
  const sorted = [...entries].sort((a, b) => a.at.localeCompare(b.at))
  const now = new Date()
  const stamp = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')} ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}:${String(now.getSeconds()).padStart(2, '0')}`
  const divider = '='.repeat(64)
  const separator = '-'.repeat(64)
  const lines: string[] = [
    'BranchPulse 审计日志导出',
    `导出时间：${stamp}`,
    `总条数：${sorted.length}`,
    divider
  ]
  for (const [index, entry] of sorted.entries()) {
    const time = new Date(entry.at)
    const timeLabel = `${time.getFullYear()}-${String(time.getMonth() + 1).padStart(2, '0')}-${String(time.getDate()).padStart(2, '0')} ${String(time.getHours()).padStart(2, '0')}:${String(time.getMinutes()).padStart(2, '0')}:${String(time.getSeconds()).padStart(2, '0')}`
    lines.push(
      `#${String(index + 1).padStart(4, '0')}`,
      `时间：${timeLabel}`,
      `动作：${entry.action}`,
      `结果：${entry.result === 'success' ? '成功' : '失败'}`
    )
    const detailKeys = Object.keys(entry.detail ?? {})
    if (detailKeys.length === 0) {
      lines.push('详情：无')
    } else {
      lines.push('详情：')
      for (const key of detailKeys) {
        lines.push(`  ${detailLabels[key] ?? key}：${formatDetailValue((entry.detail as Record<string, unknown>)[key])}`)
      }
    }
    lines.push(separator)
  }
  return lines.join('\r\n') + '\r\n'
}
