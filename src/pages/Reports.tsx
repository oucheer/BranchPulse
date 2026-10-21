import { useEffect, useRef, useState } from 'react'
import { CalendarClock, Download, FileBarChart, FolderOpen, Plus, Send, Trash2 } from 'lucide-react'
import { useAppStore, tr } from '../stores/appStore'
import { Badge, Card, EmptyState, Modal, Toggle } from '../components/ui'
import RecipientPicker from '../components/RecipientPicker'
import { resolveRecipientDisplay } from '../lib/recipients'
import { timeAgo } from '../lib/format'
import { downloadReportFile } from '../lib/download'
import { repositoryScopeLabel } from '../lib/scope'
import { reportViewPath } from '@shared/rpc'
import type { ReportScheduleFrequency } from '@shared/types'

const formats = ['html', 'csv']
const frequencies: ReportScheduleFrequency[] = ['daily', 'weekly', 'monthly', 'once']

const frequencyHint = (frequency: ReportScheduleFrequency): string =>
  frequency === 'daily'
    ? '按天巡检和汇总，适合每天观察新增已停更分支。'
    : frequency === 'weekly'
      ? '按周聚合趋势，适合复盘一周清理效果。'
      : frequency === 'monthly'
        ? '按月汇总长期变化，适合月度治理回顾。'
        : '只在指定时间生成一次。'

const emptySchedule = () => ({
  name: '每日分支报告',
  frequency: 'daily' as ReportScheduleFrequency,
  time: '09:00',
  weekday: 1,
  dayOfMonth: 1,
  runAt: '',
  recipients: '',
  groupIds: [] as string[]
})

