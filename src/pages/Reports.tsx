import { useState } from 'react'
import { Download, FileBarChart, FolderOpen, Plus } from 'lucide-react'
import { useAppStore, tr } from '../stores/appStore'
import { Badge, Card, EmptyState } from '../components/ui'
import { timeAgo } from '../lib/format'

const periods = ['on-demand', 'daily', 'weekly', 'monthly', 'quarterly']
const formats = ['html', 'csv', 'json', 'pdf', 'png']

export default function Reports(): JSX.Element {
  const allReports = useAppStore((s) => s.reports)
  const activeRepositoryId = useAppStore((s) => s.activeRepositoryId)
  const reports = activeRepositoryId ? allReports.filter((report) => report.repositoryId === activeRepositoryId) : allReports
  const toast = useAppStore((s) => s.toast)
  const refresh = useAppStore((s) => s.refresh)
  const [period, setPeriod] = useState('weekly')
  const [format, setFormat] = useState('html')
  const [generating, setGenerating] = useState(false)

  const generate = async (): Promise<void> => {
    setGenerating(true)
    try {
      const report = await window.branchpulse.generateReport(period, format, activeRepositoryId)
      toast(`Report generated: ${report.title}`, 'success')
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
      toast(`Exported as ${fmt.toUpperCase()}`, 'success')
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

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-lg font-bold text-canvas-fg">{tr('reports')}</h1>
          <div className="text-xs text-muted">{reports.length} generated</div>
        </div>
        <button className="btn" onClick={() => void openFolder()}>
          <FolderOpen size={14} /> {tr('openFolder')}
        </button>
      </div>

      <Card className="p-4">
        <div className="mb-3 text-sm font-semibold text-canvas-fg">{tr('generate')}</div>
        <div className="flex flex-wrap items-end gap-3">
          <div>
            <div className="label mb-1.5">{tr('period')}</div>
            <select className="input w-40" value={period} onChange={(e) => setPeriod(e.target.value)}>
              {periods.map((p) => <option key={p} value={p}>{p}</option>)}
            </select>
          </div>
          <div>
            <div className="label mb-1.5">{tr('format')}</div>
            <select className="input w-32" value={format} onChange={(e) => setFormat(e.target.value)}>
              {formats.map((f) => <option key={f} value={f}>{f.toUpperCase()}</option>)}
            </select>
          </div>
          <button className="btn btn-primary" disabled={generating} onClick={() => void generate()}>
            <Plus size={14} /> {tr('generate')}
          </button>
        </div>
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
                <div className="font-semibold text-canvas-fg">{report.summary.totalBranches} branches</div>
                <div>{report.summary.compliancePercent}% compliant</div>
              </div>
              <div className="flex items-center gap-1">
                {formats.filter((f) => f !== report.format).map((f) => (
                  <button key={f} className="btn px-2 text-[11px]" onClick={() => void exportReport(report.id, f)}>
                    <Download size={12} /> {f.toUpperCase()}
                  </button>
                ))}
              </div>
            </Card>
          ))}
        </div>
      )}
    </div>
  )
}
