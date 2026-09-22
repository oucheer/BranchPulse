import { useEffect, useState } from 'react'
import { ArrowUp, ArrowDown, Plus, Trash2, CheckCircle } from 'lucide-react'
import { useAppStore, tr } from '../stores/appStore'
import { Badge, Card, EmptyState, Modal, Toggle } from '../components/ui'
import type { NamingRule } from '@shared/types'

const emptyRule = (repositoryId: string | null): Omit<NamingRule, 'id' | 'enabled'> => ({
  repositoryId,
  name: '',
  pattern: '',
  type: 'glob',
  mode: 'allow',
  description: '',
  priority: 50
})

const namingTemplates = [
  {
    label: '功能分支（字母、数字、点、下划线、短横线）',
    name: '功能分支',
    pattern: '^feature\\/[a-z0-9._-]+$',
    description: 'feature/ 后使用小写字母、数字、点、下划线或短横线'
  },
  {
    label: '修复分支',
    name: '修复分支',
    pattern: '^(bugfix|hotfix)\\/[a-z0-9._-]+$',
    description: 'bugfix/ 或 hotfix/ 后使用小写字母、数字、点、下划线或短横线'
  },
  {
    label: '发布 / 维护分支',
    name: '发布维护分支',
    pattern: '^(release|chore|docs)\\/[a-z0-9._-]+$',
    description: 'release、chore 或 docs 前缀后使用小写字母、数字、点、下划线或短横线'
  },
  {
    label: '允许中文的功能分支',
    name: '允许中文的功能分支',
    pattern: '^feature\\/[\\p{Script=Han}a-z0-9._-]+$',
    description: 'feature/ 后允许中文、小写字母、数字、点、下划线或短横线'
  }
]