export default function Reports(): JSX.Element {
  const repositories = useAppStore((s) => s.repositories)
  const allReports = useAppStore((s) => s.reports)
  const reportSchedules = useAppStore((s) => s.reportSchedules)
  const selectedRepositoryIds = useAppStore((s) => s.selectedRepositoryIds)
  const toast = useAppStore((s) => s.toast)
  const refresh = useAppStore((s) => s.refresh)
  const emailGroups = useAppStore((s) => s.emailGroups)
  const emailConfig = useAppStore((s) => s.emailConfig)
  const [format, setFormat] = useState('html')
  const [generating, setGenerating] = useState(false)
  const [bulkRecipients, setBulkRecipients] = useState('self')
  const [sendingAll, setSendingAll] = useState(false)
  const [manualSendRunning, setManualSendRunning] = useState(false)
  const manualSendSeenRef = useRef<string | null>(null)
  const [reportMode, setReportMode] = useState<'send' | 'schedule'>('send')
  const [reportDirectory, setReportDirectory] = useState<string | null>(null)
  const [draft, setDraft] = useState(emptySchedule())
  const emailDisabled = !emailConfig?.enabled
  const noSelection = selectedRepositoryIds.length === 0

  useEffect(() => {
    let cancelled = false
    let timer: number | undefined
    let nextDelay = 5000
    const poll = async (): Promise<void> => {
      try {
        const state = await window.gitmanager.getManualSendReportState()
        if (cancelled) return
        setManualSendRunning(state.running)
        nextDelay = state.running ? 3000 : 5000
        if (state.finishedAt && state.finishedAt !== manualSendSeenRef.current && state.lastResult) {
          manualSendSeenRef.current = state.finishedAt
          const result = state.lastResult
          const recipientText = result.recipients?.length ? `：${result.recipients.join(', ')}` : ''
          if (result.ok) {
            toast(`勾选仓库汇总已发送${recipientText}`, 'success')
          } else {
            toast(`${result.message}${result.technical ? `：${result.technical}` : ''}`, 'error')
          }
          void refresh()
        }
      } catch {
        // 后端短暂不可用时不中断轮询，下一轮再恢复。
      } finally {
        if (!cancelled) timer = window.setTimeout(() => void poll(), nextDelay)
      }
    }
    void poll()
    return () => {
      cancelled = true
      if (timer) window.clearTimeout(timer)
    }
  }, [refresh, toast])

  const reports = selectedRepositoryIds.length
    ? allReports.filter((report) => report.repositoryIds.some((id) => selectedRepositoryIds.includes(id)))
    : allReports

  const generate = async (): Promise<void> => {
    if (noSelection) {
      toast('未选择仓库：请先在仓库页勾选要汇总的仓库。', 'warn')
      return
    }
    setGenerating(true)
    try {
      const report = await window.gitmanager.generateReport('manual', format, undefined, selectedRepositoryIds)
      toast(`报告已生成：${report.title} · ${report.path}`, 'success')
      void refresh()
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), 'error')
    } finally {
      setGenerating(false)
    }
  }

  const sendSelectedRepositories = async (): Promise<void> => {
    if (sendingAll || noSelection) return
    setSendingAll(true)
    try {
      const result = await window.gitmanager.sendSelectedRepositoriesReport(
        'manual',
        bulkRecipients,
        selectedRepositoryIds
      )
      const recipientText = result.recipients?.length ? `：${result.recipients.join(', ')}` : ''
      manualSendSeenRef.current = new Date().toISOString()
      if (result.ok) {
        toast(`勾选仓库汇总已发送${recipientText}`, 'success')
      } else {
        toast(`${result.message}${result.technical ? `：${result.technical}` : ''}`, 'error')
      }
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), 'error')
    } finally {
      setSendingAll(false)
      void refresh()
    }
  }

  const exportReport = async (id: string, fmt: string): Promise<void> => {
    try {
      await window.gitmanager.exportReport(id, fmt)
      toast(`已导出为 ${fmt.toUpperCase()}`, 'success')
      void refresh()
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), 'error')
    }
  }

  const deleteReport = async (id: string): Promise<void> => {
    try {
      await window.gitmanager.deleteReport(id)
      toast('报告已删除', 'success')
      void refresh()
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), 'error')
    }
  }

  const saveSchedule = async (): Promise<void> => {
    try {
      await window.gitmanager.saveReportSchedule({
        ...draft,
        repositoryIds: selectedRepositoryIds,
        enabled: true,
        runAt: draft.frequency === 'once' && draft.runAt ? new Date(draft.runAt).toISOString() : null
      })
      toast('定时报告已保存', 'success')
      setDraft(emptySchedule())
      void refresh()
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), 'error')
    }
  }

  const deleteSchedule = async (id: string): Promise<void> => {
    try {
      await window.gitmanager.deleteReportSchedule(id)
      toast('定时任务已删除', 'success')
      void refresh()
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), 'error')
    }
  }

  const toggleSchedule = async (id: string, enabled: boolean): Promise<void> => {
    const schedule = reportSchedules.find((s) => s.id === id)
    if (!schedule) return
    try {
      await window.gitmanager.saveReportSchedule({ ...schedule, enabled })
      void refresh()
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), 'error')
    }
  }

  const openFolder = async (): Promise<void> => {
    try {
      const response = await fetch('/api/health')
      if (!response.ok) throw new Error(`无法读取报告目录（HTTP ${response.status}）。`)
      const body = await response.json() as { reportsDir?: unknown }
      const directory = typeof body.reportsDir === 'string' ? body.reportsDir.trim() : ''
      if (!directory) throw new Error('后端没有返回报告目录。')
      setReportDirectory(directory)
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), 'error')
    }
  }

  const openReportFile = async (id: string, reportFormat: string): Promise<void> => {
    try {
      if (reportFormat === 'html') {
        const preview = window.open(reportViewPath(id), '_blank')
        if (!preview) {
          toast('浏览器阻止了报告预览窗口，请允许本站打开新窗口后重试。', 'warn')
          return
        }
        preview.opener = null
        return
      }
      await downloadReportFile(id)
      toast('CSV 报告已下载，请使用本地表格软件打开。', 'success')
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), 'error')
    }
  }

  const downloadReport = async (id: string): Promise<void> => {
    try {
      await downloadReportFile(id)
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), 'error')
    }
  }

  const frequencyLabel = (frequency: ReportScheduleFrequency): string =>
    frequency === 'daily' ? '每日' : frequency === 'weekly' ? '每周' : frequency === 'monthly' ? '每月' : '指定时间'

  const groupScopeLabel = (groupIds: string[]): string => {
    const names = groupIds
      .map((id) => emailGroups.find((group) => group.id === id)?.name)
      .filter((name): name is string => Boolean(name))
    return names.length > 0 ? names.join('、') : '分组已删除'
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-lg font-bold text-canvas-fg">{tr('reports')}</h1>
          <div className="text-xs text-muted">{reports.length} 份报告</div>
        </div>
        <button className="btn" title="查看服务器报告目录" onClick={() => void openFolder()}>
          <FolderOpen size={14} /> 报告目录
        </button>
      </div>

      <Card className="p-4">
        <div className="mb-3 text-sm font-semibold text-canvas-fg">立即生成</div>
        <div className="flex flex-wrap items-end gap-3">
          <div>
            <div className="label mb-1.5">格式</div>
            <select className="input w-32" value={format} onChange={(e) => setFormat(e.target.value)}>
              {formats.map((f) => <option key={f} value={f}>{f.toUpperCase()}</option>)}
            </select>
          </div>
          <button
            className="btn btn-primary"
            disabled={generating || noSelection}
            title={noSelection ? '未选择仓库' : undefined}
            onClick={() => void generate()}
          >
            <Plus size={14} /> {tr('generate')}
          </button>
          <div className="text-xs text-muted">
            {noSelection
              ? '未选择仓库：请先在仓库页勾选要汇总的仓库。'
              : `报告按仓库分区汇总当前勾选的 ${selectedRepositoryIds.length} 个仓库。`}
          </div>
        </div>
      </Card>

      <Card className="p-4">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <div className="text-sm font-semibold text-canvas-fg">报告邮件</div>
          <div className="inline-flex rounded-md border border-line p-0.5" role="tablist" aria-label="报告邮件模式">
            <button type="button" role="tab" aria-selected={reportMode === 'send'} className={`flex items-center gap-1.5 rounded px-3 py-1.5 text-sm ${reportMode === 'send' ? 'bg-primary/10 text-primary' : 'text-muted hover:text-canvas-fg'}`} onClick={() => setReportMode('send')}>
              <Send size={13} /> 立即发送
            </button>
            <button type="button" role="tab" aria-selected={reportMode === 'schedule'} className={`flex items-center gap-1.5 rounded px-3 py-1.5 text-sm ${reportMode === 'schedule' ? 'bg-primary/10 text-primary' : 'text-muted hover:text-canvas-fg'}`} onClick={() => setReportMode('schedule')}>
              <CalendarClock size={14} /> 定时发送
            </button>
          </div>
        </div>
        {reportMode === 'send' ? <>
          <div className="mb-3 text-xs text-muted">
            对当前勾选的仓库生成一份按仓库分区的分支汇总，并通过邮件一次发送；仓库较多时无需逐个发送。
            勾选「通知分支创始人」后，范围内需要处理分支的创始人会加入同一封邮件的收件人，而不是逐人逐封发送。
          </div>
          <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-end">
            <RecipientPicker
              value={bulkRecipients}
              onChange={setBulkRecipients}
              groups={emailGroups}
              selfEmail={emailConfig?.selfEmail ?? ''}
              disabled={emailDisabled}
              allowSelf
              allowCreator
              creatorHint="勾选后把范围内需要处理分支的创始人加入同一封汇总邮件的收件人，不会逐人逐封发送"
              label="勾选仓库汇总收件人"
              manualPlaceholder="不填写时默认发送到我的个人邮箱"
              rows={3}
            />
            <button
              className="btn btn-primary h-fit"
              disabled={sendingAll || manualSendRunning || emailDisabled || noSelection}
              title={noSelection ? '未选择仓库' : emailDisabled ? '邮件发送未启用' : undefined}
              onClick={() => void sendSelectedRepositories()}
            >
              <Send size={14} /> {sendingAll || manualSendRunning ? '发送中...' : '发送勾选仓库汇总'}
            </button>
          </div>
          {emailDisabled ? <div className="mt-2 text-xs text-warn">邮件发送未启用，请先在设置中配置邮箱。</div> : null}
          {noSelection ? <div className="mt-2 text-xs text-warn">未选择仓库：请先在仓库页勾选要汇总的仓库。</div> : null}
        </> : <>
          <div className="grid gap-3 lg:grid-cols-4">
            <div>
              <div className="label mb-1.5">任务名称</div>
              <input className="input" value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
            </div>
            <div>
              <div className="label mb-1.5">频率</div>
              <select className="input" value={draft.frequency} onChange={(e) => setDraft({ ...draft, frequency: e.target.value as ReportScheduleFrequency })}>
                {frequencies.map((f) => <option key={f} value={f}>{frequencyLabel(f)}</option>)}
              </select>
            </div>
            <div>
              <div className="label mb-1.5">{draft.frequency === 'once' ? '执行时间' : '每日时间'}</div>
              <input
                className="input"
                type={draft.frequency === 'once' ? 'datetime-local' : 'time'}
                value={draft.frequency === 'once' ? draft.runAt : draft.time}
                onChange={(e) => setDraft(draft.frequency === 'once' ? { ...draft, runAt: e.target.value } : { ...draft, time: e.target.value })}
              />
            </div>
            <div className="lg:col-span-4">
              <RecipientPicker
                value={draft.recipients}
                onChange={(value) => setDraft({ ...draft, recipients: value })}
                groups={emailGroups}
                selfEmail={emailConfig?.selfEmail ?? ''}
                disabled={emailDisabled}
                allowSelf
                allowCreator
                creatorHint="定时报告同样只发一封：创始人加入收件人，不会逐人逐封发送"
                manualPlaceholder="多个邮箱或分支组用逗号、分号或换行分隔"
                rows={5}
              />
            </div>
          </div>
          {draft.frequency === 'weekly' ? (
            <div className="mt-3 max-w-xs">
              <div className="label mb-1.5">星期几</div>
              <select className="input" value={draft.weekday} onChange={(e) => setDraft({ ...draft, weekday: Number(e.target.value) })}>
                {['周日', '周一', '周二', '周三', '周四', '周五', '周六'].map((label, index) => (
                  <option key={label} value={index}>{label}</option>
                ))}
              </select>
            </div>
          ) : null}
          {draft.frequency === 'monthly' ? (
            <div className="mt-3 max-w-xs">
              <div className="label mb-1.5">每月几号</div>
              <input className="input" type="number" min={1} max={31} value={draft.dayOfMonth} onChange={(e) => setDraft({ ...draft, dayOfMonth: Math.max(1, Math.min(31, Number(e.target.value) || 1)) })} />
            </div>
          ) : null}
          <button className="btn btn-primary mt-4" onClick={() => void saveSchedule()}>
            <Plus size={14} /> 保存定时任务
          </button>
          <div className="mt-2 text-xs text-muted">{frequencyHint(draft.frequency)}</div>
        </>}

        {reportSchedules.length > 0 ? (
          <div className="mt-4 space-y-2">
            {reportSchedules.map((schedule) => (
              <div key={schedule.id} className="flex items-center gap-3 rounded-md border border-line px-3 py-2">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="truncate text-sm font-medium text-canvas-fg">{schedule.name}</span>
                    <Badge tone="info">{frequencyLabel(schedule.frequency)}</Badge>
                  </div>
                  <div className="text-xs text-muted">
                    {schedule.nextRunAt ? `下次：${new Date(schedule.nextRunAt).toLocaleString('zh-CN')}` : '已完成或未启用'}
                    {schedule.groupIds.length > 0 ? ` · 分组范围：${groupScopeLabel(schedule.groupIds)}` : ''}
                    {schedule.recipients
                      ? ` · 发送到 ${resolveRecipientDisplay(schedule.recipients, emailGroups, emailConfig?.selfEmail).join(', ') || schedule.recipients}`
                      : ' · 不发送邮件'}
                  </div>
                </div>
                <Toggle checked={schedule.enabled} onChange={(v) => void toggleSchedule(schedule.id, v)} />
                <button className="btn px-2" onClick={() => void deleteSchedule(schedule.id)}>
                  <Trash2 size={14} className="text-danger" />
                </button>
              </div>
            ))}
          </div>
        ) : null}
      </Card>

      {reports.length === 0 ? (
        <EmptyState title={tr('reportsEmpty')} />
      ) : (
        <div className="space-y-2">
          {reports.map((report) => (
            <Card key={report.id} className="flex items-center gap-3 p-3">
              <div className="flex h-9 w-9 items-center justify-center rounded-md bg-secondary/10 text-secondary">
                <FileBarChart size={16} />
              </div>
              <div className="min-w-0 flex-1">
                <div className="text-sm font-semibold text-canvas-fg">{report.title}</div>
                <div className="mt-0.5 flex items-center gap-2 text-xs text-muted">
                  <span>{report.period}</span>
                  <Badge>{report.format.toUpperCase()}</Badge>
                  <span>·</span>
                  <span>{timeAgo(report.generatedAt)}</span>
                </div>
              </div>
              <div className="hidden text-right text-xs text-muted md:block">
                <div className="font-semibold text-canvas-fg">{report.summary.totalBranches} 个分支</div>
                <div>{report.summary.cleanupCandidates} 个清理候选</div>
              </div>
              <div className="flex items-center gap-1">
                <button className="btn px-2 text-[11px]" onClick={() => void openReportFile(report.id, report.format)}>
                  <FolderOpen size={12} /> 打开
                </button>
                <button className="btn px-2 text-[11px]" onClick={() => void downloadReport(report.id)}>
                  <Download size={12} /> {tr('download')}
                </button>
                {formats.filter((f) => f !== report.format).map((f) => (
                  <button key={f} className="btn px-2 text-[11px]" onClick={() => void exportReport(report.id, f)}>
                    <Download size={12} /> {f.toUpperCase()}
                  </button>
                ))}
                <button className="btn px-2" onClick={() => void deleteReport(report.id)}>
                  <Trash2 size={14} className="text-danger" />
                </button>
              </div>
            </Card>
          ))}
        </div>
      )}

      <Modal
        open={reportDirectory !== null}
        title="服务器报告目录"
        onClose={() => setReportDirectory(null)}
        footer={<button className="btn" onClick={() => setReportDirectory(null)}>关闭</button>}
        width={620}
      >
        <div className="space-y-3 text-sm text-muted">
          <p>报告文件保存在运行 GitManager 的服务器上。浏览器不能直接打开服务器文件夹，请在报告列表中点击“打开”预览 HTML，或点击“下载”保存到本机。</p>
          <code className="block break-all rounded-md border border-line bg-elevated px-3 py-2 text-xs text-canvas-fg">
            {reportDirectory}
          </code>
        </div>
      </Modal>
    </div>
  )
}
