import { useEffect, useRef, useState } from 'react'
import { Activity, Bell, Mail, Play, Plus, Save, Scale, Timer, X } from 'lucide-react'
import { useAppStore, tr } from '../stores/appStore'
import { Badge, Card, Toggle } from '../components/ui'
import RecipientPicker from '../components/RecipientPicker'
import GroupScopePicker from '../components/GroupScopePicker'
import type { MonitoringConfig, NotifyTarget, ThresholdRule } from '@shared/types'

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
  const [ruleDraft, setRuleDraft] = useState<ThresholdRule>({ prefix: '', value: 90, unit: 'days' })
  const [scopeGroupIds, setScopeGroupIds] = useState<string[]>([])
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
      await window.gitmanager.saveMonitoring(draft, activeRepositoryId)
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
      await window.gitmanager.saveMonitoring({ ...monitoring, enabled }, activeRepositoryId)
      toast(enabled ? '监控已开启' : '监控已关闭', 'success')
      void refresh()
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), 'error')
      void refresh()
    }
  }

  const rules = draft.thresholdRules ?? []

  const addRule = (): void => {
    const prefix = ruleDraft.prefix.trim()
    if (!prefix) { toast('请填写分支前缀，例如 release/', 'warn'); return }
    if (!Number.isFinite(ruleDraft.value) || ruleDraft.value <= 0) { toast('阈值必须是大于 0 的数值', 'warn'); return }
    const next = rules.filter((rule) => rule.prefix !== prefix)
    next.push({ ...ruleDraft, prefix, value: ruleDraft.value })
    setDraft({ ...draft, thresholdRules: next })
    setRuleDraft({ prefix: '', value: 90, unit: 'days' })
  }

  const removeRule = (prefix: string): void => {
    setDraft({ ...draft, thresholdRules: rules.filter((rule) => rule.prefix !== prefix) })
  }

  const updateRule = (prefix: string, patch: Partial<ThresholdRule>): void => {
    setDraft({
      ...draft,
      thresholdRules: rules.map((rule) => (rule.prefix === prefix ? { ...rule, ...patch } : rule))
    })
  }

  const runCheck = async (): Promise<void> => {
    setScanning(true)
    suppressDraftSync.current = true
    try {
      await window.gitmanager.saveMonitoring(draft, activeRepositoryId)
      const run = await window.gitmanager.runCheckNow({
        bypassEnabledCheck: true,
        notifyTarget: draft.notificationEnabled ? draft.notifyTarget : 'none',
        emailPolicy: draft.notificationEnabled ? draft.emailPolicy : 'none',
        trigger: 'manual',
        ...(activeRepositoryId ? { repositoryIds: [activeRepositoryId] } : {}),
        ...(scopeGroupIds.length > 0 ? { groupIds: scopeGroupIds } : {})
      })
      // A check that reached no repository must not read as a clean run: the
      // reason is the only thing the user can act on.
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
              巡查会实时读取远程仓库平台上的分支列表和最近提交：超过未提交阈值的分支标记为已停更，符合清理条件时进入清理候选，并按下面的通知方式提醒你或分支创始人。
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
            <div className="space-y-2 rounded-md border border-line p-3">
              <div className="flex items-center gap-1.5 text-sm text-canvas-fg"><Timer size={13} className="text-secondary" /> 按前缀覆盖阈值</div>
              <p className="text-xs text-muted">命中前缀的分支使用这里的阈值，未命中任何前缀时使用上面的全局阈值；前缀最长（最具体）的规则优先。</p>
              {rules.length === 0 ? (
                <div className="rounded-md bg-surface-elevated px-3 py-2 text-xs text-muted">暂无前缀规则，所有分支共用全局阈值</div>
              ) : (
                <div className="space-y-2">
                  {[...rules]
                    .sort((a, b) => b.prefix.length - a.prefix.length)
                    .map((rule) => (
                      <div key={rule.prefix} className="grid grid-cols-[1fr_5rem_5.5rem_auto] items-center gap-2">
                        <input className="input font-mono text-xs" value={rule.prefix} readOnly />
                        <input
                          type="number"
                          min={1}
                          max={maxByUnit[rule.unit]}
                          className="input"
                          value={rule.value}
                          onChange={(e) => updateRule(rule.prefix, { value: Math.max(1, Number(e.target.value) || 1) })}
                        />
                        <select
                          className="input"
                          value={rule.unit}
                          onChange={(e) => updateRule(rule.prefix, { unit: e.target.value as ThresholdUnit })}
                        >
                          <option value="weeks">周</option>
                          <option value="days">天</option>
                          <option value="hours">小时</option>
                          <option value="minutes">分钟</option>
                        </select>
                        <button className="btn px-2" onClick={() => removeRule(rule.prefix)} title={`删除 ${rule.prefix} 规则`}>
                          <X size={13} className="text-danger" />
                        </button>
                      </div>
                    ))}
                </div>
              )}
              <div className="grid grid-cols-[1fr_5rem_5.5rem_auto] items-center gap-2">
                <input
                  className="input font-mono text-xs"
                  placeholder="前缀，如 release/"
                  value={ruleDraft.prefix}
                  onChange={(e) => setRuleDraft({ ...ruleDraft, prefix: e.target.value })}
                />
                <input
                  type="number"
                  min={1}
                  max={maxByUnit[ruleDraft.unit]}
                  className="input"
                  value={ruleDraft.value}
                  onChange={(e) => setRuleDraft({ ...ruleDraft, value: Math.max(1, Number(e.target.value) || 1) })}
                />
                <select
                  className="input"
                  value={ruleDraft.unit}
                  onChange={(e) => setRuleDraft({ ...ruleDraft, unit: e.target.value as ThresholdUnit })}
                >
                  <option value="weeks">周</option>
                  <option value="days">天</option>
                  <option value="hours">小时</option>
                  <option value="minutes">分钟</option>
                </select>
                <button className="btn px-2" disabled={!ruleDraft.prefix.trim()} onClick={addRule}>
                  <Plus size={13} />
                </button>
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
            <GroupScopePicker
              value={scopeGroupIds}
              onChange={setScopeGroupIds}
              groups={emailGroups}
              emptyHint="不选则检查当前仓库范围内的全部分支。选组只收窄检查范围，收件人不变；要让组员只收到本组数据，请在上方收件人里同时选该组。"
            />
            <button className="btn btn-primary w-full justify-center" disabled={scanning} onClick={() => void runCheck()}>
              <Play size={14} /> {tr('triggerCheckNotify')}
            </button>
          </div>
          <div className="mt-4 flex items-center gap-2 text-xs text-muted">
            <Badge tone={monitoring.notificationEnabled ? 'ok' : 'warn'}>
              {monitoring.notificationEnabled ? tr('notificationsOn') : tr('notificationsOff')}
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
