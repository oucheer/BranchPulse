import { Download, ScrollText } from 'lucide-react'
import { useAppStore, tr } from '../stores/appStore'
import { Badge, Card, EmptyState } from '../components/ui'
import { useState } from 'react'
import { timeAgo } from '../lib/format'

export default function Audit(): JSX.Element {
  const audit = useAppStore((s) => s.audit)
  const language = useAppStore((s) => s.language)
  const activeRepositoryId = useAppStore((s) => s.activeRepositoryId)
  const repositories = useAppStore((s) => s.repositories)
  const toast = useAppStore((s) => s.toast)
  const refresh = useAppStore((s) => s.refresh)
  const [exporting, setExporting] = useState(false)

  const repoNames = new Map(repositories.map((r) => [r.id, r.name]))
  // Global actions (report schedules, emails, settings) are not repository-scoped and must
  // stay visible even when a repository filter is active.
  const globalActions = new Set([
    'report_schedule_saved', 'report_schedule_deleted', 'report_schedule_run',
    'report_schedule_email_skipped', 'email_report_sent', 'email_sent', 'email_summary_sent',
    'email_summary_skipped', 'email_creator_sent', 'email_test_sent', 'email_connection_test',
    'email_config_updated', 'email_config_save_failed', 'settings_updated', 'settings_save_failed',
    'scheduler_job_ran', 'scheduler_job_failed'
  ])
  const visibleAudit = activeRepositoryId
    ? audit.filter((entry) => {
        if (globalActions.has(entry.action)) return true
        const detail = entry.detail as Record<string, unknown>
        const repository = String(detail.repository ?? detail.repositoryName ?? '')
        return repository === activeRepositoryId || repository === repoNames.get(activeRepositoryId)
      })
    : audit

  const actionLabel = (action: string): string => {
    const zhLabels: Record<string, string> = {
      branch_delete: '删除分支',
      branch_notified: '发送分支提醒',
      repository_added: '添加仓库',
      repository_removed: '移除仓库',
      repository_scanned: '扫描仓库',
      monitoring_check: '执行监控检查',
      monitoring_rules_updated: '更新监控规则',
      settings_updated: '保存设置',
      naming_rule_added: '添加命名规则',
      naming_rule_updated: '更新命名规则',
      naming_rule_removed: '删除命名规则',
      whitelist_added: '添加白名单',
      whitelist_removed: '移除白名单',
      protected_added: '添加保护分支',
      protected_removed: '移除保护分支',
      report_generated: '生成报告',
      report_exported: '导出报告',
      scheduler_job_added: '添加定时任务',
      scheduler_job_updated: '更新定时任务',
      scheduler_job_removed: '删除定时任务',
      scheduler_job_ran: '执行定时任务',
      scheduler_job_failed: '定时任务失败',
      email_sent: '发送邮件',
      email_summary_sent: '发送汇总邮件',
      email_summary_skipped: '汇总邮件未发送',
      email_creator_sent: '发送创建人邮件',
      email_test_sent: '发送测试邮件',
      email_connection_test: '测试邮件连接',
      email_config_updated: '更新邮件配置',
      email_config_save_failed: '保存邮件配置失败',
      settings_save_failed: '保存设置失败',
      notification_marked_read: '标记通知已读',
      notification_mark_read_failed: '标记通知失败',
      notifications_cleared: '清空通知',
      notifications_clear_failed: '清空通知失败',
      check_requested: '触发巡检',
      check_failed: '巡检失败',
      audit_exported: '导出审计日志',
      audit_export_failed: '导出审计日志失败',
      report_schedule_saved: '保存定时报告',
      report_schedule_deleted: '删除定时报告',
      report_schedule_run: '执行定时报告',
      report_schedule_email_skipped: '定时报告未发送',
      email_report_sent: '发送报告邮件'
    }
    return language === 'zh' ? (zhLabels[action] ?? action) : action.replace(/_/g, ' ')
  }

  const summary = (detail: Record<string, unknown>): string => {
    const repository = String(detail.repository ?? detail.repositoryName ?? detail.url ?? '')
    const branch = String(detail.branch ?? detail.name ?? detail.pattern ?? '')
    const reason = String(detail.reason ?? detail.error ?? detail.technical ?? '')
    const parts = [
      repository ? `仓库：${repoNames.get(repository) ?? repository}` : '',
      branch ? `分支：${branch}` : '',
      detail.name ? `名称：${String(detail.name)}` : '',
      detail.to || detail.recipients ? `收件人：${String(detail.to ?? (Array.isArray(detail.recipients) ? (detail.recipients as string[]).join(', ') : detail.recipients))}` : '',
      reason ? `说明：${reason}` : ''
    ]
    return parts.filter(Boolean).join(' · ') || '应用操作已完成'
  }

  const exportLogs = async (format: 'csv' | 'json'): Promise<void> => {
    setExporting(true)
    try {
      const result = await window.branchpulse.exportAuditLogs(format)
      if (!result.ok) {
        toast(result.error || '审计日志导出失败', 'error')
        return
      }
      toast(`已导出 ${result.count} 条审计日志`, 'success')
      void refresh()
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), 'error')
    } finally {
      setExporting(false)
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-lg font-bold text-canvas-fg">{tr('auditLog')}</h1>
          <div className="text-xs text-muted">{visibleAudit.length} {tr('entries') ?? 'entries'}</div>
        </div>
        <div className="flex items-center gap-2">
          <button className="btn" disabled={exporting} onClick={() => void exportLogs('csv')}>
            <Download size={14} /> 导出 CSV
          </button>
          <button className="btn" disabled={exporting} onClick={() => void exportLogs('json')}>
            <Download size={14} /> 导出 JSON
          </button>
        </div>
      </div>

      {visibleAudit.length === 0 ? (
        <EmptyState title={tr('auditEmpty')} />
      ) : (
        <div className="overflow-x-auto rounded-card border border-line">
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="border-b border-line text-xs uppercase tracking-normal text-muted">
                <th className="px-4 py-3 font-medium">{tr('time')}</th>
                <th className="px-4 py-3 font-medium">{tr('action')}</th>
                <th className="px-4 py-3 font-medium">{tr('detail')}</th>
                <th className="px-4 py-3 font-medium">{tr('result')}</th>
              </tr>
            </thead>
            <tbody>
              {visibleAudit.map((entry) => (
                <tr key={entry.id} className="border-b border-line/50 last:border-0 hover:bg-surface/50">
                  <td className="whitespace-nowrap px-4 py-3 text-muted">{new Date(entry.at).toLocaleString()} ({timeAgo(entry.at)})</td>
                  <td className="px-4 py-3 font-medium text-canvas-fg">{actionLabel(entry.action)}</td>
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-1.5">
                      <ScrollText size={12} className="text-muted" />
                      <span className="max-w-xl truncate text-xs text-muted">{summary(entry.detail as Record<string, unknown>)}</span>
                    </div>
                  </td>
                  <td className="px-4 py-3">
                    <Badge tone={entry.result === 'success' ? 'ok' : 'danger'}>
                      {entry.result === 'success' ? '成功' : '失败'}
                    </Badge>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
