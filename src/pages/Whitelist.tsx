import { useEffect, useState } from 'react'
import { Plus, ShieldCheck, ShieldOff, Trash2, Upload } from 'lucide-react'
import { useAppStore, tr } from '../stores/appStore'
import { Badge, Card, EmptyState, Modal } from '../components/ui'
import type { ProtectionEntry } from '@shared/types'

export default function Whitelist(): JSX.Element {
  const repositories = useAppStore((s) => s.repositories)
  const selectedRepositoryIds = useAppStore((s) => s.selectedRepositoryIds)
  const toast = useAppStore((s) => s.toast)
  const refresh = useAppStore((s) => s.refresh)
  const [tab, setTab] = useState<'whitelist' | 'protected'>('whitelist')
  const [addOpen, setAddOpen] = useState(false)
  const [addMode, setAddMode] = useState<'whitelist' | 'protected'>('whitelist')
  const [form, setForm] = useState({ pattern: '', type: 'glob' as 'exact' | 'glob' | 'regex', note: '' })
  const [importFile, setImportFile] = useState<HTMLInputElement | null>(null)
  const [targetRepositoryId, setTargetRepositoryId] = useState<string | null>(null)
  // 白名单与保护规则按仓库隔离：为每个勾选仓库分别加载，分组展示。
  const [entriesByRepository, setEntriesByRepository] = useState<Record<string, { whitelist: ProtectionEntry[]; protected: ProtectionEntry[] }>>({})
  const scopedRepositories = repositories.filter((repository) => selectedRepositoryIds.includes(repository.id))
  const noSelection = scopedRepositories.length === 0
  const effectiveTargetRepositoryId = scopedRepositories.some((repository) => repository.id === targetRepositoryId)
    ? targetRepositoryId
    : scopedRepositories[0]?.id ?? null

  const loadEntries = async (): Promise<void> => {
    const entries = await Promise.all(
      scopedRepositories.map(async (repository) => [
        repository.id,
        {
          whitelist: await window.gitmanager.listWhitelist(repository.id),
          protected: await window.gitmanager.listProtected(repository.id)
        }
      ] as const)
    )
    setEntriesByRepository(Object.fromEntries(entries))
  }

  useEffect(() => {
    void loadEntries()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedRepositoryIds.join(','), repositories.length])

  const reload = async (): Promise<void> => {
    await loadEntries()
    void refresh()
  }

  const handleImportTxt = async (file: File): Promise<void> => {
    if (!effectiveTargetRepositoryId) {
      toast('未选择仓库：请先勾选仓库', 'warn')
      return
    }
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
        const type: ProtectionEntry['type'] = /[*?]/.test(branch) ? 'glob' : 'exact'
        if (kind === 'whitelist') {
          await window.gitmanager.addWhitelist({ repositoryId: effectiveTargetRepositoryId, pattern: branch, type, note: '从 TXT 导入' })
        } else {
          await window.gitmanager.addProtected({ repositoryId: effectiveTargetRepositoryId, pattern: branch, type, note: '从 TXT 导入' })
        }
      }
      const repositoryName = scopedRepositories.find((repository) => repository.id === effectiveTargetRepositoryId)?.name ?? ''
      toast(`已导入 ${branches.length} 个分支到 ${repositoryName} 的${kind === 'whitelist' ? '白名单' : '保护列表'}`, 'success')
      await reload()
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), 'error')
    }
  }

  const totalWhitelist = Object.values(entriesByRepository).reduce((sum, item) => sum + item.whitelist.length, 0)
  const totalProtected = Object.values(entriesByRepository).reduce((sum, entry) => sum + entry.protected.length, 0)

  const remove = async (id: string, kind: 'whitelist' | 'protected', repositoryId: string): Promise<void> => {
    try {
      if (kind === 'whitelist') {
        await window.gitmanager.removeWhitelist(id, repositoryId)
      } else {
        await window.gitmanager.removeProtected(id, repositoryId)
      }
      toast('Removed', 'success')
      await reload()
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), 'error')
    }
  }

  const add = async (): Promise<void> => {
    if (!form.pattern) return
    if (!effectiveTargetRepositoryId) {
      toast('未选择仓库：请先勾选仓库', 'warn')
      return
    }
    try {
      if (addMode === 'whitelist') {
        await window.gitmanager.addWhitelist({ repositoryId: effectiveTargetRepositoryId, pattern: form.pattern, type: form.type, note: form.note })
      } else {
        await window.gitmanager.addProtected({ repositoryId: effectiveTargetRepositoryId, pattern: form.pattern, type: form.type, note: form.note })
      }
      toast('Added', 'success')
      setAddOpen(false)
      setForm({ pattern: '', type: 'glob', note: '' })
      await reload()
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), 'error')
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-bold text-canvas-fg">
          {tr('whitelist')}
          <span className="ml-2 text-sm font-medium text-muted">
            {noSelection ? '未选择仓库' : `按仓库隔离（勾选 ${scopedRepositories.length} 个仓库）`}
          </span>
        </h1>
        <div className="flex gap-2">
          <button
            className="btn"
            disabled={noSelection}
            title={noSelection ? '未选择仓库：请先勾选仓库' : undefined}
            onClick={() => { setAddMode('whitelist'); setAddOpen(true) }}
          >
            <Plus size={15} /> 手动添加
          </button>
          <button
            className="btn"
            disabled={noSelection}
            title={noSelection ? '未选择仓库：请先勾选仓库' : undefined}
            onClick={() => importFile?.click()}
          >
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

      {noSelection ? (
        <div className="rounded-md border border-warn/40 bg-warn/10 px-4 py-2 text-xs text-warn">
          未选择仓库：白名单与保护列表按仓库隔离保存，请先在仓库页或顶栏勾选仓库。
        </div>
      ) : scopedRepositories.length > 1 ? (
        <div className="flex items-center gap-2 text-xs text-muted">
          <span>手动添加 / 导入TXT 的目标仓库</span>
          <select
            className="input max-w-xs"
            value={effectiveTargetRepositoryId ?? ''}
            onChange={(e) => setTargetRepositoryId(e.target.value)}
          >
            {scopedRepositories.map((repository) => (
              <option key={repository.id} value={repository.id}>{repository.name}</option>
            ))}
          </select>
        </div>
      ) : null}

      <div className="flex gap-1 rounded-card border border-line bg-surface p-1">
        <button
          className={`flex-1 rounded-md px-4 py-2 text-sm font-medium transition-colors ${tab === 'whitelist' ? 'bg-primary/10 text-primary' : 'text-muted hover:text-canvas-fg'}`}
          onClick={() => setTab('whitelist')}
        >
          <ShieldCheck size={14} className="inline" /> {tr('whitelist')} ({totalWhitelist})
        </button>
        <button
          className={`flex-1 rounded-md px-4 py-2 text-sm font-medium transition-colors ${tab === 'protected' ? 'bg-primary/10 text-primary' : 'text-muted hover:text-canvas-fg'}`}
          onClick={() => setTab('protected')}
        >
          <ShieldOff size={14} className="inline" /> {tr('protectedBranches')} ({totalProtected})
        </button>
      </div>

      {noSelection ? (
        <EmptyState title="未选择仓库" description="请先在仓库页或顶栏勾选仓库，白名单与保护列表按仓库隔离展示。" />
      ) : (tab === 'whitelist' ? totalWhitelist : totalProtected) === 0 ? (
        <EmptyState
          title={tab === 'whitelist' ? '勾选仓库暂无白名单条目' : '勾选仓库暂无保护条目'}
          description="条目只会出现在其所属仓库分组内，不会与其他仓库混用。"
        />
      ) : (
        <div className="space-y-4">
          {scopedRepositories.map((repository) => {
            const entries = entriesByRepository[repository.id]
            const list = (tab === 'whitelist' ? entries?.whitelist : entries?.protected) ?? []
            if (list.length === 0) return null
            return (
              <div key={repository.id} className="space-y-2">
                <div className="flex items-center gap-2 text-sm font-semibold text-canvas-fg">
                  <span>{repository.name}</span>
                  <Badge>{list.length} 个条目</Badge>
                </div>
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
                    <button className="btn px-2" onClick={() => void remove(entry.id, tab, repository.id)}>
                      <Trash2 size={13} className="text-danger" />
                    </button>
                  </Card>
                ))}
              </div>
            )
          })}
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
