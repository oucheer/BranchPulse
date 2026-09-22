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
  const selectedRepositoryIds = useAppStore((s) => s.selectedRepositoryIds)
  const repositories = useAppStore((s) => s.repositories)
  const emailGroups = useAppStore((s) => s.emailGroups)
  const emailConfig = useAppStore((s) => s.emailConfig)
  const [draft, setDraft] = useState(monitoring)
  const [saving, setSaving] = useState(false)
  const suppressDraftSync = useRef(false)
  // 监控配置按仓库独立保存：这里只允许在勾选范围内切换目标仓库。
  const scopedRepositories = repositories.filter((repository) => selectedRepositoryIds.includes(repository.id))
  const [activeRepositoryId, setActiveRepositoryId] = useState<string | null>(scopedRepositories[0]?.id ?? null)
  const effectiveRepositoryId = scopedRepositories.some((repository) => repository.id === activeRepositoryId)
    ? activeRepositoryId
    : scopedRepositories[0]?.id ?? null

  useEffect(() => {
    if (effectiveRepositoryId === activeRepositoryId) return
    setActiveRepositoryId(effectiveRepositoryId)
  }, [effectiveRepositoryId, activeRepositoryId])

  useEffect(() => {
    let cancelled = false
    if (!effectiveRepositoryId) {
      setDraft(monitoring)
      return
    }
    void window.gitmanager.getMonitoring(effectiveRepositoryId).then((config) => {
      if (!cancelled) setDraft(config)
    })
    return () => {
      cancelled = true
    }
  }, [effectiveRepositoryId])

  useEffect(() => {
    if (suppressDraftSync.current) return
    if (!effectiveRepositoryId) setDraft(monitoring)
  }, [monitoring, effectiveRepositoryId])

  const emailDisabled = !emailConfig?.enabled
  const noSelection = selectedRepositoryIds.length === 0

  const save = async (): Promise<void> => {
    if (!effectiveRepositoryId) {
      toast('未选择仓库：请先勾选仓库', 'warn')
      return
    }
    setSaving(true)
    try {
      await window.gitmanager.saveMonitoring(draft, effectiveRepositoryId)
      toast(tr('saved'), 'success')
      void refresh()
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), 'error')
    } finally {
      setSaving(false)
    }
  }

  const toggleMonitoring = async (enabled: boolean): Promise<void> => {
    if (!effectiveRepositoryId) {
      toast('未选择仓库：请先勾选仓库', 'warn')
      return
    }
    try {
      await window.gitmanager.saveMonitoring({ ...monitoring, enabled }, effectiveRepositoryId)
      toast(enabled ? '监控已开启' : '监控已关闭', 'success')
      void refresh()
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), 'error')
      void refresh()
    }
  }

  const runCheck = async (): Promise<void> => {
    if (noSelection) {
      toast('未选择仓库：请先勾选仓库', 'warn')
      return
    }
    setScanning(true)
    suppressDraftSync.current = true
    try {
      if (effectiveRepositoryId) await window.gitmanager.saveMonitoring(draft, effectiveRepositoryId)
      const run = await window.gitmanager.runCheckNow({
        bypassEnabledCheck: true,
        notifyTarget: draft.notificationEnabled ? draft.notifyTarget : 'none',
        emailPolicy: draft.notificationEnabled ? draft.emailPolicy : 'none',
        trigger: 'manual',
        repositoryIds: selectedRepositoryIds
      })
      if (run.error) {
        toast(`检查未完全成功：${run.error}`, run.branches > 0 ? 'warn' : 'error')
      } else {
        toast(`Check complete: ${run.branches} branches, ${run.notifications} notifications`, 'success')
      }
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

  const activeRepository = scopedRepositories.find((r) => r.id === effectiveRepositoryId)
  const isRemoteOnly = activeRepository ? activeRepository.source !== 'local' : scopedRepositories.length > 0 && scopedRepositories.every((r) => r.source !== 'local')
  const selectedSet = new Set(selectedRepositoryIds)
  const lastRuns = (noSelection ? [] : scanRuns.filter((run) => (run.repositoryIds ?? []).some((id) => selectedSet.has(id)))).slice(0, 5)

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="flex items-center gap-3 text-lg font-bold text-canvas-fg">
          {tr('monitoring')}
          {effectiveRepositoryId ? (
            <span className="ml-2 text-sm font-medium text-muted">
              仓库独立配置：{activeRepository?.name ?? '已删除仓库'}
            </span>
          ) : (
            <span className="ml-2 text-sm font-medium text-muted">未选择仓库</span>
          )}
          <Badge tone={monitoring.enabled ? 'ok' : 'warn'}>
            {monitoring.enabled ? '已开启' : '已关闭'}
          </Badge>
        </h1>
        <div className="flex items-center gap-3">
          <span className="text-sm text-muted">{monitoring.enabled ? '监控开启中' : '监控已关闭'}</span>
          <Toggle checked={monitoring.enabled} label="监控开关" disabled={saving || !effectiveRepositoryId} onChange={(v) => void toggleMonitoring(v)} />
        </div>
      </div>

      {noSelection ? (
        <div className="rounded-md border border-warn/40 bg-warn/10 px-4 py-2 text-xs text-warn">
          未选择仓库：请先在仓库页或顶栏勾选仓库。监控、命名规则、白名单与保护规则都按仓库隔离，未选择时无法编辑。
        </div>
      ) : scopedRepositories.length > 1 ? (
        <div className="rounded-md border border-line bg-surface/60 px-4 py-2 text-xs text-muted">
          <div className="mb-2">监控检查会按每个仓库自己的配置逐仓执行；下面的设置只作用于当前选中的仓库。</div>
          <select
            className="input w-72"
            value={effectiveRepositoryId ?? ''}
            onChange={(e) => setActiveRepositoryId(e.target.value)}
          >
            {scopedRepositories.map((repo) => <option key={repo.id} value={repo.id}>{repo.name}</option>)}
          </select>
        </div>
      ) : null}

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-3">
        <Card className="p-5">
          <div className="mb-4 flex items-center gap-2 text-sm font-semibold text-canvas-fg">
            <Timer size={15} className="text-warn" /> 巡查规则
            {activeRepository ? <span className="text-xs font-normal text-muted">· {activeRepository.name}</span> : null}
          </div>
          <div className="space-y-4">
            <div className="rounded-md bg-surface-elevated p-3 text-xs text-muted">
              巡查会实时读取远程仓库平台上的分支列表和最近提交：超过未提交时间阈值的分支标记为已停更，符合清理条件时进入清理候选，并按下面的通知方式提醒你或分支创始人。
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
            <button className="btn btn-primary w-full justify-center" disabled={saving || scanning || noSelection} onClick={() => void save()}>
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
            <button className="btn btn-primary w-full justify-center" disabled={scanning || noSelection} onClick={() => void runCheck()}>
              <Play size={14} /> {tr('triggerCheckNotify')}
            </button>
          </div>
          <div className="mt-4 flex items-center gap-2 text-xs text-muted">
            <Badge tone={monitoring.notificationEnabled ? 'ok' : 'warn'}>
              {monitoring.notificationEnabled ? tr('notificationsOn') : tr('notificationsOff')}
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
                    <div className="text-xs text-muted">{run.branches} 个分支 · {run.stale} 个已停更 · {run.namingInvalid} 个命名不规范</div>
                    {run.error ? <div className="mt-0.5 text-xs text-danger">{run.error}</div> : null}
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
