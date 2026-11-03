import { useEffect, useMemo, useRef, useState } from 'react'
import { ArrowLeft, ChevronDown, ChevronRight, ExternalLink, File, FileDiff, Folder, FolderOpen } from 'lucide-react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import type { PersonalActivity, PersonalCommit } from '@shared/types'
import { readMyActivityMonths, useAppStore } from '../stores/appStore'
import { Badge } from '../components/ui'

const SOURCE_LABELS = { github: 'GitHub', gitlab: 'GitLab', gitee: 'Gitee', local: 'Local' } as const
type FileNode = { name: string; path: string; files: string[]; directories: Record<string, FileNode> }

function buildFileTree(paths: string[]): FileNode {
  const root: FileNode = { name: '', path: '', files: [], directories: {} }
  for (const filePath of paths) {
    const parts = filePath.split('/').filter(Boolean)
    let node = root
    parts.forEach((part, index) => {
      if (index === parts.length - 1) node.files.push(filePath)
      else {
        const path = node.path ? `${node.path}/${part}` : part
        node.directories[part] ??= { name: part, path, files: [], directories: {} }
        node = node.directories[part]!
      }
    })
  }
  return root
}

export default function CommitDetails(): JSX.Element {
  const { repositoryId = '', sha = '' } = useParams()
  const navigate = useNavigate()
  const language = useAppStore((s) => s.language)
  const session = useAppStore((s) => s.session)
  const cache = useAppStore((s) => s.myActivityCache)
  const busy = useAppStore((s) => s.myActivityBusy)
  const loadMyActivity = useAppStore((s) => s.loadMyActivity)
  const zh = language === 'zh'
  const months = readMyActivityMonths(session)
  const [requested, setRequested] = useState(false)
  const [selectedPath, setSelectedPath] = useState('')
  const [view, setView] = useState<'diff' | 'file'>('diff')
  const [expandedDirectories, setExpandedDirectories] = useState<Record<string, boolean>>({})
  const [fileContents, setFileContents] = useState<Record<string, string>>({})
  const [fileErrors, setFileErrors] = useState<Record<string, string>>({})
  const [loadingFile, setLoadingFile] = useState(false)
  const initializedFiles = useRef(false)

  const activity = useMemo(() => {
    const identity = `${session?.email.toLowerCase() ?? ''}|${session?.source ?? ''}|${session?.accountId ?? session?.username.toLowerCase() ?? ''}|`
    return cache[`${identity}${months}`] ?? null
  }, [cache, months, session])
  const commit: PersonalCommit | undefined = activity?.commits.find((item) => item.repositoryId === repositoryId && item.sha === sha)
  const detail = activity?.commitDetails.find((item) => item.repositoryId === repositoryId && item.sha === sha)
  const tree = useMemo(() => buildFileTree(detail?.files.map((file) => file.path) ?? []), [detail])
  const selectedFile = detail?.files.find((file) => file.path === selectedPath)

  useEffect(() => {
    if (!commit && !busy && !requested) {
      setRequested(true)
      void loadMyActivity(months, true).catch(() => undefined)
    }
  }, [commit, busy, requested, loadMyActivity, months])

  useEffect(() => {
    if (!detail?.files.length || initializedFiles.current) return
    initializedFiles.current = true
    setSelectedPath(detail.files[0]?.path ?? '')
    const directories: Record<string, boolean> = {}
    for (const file of detail.files) {
      const parts = file.path.split('/')
      let path = ''
      for (const part of parts.slice(0, -1)) {
        path = path ? `${path}/${part}` : part
        directories[path] = true
      }
    }
    setExpandedDirectories(directories)
  }, [detail])

  useEffect(() => {
    if (view !== 'file' || !selectedFile || !commit || fileContents[selectedFile.path] !== undefined) return
    let active = true
    setLoadingFile(true)
    setFileErrors((previous) => ({ ...previous, [selectedFile.path]: '' }))
    void window.gitmanager.getCommitFile(repositoryId, sha, selectedFile.path).then((content) => {
      if (active) setFileContents((previous) => ({ ...previous, [selectedFile.path]: content }))
    }).catch((error: unknown) => {
      if (active) setFileErrors((previous) => ({ ...previous, [selectedFile.path]: error instanceof Error ? error.message : String(error) }))
    }).finally(() => { if (active) setLoadingFile(false) })
    return () => { active = false }
  }, [view, selectedFile, commit, fileContents, repositoryId, sha])

  const back = (): void => {
    if (window.history.state?.idx > 0) navigate(-1)
    else navigate('/my-activity')
  }

  const renderTree = (node: FileNode): JSX.Element => <div className="space-y-0.5">
    {Object.values(node.directories).sort((a, b) => a.name.localeCompare(b.name)).map((directory) => <div key={directory.path}>
      <button className="flex w-full items-center gap-1.5 rounded px-2 py-1 text-left text-xs text-canvas-fg hover:bg-elevated" onClick={() => setExpandedDirectories((previous) => ({ ...previous, [directory.path]: !previous[directory.path] }))}>
        {expandedDirectories[directory.path] ? <ChevronDown size={13} /> : <ChevronRight size={13} />}{expandedDirectories[directory.path] ? <FolderOpen size={14} /> : <Folder size={14} />}<span className="truncate">{directory.name}</span>
      </button>
      {expandedDirectories[directory.path] ? <div className="ml-3 border-l border-line pl-1">{renderTree(directory)}</div> : null}
    </div>)}
    {node.files.sort((a, b) => a.localeCompare(b)).map((path) => <button key={path} title={path} className={`flex w-full items-center gap-1.5 rounded px-2 py-1 text-left text-xs ${selectedPath === path ? 'bg-primary/10 text-primary' : 'text-muted hover:bg-elevated hover:text-canvas-fg'}`} onClick={() => { setSelectedPath(path); setView('diff') }}>
      <File size={13} /><span className="truncate">{path.split('/').at(-1)}</span>
    </button>)}
  </div>

  return <div className="mx-auto max-w-[1500px] space-y-4 p-3 md:p-5">
    <div className="flex flex-wrap items-center justify-between gap-3">
      <button className="btn btn-secondary h-8 px-3 text-xs" onClick={back}><ArrowLeft size={14} />{zh ? '返回个人活动' : 'Back to activity'}</button>
      {commit?.webUrl ? <a className="btn btn-secondary h-8 px-3 text-xs" href={commit.webUrl} target="_blank" rel="noreferrer"><ExternalLink size={14} />{zh ? `在 ${SOURCE_LABELS[commit.source]} 打开` : `Open in ${SOURCE_LABELS[commit.source]}`}</a> : null}
    </div>

    {commit ? <>
      <header className="border-b border-line pb-4">
        <div className="mb-2 flex items-center gap-2 text-xs text-muted"><Link className="text-primary hover:underline" to="/my-activity">{zh ? '个人活动' : 'My activity'}</Link><span>/</span><span>{commit.repositoryName}</span><span>/</span><span>{zh ? '提交' : 'Commit'}</span></div>
        <h1 className="break-words text-xl font-semibold text-canvas-fg">{commit.subject}</h1>
        <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-2 text-xs text-muted"><Badge tone="default">{commit.shortSha}</Badge><code>{commit.sha}</code><span>{new Date(commit.committedAt).toLocaleString()}</span>{detail ? <span><b className="text-ok">+{detail.added}</b> <b className="text-danger">-{detail.removed}</b> {zh ? '行' : 'lines'}</span> : null}</div>
      </header>

      {detail?.diffStatus === 'failed' ? <div role="status" className="border-l-2 border-danger px-3 py-2 text-sm text-danger">{zh ? '无法获取此提交的代码差异。可以在上方跳转到代码托管平台查看。' : 'Could not load this commit diff. Open it on the hosting platform to inspect the changes.'}</div> : null}
      {detail?.files.length ? <div className="grid min-h-[60vh] grid-cols-1 overflow-hidden rounded-md border border-line lg:grid-cols-[240px_minmax(0,1fr)]">
        <aside className="max-h-[38vh] overflow-auto border-b border-line bg-surface p-2 lg:max-h-[72vh] lg:border-b-0 lg:border-r" aria-label={zh ? '更改文件目录' : 'Changed files'}>
          <div className="mb-2 px-2 py-1 text-[11px] font-semibold uppercase text-muted">{zh ? `${detail.files.length} 个已更改文件` : `${detail.files.length} changed files`}</div>
          {renderTree(tree)}
        </aside>
        <section className="min-w-0 bg-canvas">
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line bg-elevated px-3 py-2">
            <code className="min-w-0 truncate text-xs text-canvas-fg">{selectedPath}</code>
            <div className="flex shrink-0 items-center gap-3 text-xs"><span><b className="text-ok">+{selectedFile?.added ?? 0}</b> / <b className="text-danger">-{selectedFile?.removed ?? 0}</b></span><div className="flex border-l border-line pl-2"><button className={`rounded px-2 py-1 ${view === 'diff' ? 'bg-primary/10 text-primary' : 'text-muted'}`} onClick={() => setView('diff')}>{zh ? '差异' : 'Diff'}</button><button className={`rounded px-2 py-1 ${view === 'file' ? 'bg-primary/10 text-primary' : 'text-muted'}`} onClick={() => setView('file')}>{zh ? '完整文件' : 'Full file'}</button></div></div>
          </div>
          {view === 'diff' ? selectedFile?.patch ? <pre className="max-h-[68vh] overflow-auto py-2 text-[11px] leading-5">
            {selectedFile.patch.split('\n').map((line, index) => <div key={index} className={`flex min-w-max ${line.startsWith('+') && !line.startsWith('+++') ? 'bg-ok/10 text-ok' : line.startsWith('-') && !line.startsWith('---') ? 'bg-danger/10 text-danger' : 'text-muted'}`}><span className="w-12 shrink-0 select-none px-2 text-right opacity-60">{line.startsWith('+') && !line.startsWith('+++') ? '+' : line.startsWith('-') && !line.startsWith('---') ? '-' : ' '}{index + 1}</span><span className="pr-5">{line || ' '}</span></div>)}
          </pre> : <div className="p-5 text-xs text-muted">{zh ? '此文件没有可展示的文本差异。' : 'No text diff is available for this file.'}</div> : loadingFile ? <div className="p-5 text-xs text-muted">{zh ? '正在读取完整文件…' : 'Loading full file...'}</div> : fileErrors[selectedPath] ? <div className="p-5 text-xs text-danger">{zh ? `无法读取完整文件：${fileErrors[selectedPath]}` : `Could not load full file: ${fileErrors[selectedPath]}`}</div> : <pre className="max-h-[68vh] overflow-auto py-2 text-[11px] leading-5 text-canvas-fg">
            {(fileContents[selectedPath] ?? '').split('\n').map((line, index) => <div key={index} className="flex min-w-max"><span className="sticky left-0 w-12 shrink-0 select-none bg-elevated px-2 text-right text-muted">{index + 1}</span><span className="whitespace-pre px-4">{line || ' '}</span></div>)}
          </pre>}
        </section>
      </div> : detail?.diffStatus !== 'failed' ? <div className="border-y border-line py-8 text-center text-sm text-muted">{busy ? (zh ? '正在获取提交差异…' : 'Loading commit diff...') : (zh ? '没有可展示的文件差异。' : 'No file diff is available.')}</div> : null}
    </> : <div className="border-y border-line py-12 text-center"><h1 className="text-lg font-semibold text-canvas-fg">{busy ? (zh ? '正在加载提交…' : 'Loading commit...') : (zh ? '未找到此提交' : 'Commit not found')}</h1>{!busy ? <button className="mt-4 btn btn-secondary h-8 px-3 text-xs" onClick={() => navigate('/my-activity')}>{zh ? '返回个人活动' : 'Return to activity'}</button> : null}</div>}
  </div>
}
