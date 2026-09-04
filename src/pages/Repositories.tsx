import { useState } from 'react'
import { Cloud, FolderGit2, GitBranch, Plus, RefreshCw, ScanLine, ShieldBan, Trash2 } from 'lucide-react'
import { useAppStore, tr } from '../stores/appStore'
import { Badge, Card, EmptyState, Toggle } from '../components/ui'
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
  const setActiveRepositoryId = useAppStore((s) => s.setActiveRepositoryId)
  const activeRepositoryId = useAppStore((s) => s.activeRepositoryId)
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

  const connect = async (): Promise<void> => {
    setGitlabBusy(true)
    setGitlabMessage(null)
    try {
      await window.branchpulse.saveSettings({ ...settings, gitlabUrl, ...(gitlabApiKey ? { gitlabApiKey } : {}) })
      const projects = await window.branchpulse.listGitLabProjects(gitlabConfig())
      setGitlabProjects(projects)
      setGitlabApiKey('')
      setGitlabMessage(`已连接，发现 ${projects.length} 个仓库`)
      toast('已连接远程仓库', 'success')
      void refresh()
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      setGitlabMessage(message)
      toast(message, 'error')
    } finally {
      setGitlabBusy(false)
    }
  }

  const toggleDeletionDisabled = async (disabled: boolean): Promise<void> => {
    try {
      await window.branchpulse.saveSettings({ ...settings, deletionDisabled: disabled })
      toast(tr('saved'), 'success')
      void refresh()
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), 'error')
    }
  }

  const addGitlabProject = async (projectId: number): Promise<void> => {
    setGitlabBusy(true)
    try {
      const repo = await window.branchpulse.addGitLabRepository(projectId, gitlabConfig())
      const run = await window.branchpulse.scanRepository(repo.id, true)
      toast(`${repo.name} 已添加，扫描到 ${run.branches} 个分支`, 'success')
      void refresh()
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), 'error')
    } finally {
      setGitlabBusy(false)
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


  return (
    <div className="space-y-6">
      <Card className="p-5">
        <div className="grid gap-4 lg:grid-cols-[minmax(260px,1fr)_minmax(300px,1fr)]">
          <div>
            <label className="label mb-1.5" htmlFor="active-repository">当前仓库</label>
            <select
              id="active-repository"
              className="input"
              value={activeRepositoryId ?? ''}
              onChange={(e) => void setActiveRepositoryId(e.target.value || null)}
            >
              <option value="">全部仓库</option>
              {repositories.map((repo) => (
                <option key={repo.id} value={repo.id}>{repo.name}</option>
              ))}
            </select>
          </div>
          <div className="flex items-center justify-between rounded-md border border-line bg-surface px-4 py-3">
            <div className="flex items-center gap-3">
              <div className={`flex h-9 w-9 items-center justify-center rounded-md ${settings.deletionDisabled ? 'bg-danger/10 text-danger' : 'bg-line/20 text-muted'}`}>
                <ShieldBan size={17} />
              </div>
              <div>
                <div className="text-sm font-semibold text-canvas-fg">全局禁止删除分支</div>
                <div className="text-xs text-muted">开启后，应用内所有删除功能将被禁用。</div>
              </div>
            </div>
            <Toggle checked={settings.deletionDisabled} onChange={(v) => void toggleDeletionDisabled(v)} />
          </div>
        </div>
      </Card>

      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-lg font-bold text-canvas-fg">{tr('repositories')}</h1>
          <div className="text-xs text-muted">{repositories.length} {tr('repositories').toLowerCase()} · {branches.length} 分支</div>
        </div>
        <div className="flex items-center gap-2">
          <button className="btn btn-primary" disabled={gitlabBusy || !gitlabUrl} onClick={() => void connect()}>
            <Plus size={15} /> 连接仓库
          </button>
        </div>
      </div>

      {repositories.length === 0 ? (
        <EmptyState
          title={tr('noRepositories')}
          description="请在下方完成远程仓库连接配置，加载并添加 GitLab、GitHub 或 Gitee 项目。"
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
                      <Badge tone="info">{repo.source === 'gitlab' ? 'GitLab' : repo.source === 'github' ? 'GitHub' : repo.source === 'gitee' ? 'Gitee' : 'Local'}</Badge>
                    </div>
                    <div className="truncate font-mono text-xs text-muted">{repo.webUrl ?? repo.path}</div>
                  </div>
                  <div className="hidden items-center gap-4 text-right text-xs text-muted md:flex">
                    <div>
                      <div className="font-semibold text-canvas-fg">{repo.totalBranches}</div>
                      分支
                    </div>
                    <div>
                      <div className="font-semibold text-canvas-fg">{repoBranches.filter((b) => b.stale).length}</div>
                      过期
                    </div>
                    <div>
                      <div className="font-semibold text-canvas-fg">{timeAgo(repo.lastScanAt)}</div>
                      扫描
                    </div>
                  </div>
                  <div className="flex shrink-0 items-center gap-1.5">
                    <button
                      className={`btn px-2 ${activeRepositoryId === repo.id ? 'border-primary/60 text-primary' : ''}`}
                      onClick={() => void setActiveRepositoryId(activeRepositoryId === repo.id ? null : repo.id)}
                      title={activeRepositoryId === repo.id ? '切换到全部仓库' : '设为当前仓库'}
                    >
                      <FolderGit2 size={15} />
                    </button>
                    <button
                      className={`btn px-2 ${activeRepositoryId === repo.id ? 'border-primary/60 text-primary' : ''}`}
                      onClick={() => void scan(repo.id)}
                      disabled={scanning}
                      title={tr('scanAll')}
                    >
                      <ScanLine size={15} />
                    </button>
                    <button className="btn px-2" onClick={() => setConfirmId(repo.id)} title={tr('removeGitlab')}>
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
          <Cloud size={15} className="text-primary" /> 远程仓库连接
        </div>
        <div className="grid gap-3 lg:grid-cols-[2fr_2fr_auto]">
          <div>
            <div className="label mb-1">远程仓库地址</div>
            <input
              className="input"
              value={gitlabUrl}
              onChange={(e) => setGitlabUrl(e.target.value)}
              placeholder="https://gitlab.com 或 https://github.com/owner/repo"
            />
          </div>
          <div>
            <div className="label mb-1">API Token</div>
            <input
              className="input"
              type="password"
              value={gitlabApiKey}
              onChange={(e) => setGitlabApiKey(e.target.value)}
              placeholder={settings.hasGitlabApiKey ? tr('apiKeySaved') : tr('gitlabApiKey')}
            />
          </div>
          <button className="btn btn-primary" disabled={gitlabBusy || !gitlabUrl} onClick={() => void connect()}>
            <RefreshCw size={14} /> 连接
          </button>
        </div>
        <div className="mt-3 flex items-center justify-between gap-3">
          <div className="min-h-5 text-xs text-muted">{gitlabMessage}</div>
          <span className="text-xs text-muted">支持 GitLab / GitHub / Gitee，自动识别平台</span>
        </div>
        {gitlabProjects.length > 0 ? (
          <div className="mt-4 grid max-h-72 gap-2 overflow-y-auto pr-1">
            {gitlabProjects.map((project) => {
              const added = repositories.some((repo) => repo.gitlabProjectId === project.id && repo.source !== 'local')
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