export default function NamingRules(): JSX.Element {
  const repositories = useAppStore((s) => s.repositories)
  const selectedRepositoryIds = useAppStore((s) => s.selectedRepositoryIds)
  const toast = useAppStore((s) => s.toast)
  const refresh = useAppStore((s) => s.refresh)
  const language = useAppStore((s) => s.language)
  const zh = language === 'zh'
  const [editRule, setEditRule] = useState<Partial<NamingRule> & { id?: string } | null>(null)
  const [validateName, setValidateName] = useState('')
  const [validationResult, setValidationResult] = useState<{ status: string; ruleName?: string; reason?: string } | null>(null)
  const [validateRepositoryId, setValidateRepositoryId] = useState<string | null>(null)
  // 命名规则按仓库严格隔离：这里为每个勾选仓库分别加载规则，分组展示。
  const [rulesByRepository, setRulesByRepository] = useState<Record<string, NamingRule[]>>({})
  const scopedRepositories = repositories.filter((repository) => selectedRepositoryIds.includes(repository.id))
  const noSelection = scopedRepositories.length === 0
  const effectiveValidateRepositoryId = scopedRepositories.some((repository) => repository.id === validateRepositoryId)
    ? validateRepositoryId
    : scopedRepositories[0]?.id ?? null

  const loadRules = async (): Promise<void> => {
    const entries = await Promise.all(
      scopedRepositories.map(async (repository) => [repository.id, await window.gitmanager.listNamingRules(repository.id)] as const)
    )
    setRulesByRepository(Object.fromEntries(entries))
  }

  useEffect(() => {
    void loadRules()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedRepositoryIds.join(','), repositories.length])

  const reload = async (): Promise<void> => {
    await loadRules()
    void refresh()
  }

  const save = async (rule: Partial<NamingRule> & { id?: string }): Promise<void> => {
    if (!rule.repositoryId) {
      toast('未选择仓库：请先勾选仓库', 'warn')
      return
    }
    try {
      await window.gitmanager.saveNamingRule(rule)
      toast(tr('saved'), 'success')
      setEditRule(null)
      await reload()
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), 'error')
    }
  }

  const remove = async (id: string, repositoryId: string): Promise<void> => {
    try {
      await window.gitmanager.deleteNamingRule(id, repositoryId)
      toast('Rule deleted', 'success')
      await reload()
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), 'error')
    }
  }

  const reorder = async (id: string, direction: -1 | 1, repositoryId: string): Promise<void> => {
    try {
      await window.gitmanager.reorderNamingRule(id, direction, repositoryId)
      await reload()
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), 'error')
    }
  }

  const validate = async (repositoryId: string): Promise<void> => {
    if (!validateName) return
    try {
      const result = await window.gitmanager.validateBranchName(validateName, repositoryId)
      setValidationResult(result)
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), 'error')
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-bold text-canvas-fg">
          {tr('namingRules')}
          <span className="ml-2 text-sm font-medium text-muted">
            {noSelection ? '未选择仓库' : `按仓库隔离（勾选 ${scopedRepositories.length} 个仓库）`}
          </span>
        </h1>
        <button
          className="btn btn-primary"
          disabled={noSelection}
          title={noSelection ? '未选择仓库：请先勾选仓库' : undefined}
          onClick={() => setEditRule({ ...emptyRule(scopedRepositories[0]?.id ?? null) })}
        >
          <Plus size={15} /> {tr('addRule')}
        </button>
      </div>

      {noSelection ? (
        <div className="rounded-md border border-warn/40 bg-warn/10 px-4 py-2 text-xs text-warn">
          未选择仓库：命名规则按仓库隔离保存，请先在仓库页或顶栏勾选仓库。
        </div>
      ) : null}

      <Card className="p-4">
        <div className="mb-3 rounded-md border border-line bg-surface/60 p-3 text-xs leading-relaxed text-muted">
          <div className="mb-1 text-sm font-semibold text-canvas-fg">命名规则说明</div>
          常用前缀是 <span className="font-mono">feature/、bugfix/、hotfix/、release/、chore/、docs/</span>。
          基础规则要求：前缀后必须有具体描述；描述使用小写字母、数字、点、下划线或短横线；不能包含空格或连续斜杠；不能以 <span className="font-mono">/</span> 或 <span className="font-mono">-</span> 开头，也不能以 <span className="font-mono">/</span> 结尾。
          <span className="font-mono">main</span> 和 <span className="font-mono">develop</span> 默认豁免。
          基础前缀规则不支持中文；如需支持中文，必须使用下方允许中文的 regex / unicode 模板。
        </div>
        <div className="mb-2 text-sm font-semibold text-canvas-fg">{tr('validate')}</div>
        {noSelection ? (
          <div className="text-xs text-muted">未选择仓库，无法校验分支命名。</div>
        ) : (
          <div className="space-y-2">
            {scopedRepositories.length > 1 ? (
              <select
                className="input"
                value={effectiveValidateRepositoryId ?? ''}
                onChange={(e) => { setValidateRepositoryId(e.target.value); setValidationResult(null) }}
              >
                {scopedRepositories.map((repo) => <option key={repo.id} value={repo.id}>{repo.name}</option>)}
              </select>
            ) : null}
            <div className="flex gap-2">
              <input
                className="input flex-1"
                placeholder="feature/my-branch"
                value={validateName}
                onChange={(e) => { setValidateName(e.target.value); setValidationResult(null) }}
                onKeyDown={(e) => { if (e.key === 'Enter') void validate(effectiveValidateRepositoryId ?? scopedRepositories[0]!.id) }}
              />
              <button className="btn" onClick={() => void validate(effectiveValidateRepositoryId ?? scopedRepositories[0]!.id)}>
                <CheckCircle size={14} /> {tr('validate')}
              </button>
            </div>
          </div>
        )}
        {validationResult ? (
          <div className="mt-2 space-y-1">
            <div className={`text-sm font-medium ${validationResult.status === 'valid' ? 'text-ok' : validationResult.status === 'excluded' ? 'text-warn' : 'text-danger'}`}>
              {validationResult.status === 'valid'
                ? (zh ? '✔ 命名合规' : '✔ Valid')
                : validationResult.status === 'excluded'
                  ? (zh ? '⚠ 已豁免' : '⚠ Excluded')
                  : (zh ? '✖ 命名不规范' : '✖ Invalid')}
              {validationResult.ruleName ? ` — ${validationResult.ruleName}` : ''}
            </div>
            {validationResult.reason ? (
              <div className={`rounded-md border px-3 py-2 text-xs leading-relaxed ${validationResult.status === 'invalid' ? 'border-danger/40 bg-danger/10 text-danger' : 'border-line bg-surface/60 text-muted'}`}>
                {zh ? '原因：' : 'Reason: '}
                {validationResult.reason}
              </div>
            ) : null}
          </div>
        ) : null}
      </Card>

      {noSelection ? (
        <EmptyState title="未选择仓库" description="请先在仓库页或顶栏勾选仓库，命名规则按仓库隔离展示。" />
      ) : (
        <div className="space-y-4">
          {scopedRepositories.map((repository) => {
            const rules = rulesByRepository[repository.id] ?? []
            return (
              <div key={repository.id} className="space-y-2">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2 text-sm font-semibold text-canvas-fg">
                    <span>{repository.name}</span>
                    <Badge>{rules.length} 条规则</Badge>
                  </div>
                  <button className="btn text-xs" onClick={() => setEditRule({ ...emptyRule(repository.id) })}>
                    <Plus size={13} /> 为该仓库添加规则
                  </button>
                </div>
                {rules.length === 0 ? (
                  <Card className="p-3 text-xs text-muted">该仓库暂无命名规则，只校验基础格式。</Card>
                ) : (
                  rules.map((rule, idx) => (
                    <Card key={rule.id} className="flex items-center gap-3 p-3">
                      <div className="flex flex-col gap-0.5">
                        <button className="btn px-1 py-0.5 text-[11px]" disabled={idx === 0} onClick={() => void reorder(rule.id, -1, repository.id)}>
                          <ArrowUp size={12} />
                        </button>
                        <button className="btn px-1 py-0.5 text-[11px]" disabled={idx === rules.length - 1} onClick={() => void reorder(rule.id, 1, repository.id)}>
                          <ArrowDown size={12} />
                        </button>
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <span className="text-sm font-semibold text-canvas-fg">{rule.name}</span>
                          <Badge tone={rule.mode === 'allow' ? 'ok' : 'warn'}>{rule.mode}</Badge>
                          <Badge>{rule.type}</Badge>
                          <Toggle checked={rule.enabled} onChange={async (v) => { await save({ ...rule, enabled: v, repositoryId: repository.id }) }} />
                        </div>
                        <div className="mt-0.5 font-mono text-xs text-muted">{rule.pattern}</div>
                        {rule.description ? <div className="mt-0.5 text-xs text-muted">{rule.description}</div> : null}
                      </div>
                      <div className="flex items-center gap-1">
                        <button className="btn px-2" onClick={() => setEditRule({ ...rule, repositoryId: repository.id })}>{tr('edit')}</button>
                        <button className="btn px-2" onClick={() => void remove(rule.id, repository.id)}><Trash2 size={13} className="text-danger" /></button>
                      </div>
                    </Card>
                  ))
                )}
              </div>
            )
          })}
        </div>
      )}

      <Modal
        open={editRule !== null}
        title={editRule?.id ? 'Edit rule' : 'Add rule'}
        onClose={() => setEditRule(null)}
        footer={
          <div className="flex gap-2">
            <button className="btn" onClick={() => setEditRule(null)}>{tr('cancel')}</button>
            <button className="btn btn-primary" onClick={() => editRule && void save(editRule)}>{tr('save')}</button>
          </div>
        }
      >
        <div className="space-y-4">
          <div>
            <div className="label mb-1">{tr('name')}</div>
            <input className="input" value={editRule?.name ?? ''} onChange={(e) => setEditRule({ ...editRule, name: e.target.value })} />
          </div>
          <div>
            <div className="label mb-1">{tr('pattern')}</div>
            <select
              className="input mb-2"
              value=""
              onChange={(e) => {
                const template = namingTemplates.find((item) => item.label === e.target.value)
                if (!template) return
                setEditRule({ ...editRule, name: editRule?.name || template.name, pattern: template.pattern, description: template.description, type: 'regex', mode: 'allow' })
              }}
            >
              <option value="">选择常用模板</option>
              {namingTemplates.map((template) => (
                <option key={template.pattern} value={template.label}>{template.label}</option>
              ))}
            </select>
            <input className="input font-mono" value={editRule?.pattern ?? ''} onChange={(e) => setEditRule({ ...editRule, pattern: e.target.value })} />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <div className="label mb-1">{tr('type')}</div>
              <select className="input" value={editRule?.type ?? 'glob'} onChange={(e) => setEditRule({ ...editRule, type: e.target.value as 'glob' | 'regex' })}>
                <option value="glob">{tr('glob')}</option>
                <option value="regex">{tr('regex')}</option>
              </select>
            </div>
            <div>
              <div className="label mb-1">{tr('mode')}</div>
              <select className="input" value={editRule?.mode ?? 'allow'} onChange={(e) => setEditRule({ ...editRule, mode: e.target.value as 'allow' | 'exclude' })}>
                <option value="allow">{tr('allow')}</option>
                <option value="exclude">{tr('exclude')}</option>
              </select>
            </div>
          </div>
          <div>
            <div className="label mb-1">{tr('description')}</div>
            <input className="input" value={editRule?.description ?? ''} onChange={(e) => setEditRule({ ...editRule, description: e.target.value })} />
          </div>
          <div>
            <div className="label mb-1">{tr('priority')}</div>
            <input type="number" className="input" value={editRule?.priority ?? 50} onChange={(e) => setEditRule({ ...editRule, priority: Number(e.target.value) || 0 })} />
          </div>
        </div>
      </Modal>
    </div>
  )
}
