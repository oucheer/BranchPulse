import { useState } from 'react'
import { CalendarClock, Play, Plus, Trash2 } from 'lucide-react'
import { useAppStore, tr } from '../stores/appStore'
import { Badge, Card, EmptyState, Modal, Toggle } from '../components/ui'
import { timeAgo } from '../lib/format'
import type { SchedulerJob, NotifyTarget } from '@shared/types'

const weekDays = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
function notifyLabel(target: string): string {
  if (target === 'both') return '通知自己和分支创始人'
  if (target === 'creator') return '通知分支创始人'
  if (target === 'self') return '通知自己'
  if (target === 'none') return '不通知'
  return `通知 ${target}`
}

function parseNotifyDraft(target: string | null): { self: boolean; creator: boolean; recipients: string } {
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

function applyNotifyDraft(self: boolean, creator: boolean, recipients: string): NotifyTarget {
  const parts: string[] = []
  if (self) parts.push('self')
  if (creator) parts.push('creator')
  for (const token of recipients.split(/[,;\s]+/).map((t) => t.trim()).filter(Boolean)) {
    if (token !== 'self' && token !== 'creator' && token !== 'none' && !parts.includes(token)) parts.push(token)
  }
  return (parts.join(', ') || 'none') as NotifyTarget
}

const emptyJob = (repositoryId: string | null): Omit<SchedulerJob, 'id' | 'createdAt' | 'lastRunAt' | 'nextRunAt'> => ({
  repositoryId,
  name: '',
  kind: 'interval',
  enabled: true,
  intervalHours: 24,
  daysOfWeek: [1, 2, 3, 4, 5],
  time: '09:00',
  startDate: null,
  endDate: null,
  emailPolicy: 'none',

  fetchEnabled: true,
  autoDeleteEnabled: false,
  notifyTarget: 'self'
})

export default function Scheduler(): JSX.Element {
  const jobs = useAppStore((s) => s.jobs)
  const calendarRuns = useAppStore((s) => s.calendarRuns)
  const repositories = useAppStore((s) => s.repositories)
  const scanRuns = useAppStore((s) => s.scanRuns)
  const activeRepositoryId = useAppStore((s) => s.activeRepositoryId)
  const settings = useAppStore((s) => s.settings)
  const emailGroups = useAppStore((s) => s.emailGroups)
  const toast = useAppStore((s) => s.toast)
  const refresh = useAppStore((s) => s.refresh)
  const [editJob, setEditJob] = useState<Partial<SchedulerJob> & { id?: string } | null>(null)
  const [tab, setTab] = useState<'schedule' | 'history' | 'calendar'>('schedule')
  const parsedNotify = parseNotifyDraft(editJob?.notifyTarget ?? null)
  const notifySelf = parsedNotify.self
  const notifyCreator = parsedNotify.creator
  const customRecipients = parsedNotify.recipients

  const visibleJobs = activeRepositoryId ? jobs.filter((job) => job.repositoryId === activeRepositoryId || job.repositoryId === null) : jobs

  const visibleRuns = activeRepositoryId ? scanRuns.filter((run) => run.repositories <= 1) : scanRuns

  const save = async (job: Partial<SchedulerJob> & { id?: string }): Promise<void> => {
    try {
      await window.branchpulse.saveJob(job)
      toast(tr('saved'), 'success')
      setEditJob(null)
      void refresh()
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), 'error')
    }
  }

  const remove = async (id: string): Promise<void> => {
    try {
      await window.branchpulse.deleteJob(id)
      toast('Job deleted', 'success')
      void refresh()
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), 'error')
    }
  }

  const run = async (id: string): Promise<void> => {
    try {
      const runResult = await window.branchpulse.runSchedulerJob(id)
      toast(`Check complete: ${runResult.branches} branches`, 'success')
      void refresh()
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), 'error')
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-bold text-canvas-fg">{tr('scheduler')}</h1>
        <button className="btn btn-primary" onClick={() => setEditJob({ ...emptyJob(activeRepositoryId) })}>
          <Plus size={15} /> {tr('schedule')}
        </button>
      </div>

      <div className="flex gap-1 rounded-card border border-line bg-surface p-1">
        {(['schedule', 'history', 'calendar'] as const).map((t) => (
          <button
            key={t}
            className={`flex-1 rounded-md px-4 py-2 text-sm font-medium transition-colors ${tab === t ? 'bg-primary/10 text-primary' : 'text-muted hover:text-canvas-fg'}`}
            onClick={() => setTab(t)}
          >
            {tr(t)}
          </button>
        ))}
      </div>

      {tab === 'schedule' ? (
        visibleJobs.length === 0 ? (
          <EmptyState title="暂无定时任务" />
        ) : (
          <div className="space-y-2">
            {visibleJobs.map((job) => (
              <Card key={job.id} className="flex items-center gap-3 p-3">
                <div className="flex h-9 w-9 items-center justify-center rounded-md bg-primary/10 text-primary">
                  <CalendarClock size={16} />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-semibold text-canvas-fg">{job.name}</span>
                    <Badge tone={job.kind === 'interval' ? 'secondary' : 'info'}>{job.kind}</Badge>
                    <Toggle checked={job.enabled} onChange={async (v) => { await save({ ...job, enabled: v }) }} />
                  </div>
                  <div className="mt-0.5 flex items-center gap-2 text-xs text-muted">
                    {job.kind === 'interval' ? (
                      <span>每 {job.intervalHours} 小时</span>
                    ) : (
                      <span>{job.time} · {job.daysOfWeek.map((d) => weekDays[d]).join(', ')}</span>
                    )}
                    {job.nextRunAt ? <span>· 下次：{new Date(job.nextRunAt).toLocaleString()}</span> : null}
                    <span>· {job.autoDeleteEnabled ? tr('checkAndDelete') : tr('inspectionOnly')}</span>
                    <span>· {notifyLabel(job.notifyTarget)}</span>
                  </div>
                </div>
                <div className="flex items-center gap-1">
                  <button className="btn px-2" onClick={() => void run(job.id)}><Play size={13} /></button>
                  <button className="btn px-2" onClick={() => setEditJob({ ...job })}>编辑</button>
                  <button className="btn px-2" onClick={() => void remove(job.id)}><Trash2 size={13} className="text-danger" /></button>
                </div>
              </Card>
            ))}
          </div>
        )
      ) : tab === 'history' ? (
        <div className="overflow-x-auto rounded-card border border-line">
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="border-b border-line text-xs uppercase tracking-normal text-muted">
                <th className="px-4 py-3 font-medium">{tr('time')}</th>
                <th className="px-4 py-3 font-medium">触发方式</th>
                <th className="px-4 py-3 font-medium">状态</th>
                <th className="px-4 py-3 font-medium">分支数</th>
                <th className="px-4 py-3 font-medium">已停更</th>
                <th className="px-4 py-3 font-medium">命名异常</th>
                <th className="px-4 py-3 font-medium">通知</th>
              </tr>
            </thead>
            <tbody>
              {visibleRuns.slice(0, 50).map((run) => (
                <tr key={run.id} className="border-b border-line/50 last:border-0 hover:bg-surface/50">
                  <td className="px-4 py-3 text-canvas-fg">{new Date(run.startedAt).toLocaleString()}</td>
                  <td className="px-4 py-3"><Badge>{run.trigger}</Badge></td>
                  <td className="px-4 py-3">
                    <Badge tone={run.status === 'completed' ? 'ok' : run.status === 'failed' ? 'danger' : 'warn'}>{run.status}</Badge>
                  </td>
                  <td className="px-4 py-3">{run.branches}</td>
                  <td className="px-4 py-3">{run.stale}</td>
                  <td className="px-4 py-3">{run.namingInvalid}</td>
                  <td className="px-4 py-3">{run.notifications}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="grid grid-cols-7 gap-1">
          {weekDays.map((d) => (
            <div key={d} className="text-center text-xs font-medium uppercase tracking-normal text-muted py-1">{d}</div>
          ))}
          {Array.from({ length: new Date(new Date().getFullYear(), new Date().getMonth(), 1).getDay() }).map((_, i) => (
            <div key={`empty-${i}`} />
          ))}
          {Array.from({ length: new Date(new Date().getFullYear(), new Date().getMonth() + 1, 0).getDate() }).map((_, i) => {
            const day = i + 1
            const dateStr = `${new Date().getFullYear()}-${String(new Date().getMonth() + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`
            const run = calendarRuns.find((r) => r.date === dateStr)
            return (
              <div key={day} className={`aspect-square rounded-md border border-line p-1 text-xs ${run ? 'bg-primary/5 border-primary/30' : ''}`}>
                <div className={`font-medium ${run ? 'text-primary' : 'text-muted'}`}>{day}</div>
                {run ? <div className="text-[10px] text-muted">{run.runs} run{run.runs > 1 ? 's' : ''}</div> : null}
              </div>
            )
          })}
        </div>
      )}

      <Modal
        open={editJob !== null}
        title={editJob?.id ? '编辑定时任务' : '新建定时任务'}
        onClose={() => setEditJob(null)}
        footer={
          <div className="flex gap-2">
            <button className="btn" onClick={() => setEditJob(null)}>{tr('cancel')}</button>
            <button className="btn btn-primary" onClick={() => editJob && void save(editJob)}>{tr('save')}</button>
          </div>
        }
      >
        <div className="space-y-4">
          <div>
            <div className="label mb-1">仓库范围</div>
            <select
              className="input"
              value={editJob?.repositoryId ?? ''}
              onChange={(e) => setEditJob({ ...editJob, repositoryId: e.target.value || null })}
            >
              <option value="">全部仓库</option>
              {repositories.map((repo) => (
                <option key={repo.id} value={repo.id}>{repo.name}</option>
              ))}
            </select>
          </div>
          <div>
            <div className="label mb-1">{tr('name')}</div>
            <input className="input" value={editJob?.name ?? ''} onChange={(e) => setEditJob({ ...editJob, name: e.target.value })} />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <div className="label mb-1">{tr('scheduleKind')}</div>
              <select className="input" value={editJob?.kind ?? 'interval'} onChange={(e) => setEditJob({ ...editJob, kind: e.target.value as 'interval' | 'calendar' })}>
                <option value="interval">{tr('interval')}</option>
                <option value="calendar">{tr('calendar')}</option>
              </select>
            </div>
            {editJob?.kind === 'interval' ? (
              <div>
                <div className="label mb-1">{tr('intervalHours')}</div>
                <input type="number" min={1} className="input" value={editJob?.intervalHours ?? 24} onChange={(e) => setEditJob({ ...editJob, intervalHours: Math.max(1, Number(e.target.value) || 1) })} />
              </div>
            ) : null}
          </div>
          {editJob?.kind === 'calendar' ? (
            <>
              <div>
                <div className="label mb-1">{tr('time')}</div>
                <input type="time" className="input" value={editJob?.time ?? '09:00'} onChange={(e) => setEditJob({ ...editJob, time: e.target.value })} />
              </div>
              <div>
                <div className="label mb-1">{tr('daysOfWeek')}</div>
                <div className="flex flex-wrap gap-1">
                  {weekDays.map((d, i) => {
                    const days = editJob?.daysOfWeek ?? []
                    const selected = days.includes(i)
                    return (
                      <button
                        key={d}
                        className={`rounded-md px-2.5 py-1 text-xs font-medium transition-colors ${selected ? 'bg-primary/10 text-primary' : 'bg-line/20 text-muted hover:text-canvas-fg'}`}
                        onClick={() => {
                          const newDays = selected ? days.filter((v) => v !== i) : [...days, i]
                          setEditJob({ ...editJob, daysOfWeek: newDays })
                        }}
                      >{d}</button>
                    )
                  })}
                </div>
              </div>
            </>
          ) : null}
          <div className="flex items-center justify-between">
            <span className="text-sm text-canvas-fg">{tr('fetchEnabled')}</span>
            <Toggle checked={editJob?.fetchEnabled ?? true} onChange={(v) => setEditJob({ ...editJob, fetchEnabled: v })} />
          </div>
          <div className="flex items-center justify-between">
            <div>
              <div className="text-sm text-canvas-fg">{tr('autoDeleteEnabled')}</div>
              <div className="text-xs text-muted">
                {settings.deletionDisabled ? '全局禁止删除分支已开启，自动删除被禁用。' : tr('autoDeleteHint')}
              </div>
            </div>
            <Toggle
              checked={settings.deletionDisabled ? false : editJob?.autoDeleteEnabled ?? false}
              disabled={settings.deletionDisabled}
              onChange={(v) => setEditJob({ ...editJob, autoDeleteEnabled: v })}
            />
          </div>
          <div>
            <div className="label mb-1">收件人</div>
            <input
              className="input"
              type="email"
              placeholder="you@example.com 或分组名"
              value={customRecipients}
              onChange={(e) => setEditJob({ ...editJob, notifyTarget: applyNotifyDraft(notifySelf, notifyCreator, e.target.value) })}
            />
            <div className="mt-2 flex items-center gap-2">
              <select
                className="input max-w-[12rem]"
                value=""
                onChange={(e) => {
                  if (!e.target.value) return
                  const next = customRecipients ? `${customRecipients}, ${e.target.value}` : e.target.value
                  setEditJob({ ...editJob, notifyTarget: applyNotifyDraft(notifySelf, notifyCreator, next) })
                }}
              >
                <option value="">选择邮箱分组</option>
                {emailGroups.map((group) => (
                  <option key={group.id} value={group.name}>{group.name}</option>
                ))}
              </select>
            </div>
            {(() => {
              const tokens = customRecipients.split(/[,;\s]+/).map((t) => t.trim().toLowerCase()).filter(Boolean)
              const seen = new Set<string>()
              const out: string[] = []
              for (const token of tokens) {
                const group = emailGroups.find((g) => g.name.trim().toLowerCase() === token)
                if (group) {
                  for (const r of group.recipients.split(/[,;\s]+/).map((x) => x.trim()).filter(Boolean)) {
                    if (!seen.has(r.toLowerCase())) { seen.add(r.toLowerCase()); out.push(r) }
                  }
                }
              }
              return out.length > 0 ? (
                <div className="mt-2 rounded-md border border-line bg-surface/60 px-3 py-2">
                  <div className="text-xs font-medium text-muted">分组收件人（只读）</div>
                  <div className="mt-1 break-all text-xs text-canvas-fg">{out.join(', ')}</div>
                </div>
              ) : null
            })()}
            <div className="mt-2 space-y-2">
              <div className="flex items-center justify-between rounded-md border border-line px-3 py-2">
                <span className="text-sm text-canvas-fg">通知自己</span>
                <Toggle checked={notifySelf} onChange={(v) => setEditJob({ ...editJob, notifyTarget: applyNotifyDraft(v, notifyCreator, customRecipients) })} />
              </div>
              <div className="flex items-center justify-between rounded-md border border-line px-3 py-2">
                <span className="text-sm text-canvas-fg">通知分支创始人</span>
                <Toggle checked={notifyCreator} onChange={(v) => setEditJob({ ...editJob, notifyTarget: applyNotifyDraft(notifySelf, v, customRecipients) })} />
              </div>
            </div>
            <p className="mt-1 text-xs text-muted">支持填写邮箱或全局邮箱分组，多个用逗号分隔；勾选“通知自己”发送到设置中的个人邮箱，可同时生效。</p>
          </div>
        </div>
      </Modal>
    </div>
  )
}
