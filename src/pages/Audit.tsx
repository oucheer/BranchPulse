import { ScrollText } from 'lucide-react'
import { useAppStore, tr } from '../stores/appStore'
import { Badge, Card, EmptyState } from '../components/ui'
import { timeAgo } from '../lib/format'

export default function Audit(): JSX.Element {
  const audit = useAppStore((s) => s.audit)

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-lg font-bold text-canvas-fg">{tr('auditLog')}</h1>
          <div className="text-xs text-muted">{audit.length} entries</div>
        </div>
      </div>

      {audit.length === 0 ? (
        <EmptyState title={tr('auditEmpty')} />
      ) : (
        <div className="overflow-x-auto rounded-card border border-line">
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="border-b border-line text-xs uppercase tracking-normal text-muted">
                <th className="px-4 py-3 font-medium">{tr('time')}</th>
                <th className="px-4 py-3 font-medium">{tr('action')}</th>
                <th className="px-4 py-3 font-medium">{tr('detail')}</th>
                <th className="px-4 py-3 font-medium">{tr('result')}</th>
              </tr>
            </thead>
            <tbody>
              {audit.map((entry) => (
                <tr key={entry.id} className="border-b border-line/50 last:border-0 hover:bg-surface/50">
                  <td className="whitespace-nowrap px-4 py-3 text-muted">{new Date(entry.at).toLocaleString()} ({timeAgo(entry.at)})</td>
                  <td className="px-4 py-3 font-mono text-xs font-medium text-canvas-fg">{entry.action}</td>
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-1.5">
                      <ScrollText size={12} className="text-muted" />
                      <span className="max-w-md truncate font-mono text-xs text-muted">{JSON.stringify(entry.detail)}</span>
                    </div>
                  </td>
                  <td className="px-4 py-3">
                    <Badge tone={entry.result === 'success' ? 'ok' : 'danger'}>{entry.result}</Badge>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
