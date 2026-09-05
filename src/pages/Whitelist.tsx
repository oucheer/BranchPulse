import { useState } from 'react'
import { Plus, ShieldCheck, ShieldOff, Trash2, Upload } from 'lucide-react'
import { useAppStore, tr } from '../stores/appStore'
import { Badge, Card, EmptyState, Modal } from '../components/ui'
import type { ProtectionEntry } from '@shared/types'

export default function Whitelist(): JSX.Element {
  const whitelist = useAppStore((s) => s.whitelist)
  const protectedList = useAppStore((s) => s.protected)
  const toast = useAppStore((s) => s.toast)
  const refresh = useAppStore((s) => s.refresh)
  const [tab, setTab] = useState<'whitelist' | 'protected'>('whitelist')
  const [addOpen, setAddOpen] = useState(false)
  const [addMode, setAddMode] = useState<'whitelist' | 'protected'>('whitelist')
  const [form, setForm] = useState({ pattern: '', type: 'glob' as 'exact' | 'glob' | 'regex', note: '' })
  const [importFile, setImportFile] = useState<HTMLInputElement | null>(null)

  const handleImportTxt = async (file: File): Promise<void> => {
    try {
      const content = await file.text()
      const branches = content
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line.length > 0 && !line.startsWith('#'))
      if (branches.length === 0) {
        toast('文件中没有找到分支名称', 'warn')
        return
      }
      const kind = tab === 'whitelist' ? 'whitelist' : 'protected'
      for (const branch of branches) {
        if (kind === 'whitelist') {
          await window.branchpulse.addWhitelist({ pattern: branch, type: 'exact', note: '从 TXT 导入' })
        } else {
          await window.branchpulse.addProtected({ pattern: branch, type: 'exact', note: '从 TXT 导入' })
        }
      }
      toast(`已导入 ${branches.length} 个分支到${kind === 'whitelist' ? '白名单' : '保护列表'}`, 'success')
      void refresh()
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), 'error')
    }
  }

  const list = tab === 'whitelist' ? whitelist : protectedList

  const remove = async (id: string, kind: 'whitelist' | 'protected'): Promise<void> => {
    try {
      if (kind === 'whitelist') {
        await window.branchpulse.removeWhitelist(id)
      } else {
        await window.branchpulse.removeProtected(id)
      }
      toast('Removed', 'success')
      void refresh()
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), 'error')
    }
  }

  const add = async (): Promise<void> => {
    if (!form.pattern) return
    try {
      if (addMode === 'whitelist') {
        await window.branchpulse.addWhitelist({ pattern: form.pattern, type: form.type, note: form.note })
      } else {
        await window.branchpulse.addProtected({ pattern: form.pattern, type: form.type, note: form.note })
      }
      toast('Added', 'success')
      setAddOpen(false)
      setForm({ pattern: '', type: 'glob', note: '' })
      void refresh()
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), 'error')
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-bold text-canvas-fg">{tr('whitelist')}</h1>
        <div className="flex gap-2">
          <button className="btn" onClick={() => { setAddMode('whitelist'); setAddOpen(true) }}>
            <Plus size={15} /> 手动添加
          </button>
          <button className="btn" onClick={() => importFile?.click()}>
            <Upload size={15} /> 导入TXT
          </button>
          <input
            ref={(el) => setImportFile(el)}
            type="file"
            accept=".txt"
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0]
              if (file) void handleImportTxt(file)
              e.target.value = ''
            }}
          />
        </div>
      </div>

      <div className="flex gap-1 rounded-card border border-line bg-surface p-1">
        <button
          className={`flex-1 rounded-md px-4 py-2 text-sm font-medium transition-colors ${tab === 'whitelist' ? 'bg-primary/10 text-primary' : 'text-muted hover:text-canvas-fg'}`}
          onClick={() => setTab('whitelist')}
        >
          <ShieldCheck size={14} className="inline" /> {tr('whitelist')} ({whitelist.length})
        </button>
        <button
          className={`flex-1 rounded-md px-4 py-2 text-sm font-medium transition-colors ${tab === 'protected' ? 'bg-primary/10 text-primary' : 'text-muted hover:text-canvas-fg'}`}
          onClick={() => setTab('protected')}
        >
          <ShieldOff size={14} className="inline" /> {tr('protectedBranches')} ({protectedList.length})
        </button>
      </div>

      {list.length === 0 ? (
        <EmptyState title={tab === 'whitelist' ? 'No whitelist entries' : 'No protected entries'} />
      ) : (
        <div className="space-y-2">
          {list.map((entry) => (
            <Card key={entry.id} className="flex items-center gap-3 p-3">
              <div className="flex h-8 w-8 items-center justify-center rounded-md bg-primary/10">
                {tab === 'whitelist' ? <ShieldCheck size={15} className="text-ok" /> : <ShieldOff size={15} className="text-warn" />}
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="font-mono text-sm font-semibold text-canvas-fg">{entry.pattern}</span>
                  <Badge>{entry.type}</Badge>
                </div>
                {entry.note ? <div className="mt-0.5 text-xs text-muted">{entry.note}</div> : null}
              </div>
              <button className="btn px-2" onClick={() => void remove(entry.id, tab)}>
                <Trash2 size={13} className="text-danger" />
              </button>
            </Card>
          ))}
        </div>
      )}

      <Modal
        open={addOpen}
        title={addMode === 'whitelist' ? tr('addWhitelist') : tr('addProtected')}
        onClose={() => setAddOpen(false)}
        footer={
          <div className="flex gap-2">
            <button className="btn" onClick={() => setAddOpen(false)}>{tr('cancel')}</button>
            <button className="btn btn-primary" disabled={!form.pattern} onClick={() => void add()}>{tr('confirm')}</button>
          </div>
        }
      >
        <div className="space-y-4">
          <div>
            <div className="label mb-1">{tr('pattern')}</div>
            <input className="input font-mono" value={form.pattern} onChange={(e) => setForm({ ...form, pattern: e.target.value })} placeholder="feature/*" />
          </div>
          <div>
            <div className="label mb-1">{tr('type')}</div>
            <select className="input" value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value as 'exact' | 'glob' | 'regex' })}>
              <option value="exact">{tr('exact')}</option>
              <option value="glob">{tr('glob')}</option>
              <option value="regex">{tr('regex')}</option>
            </select>
          </div>
          <div>
            <div className="label mb-1">{tr('note')}</div>
            <input className="input" value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} />
          </div>
        </div>
      </Modal>
    </div>
  )
}
