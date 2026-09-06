import { useEffect, useState } from 'react'
import { Activity, Bell, Mail, Play, Save, Scale, Timer, Trash2, UserRound } from 'lucide-react'
import { useAppStore, tr } from '../stores/appStore'
import { Badge, Card, Toggle } from '../components/ui'
import type { NotifyTarget } from '@shared/types'

function notifyTargetValue(target: string | null): string {
  return target && target !== 'self' && target !== 'none' && target !== 'creator' && target !== 'both' ? target : ''
}

export default function Monitoring(): JSX.Element {
  const monitoring = useAppStore((s) => s.monitoring)
  const toast = useAppStore((s) => s.toast)
  const refresh = useAppStore((s) => s.refresh)
  const setScanning = useAppStore((s) => s.setScanning)
  const scanning = useAppStore((s) => s.scanning)
  const scanRuns = useAppStore((s) => s.scanRuns)
  const activeRepositoryId = useAppStore((s) => s.activeRepositoryId)
  const repositories = useAppStore((s) => s.repositories)
  const settings = useAppStore((s) => s.settings)
  const emailGroups = useAppStore((s) => s.emailGroups)
  const [draft, setDraft] = useState(monitoring)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    setDraft(monitoring)
  }, [monitoring])

  const notifySelf = draft.notifyTarget === 'self' || draft.notifyTarget === 'both' || (typeof draft.notifyTarget === 'string' && draft.notifyTarget.includes('@'))
  const notifyCreator = draft.notifyTarget === 'creator' || draft.notifyTarget === 'both'

  const applyNotify = (self: boolean, creator: boolean, email: string): NotifyTarget => {
    if (self && creator) return 'both'
    if (creator) return 'creator'
    if (self && email.includes('@')) return email as NotifyTarget
    if (self) return 'self'
    return 'none'
  }

  const save = async (): Promise<void> => {
    setSaving(true)
    try {
      await window.branchpulse.saveMonitoring(draft, activeRepositoryId)
      toast(tr('saved'), 'success')
      void refresh()
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), 'error')
    } finally {
      setSaving(false)
    }
  }

  const runCheck = async (autoDelete: boolean): Promise<void> => {
    setScanning(true)
    try {
      const run = await window.branchpulse.runCheckNow({ notifyTarget: draft.notifyTarget, autoDelete, trigger: 'manual' })
      toast(`Check complete: ${run.branches} branches, ${run.notifications} notifications`, 'success')
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), 'error')
    } finally {
      setScanning(false)
      void refresh()
    }
  }

  const activeRepository = repositories.find((r) => r.id === activeRepositoryId)
  const isRemoteOnly = activeRepository ? activeRepository.source !== 'local' : repositories.length > 0 && repositories.every((r) => r.source !== 'local')
  const lastRuns = (activeRepositoryId ? scanRuns.filter((run) => run.repositories <= 1) : scanRuns).slice(0, 5)

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-bold text-canvas-fg">
          {tr('monitoring')}
          {activeRepositoryId ? <span className="ml-2 text-sm font-medium text-muted">当前仓库配置</span> : <span className="ml-2 text-sm font-medium text-muted">全局默认配置</span>}
        </h1>
        <button className="btn btn-primary" disabled={saving || scanning} onClick={() => void save()}>
          <Activity size={15} /> {tr('save')}
        </button>
      </div>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-3">
        <Card className="p-5">
          <div className="mb-4 flex items-center gap-2 text-sm font-semibold text-canvas-fg">
            <Timer size={15} className="text-warn" /> 巡查规则
          </div>
          <div className="space-y-4">
            <div className="rounded-md bg-surface-elevated p-3 text-xs text-muted">
              巡查会实时读取远程仓库平台上的分支列表和最近提交：超过未提交时间阈值的分支先进入提醒宽限期，宽限期结束后标记为可清理候选，并按下面的通知方式提醒你或分支创建人。
            </div>
            <div className="grid grid-cols-[1fr_5.5rem] gap-2">
              <div>
                <div className="label mb-1.5">未提交阈值</div>
                <input
                  type="number"
                  min={1}
                  max={draft.staleThresholdUnit === 'hours' ? 8760 : 365}
                  className="input"
                  value={draft.staleThresholdDays}
                  onChange={(e) => setDraft({ ...draft, staleThresholdDays: Math.max(1, Number(e.target.value) || 1) })}
                />
              </div>
              <div>
                <div className="label mb-1.5">单位</div>
                <select
                  className="input"
                  value={draft.staleThresholdUnit}
                  onChange={(e) => setDraft({ ...draft, staleThresholdUnit: e.target.value as 'hours' | 'days', gracePeriodUnit: e.target.value as 'hours' | 'days' })}
                >
                  <option value="days">天</option>
                  <option value="hours">小时</option>
                </select>
              </div>
            </div>
            <div className="grid grid-cols-[1fr_5.5rem] gap-2">
              <div>
                <div className="label mb-1.5">提醒宽限期</div>
                <input
                  type="number"
                  min={0}
                  max={draft.gracePeriodUnit === 'hours' ? 8760 : 365}
                  className="input"
                  value={draft.gracePeriodDays}
                  onChange={(e) => setDraft({ ...draft, gracePeriodDays: Math.max(0, Number(e.target.value) || 0) })}
                />
              </div>
              <div>
                <div className="label mb-1.5">单位</div>
                <select
                  className="input"
                  value={draft.staleThresholdUnit}
                  onChange={(e) => setDraft({ ...draft, staleThresholdUnit: e.target.value as 'hours' | 'days', gracePeriodUnit: e.target.value as 'hours' | 'days' })}
                >
                  <option value="days">天</option>
                  <option value="hours">小时</option>
                </select>
              </div>
            </div>
            <div className="flex items-center justify-between">
              <div>
                <div className="flex items-center gap-1.5 text-sm text-canvas-fg"><Scale size={13} /> {tr('naming')}</div>
                <div className="text-xs text-muted">每次检查时校验分支命名</div>
              </div>
              <Toggle checked={draft.namingEnabled} onChange={(v) => setDraft({ ...draft, namingEnabled: v })} />
            </div>
            <div className="flex items-center justify-between">
              <div>
                <div className="flex items-center gap-1.5 text-sm text-canvas-fg"><Bell size={13} /> {tr('notificationsEnabled')}</div>
                <div className="text-xs text-muted">生成巡检提醒记录，并按通知方式发送邮件</div>
              </div>
              <Toggle checked={draft.notificationEnabled} onChange={(v) => setDraft({ ...draft, notificationEnabled: v })} />
            </div>
            <div className="flex items-center justify-between">
              <div>
                <div className="text-sm text-canvas-fg">{tr('autoDeleteEnabled')}</div>
                <div className="text-xs text-muted">
                  {settings.deletionDisabled ? '全局禁止删除分支已开启，自动删除被禁用。' : tr('autoDeleteHint')}
                </div>
              </div>
              <Toggle
                checked={settings.deletionDisabled ? false : draft.autoDeleteEnabled}
                disabled={settings.deletionDisabled}
                onChange={(v) => setDraft({ ...draft, autoDeleteEnabled: v })}
              />
            </div>
            <button className="btn btn-primary w-full justify-center" disabled={saving || scanning} onClick={() => void save()}>
              <Save size={14} /> 保存设置并生效
            </button>
          </div>
        </Card>

        <Card className="p-5">
          <div className="mb-4 flex items-center gap-2 text-sm font-semibold text-canvas-fg">
            <Play size={15} className="text-primary" /> {tr('runCheckNow')}
          </div>
          <p className="mb-4 text-sm text-muted">{tr('runCheckDescription')}</p>
          <div className="space-y-3">
            <div>
              <div className="label mb-1.5 flex items-center gap-1.5"><Mail size={13} /> 通知填写收件人</div>
              <input
                className="input"
                type="email"
                placeholder="you@example.com"
                value={typeof draft.notifyTarget === 'string' && draft.notifyTarget.includes('@') ? draft.notifyTarget : ''}
                onChange={(e) => setDraft({ ...draft, notifyTarget: applyNotify(notifySelf, notifyCreator, e.target.value.trim()) })}
              />
              <div className="mt-2 flex items-center gap-2">
                <select
                  className="input max-w-[12rem]"
                  value=""
                  onChange={(e) => {
                    if (!e.target.value) return
                    const current = notifyTargetValue(typeof draft.notifyTarget === 'string' ? draft.notifyTarget : '')
                    const next = current ? `${current}, ${e.target.value}` : e.target.value
                    setDraft({ ...draft, notifyTarget: applyNotify(notifySelf, notifyCreator, next) })
                  }}
                >
                  <option value="">选择邮箱分组</option>
                  {emailGroups.map((group) => (
                    <option key={group.id} value={group.name}>{group.name}</option>
                  ))}
                </select>
              </div>
              <p className="mt-1 text-xs text-muted">可选择全局邮箱分组，巡检汇总将展开发送给组内全部邮箱。</p>
            </div>
            <div className="flex items-center justify-between rounded-md border border-line px-3 py-2">
              <div className="flex items-center gap-2">
                <Bell size={13} className="text-primary" />
                <div className="text-sm text-canvas-fg">通知自己</div>
              </div>
              <Toggle
                checked={notifySelf}
                onChange={(v) => setDraft({ ...draft, notifyTarget: applyNotify(v, notifyCreator, typeof draft.notifyTarget === 'string' && draft.notifyTarget.includes('@') ? draft.notifyTarget : '') })}
              />
            </div>
            <div className="flex items-center justify-between rounded-md border border-line px-3 py-2">
              <div className="flex items-center gap-2">
                <UserRound size={13} className="text-secondary" />
                <div>
                  <div className="text-sm text-canvas-fg">通知分支创始人</div>
                  <div className="text-xs text-muted">勾选后过期的分支将邮件通知对应创始人</div>
                </div>
              </div>
              <Toggle
                checked={notifyCreator}
                onChange={(v) => setDraft({ ...draft, notifyTarget: applyNotify(notifySelf, v, typeof draft.notifyTarget === 'string' && draft.notifyTarget.includes('@') ? draft.notifyTarget : '') })}
              />
            </div>
            <button className="btn w-full justify-center" disabled={scanning} onClick={() => void runCheck(false)}>
              <Play size={14} /> {tr('inspectionOnly')}
            </button>
            <button className="btn w-full justify-center" disabled={scanning || settings.deletionDisabled} onClick={() => void runCheck(true)}>
              <Trash2 size={14} /> {tr('checkAndDelete')}
            </button>
          </div>
          <div className="mt-4 flex items-center gap-2 text-xs text-muted">
            <Badge tone={monitoring.notificationEnabled ? 'ok' : 'warn'}>
              {monitoring.notificationEnabled ? 'notifications on' : 'notifications off'}
            </Badge>
            <Badge tone={monitoring.autoDeleteEnabled ? 'danger' : 'secondary'}>
              {monitoring.autoDeleteEnabled ? tr('checkAndDelete') : tr('inspectionOnly')}
            </Badge>
          </div>
        </Card>

        <Card className="p-5">
          <div className="mb-4 flex items-center gap-2 text-sm font-semibold text-canvas-fg">
            <Activity size={15} className="text-secondary" /> 最近检查
          </div>
          <div className="space-y-2">
            {lastRuns.length === 0 ? (
              <div className="py-6 text-center text-sm text-muted">暂无检查记录</div>
            ) : (
              lastRuns.map((run) => (
                <div key={run.id} className="flex items-center justify-between rounded-md border border-line px-3 py-2 text-sm">
                  <div>
                    <div className="text-canvas-fg">{new Date(run.startedAt).toLocaleString()}</div>
                    <div className="text-xs text-muted">{run.branches} 个分支 · {run.stale} 个已停更 · {run.namingInvalid} 个命名异常</div>
                  </div>
                  <Badge tone={run.status === 'completed' ? 'ok' : run.status === 'failed' ? 'danger' : 'warn'}>
                    {run.status === 'completed' ? '已完成' : run.status === 'failed' ? '失败' : '进行中'}
                  </Badge>
                </div>
              ))
            )}
          </div>
        </Card>
      </div>
    </div>
  )
}