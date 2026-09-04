import { ScrollText } from 'lucide-react'
import { useAppStore, tr } from '../stores/appStore'
import { Badge, Card, EmptyState } from '../components/ui'
import { timeAgo } from '../lib/format'

export default function Audit(): JSX.Element {
  const audit = useAppStore((s) => s.audit)
  const language = useAppStore((s) => s.language)
  const activeRepositoryId = useAppStore((s) => s.activeRepositoryId)
  const repositories = useAppStore((s) => s.repositories)

  const repoNames = new Map(repositories.map((r) => [r.id, r.name]))
  const visibleAudit = activeRepositoryId
    ? audit.filter((entry) => {
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
      scheduler_job_added: '添加计划任务',
      scheduler_job_updated: '更新计划任务',
      scheduler_job_removed: '删除计划任务',
      scheduler_job_run: '执行计划任务',
      email_sent: '发送邮件',
      email_summary_sent: '发送汇总邮件',
      email_creator_sent: '发送创建人邮件',
      email_test_sent: '发送测试邮件',
      email_connection_test: '测试邮件连接'
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
      reason ? `说明：${reason}` : ''
    ]
    return parts.filter(Boolean).join(' · ') || '应用操作已完成'
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-lg font-bold text-canvas-fg">{tr('auditLog')}</h1>
          <div className="text-xs text-muted">{visibleAudit.length} {tr('entries') ?? 'entries'}</div>
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
