import { useState } from 'react'
import { Bell, Check, Trash2 } from 'lucide-react'
import { useAppStore, tr } from '../stores/appStore'
import { Badge, Card, EmptyState } from '../components/ui'
import { timeAgo } from '../lib/format'

export default function Notifications(): JSX.Element {
  const notifications = useAppStore((s) => s.notifications)
  const toast = useAppStore((s) => s.toast)
  const refresh = useAppStore((s) => s.refresh)
  const activeRepositoryId = useAppStore((s) => s.activeRepositoryId)
  const [filter, setFilter] = useState<'all' | 'unread'>('all')

  const scoped = activeRepositoryId ? notifications.filter((n) => n.repositoryId === activeRepositoryId) : notifications
  const list = (filter === 'unread' ? scoped.filter((n) => !n.read) : scoped).filter((n) => n.type !== 'merged')

  const markRead = async (id: string): Promise<void> => {
    try {
      await window.gitmanager.markNotificationRead(id)
      void refresh()
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), 'error')
    }
  }

  const clearAll = async (): Promise<void> => {
    try {
      await window.gitmanager.clearNotifications()
      toast(tr('clearAll'), 'success')
      void refresh()
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), 'error')
    }
  }

  const notificationTone = (type: string): 'danger' | 'warn' | 'info' | 'default' => {
    if (type === 'naming_violation' || type === 'cleanup_candidate') return 'danger'
    if (type === 'stale') return 'warn'
    return 'default'
  }

  /** 历史通知里可能残留宽限期时代的 type，统一按「已停更」展示。 */
  const notificationLabel = (type: string): string => {
    if (type === 'stale' || type === 'grace_period' || type === 'grace_expired') return '已停更分支'
    if (type === 'naming_violation') return '命名不规范'
    if (type === 'cleanup_candidate') return '清理候选'
    return type
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-lg font-bold text-canvas-fg">{tr('notifications')}</h1>
          <div className="text-xs text-muted">{scoped.filter((n) => !n.read && n.type !== 'merged').length} {tr('unread')}</div>
        </div>
        <div className="flex items-center gap-2">
          <div className="flex gap-1 rounded-card border border-line bg-surface p-0.5">
            <button
              className={`rounded-md px-3 py-1 text-xs font-medium ${filter === 'all' ? 'bg-primary/10 text-primary' : 'text-muted'}`}
              onClick={() => setFilter('all')}
            >{tr('all')}</button>
            <button
              className={`rounded-md px-3 py-1 text-xs font-medium ${filter === 'unread' ? 'bg-primary/10 text-primary' : 'text-muted'}`}
              onClick={() => setFilter('unread')}
            >{tr('unread')}</button>
          </div>
          {scoped.length > 0 ? (
            <button className="btn" onClick={() => void clearAll()}>
              <Trash2 size={14} /> {tr('clearAll')}
            </button>
          ) : null}
        </div>
      </div>

      {list.length === 0 ? (
        <EmptyState title={tr('noNotifications')} />
      ) : (
        <div className="space-y-2">
          {list.map((n) => (
            <Card key={n.id} className={`flex items-start gap-3 p-3 ${!n.read ? 'border-primary/30' : ''}`}>
              <div className={`mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full ${!n.read ? 'bg-primary/10 text-primary' : 'bg-line/30 text-muted'}`}>
                <Bell size={13} />
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <Badge tone={notificationTone(n.type)}>
                    {notificationLabel(n.type)}
                  </Badge>
                  {!n.read ? <span className="h-1.5 w-1.5 rounded-full bg-primary" /> : null}
                </div>
                <div className="mt-1 text-sm text-canvas-fg">{n.message}</div>
                <div className="mt-0.5 flex items-center gap-2 text-xs text-muted">
                  <span>{n.repositoryName}</span>
                  <span>·</span>
                  <span>{timeAgo(n.createdAt)}</span>
                  {n.deliveredToDesktop ? <Badge>desktop</Badge> : null}
                  {n.deliveredViaEmail ? <Badge>email</Badge> : null}
                </div>
              </div>
              {!n.read ? (
                <button className="btn px-2" onClick={() => void markRead(n.id)} title={tr('markRead')}>
                  <Check size={14} />
                </button>
              ) : null}
            </Card>
          ))}
        </div>
      )}
    </div>
  )
}
