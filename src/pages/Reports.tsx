import { useState } from 'react'
import { CalendarClock, Download, FileBarChart, FolderOpen, Plus, Trash2 } from 'lucide-react'
import { useAppStore, tr } from '../stores/appStore'
import { Badge, Card, EmptyState, Toggle } from '../components/ui'
import { timeAgo } from '../lib/format'
import type { ReportScheduleFrequency } from '@shared/types'

const formats = ['html', 'csv', 'json', 'pdf', 'png']
const frequencies: ReportScheduleFrequency[] = ['daily', 'weekly', 'monthly', 'once']

const emptySchedule = () => ({
  name: '每日分支报告',
  frequency: 'daily' as ReportScheduleFrequency,
  time: '09:00',
  weekday: 1,
  dayOfMonth: 1,
  runAt: '',
  recipients: ''
})

export default function Reports(): JSX.Element {
  const allReports = useAppStore((s) => s.reports)
  const reportSchedules = useAppStore((s) => s.reportSchedules)
  const activeRepositoryId = useAppStore((s) => s.activeRepositoryId)
  const toast = useAppStore((s) => s.toast)
  const refresh = useAppStore((s) => s.refresh)
  const [format, setFormat] = useState('html')
  const [generating, setGenerating] = useState(false)
  const [draft, setDraft] = useState(emptySchedule())

  const reports = activeRepositoryId
    ? allReports.filter((report) => report.repositoryId === activeRepositoryId)
    : allReports

  const generate = async (): Promise<void> => {
    setGenerating(true)
    try {
      const report = await window.branchpulse.generateReport('manual', format, activeRepositoryId)
      toast(`报告已生成：${report.title}`, 'success')
      void refresh()
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), 'error')
    } finally {
      setGenerating(false)
    }
  }

  const exportReport = async (id: string, fmt: string): Promise<void> => {
    try {
      await window.branchpulse.exportReport(id, fmt)
      toast(`已导出为 ${fmt.toUpperCase()}`, 'success')
      void refresh()
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), 'error')
    }
  }

  const deleteReport = async (id: string): Promise<void> => {
    try {
      await window.branchpulse.deleteReport(id)
      toast('报告已删除', 'success')
      void refresh()
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), 'error')
    }
  }

  const saveSchedule = async (): Promise<void> => {
    try {
      await window.branchpulse.saveReportSchedule({
        ...draft,
        repositoryId: activeRepositoryId,
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
      await window.branchpulse.deleteReportSchedule(id)
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
      await window.branchpulse.saveReportSchedule({ ...schedule, enabled })
      void refresh()
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), 'error')
    }
  }

  const openFolder = async (): Promise<void> => {
    try {
      await window.branchpulse.openReportFolder()
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), 'error')
    }
  }

  const frequencyLabel = (frequency: ReportScheduleFrequency): string =>
    frequency === 'daily' ? '每日' : frequency === 'weekly' ? '每周' : frequency === 'monthly' ? '每月' : '指定时间'

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
          <button className="btn btn-primary" disabled={generating} onClick={() => void generate()}>
            <Plus size={14} /> {tr('generate')}
          </button>
          <div className="text-xs text-muted">立即生成的报告使用当前选中的仓库范围。</div>
        </div>
      </Card>

      <Card className="p-4">
        <div className="mb-3 flex items-center gap-2 text-sm font-semibold text-canvas-fg">
          <CalendarClock size={15} className="text-primary" /> 定时发送报告
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
          <div>
            <div className="label mb-1.5">收件邮箱</div>
            <input
              className="input"
              placeholder="多个邮箱用逗号分隔"
              value={draft.recipients}
              onChange={(e) => setDraft({ ...draft, recipients: e.target.value })}
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
                    {schedule.recipients ? ` · 发送到 ${schedule.recipients}` : ' · 不发送邮件'}
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
