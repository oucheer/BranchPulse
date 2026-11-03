import { useCallback, useEffect, useRef, useState } from 'react'
import { Bot, KeyRound, MessageSquarePlus, Plus, Save, Send, Trash2, Wifi } from 'lucide-react'
import type { PersonalAiConfig, PersonalAiConversation, PersonalAiMessage, PersonalAiTask } from '@shared/types'
import { useAppStore } from '../stores/appStore'
import { Card } from '../components/ui'
import { readMyActivityMonths } from '../stores/appStore'

const suggestions = ['我上周做了什么？', '最近我主要修改了哪些模块？', '哪些 MR 还没有合并？', '我最近的代码返工情况如何？', '帮我生成研发周报', '我最近三个月的研发趋势是什么？']
const ACTIVE_CONVERSATION_KEY = 'gitmanager:personal-ai-active:v1'
const CONFIG_DRAFT_KEY = 'gitmanager:personal-ai-config-draft:v1'

function readConfigDraft(identity: string): { baseUrl: string; model: string } {
  try {
    const saved = JSON.parse(localStorage.getItem(`${CONFIG_DRAFT_KEY}:${identity}`) ?? 'null') as { baseUrl?: string; model?: string } | null
    return { baseUrl: saved?.baseUrl ?? '', model: saved?.model ?? '' }
  } catch {
    return { baseUrl: '', model: '' }
  }
}

