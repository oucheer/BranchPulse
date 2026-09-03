import { useEffect, useState } from 'react'
import { Activity, Bell, Play, Scale, Timer, Trash2 } from 'lucide-react'
import { useAppStore, tr } from '../stores/appStore'
import { Badge, Card, Toggle } from '../components/ui'
import type { NotifyTarget } from '@shared/types'

export default function Monitoring(): JSX.Element {
  const monitoring = useAppStore((s) => s.monitoring)
  const toast = useAppStore((s) => s.toast)
  const refresh = useAppStore((s) => s.refresh)
  const setScanning = useAppStore((s) => s.setScanning)
  const scanning = useAppStore((s) => s.scanning)
  const scanRuns = useAppStore((s) => s.scanRuns)
  const [draft, setDraft] = useState(monitoring)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    setDraft(monitoring)
  }, [monitoring])

  const save = async (): Promise<void> => {
    setSaving(true)
    try {
      await window.branchpulse.saveMonitoring(draft)
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

  const lastRuns = scanRuns.slice(0, 5)

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-bold text-canvas-fg">{tr('monitoring')}</h1>
        <button className="btn btn-primary" disabled={saving || scanning} onClick={() => void save()}>
          <Activity size={15} /> {tr('save')}
        </button>
      </div>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-3">
        <Card className="p-5">
          <div className="mb-4 flex items-center gap-2 text-sm font-semibold text-canvas-fg">
            <Timer size={15} className="text-warn" /> Lifecycle thresholds
          </div>
          <div className="space-y-4">
            <div>
              <div className="label mb-1.5">Stale threshold (days)</div>
              <input
                type="number"
                min={1}
                max={365}
                className="input"
                value={draft.staleThresholdDays}
                onChange={(e) => setDraft({ ...draft, staleThresholdDays: Math.max(1, Number(e.target.value) || 1) })}
              />
            </div>
            <div>
              <div className="label mb-1.5">Grace period (days)</div>
              <input
                type="number"
                min={0}
                max={365}
                className="input"
                value={draft.gracePeriodDays}
                onChange={(e) => setDraft({ ...draft, gracePeriodDays: Math.max(0, Number(e.target.value) || 0) })}
              />
            </div>
            <div className="flex items-center justify-between">
              <div>
                <div className="text-sm text-canvas-fg">{tr('fetchEnabled')}</div>
                <div className="text-xs text-muted">Run git fetch before analysis</div>
              </div>
              <Toggle checked={draft.fetchEnabled} onChange={(v) => setDraft({ ...draft, fetchEnabled: v })} />
            </div>
            <div className="flex items-center justify-between">
              <div>
                <div className="flex items-center gap-1.5 text-sm text-canvas-fg"><Scale size={13} /> {tr('naming')}</div>
                <div className="text-xs text-muted">Validate branch naming on each check</div>
              </div>
              <Toggle checked={draft.namingEnabled} onChange={(v) => setDraft({ ...draft, namingEnabled: v })} />
            </div>
            <div className="flex items-center justify-between">
              <div>
                <div className="flex items-center gap-1.5 text-sm text-canvas-fg"><Bell size={13} /> {tr('notificationsEnabled')}</div>
                <div className="text-xs text-muted">Create desktop notifications</div>
              </div>
              <Toggle checked={draft.notificationEnabled} onChange={(v) => setDraft({ ...draft, notificationEnabled: v })} />
            </div>
            <div>
              <div className="label mb-1.5">{tr('notifyTarget')}</div>
              <select
                className="input"
                value={draft.notifyTarget}
                onChange={(e) => setDraft({ ...draft, notifyTarget: e.target.value as NotifyTarget })}
              >
                <option value="none">{tr('noNotify')}</option>
                <option value="self">{tr('notifySelf')}</option>
                <option value="creator">{tr('notifyCreators')}</option>
                <option value="both">{tr('notifyBoth')}</option>
              </select>
            </div>
            <div className="flex items-center justify-between">
              <div>
                <div className="text-sm text-canvas-fg">{tr('autoDeleteEnabled')}</div>
                <div className="text-xs text-muted">{tr('autoDeleteHint')}</div>
              </div>
              <Toggle checked={draft.autoDeleteEnabled} onChange={(v) => setDraft({ ...draft, autoDeleteEnabled: v })} />
            </div>
          </div>
        </Card>

        <Card className="p-5">
          <div className="mb-4 flex items-center gap-2 text-sm font-semibold text-canvas-fg">
            <Play size={15} className="text-primary" /> {tr('runCheckNow')}
          </div>
          <p className="mb-4 text-sm text-muted">{tr('runCheckDescription')}</p>
          <div className="space-y-2">
            <button className="btn w-full justify-center" disabled={scanning} onClick={() => void runCheck(false)}>
              <Play size={14} /> {tr('inspectionOnly')}
            </button>
            <button className="btn w-full justify-center" disabled={scanning} onClick={() => void runCheck(true)}>
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
            <Activity size={15} className="text-secondary" /> Recent checks
          </div>
          <div className="space-y-2">
            {lastRuns.length === 0 ? (
              <div className="py-6 text-center text-sm text-muted">No checks yet</div>
            ) : (
              lastRuns.map((run) => (
                <div key={run.id} className="flex items-center justify-between rounded-md border border-line px-3 py-2 text-sm">
                  <div>
                    <div className="text-canvas-fg">{new Date(run.startedAt).toLocaleString()}</div>
                    <div className="text-xs text-muted">{run.branches} branches · {run.stale} stale · {run.namingInvalid} invalid</div>
                  </div>
                  <Badge tone={run.status === 'completed' ? 'ok' : run.status === 'failed' ? 'danger' : 'warn'}>{run.status}</Badge>
                </div>
              ))
            )}
          </div>
        </Card>
      </div>
    </div>
  )
}
