import { useState } from 'react'
import { CalendarClock, Download, FileBarChart, FolderOpen, Plus, Send, Trash2 } from 'lucide-react'
import { useAppStore, tr } from '../stores/appStore'
import { Badge, Card, EmptyState, Toggle } from '../components/ui'
import RecipientPicker from '../components/RecipientPicker'
import { resolveRecipientDisplay } from '../lib/recipients'
import { timeAgo } from '../lib/format'
import { repositoryScopeLabel } from '../lib/scope'
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

/** `repositoryIds: null` 表示「跟随当前全局勾选」，用户手动改动后才固化。 */
const emptySchedule = () => ({
  name: '每日分支报告',
  repositoryIds: null as string[] | null,
  frequency: 'daily' as ReportScheduleFrequency,
  time: '09:00',
  weekday: 1,
  dayOfMonth: 1,
  runAt: '',
  recipients: ''
})

export default function Reports(): JSX.Element {
  const repositories = useAppStore((s) => s.repositories)
  const reports = useAppStore((s) => s.reports)
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
  const [draft, setDraft] = useState(emptySchedule())
  const emailDisabled = !emailConfig?.enabled
  const noSelection = selectedRepositoryIds.length === 0
  // 未手动调整时，定时报告的仓库范围跟随当前全局勾选。
  const draftRepositoryIds = draft.repositoryIds ?? selectedRepositoryIds

  const generate = async (): Promise<void> => {
    if (noSelection) {
      toast('未选择仓库：请先在仓库页勾选要汇总的仓库。', 'warn')
      return
    }
    setGenerating(true)
    try {
      const report = await window.gitmanager.generateReport('manual', format, selectedRepositoryIds)
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
      const result = await window.gitmanager.sendSelectedRepositoriesReport('manual', bulkRecipients, selectedRepositoryIds)
      const recipientText = result.recipients?.length ? `：${result.recipients.join(', ')}` : ''
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
      await window.gitmanager.exportReport(id, fmt, selectedRepositoryIds)
      toast(`已导出为 ${fmt.toUpperCase()}`, 'success')
      void refresh()
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), 'error')
    }
  }

  const deleteReport = async (id: string): Promise<void> => {
    try {
      await window.gitmanager.deleteReport(id, selectedRepositoryIds)
      toast('报告已删除', 'success')
      void refresh()
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), 'error')
    }
  }

  const saveSchedule = async (): Promise<void> => {
    if (draftRepositoryIds.length === 0) {
      toast('未选择仓库：定时报告至少需要勾选一个仓库。', 'warn')
      return
    }
    try {
      await window.gitmanager.saveReportSchedule({
        ...draft,
        // 保存创建/编辑时的仓库快照；之后修改全局勾选不会改变该任务范围。
        repositoryIds: [...draftRepositoryIds],
        enabled: true,
        runAt: draft.frequency === 'once' && draft.runAt ? new Date(draft.runAt).toISOString() : null
      }, selectedRepositoryIds)
      toast('定时报告已保存', 'success')
      setDraft(emptySchedule())
      void refresh()
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), 'error')
    }
  }

  const deleteSchedule = async (id: string): Promise<void> => {
    try {
      await window.gitmanager.deleteReportSchedule(id, selectedRepositoryIds)
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
      await window.gitmanager.saveReportSchedule({ ...schedule, enabled }, selectedRepositoryIds)
      void refresh()
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), 'error')
    }
  }

  const openFolder = async (): Promise<void> => {
    try {
      await window.gitmanager.openReportFolder()
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), 'error')
    }
  }

  const openReportFile = async (id: string): Promise<void> => {
    try {
      await window.gitmanager.openReportFile(id, selectedRepositoryIds)
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), 'error')
    }
  }

  const frequencyLabel = (frequency: ReportScheduleFrequency): string =>
    frequency === 'daily' ? '每日' : frequency === 'weekly' ? '每周' : frequency === 'monthly' ? '每月' : '指定时间'

  const repositoryNames = (ids: string[]): string => {
    return repositoryScopeLabel(ids, repositories)
  }

  const selectedSet = new Set(selectedRepositoryIds)
  /** 定时报告的仓库范围完全落在当前勾选内时才能修改。 */
  const isScheduleEditable = (repositoryIds: string[]): boolean =>
    repositoryIds.length > 0 && repositoryIds.every((id) => selectedSet.has(id))

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-lg font-bold text-canvas-fg">{tr('reports')}</h1>
          <div className="text-xs text-muted">{reports.length} 份报告</div>
        </div>
        <button className="btn" onClick={() => void openFolder()}>
          <FolderOpen size={14} /> {tr('openFolder')}
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
        <div className="mb-1 text-sm font-semibold text-canvas-fg">发送勾选仓库汇总</div>
        <div className="mb-3 text-xs text-muted">
          对当前勾选的仓库生成一份按仓库分区的分支汇总，并通过邮件一次发送；仓库较多时无需逐个发送。
        </div>
        <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-end">
          <RecipientPicker
            value={bulkRecipients}
            onChange={(value) => setBulkRecipients(value)}
            groups={emailGroups}
            selfEmail={emailConfig?.selfEmail ?? ''}
            disabled={emailDisabled}
            allowSelf
            label="勾选仓库汇总收件人"
            manualPlaceholder="不填写时默认发送到我的个人邮箱"
            rows={3}
          />
          <button
            className="btn btn-primary h-fit"
            disabled={sendingAll || emailDisabled || noSelection}
            title={noSelection ? '未选择仓库' : emailDisabled ? '邮件发送未启用' : undefined}
            onClick={() => void sendSelectedRepositories()}
          >
            <Send size={14} /> {sendingAll ? '发送中...' : '发送勾选仓库汇总'}
          </button>
        </div>
        {emailDisabled ? <div className="mt-2 text-xs text-warn">邮件发送未启用，请先在设置中配置邮箱。</div> : null}
        {noSelection ? <div className="mt-2 text-xs text-warn">未选择仓库：请先在仓库页勾选要汇总的仓库。</div> : null}
      </Card>

      <Card className="p-4">
        <div className="mb-3 flex items-center gap-2 text-sm font-semibold text-canvas-fg">
          <CalendarClock size={15} className="text-primary" /> 定时发送报告
        </div>
        <div className="mb-3 rounded-md border border-line bg-surface/60 p-3 text-xs leading-relaxed text-muted">
          新建定时报告时默认采用当前勾选的仓库（{noSelection ? '当前未选择仓库' : repositoryNames(selectedRepositoryIds)}），
          并保存为任务快照；之后调整全局勾选不会改变已有任务的范围。
        </div>
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
              manualPlaceholder="多个邮箱或分组用逗号、分号或换行分隔"
              rows={5}
            />
          </div>
          <div className="lg:col-span-4">
            <div className="label mb-1.5">仓库范围（可多选）</div>
            {repositories.length === 0 ? (
              <div className="text-xs text-muted">暂无仓库，请先在仓库页添加仓库。</div>
            ) : (
              <div className="max-h-44 space-y-0.5 overflow-y-auto rounded-md border border-line p-2">
                {repositories.map((repo) => {
                  const checked = draftRepositoryIds.includes(repo.id)
                  const locked = draft.repositoryIds !== null && !selectedSet.has(repo.id)
                  return (
                    <label
                      key={repo.id}
                      className={`flex items-center gap-2 rounded-md px-2 py-1.5 text-sm ${locked ? 'cursor-not-allowed text-muted' : 'cursor-pointer text-canvas-fg hover:bg-line/30'}`}
                    >
                      <input
                        type="checkbox"
                        className="h-4 w-4"
                        checked={checked}
                        disabled={locked}
                        onChange={() =>
                          setDraft({
                            ...draft,
                            repositoryIds: checked
                              ? draftRepositoryIds.filter((id) => id !== repo.id)
                              : [...draftRepositoryIds, repo.id]
                          })
                        }
                      />
                      <span className="truncate">{repo.name}</span>
                    </label>
                  )
                })}
              </div>
            )}
            <div className="mt-1 text-xs text-muted">
              {draftRepositoryIds.length === 0
                ? '未选择仓库：该定时报告不会生成或发送。'
                : `将汇总：${repositoryScopeLabel(draftRepositoryIds, repositories)}`}
            </div>
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
        <button
          className="btn btn-primary mt-4"
          disabled={draftRepositoryIds.length === 0}
          title={draftRepositoryIds.length === 0 ? '未选择仓库：定时报告至少需要勾选一个仓库' : undefined}
          onClick={() => void saveSchedule()}
        >
          <Plus size={14} /> 保存定时任务
        </button>
        <div className="mt-2 text-xs text-muted">{frequencyHint(draft.frequency)}</div>

        {reportSchedules.length > 0 ? (
          <div className="mt-4 space-y-2">
            {reportSchedules.map((schedule) => {
              const editable = isScheduleEditable(schedule.repositoryIds)
              return (
                <div key={schedule.id} className="flex items-center gap-3 rounded-md border border-line px-3 py-2">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="truncate text-sm font-medium text-canvas-fg">{schedule.name}</span>
                      <Badge tone="info">{frequencyLabel(schedule.frequency)}</Badge>
                      {editable ? null : <Badge tone="warn">部分选中（只读）</Badge>}
                    </div>
                    <div className="text-xs text-muted">
                      {`范围：${repositoryNames(schedule.repositoryIds)}`}
                      {schedule.nextRunAt ? ` · 下次：${new Date(schedule.nextRunAt).toLocaleString('zh-CN')}` : ' · 已完成或未启用'}
                      {schedule.recipients
                        ? ` · 发送到 ${resolveRecipientDisplay(schedule.recipients, emailGroups, emailConfig?.selfEmail).join(', ') || schedule.recipients}`
                        : ' · 不发送邮件'}
                    </div>
                  </div>
                  <Toggle
                    checked={schedule.enabled}
                    disabled={!editable}
                    onChange={(v) => void toggleSchedule(schedule.id, v)}
                  />
                  <button
                    className="btn px-2"
                    disabled={!editable}
                    title={editable ? undefined : '该定时报告包含未勾选仓库，当前范围为只读'}
                    onClick={() => void deleteSchedule(schedule.id)}
                  >
                    <Trash2 size={14} className="text-danger" />
                  </button>
                </div>
              )
            })}
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
                  <span className="truncate">{repositoryNames(report.repositoryIds)}</span>
                  <span>·</span>
                  <span>{timeAgo(report.generatedAt)}</span>
                </div>
              </div>
              <div className="hidden text-right text-xs text-muted md:block">
                <div className="font-semibold text-canvas-fg">{report.summary.totalBranches} 个分支</div>
                <div>{report.summary.cleanupCandidates} 个清理候选</div>
              </div>
              <div className="flex items-center gap-1">
                <button className="btn px-2 text-[11px]" onClick={() => void openReportFile(report.id)}>
                  <FolderOpen size={12} /> 打开
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
    </div>
  )
}
