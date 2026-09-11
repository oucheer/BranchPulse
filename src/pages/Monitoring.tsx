import { useEffect, useRef, useState } from 'react'
import { Activity, Bell, Mail, Play, Save, Scale, Timer } from 'lucide-react'
import { useAppStore, tr } from '../stores/appStore'
import { Badge, Card, Toggle } from '../components/ui'
import RecipientPicker from '../components/RecipientPicker'
import type { MonitoringConfig, NotifyTarget } from '@shared/types'

type ThresholdUnit = MonitoringConfig['staleThresholdUnit']

const maxByUnit: Record<ThresholdUnit, number> = {
  weeks: 52,
  days: 365,
  hours: 8760,
  minutes: 525600
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
  const emailGroups = useAppStore((s) => s.emailGroups)
  const emailConfig = useAppStore((s) => s.emailConfig)
  const [draft, setDraft] = useState(monitoring)
  const [saving, setSaving] = useState(false)
  const suppressDraftSync = useRef(false)

  useEffect(() => {
    if (suppressDraftSync.current) return
    setDraft(monitoring)
  }, [monitoring])

  const emailDisabled = !emailConfig?.enabled

  const save = async (): Promise<void> => {
    setSaving(true)
    try {
      await window.branchpulse.saveMonitoring({ ...draft, autoDeleteEnabled: false }, activeRepositoryId)
      toast(tr('saved'), 'success')
      void refresh()
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), 'error')
    } finally {
      setSaving(false)
    }
  }

  const toggleMonitoring = async (enabled: boolean): Promise<void> => {
    try {
      await window.branchpulse.saveMonitoring({ ...monitoring, enabled }, activeRepositoryId)
      toast(enabled ? '监控已开启' : '监控已关闭', 'success')
      void refresh()
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), 'error')
      void refresh()
    }
  }

  const runCheck = async (): Promise<void> => {
    setScanning(true)
    suppressDraftSync.current = true
    try {
      await window.branchpulse.saveMonitoring({ ...draft, autoDeleteEnabled: false }, activeRepositoryId)
      const run = await window.branchpulse.runCheckNow({
        bypassEnabledCheck: true,
        notifyTarget: draft.notificationEnabled ? draft.notifyTarget : 'none',
        emailPolicy: draft.notificationEnabled ? draft.emailPolicy : 'none',
        autoDelete: false,
        trigger: 'manual',
        ...(activeRepositoryId ? { repositoryIds: [activeRepositoryId] } : {})
      })
      toast(`Check complete: ${run.branches} branches, ${run.notifications} notifications`, 'success')
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), 'error')
    } finally {
      setScanning(false)
      try {
        await refresh()
      } finally {
        suppressDraftSync.current = false
      }
    }
  }

  const activeRepository = repositories.find((r) => r.id === activeRepositoryId)
  const isRemoteOnly = activeRepository ? activeRepository.source !== 'local' : repositories.length > 0 && repositories.every((r) => r.source !== 'local')
  const lastRuns = (activeRepositoryId ? scanRuns.filter((run) => run.repositoryIds?.includes(activeRepositoryId)) : scanRuns).slice(0, 5)

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="flex items-center gap-3 text-lg font-bold text-canvas-fg">
          {tr('monitoring')}
          {activeRepositoryId ? <span className="ml-2 text-sm font-medium text-muted">当前仓库配置</span> : <span className="ml-2 text-sm font-medium text-muted">全局默认配置</span>}
          <Badge tone={monitoring.enabled ? 'ok' : 'warn'}>
            {monitoring.enabled ? '已开启' : '已关闭'}
          </Badge>
        </h1>
        <div className="flex items-center gap-3">
          <span className="text-sm text-muted">{monitoring.enabled ? '监控开启中' : '监控已关闭'}</span>
          <Toggle checked={monitoring.enabled} label="监控开关" disabled={saving} onChange={(v) => void toggleMonitoring(v)} />
        </div>
      </div>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-3">
        <Card className="p-5">
          <div className="mb-4 flex items-center gap-2 text-sm font-semibold text-canvas-fg">
            <Timer size={15} className="text-warn" /> 巡查规则
          </div>
          <div className="space-y-4">
            <div className="rounded-md bg-surface-elevated p-3 text-xs text-muted">
              巡查会实时读取远程仓库平台上的分支列表和最近提交：超过未提交时间阈值的分支先进入宽限期内，宽限期已过后标记为可清理候选，并按下面的通知方式提醒你或分支创建人。
            </div>
            <div className="grid grid-cols-[1fr_5.5rem] gap-2">
              <div>
                <div className="label mb-1.5">未提交阈值</div>
                <input
                  type="number"
                  min={1}
                  max={maxByUnit[draft.staleThresholdUnit]}
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
                  onChange={(e) => setDraft({ ...draft, staleThresholdUnit: e.target.value as ThresholdUnit })}
                >
                  <option value="weeks">周</option>
                  <option value="days">天</option>
                  <option value="hours">小时</option>
                  <option value="minutes">分钟</option>
                </select>
              </div>
            </div>
            <div className="grid grid-cols-[1fr_5.5rem] gap-2">
              <div>
                <div className="label mb-1.5">提醒宽限期</div>
                <input
                  type="number"
                  min={0}
                  max={maxByUnit[draft.gracePeriodUnit]}
                  className="input"
                  value={draft.gracePeriodDays}
                  onChange={(e) => setDraft({ ...draft, gracePeriodDays: Math.max(0, Number(e.target.value) || 0) })}
                />
              </div>
              <div>
                <div className="label mb-1.5">单位</div>
                <select
                  className="input"
                  value={draft.gracePeriodUnit}
                  onChange={(e) => setDraft({ ...draft, gracePeriodUnit: e.target.value as ThresholdUnit })}
                >
                  <option value="weeks">周</option>
                  <option value="days">天</option>
                  <option value="hours">小时</option>
                  <option value="minutes">分钟</option>
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
              <Toggle checked={draft.notificationEnabled} disabled={emailDisabled} onChange={(v) => setDraft({ ...draft, notificationEnabled: v })} />
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
            <RecipientPicker
              value={draft.notifyTarget}
              onChange={(value: NotifyTarget) => setDraft({ ...draft, notifyTarget: value })}
              groups={emailGroups}
              selfEmail={emailConfig?.selfEmail ?? ''}
              disabled={emailDisabled || !draft.notificationEnabled}
              allowSelf
              allowCreator
            />
            <p className="text-xs text-muted">
              {emailDisabled || !draft.notificationEnabled ? tr('checkOnlyNoEmail') : tr('notifyTarget')}
            </p>
            <button className="btn btn-primary w-full justify-center" disabled={scanning} onClick={() => void runCheck()}>
              <Play size={14} /> {tr('triggerCheckNotify')}
            </button>
          </div>
          <div className="mt-4 flex items-center gap-2 text-xs text-muted">
            <Badge tone={monitoring.notificationEnabled ? 'ok' : 'warn'}>
              {monitoring.notificationEnabled ? 'notifications on' : 'notifications off'}
            </Badge>
            <Badge tone="secondary">{tr('inspectionOnly')}</Badge>
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
                    <div className="text-xs text-muted">{run.branches} 个分支 · {run.stale} 个已停更 · {run.namingInvalid} 个命名不规范</div>
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
