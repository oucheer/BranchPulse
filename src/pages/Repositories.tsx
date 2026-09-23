import { useEffect, useState } from 'react'
import { Cloud, Eye, EyeOff, FolderGit2, GitBranch, Plus, RefreshCw, ScanLine, Trash2 } from 'lucide-react'
import { useAppStore, tr } from '../stores/appStore'
import { Badge, Card, EmptyState } from '../components/ui'
import { describeScanRun, timeAgo } from '../lib/format'
import type { GitLabConnectionConfig, GitLabProject } from '@shared/types'

export default function Repositories(): JSX.Element {
  const repositories = useAppStore((s) => s.repositories)
  const branches = useAppStore((s) => s.branches)
  const [allRepositoryBranches, setAllRepositoryBranches] = useState<typeof branches>([])
  const scanning = useAppStore((s) => s.scanning)
  const setScanning = useAppStore((s) => s.setScanning)
  const toast = useAppStore((s) => s.toast)
  const refresh = useAppStore((s) => s.refresh)
  const settings = useAppStore((s) => s.settings)
  const selectedRepositoryIds = useAppStore((s) => s.selectedRepositoryIds)
  const toggleRepositorySelection = useAppStore((s) => s.toggleRepositorySelection)
  const selectAllRepositories = useAppStore((s) => s.selectAllRepositories)
  const clearRepositorySelection = useAppStore((s) => s.clearRepositorySelection)
  const [confirmId, setConfirmId] = useState<string | null>(null)
  const [gitlabUrl, setGitlabUrl] = useState(settings.gitlabUrl)
  const [gitlabApiKey, setGitlabApiKey] = useState('')
  const [gitlabApiKeyTouched, setGitlabApiKeyTouched] = useState(false)
  const [gitlabBusy, setGitlabBusy] = useState(false)
  const [gitlabProjects, setGitlabProjects] = useState<GitLabProject[]>([])
  const [gitlabMessage, setGitlabMessage] = useState<string | null>(null)
  const [showGitlabApiKey, setShowGitlabApiKey] = useState(false)

  useEffect(() => {
    let cancelled = false
    if (repositories.length === 0) {
      setAllRepositoryBranches([])
      return
    }
    void window.gitmanager.listBranches(repositories.map((repository) => repository.id)).then((rows) => {
      if (!cancelled) setAllRepositoryBranches(rows)
    }).catch(() => {
      if (!cancelled) setAllRepositoryBranches([])
    })
    return () => {
      cancelled = true
    }
  }, [repositories, branches])

  useEffect(() => {
    if (!gitlabApiKeyTouched) setGitlabApiKey(settings.gitlabApiKey ?? '')
  }, [gitlabApiKeyTouched, settings.gitlabApiKey])

  const gitlabConfig = (): GitLabConnectionConfig => ({
    url: gitlabUrl,
    ...((gitlabApiKey || settings.gitlabApiKey) ? { apiKey: gitlabApiKey || settings.gitlabApiKey } : {})
  })

  const connect = async (): Promise<void> => {
    setGitlabBusy(true)
    setGitlabMessage(null)
    try {
      await window.gitmanager.saveSettings({ ...settings, gitlabUrl, ...(gitlabApiKey ? { gitlabApiKey } : {}) })
      const projects = await window.gitmanager.listGitLabProjects(gitlabConfig())
      setGitlabProjects(projects)
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

  const addGitlabProject = async (projectId: number): Promise<void> => {
    setGitlabBusy(true)
    try {
      const repo = await window.gitmanager.addGitLabRepository(projectId, gitlabConfig())
      const run = await window.gitmanager.scanRepository(repo.id, true)
      const described = describeScanRun(run, 'zh')
      toast(`${repo.name} 已添加，${described.message}`, described.level)
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
      const run = await window.gitmanager.scanRepository(id, true)
      const described = describeScanRun(run, 'zh')
      toast(described.message, described.level)
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), 'error')
    } finally {
      setScanning(false)
      void refresh()
    }
  }

  const remove = async (id: string): Promise<void> => {
    try {
      await window.gitmanager.removeRepository(id)
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
        <div className="flex items-center justify-between gap-3">
          <div>
            <div className="text-sm font-semibold text-canvas-fg">勾选仓库范围</div>
            <div className="mt-1 text-xs text-muted">
              {repositories.length === 0
                ? '暂无可勾选的仓库。'
                : selectedRepositoryIds.length === 0
                  ? '当前未选择仓库：所有功能页显示空数据并禁用操作。'
                  : `已勾选 ${selectedRepositoryIds.length} / ${repositories.length} 个仓库，所有功能页仅显示这些仓库的分支与统计。`}
            </div>
          </div>
          <div className="flex shrink-0 gap-2">
            <button className="btn" disabled={repositories.length === 0} onClick={() => void selectAllRepositories()}>全选</button>
            <button className="btn" disabled={selectedRepositoryIds.length === 0} onClick={() => void clearRepositorySelection()}>清空</button>
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
            const repoBranches = allRepositoryBranches.filter((b) => b.repositoryId === repo.id)
            return (
              <Card key={repo.id} className="p-4">
                <div className="flex items-center gap-3">
                  <input
                    type="checkbox"
                    className="no-specular h-4 w-4 shrink-0 cursor-pointer accent-[rgb(var(--primary))]"
                    checked={selectedRepositoryIds.includes(repo.id)}
                    title={selectedRepositoryIds.includes(repo.id) ? '取消勾选该仓库' : '勾选该仓库'}
                    onChange={() => void toggleRepositorySelection(repo.id)}
                  />
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
                      <div className="font-semibold text-canvas-fg">{repo.lastScanAt ? repoBranches.filter((b) => b.stale).length : '—'}</div>
                      已停更
                    </div>
                    <div>
                      <div className="font-semibold text-canvas-fg">{timeAgo(repo.lastScanAt)}</div>
                      扫描
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
                    <button className="btn px-2" onClick={() => setConfirmId(repo.id)} title={tr('removeRemote')}>
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
              placeholder="https://gitlab.com、https://github.com/owner/repo 或 http://内网地址[:端口]"
            />
          </div>
          <div>
<div className="label mb-1">API Token</div>
            <div className="flex items-center gap-2">
              <input
                className="input flex-1"
                type={showGitlabApiKey ? 'text' : 'password'}
                value={gitlabApiKey}
                onChange={(e) => {
                  setGitlabApiKey(e.target.value)
                  setGitlabApiKeyTouched(true)
                }}
                placeholder={settings.hasGitlabApiKey ? tr('apiKeySaved') : tr('remoteApiKey')}
              />
              <button
                className="btn px-2"
                type="button"
                onClick={() => setShowGitlabApiKey(!showGitlabApiKey)}
                title={showGitlabApiKey ? '隐藏 API Token' : '显示 API Token'}
              >
                {showGitlabApiKey ? <EyeOff size={14} /> : <Eye size={14} />}
              </button>
            </div>
          </div>
          <button className="btn btn-primary" disabled={gitlabBusy || !gitlabUrl} onClick={() => void connect()}>
            <RefreshCw size={14} /> 连接
          </button>
        </div>
        <div className="mt-3 flex items-center justify-between gap-3">
          <div className="min-h-5 text-xs text-muted">{gitlabMessage}</div>
          <span className="text-xs text-muted">支持 GitLab / GitHub / Gitee，自动识别平台</span>
        </div>
        <p className="mt-1 text-xs text-muted">
          自建 GitLab 为根路径时填 <span className="font-mono">http://内网地址[:端口]</span>；
          挂在子路径下时填子路径根（如 <span className="font-mono">http://内网地址/gitlab</span>）；
          也可以填项目完整地址。若自动推导失败，直接把完整 API 地址（如
          <span className="font-mono"> http://内网地址[:端口]/api/v4</span>）填进去。
        </p>
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
            <div className="mb-2 text-sm font-semibold text-canvas-fg">移除仓库？</div>
            <div className="mb-4 text-sm text-muted">
              将移除该仓库在 GitManager 中的连接和分析数据，不会影响远程仓库本身。
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
