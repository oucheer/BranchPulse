import { useEffect, useMemo, useRef, useState } from 'react'
import { Bot, Check, Loader2, LockKeyhole, Plus, Send, Settings2, ShieldCheck, Trash2, Wrench } from 'lucide-react'
import { useAppStore } from '../stores/appStore'
import { Badge, Card } from '../components/ui'
import type { AgentMessage, AgentRun, AgentSession, AiProviderConfig } from '@shared/types'

const emptyConfig: AiProviderConfig = { providerType: 'openai-compatible', baseUrl: '', model: '', apiMode: 'chat-completions', temperature: 0.2, maxTokens: 2000, timeoutMs: 30000, enabled: false, hasApiKey: false }

export default function Agent(): JSX.Element {
  const selectedRepositoryIds = useAppStore((s) => s.selectedRepositoryIds)
  const repositories = useAppStore((s) => s.repositories)
  const toast = useAppStore((s) => s.toast)
  const [session, setSession] = useState<AgentSession | null>(null)
  const [sessions, setSessions] = useState<AgentSession[]>([])
  const [loadingHistory, setLoadingHistory] = useState(true)
  const historyRequest = useRef(0)
  const [input, setInput] = useState('')
  const [sending, setSending] = useState(false)
  const [run, setRun] = useState<AgentRun | null>(null)
  const [runError, setRunError] = useState('')
  const [config, setConfig] = useState<AiProviderConfig>(emptyConfig)
  const [apiKey, setApiKey] = useState('')
  const [showSettings, setShowSettings] = useState(false)
  const scope = useMemo(() => repositories.filter((repo) => selectedRepositoryIds.includes(repo.id)), [repositories, selectedRepositoryIds])

  useEffect(() => { void window.gitmanager.getAiProviderConfig().then(setConfig).catch(() => undefined) }, [])
  useEffect(() => {
    let active = true
    const initialize = async (): Promise<void> => {
      try {
        const items = await window.gitmanager.listAgentSessions()
        if (!active) return
        const selected = items[0] ?? null
        const runs = selected ? await window.gitmanager.listAgentRuns(selected.id) : []
        if (!active) return
        setSessions(items)
        setSession(selected)
        setRun(runs[0] ?? null)
      } catch (err) {
        if (active) setRunError(`会话记录加载失败：${err instanceof Error ? err.message : String(err)}`)
      } finally {
        if (active) setLoadingHistory(false)
      }
    }
    void initialize()
    return () => { active = false }
  }, [])

  const createSession = async (): Promise<void> => {
    if (sending || loadingHistory) return
    const request = ++historyRequest.current
    setLoadingHistory(true)
    try {
      if (request !== historyRequest.current) return
      setSession(null)
      setRun(null)
      setRunError('')
      setInput('')
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), 'error')
    } finally {
      if (request === historyRequest.current) setLoadingHistory(false)
    }
  }
  const deleteSession = async (): Promise<void> => {
    if (!session || sending || loadingHistory || !window.confirm(`删除会话“${session.title}”及其全部记录？`)) return
    setLoadingHistory(true)
    try {
      await window.gitmanager.deleteAgentSession(session.id)
      const items = await window.gitmanager.listAgentSessions()
      setSessions(items)
      setSession(items[0] ?? null)
      setRun(null)
      setRunError('')
      setInput('')
    } catch (err) { toast(err instanceof Error ? err.message : String(err), 'error') }
    finally { setLoadingHistory(false) }
  }

  const selectSession = async (id: string): Promise<void> => {
    if (sending) return
    const request = ++historyRequest.current
    setLoadingHistory(true)
    try {
      const [selected, runs] = await Promise.all([window.gitmanager.getAgentSession(id), window.gitmanager.listAgentRuns(id)])
      if (request !== historyRequest.current) return
      if (!selected) throw new Error('会话不存在。')
      setSession(selected)
      setRunError('')
      setRun(runs[0] ?? null)
      setInput('')
    } catch (err) {
      if (request === historyRequest.current) toast(err instanceof Error ? err.message : String(err), 'error')
    } finally {
      if (request === historyRequest.current) setLoadingHistory(false)
    }
  }
  const send = async (): Promise<void> => {
    if (!input.trim() || sending || loadingHistory) return
    const content = input.trim(); setInput(''); setSending(true)
    setRunError('')
    let activeSession = session
    try {
      activeSession ??= await window.gitmanager.createAgentSession({ page: 'agent', repositoryIds: selectedRepositoryIds })
      setSession(activeSession)
      await window.gitmanager.sendAgentMessage(activeSession.id, content, { page: 'agent', repositoryIds: selectedRepositoryIds })
      const items = await window.gitmanager.listAgentSessions()
      setSessions(items)
      setSession(items.find((item) => item.id === activeSession?.id) ?? activeSession)
      const runs = await window.gitmanager.listAgentRuns(activeSession.id); setRun(runs[0] ?? null)
    }
    catch (err) {
      const error = err instanceof Error ? err.message : String(err)
      setRunError(error); toast(error, 'error'); setInput(content)
      const items = await window.gitmanager.listAgentSessions().catch(() => null)
      if (items) { setSessions(items); setSession(items.find((item) => item.id === activeSession?.id) ?? activeSession) }
      const runs = activeSession ? await window.gitmanager.listAgentRuns(activeSession.id).catch(() => []) : []
      setRun(runs[0] ?? null)
    } finally { setSending(false) }
  }
  const saveProvider = async (): Promise<void> => { try { const saved = await window.gitmanager.saveAiProviderConfig({ ...config, apiKey }); setConfig(saved); setApiKey(''); toast('AI Agent 配置已保存', 'success') } catch (err) { toast(err instanceof Error ? err.message : String(err), 'error') } }

  return <div className="flex h-full min-h-0 flex-col gap-4">
    <div className="flex items-center justify-between gap-2 text-xs text-muted"><span>受控 Git 命令 · 禁止删除分支</span><button className="btn" title="删除当前会话" aria-label="删除当前会话" disabled={!session || sending || loadingHistory} onClick={() => void deleteSession()}><Trash2 size={14} /></button></div>
    <div className="flex flex-wrap items-center justify-between gap-3"><div><h1 className="text-lg font-bold text-canvas-fg">AI Agent</h1><div className="mt-1 flex items-center gap-2 text-xs text-muted"><ShieldCheck size={13} className="text-ok" />数据查询 · 受控 Git 命令 · 报告生成 <Badge tone="ok">禁止删除分支</Badge></div></div><div className="flex gap-2"><button className="btn" onClick={() => void createSession()}><Plus size={14} /> 新会话</button><button className="btn" onClick={() => setShowSettings((v) => !v)}><Settings2 size={14} /> Provider</button></div></div>
    {showSettings ? <Card className="p-4"><div className="grid grid-cols-1 gap-3 md:grid-cols-2"><label className="label">Base URL<input className="input mt-1 normal-case" value={config.baseUrl} onChange={(e) => setConfig({ ...config, baseUrl: e.target.value })} placeholder="https://api.openai.com/v1" /></label><label className="label">Model<input className="input mt-1 normal-case" value={config.model} onChange={(e) => setConfig({ ...config, model: e.target.value })} placeholder="gpt-4o-mini" /></label><label className="label">API Key<input className="input mt-1 normal-case" type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder={config.hasApiKey ? '已保存，留空保持不变' : '输入 API Key'} /></label><label className="label">Max Tokens<input className="input mt-1 normal-case" type="number" value={config.maxTokens} onChange={(e) => setConfig({ ...config, maxTokens: Number(e.target.value) })} /></label></div><div className="mt-3 flex items-center gap-2"><button className="btn btn-primary" onClick={() => void saveProvider()}><Check size={14} /> 保存配置</button><button className="btn" onClick={() => void window.gitmanager.testAiProviderConnection({ ...config, apiKey }).then((result) => toast(result.message, result.ok ? 'success' : 'error'))}><LockKeyhole size={14} /> 测试连接</button><label className="ml-auto flex items-center gap-2 text-sm text-muted"><input type="checkbox" checked={config.enabled} onChange={(e) => setConfig({ ...config, enabled: e.target.checked })} />启用 Agent</label></div></Card> : null}
    <div className="grid min-h-0 flex-1 grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1fr)_17rem]"><Card className="flex min-h-0 flex-col overflow-hidden"><div className="flex items-center gap-2 border-b border-line px-4 py-3 text-sm font-semibold text-canvas-fg"><Bot size={16} className="text-primary" />对话 <span className="ml-auto text-xs font-normal text-muted">{loadingHistory ? <><Loader2 size={12} className="mr-1 inline animate-spin" />加载会话</> : sending ? <><Loader2 size={12} className="mr-1 inline animate-spin" />查询中 · {scope.length} 个仓库</> : run ? `Run ${run.status}` : ''}</span></div><div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-4">{runError ? <div role="alert" className="rounded-md border border-danger/30 bg-danger/5 p-3 text-sm text-danger">{runError}</div> : null}{session?.messages.length ? session.messages.map((message) => <Message key={message.id} message={message} />) : <div className="flex h-full items-center justify-center text-sm text-muted">输入问题，查询当前仓库范围内的 GitLab 数据。</div>}</div><div className="border-t border-line p-3"><div className="flex items-end gap-2"><textarea className="input min-h-[44px] resize-none" value={input} onChange={(e) => setInput(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void send() } }} placeholder="例如：统计张三本周提交了多少代码" /><button className="btn btn-primary h-11 px-3" disabled={sending || loadingHistory || !input.trim()} onClick={() => void send()} aria-label="发送"><Send size={15} /></button></div></div></Card><Card className="min-h-0 overflow-y-auto p-4"><div className="mb-3 flex items-center justify-between gap-2 text-sm font-semibold text-canvas-fg"><span>会话记录</span><span className="text-xs font-normal text-muted">{sessions.length} 个</span></div><div className="space-y-1">{sessions.map((item) => <button key={item.id} className={`w-full rounded-md border px-2 py-2 text-left text-xs ${item.id === session?.id ? 'border-primary bg-primary/10 text-canvas-fg' : 'border-transparent bg-elevated text-muted hover:text-canvas-fg'}`} onClick={() => void selectSession(item.id)} disabled={sending || loadingHistory}><div className="truncate font-medium">{item.title || '新会话'}</div><div className="mt-1 text-[11px] opacity-70">{formatSessionDate(item.updatedAt)} · {item.messages.length} 条消息</div></button>)}</div><div className="mb-3 mt-5 flex items-center gap-2 border-t border-line pt-3 text-sm font-semibold text-canvas-fg"><LockKeyhole size={15} className="text-ok" />查询范围</div><div className="text-xs text-muted">Run Scope · {run?.scope.length ?? selectedRepositoryIds.length} 个仓库</div><div className="mt-2 space-y-1">{scope.length ? scope.map((repo) => <div key={repo.id} className="truncate rounded-md bg-elevated px-2 py-1.5 text-xs text-canvas-fg">{repo.name}</div>) : <div className="text-xs text-warn">未选择仓库</div>}</div><div className="mt-5 border-t border-line pt-3 text-xs leading-5 text-muted">Git 命令仅用于本地查询；删除分支、修改引用、任意 Shell 和 SQL 均被禁止。</div></Card></div>
  </div>
}

function Message({ message }: { message: AgentMessage }): JSX.Element { return <div className={message.role === 'user' ? 'ml-8 rounded-md bg-primary/10 p-3 text-sm text-canvas-fg' : 'mr-8 rounded-md border border-line bg-surface-elevated p-3 text-sm text-canvas-fg'}><div className="whitespace-pre-wrap">{message.content}</div>{message.toolTraces.length ? <div className="mt-3 border-t border-line pt-2 text-xs text-muted"><div className="mb-1 flex items-center gap-1"><Wrench size={12} />数据来源</div>{message.toolTraces.map((trace) => <div key={trace.id} className="flex items-center gap-1.5"><span className={trace.status === 'success' ? 'text-ok' : 'text-danger'}>{trace.status === 'success' ? '✓' : '!'}</span>{trace.toolName}{trace.durationMs != null ? ` · ${trace.durationMs}ms` : ''}</div>)}</div> : null}</div> }

function formatSessionDate(value: string): string {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString()
}