export default function PersonalAi(): JSX.Element {
  const role = useAppStore((s) => s.role)
  const language = useAppStore((s) => s.language)
  const toast = useAppStore((s) => s.toast)
  const session = useAppStore((s) => s.session)
  const identity = session ? `${session.email.toLowerCase()}:${session.source ?? ''}:${session.accountId ?? session.username.toLowerCase()}` : ''
  const zh = language === 'zh'
  const [months] = useState(() => readMyActivityMonths(session))
  const [config, setConfig] = useState<PersonalAiConfig>({ baseUrl: '', model: '', hasApiKey: false })
  const [draft, setDraft] = useState(() => ({ ...readConfigDraft(identity), apiKey: '' }))
  const [conversations, setConversations] = useState<PersonalAiConversation[]>([])
  const [activeId, setActiveId] = useState('')
  const [messages, setMessages] = useState<PersonalAiMessage[]>([])
  const [question, setQuestion] = useState('')
  const [busy, setBusy] = useState(false)
  const [testing, setTesting] = useState(false)
  const [loading, setLoading] = useState(true)
  const scroller = useRef<HTMLDivElement>(null)

  const refreshConversations = useCallback(async (): Promise<PersonalAiConversation[]> => {
    const result = await window.gitmanager.listPersonalAiConversations()
    setConversations(result)
    return result
  }, [])

  const refreshMessages = useCallback(async (id: string): Promise<void> => {
    if (!id) { setMessages([]); setBusy(false); return }
    const list = await window.gitmanager.listPersonalAiMessages(id)
    setMessages(list)
    const items = await window.gitmanager.listPersonalAiConversations()
    setConversations(items)
    setBusy(items.find((conversation) => conversation.id === id)?.status === 'running')
  }, [])

  useEffect(() => {
    if (role !== 'user' || !identity) return
    let cancelled = false
    setLoading(true)
    void Promise.all([window.gitmanager.getPersonalAiConfig(), window.gitmanager.listPersonalAiConversations()]).then(async ([saved, list]) => {
      if (cancelled) return
      setConfig(saved)
      const localDraft = readConfigDraft(identity)
      setDraft((current) => ({ ...current, baseUrl: saved.baseUrl || localDraft.baseUrl, model: saved.model || localDraft.model }))
      setConversations(list)
      const selected = localStorage.getItem(`${ACTIVE_CONVERSATION_KEY}:${identity}`)
      let target = list.find((item) => item.id === selected)?.id ?? list[0]?.id ?? ''
      if (!target) {
        const created = await window.gitmanager.createPersonalAiConversation()
        if (cancelled) return
        target = created.id
        setConversations((current) => [created, ...current])
      }
      setActiveId(target)
      localStorage.setItem(`${ACTIVE_CONVERSATION_KEY}:${identity}`, target)
      const stored = await window.gitmanager.listPersonalAiMessages(target)
      if (cancelled) return
      setMessages(stored)
      setBusy(list.find((item) => item.id === target)?.status === 'running')
    }).catch((err: unknown) => toast(err instanceof Error ? err.message : String(err), 'error')).finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [role, identity, toast])

  useEffect(() => {
    if (!identity) return
    try {
      localStorage.setItem(`${CONFIG_DRAFT_KEY}:${identity}`, JSON.stringify({ baseUrl: draft.baseUrl, model: draft.model }))
    } catch {
      // Server-side saved settings remain available when browser storage is full.
    }
  }, [identity, draft.baseUrl, draft.model])

  useEffect(() => {
    if (!activeId || !busy) return
    let alive = true
    const timer = window.setInterval(() => {
      void Promise.all([window.gitmanager.listPersonalAiMessages(activeId), window.gitmanager.listPersonalAiConversations()]).then(([list, items]) => {
        if (!alive) return
        setMessages(list)
        setConversations(items)
        setBusy(items.find((item) => item.id === activeId)?.status === 'running')
      }).catch(() => undefined)
    }, 1200)
    return () => { alive = false; window.clearInterval(timer) }
  }, [activeId, busy])

  useEffect(() => { scroller.current?.scrollTo({ top: scroller.current.scrollHeight, behavior: 'smooth' }) }, [messages, busy])

  const selectConversation = async (id: string): Promise<void> => {
    setActiveId(id)
    if (identity) localStorage.setItem(`${ACTIVE_CONVERSATION_KEY}:${identity}`, id)
    await refreshMessages(id)
  }

  const createConversation = async (): Promise<void> => {
    try {
      const conversation = await window.gitmanager.createPersonalAiConversation()
      setConversations((current) => [conversation, ...current])
      await selectConversation(conversation.id)
    } catch (err) { toast(err instanceof Error ? err.message : String(err), 'error') }
  }

  const deleteConversation = async (conversation: PersonalAiConversation): Promise<void> => {
    try {
      await window.gitmanager.deletePersonalAiConversation(conversation.id)
      const remaining = await refreshConversations()
      if (activeId === conversation.id) {
        let next = remaining[0]
        if (!next) next = await window.gitmanager.createPersonalAiConversation()
        if (!remaining.length) setConversations([next])
        await selectConversation(next.id)
      }
    } catch (err) { toast(err instanceof Error ? err.message : String(err), 'error') }
  }

  const save = async (): Promise<void> => {
    try {
      const saved = await window.gitmanager.savePersonalAiConfig(draft)
      setConfig(saved)
      setDraft((current) => ({ ...current, apiKey: '' }))
      toast(zh ? 'AI 配置已保存' : 'AI settings saved', 'success')
    } catch (err) { toast(err instanceof Error ? err.message : String(err), 'error') }
  }

  const test = async (): Promise<void> => {
    setTesting(true)
    try { const result = await window.gitmanager.testPersonalAiConnection(); toast(result.message, result.ok ? 'success' : 'error') }
    catch (err) { toast(err instanceof Error ? err.message : String(err), 'error') }
    finally { setTesting(false) }
  }

  const ask = async (value = question): Promise<void> => {
    const prompt = value.trim()
    if (!prompt || !activeId || busy) return
    if (!config.hasApiKey) { toast(zh ? '请先保存模型配置，再开始对话。' : 'Save your model configuration before chatting.', 'error'); return }
    setQuestion('')
    setBusy(true)
    try {
      const task: PersonalAiTask = await window.gitmanager.startPersonalAiChat(activeId, prompt, months)
      setMessages(await window.gitmanager.listPersonalAiMessages(activeId))
      void task
      await refreshConversations()
    } catch (err) { setQuestion((current) => current || prompt); setBusy(false); toast(err instanceof Error ? err.message : String(err), 'error') }
  }

  if (role !== 'user') return <div className="text-sm text-muted">{zh ? '此页面仅对普通用户开放。' : 'Available to regular users only.'}</div>
  return <div className="space-y-4">
    <header><h1 className="text-lg font-bold text-canvas-fg">{zh ? 'AI 研发助手' : 'AI Development Assistant'}</h1><p className="mt-1 text-xs text-muted">{zh ? '只读分析个人 Git 数据；会话和进行状态会自动保存' : 'Read-only Git activity analysis with saved conversations and task status'}</p></header>
    <Card className="p-4">
      <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold text-canvas-fg"><KeyRound size={15} />{zh ? '模型配置' : 'Model configuration'}</h2>
      <div className="grid gap-3 md:grid-cols-3">
        <label className="text-xs text-muted">API URL<input className="input mt-1 w-full" value={draft.baseUrl} onChange={(e) => setDraft({ ...draft, baseUrl: e.target.value })} placeholder="https://api.example.com/v1" /></label>
        <label className="text-xs text-muted">{zh ? '模型' : 'Model'}<input className="input mt-1 w-full" value={draft.model} onChange={(e) => setDraft({ ...draft, model: e.target.value })} placeholder="model-name" /></label>
        <label className="text-xs text-muted">API Key<input className="input mt-1 w-full" type="password" autoComplete="new-password" value={draft.apiKey} onChange={(e) => setDraft({ ...draft, apiKey: e.target.value })} placeholder={config.hasApiKey ? (zh ? '密钥已加密保存，留空保持不变' : 'Saved securely; leave blank to keep') : 'sk-...'} /></label>
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-2"><button className="btn btn-primary" disabled={testing} onClick={() => void save()}><Save size={14} />{zh ? '保存' : 'Save'}</button><button className="btn btn-secondary" disabled={testing || !config.hasApiKey} onClick={() => void test()}><Wifi size={14} />{testing ? (zh ? '连接中…' : 'Connecting…') : (zh ? '测试连接' : 'Test connection')}</button><span className="text-xs text-muted">{config.hasApiKey ? (zh ? '配置按个人账号保存在服务端；密钥加密且不会回传浏览器。' : 'Settings are private to your account; the key is encrypted server-side.') : (zh ? '填写 API URL、模型和 API Key 后即可使用助手。' : 'Enter API URL, model and API key to enable the assistant.')}</span></div>
    </Card>

    <div className="grid min-h-[520px] gap-3 lg:grid-cols-[220px_minmax(0,1fr)]">
      <Card className="flex min-h-0 flex-col p-3">
        <button className="btn btn-secondary mb-3 w-full" onClick={() => void createConversation()}><MessageSquarePlus size={14} />{zh ? '新建会话' : 'New chat'}</button>
        <div className="min-h-0 flex-1 space-y-1 overflow-auto">{conversations.map((conversation) => <div key={conversation.id} className={`flex items-center gap-1 rounded-md px-2 ${activeId === conversation.id ? 'bg-primary/10' : 'hover:bg-elevated'}`}>
          <button className="min-w-0 flex-1 py-2 text-left" onClick={() => void selectConversation(conversation.id)}><span className="block truncate text-xs text-canvas-fg">{conversation.title}</span><span className={`mt-1 block text-[10px] ${conversation.status === 'running' ? 'text-primary' : 'text-muted'}`}>{conversation.status === 'running' ? (zh ? '正在生成…' : 'Running…') : conversation.status === 'failed' ? (zh ? '上次失败' : 'Failed') : new Date(conversation.updatedAt).toLocaleString()}</span></button>
          <button className="btn btn-ghost h-7 w-7 p-0" title={zh ? '删除会话' : 'Delete conversation'} onClick={() => void deleteConversation(conversation)}><Trash2 size={13} /></button>
        </div>)}</div>
      </Card>

      <Card className="flex min-h-0 flex-col p-4">
        <div className="mb-3 flex items-center justify-between gap-2"><h2 className="flex items-center gap-2 text-sm font-semibold text-canvas-fg"><Bot size={15} />{zh ? '个人数据问答' : 'Ask about your activity'}</h2><span className="text-xs text-muted">{zh ? `使用个人活动页的最近 ${months} 个月范围` : `Using your ${months}-month activity range`}</span></div>
        <div className="mb-3 flex flex-wrap gap-1.5">{suggestions.map((item) => <button key={item} className="btn btn-ghost h-auto px-2 py-1 text-xs" disabled={busy || !config.hasApiKey} onClick={() => void ask(item)}><Plus size={12} />{item}</button>)}</div>
        <div ref={scroller} className="min-h-[270px] flex-1 space-y-3 overflow-y-auto border-y border-line py-3">
          {loading ? <div className="text-xs text-muted">{zh ? '正在恢复会话…' : 'Restoring chat…'}</div> : null}
          {!loading && !messages.length ? <div className="text-xs text-muted">{zh ? '选择一个建议问题，或直接输入关于个人 Git 活动的问题。' : 'Choose a suggested question or ask about your Git activity.'}</div> : null}
          {messages.map((message, index) => <div key={message.id ?? index} className={message.role === 'user' ? 'ml-8 whitespace-pre-wrap rounded-md bg-primary/10 p-3 text-sm text-canvas-fg' : `mr-4 whitespace-pre-wrap p-2 text-sm ${message.status === 'failed' ? 'text-danger' : 'text-canvas-fg'}`}>{message.content}</div>)}
          {busy ? <div role="status" className="flex items-center gap-2 text-xs text-primary"><span className="h-2 w-2 animate-pulse rounded-full bg-primary" />{zh ? '正在查询个人数据并生成回答，切换页面不会中断…' : 'Querying your data; this task continues in the background…'}</div> : null}
        </div>
        <form className="mt-3 flex gap-2" onSubmit={(e) => { e.preventDefault(); void ask() }}><input className="input min-w-0 flex-1" value={question} onChange={(e) => setQuestion(e.target.value)} placeholder={zh ? '继续追问个人研发数据' : 'Ask a follow-up'} /><button type="submit" className="btn btn-primary" disabled={busy || loading || !activeId || !config.hasApiKey || !question.trim()} aria-label={zh ? '发送问题' : 'Send question'} title={!config.hasApiKey ? (zh ? '请先配置并保存 API 密钥' : 'Configure and save an API key first') : undefined}><Send size={15} /></button></form>
      </Card>
    </div>
  </div>
}
