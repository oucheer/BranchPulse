import { useState } from 'react'
import { Cloud, FolderGit2, GitBranch, Plus, RefreshCw, ScanLine, Trash2 } from 'lucide-react'
import { useAppStore, tr } from '../stores/appStore'
import { Badge, Card, EmptyState } from '../components/ui'
import { timeAgo } from '../lib/format'
import type { GitLabConnectionConfig, GitLabProject } from '@shared/types'

export default function Repositories(): JSX.Element {
  const repositories = useAppStore((s) => s.repositories)
  const branches = useAppStore((s) => s.branches)
  const scanning = useAppStore((s) => s.scanning)
  const setScanning = useAppStore((s) => s.setScanning)
  const toast = useAppStore((s) => s.toast)
  const refresh = useAppStore((s) => s.refresh)
  const settings = useAppStore((s) => s.settings)
  const [confirmId, setConfirmId] = useState<string | null>(null)
  const [gitlabUrl, setGitlabUrl] = useState(settings.gitlabUrl)
  const [gitlabApiKey, setGitlabApiKey] = useState('')
  const [gitlabBusy, setGitlabBusy] = useState(false)
  const [gitlabProjects, setGitlabProjects] = useState<GitLabProject[]>([])
  const [gitlabMessage, setGitlabMessage] = useState<string | null>(null)

  const gitlabConfig = (): GitLabConnectionConfig => ({
    url: gitlabUrl,
    ...(gitlabApiKey ? { apiKey: gitlabApiKey } : {})
  })

  const saveGitlabConfig = async (): Promise<void> => {
    setGitlabBusy(true)
    try {
      await window.branchpulse.saveSettings({ ...settings, gitlabUrl, ...(gitlabApiKey ? { gitlabApiKey } : {}) })
      toast(tr('saved'), 'success')
      setGitlabApiKey('')
      void refresh()
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), 'error')
    } finally {
      setGitlabBusy(false)
    }
  }

  const testGitlab = async (): Promise<void> => {
    setGitlabBusy(true)
    setGitlabMessage(null)
    try {
      const result = await window.branchpulse.testGitLabConnection(gitlabConfig())
      setGitlabMessage(result.message)
      toast(result.ok ? tr('success') : tr('error'), result.ok ? 'success' : 'error')
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      setGitlabMessage(message)
      toast(message, 'error')
    } finally {
      setGitlabBusy(false)
    }
  }

  const loadGitlabProjects = async (): Promise<void> => {
    setGitlabBusy(true)
    setGitlabMessage(null)
    try {
      await window.branchpulse.saveSettings({ ...settings, gitlabUrl, ...(gitlabApiKey ? { gitlabApiKey } : {}) })
      const projects = await window.branchpulse.listGitLabProjects(gitlabConfig())
      setGitlabProjects(projects)
      setGitlabApiKey('')
      setGitlabMessage(`${projects.length} ${tr('projects').toLowerCase()}`)
      void refresh()
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      setGitlabMessage(message)
      toast(message, 'error')
    } finally {
      setGitlabBusy(false)
    }
  }

  const addGitlabProject = async (projectId: number): Promise<void> => {
    setGitlabBusy(true)
    try {
      const repo = await window.branchpulse.addGitLabRepository(projectId, gitlabConfig())
      toast(`Added ${repo.name}`, 'success')
      void refresh()
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), 'error')
    } finally {
      setGitlabBusy(false)
    }
  }

  const addRepository = async (): Promise<void> => {
    const dir = await window.branchpulse.pickDirectory()
    if (!dir) return
    try {
      const repo = await window.branchpulse.addRepository(dir)
      toast(`Added ${repo.name}`, 'success')
      void refresh()
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), 'error')
    }
  }

  const scan = async (id: string): Promise<void> => {
    setScanning(true)
    try {
      const run = await window.branchpulse.scanRepository(id, true)
      toast(`Scan complete: ${run.branches} branches`, 'success')
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), 'error')
    } finally {
      setScanning(false)
      void refresh()
    }
  }

  const remove = async (id: string): Promise<void> => {
    try {
      await window.branchpulse.removeRepository(id)
      toast(tr('repository') + ' removed', 'success')
      setConfirmId(null)
      void refresh()
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), 'error')
    }
  }

  const createDemo = async (): Promise<void> => {
    try {
      await window.branchpulse.createDemoRepository()
      toast('Demo repository created', 'success')
      void refresh()
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), 'error')
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-lg font-bold text-canvas-fg">{tr('repositories')}</h1>
          <div className="text-xs text-muted">{repositories.length} {tr('repositories').toLowerCase()} · {branches.length} branches</div>
        </div>
        <div className="flex items-center gap-2">
          <button className="btn" onClick={() => void createDemo()}>
            <Plus size={15} /> {tr('createDemo')}
          </button>
          <button className="btn btn-primary" onClick={() => void addRepository()}>
            <Plus size={15} /> {tr('addRepository')}
          </button>
        </div>
      </div>

      {repositories.length === 0 ? (
        <EmptyState
          title={tr('noRepositories')}
          description={tr('addFirst')}
          action={
            <div className="flex gap-2">
              <button className="btn btn-primary" onClick={() => void addRepository()}>
                <FolderGit2 size={15} /> {tr('pickFolder')}
              </button>
              <button className="btn" onClick={() => void createDemo()}>
                {tr('createDemo')}
              </button>
            </div>
          }
        />
      ) : (
        <div className="space-y-3">
          {repositories.map((repo) => {
            const repoBranches = branches.filter((b) => b.repositoryId === repo.id)
            return (
              <Card key={repo.id} className="p-4">
                <div className="flex items-center gap-3">
                  <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary">
                    <FolderGit2 size={18} />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="truncate text-sm font-semibold text-canvas-fg">{repo.name}</span>
                      <Badge tone={repo.source === 'gitlab' ? 'info' : 'secondary'}>{repo.source === 'gitlab' ? tr('gitlab') : tr('local')}</Badge>
                      <Badge tone="secondary">{repo.currentBranch || 'HEAD'}</Badge>
                    </div>
                    <div className="truncate font-mono text-xs text-muted">{repo.source === 'gitlab' ? repo.webUrl ?? repo.path : repo.path}</div>
                  </div>
                  <div className="hidden items-center gap-4 text-right text-xs text-muted md:flex">
                    <div>
                      <div className="font-semibold text-canvas-fg">{repo.totalBranches}</div>
                      branches
                    </div>
                    <div>
                      <div className="font-semibold text-canvas-fg">{repoBranches.filter((b) => b.stale).length}</div>
                      stale
                    </div>
                    <div>
                      <div className="font-semibold text-canvas-fg">{timeAgo(repo.lastScanAt)}</div>
                      scanned
                    </div>
                  </div>
                  <div className="flex shrink-0 items-center gap-1.5">
                    <button
                      className="btn px-2"
                      onClick={() => void scan(repo.id)}
                      disabled={scanning}
                      title={tr('scanAll')}
                    >
                      <ScanLine size={15} />
                    </button>
                    <button className="btn px-2" onClick={() => setConfirmId(repo.id)} title={repo.source === 'gitlab' ? tr('removeGitlab') : tr('deleteLocal')}>
                      <Trash2 size={15} className="text-danger" />
                    </button>
                  </div>
                </div>
              </Card>
            )
          })}
        </div>
      )}

      <Card className="p-5">
        <div className="mb-4 flex items-center gap-2 text-sm font-semibold text-canvas-fg">
          <Cloud size={15} className="text-primary" /> {tr('gitlabConnection')}
        </div>
        <div className="grid gap-3 lg:grid-cols-[2fr_2fr_auto_auto]">
          <div>
            <div className="label mb-1">{tr('gitlabUrl')}</div>
            <input className="input" value={gitlabUrl} onChange={(e) => setGitlabUrl(e.target.value)} placeholder="https://gitlab.com" />
          </div>
          <div>
            <div className="label mb-1">{tr('gitlabApiKey')}</div>
            <input
              className="input"
              type="password"
              value={gitlabApiKey}
              onChange={(e) => setGitlabApiKey(e.target.value)}
              placeholder={settings.hasGitlabApiKey ? tr('apiKeySaved') : tr('gitlabApiKey')}
            />
          </div>
          <button className="btn" disabled={gitlabBusy || !gitlabUrl} onClick={() => void testGitlab()}>{tr('testConnection')}</button>
          <button className="btn btn-primary" disabled={gitlabBusy || !gitlabUrl} onClick={() => void saveGitlabConfig()}>{tr('save')}</button>
        </div>
        <div className="mt-3 flex items-center justify-between gap-3">
          <div className="min-h-5 text-xs text-muted">{gitlabMessage}</div>
          <button className="btn" disabled={gitlabBusy || !gitlabUrl} onClick={() => void loadGitlabProjects()}>
            <RefreshCw size={14} /> {tr('loadProjects')}
          </button>
        </div>
        {gitlabProjects.length > 0 ? (
          <div className="mt-4 grid max-h-72 gap-2 overflow-y-auto pr-1">
            {gitlabProjects.map((project) => {
              const added = repositories.some((repo) => repo.gitlabProjectId === project.id)
              return (
                <div key={project.id} className="flex items-center gap-3 rounded-md border border-line px-3 py-2">
                  <GitBranch size={15} className="shrink-0 text-muted" />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm text-canvas-fg">{project.pathWithNamespace}</div>
                    <div className="truncate text-xs text-muted">{project.defaultBranch}</div>
                  </div>
                  <button className="btn btn-primary px-3 py-1.5 text-xs" disabled={gitlabBusy || added} onClick={() => void addGitlabProject(project.id)}>
                    {added ? tr('added') : tr('addRepository')}
                  </button>
                </div>
              )
            })}
          </div>
        ) : null}
      </Card>

      {confirmId ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
          <div className="w-[420px] rounded-card border border-line bg-surface p-5 shadow-panel">
            <div className="mb-2 text-sm font-semibold text-canvas-fg">Remove repository?</div>
            <div className="mb-4 text-sm text-muted">
              The local clone and its analyzed branch data in BranchPulse will be removed. The repository on disk is not affected.
            </div>
            <div className="flex justify-end gap-2">
              <button className="btn" onClick={() => setConfirmId(null)}>{tr('cancel')}</button>
              <button className="btn text-danger" onClick={() => void remove(confirmId)}>{tr('confirm')}</button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  )
}
