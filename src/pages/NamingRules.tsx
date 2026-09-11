import { useState } from 'react'
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
  const namingRules = useAppStore((s) => s.namingRules)
  const activeRepositoryId = useAppStore((s) => s.activeRepositoryId)
  const toast = useAppStore((s) => s.toast)
  const refresh = useAppStore((s) => s.refresh)
  const [editRule, setEditRule] = useState<Partial<NamingRule> & { id?: string } | null>(null)
  const [validateName, setValidateName] = useState('')
  const [validationResult, setValidationResult] = useState<{ status: string; ruleName?: string } | null>(null)

  const save = async (rule: Partial<NamingRule> & { id?: string }): Promise<void> => {
    try {
      await window.branchpulse.saveNamingRule({ ...rule, repositoryId: activeRepositoryId })
      toast(tr('saved'), 'success')
      setEditRule(null)
      void refresh()
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), 'error')
    }
  }

  const remove = async (id: string): Promise<void> => {
    try {
      await window.branchpulse.deleteNamingRule(id, activeRepositoryId)
      toast('Rule deleted', 'success')
      void refresh()
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), 'error')
    }
  }

  const reorder = async (id: string, direction: -1 | 1): Promise<void> => {
    try {
      await window.branchpulse.reorderNamingRule(id, direction, activeRepositoryId)
      void refresh()
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), 'error')
    }
  }

  const validate = async (): Promise<void> => {
    if (!validateName) return
    try {
      const result = await window.branchpulse.validateBranchName(validateName, activeRepositoryId)
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
          {activeRepositoryId ? <span className="ml-2 text-sm font-medium text-muted">当前仓库隔离</span> : <span className="ml-2 text-sm font-medium text-muted">全部仓库</span>}
        </h1>
        <button className="btn btn-primary" onClick={() => setEditRule({ ...emptyRule(activeRepositoryId) })}>
          <Plus size={15} /> {tr('addRule')}
        </button>
      </div>

      <Card className="p-4">
        <div className="mb-3 rounded-md border border-line bg-surface/60 p-3 text-xs leading-relaxed text-muted">
          <div className="mb-1 text-sm font-semibold text-canvas-fg">命名规则说明</div>
          常用前缀是 <span className="font-mono">feature/、bugfix/、hotfix/、release/、chore/、docs/</span>。
          分支名建议使用小写字母，不能包含空格或连续斜杠，也不能以斜杠结尾。
          如果需要支持中文，请使用下方允许中文的 regex 模板。
        </div>
        <div className="mb-2 text-sm font-semibold text-canvas-fg">{tr('validate')}</div>
        <div className="flex gap-2">
          <input
            className="input flex-1"
            placeholder="feature/my-branch"
            value={validateName}
            onChange={(e) => { setValidateName(e.target.value); setValidationResult(null) }}
            onKeyDown={(e) => { if (e.key === 'Enter') void validate() }}
          />
          <button className="btn" onClick={() => void validate()}><CheckCircle size={14} /> {tr('validate')}</button>
        </div>
        {validationResult ? (
          <div className={`mt-2 text-sm ${validationResult.status === 'valid' ? 'text-ok' : validationResult.status === 'excluded' ? 'text-warn' : 'text-danger'}`}>
            {validationResult.status === 'valid' ? '✔ Valid' : validationResult.status === 'excluded' ? '⚠ Excluded' : '✖ Invalid'}
            {validationResult.ruleName ? ` — ${validationResult.ruleName}` : ''}
          </div>
        ) : null}
      </Card>

      {namingRules.length === 0 ? (
        <EmptyState title={tr('noBranches')} />
      ) : (
        <div className="space-y-2">
          {namingRules.map((rule, idx) => (
            <Card key={rule.id} className="flex items-center gap-3 p-3">
              <div className="flex flex-col gap-0.5">
                <button className="btn px-1 py-0.5 text-[11px]" disabled={idx === 0} onClick={() => void reorder(rule.id, -1)}>
                  <ArrowUp size={12} />
                </button>
                <button className="btn px-1 py-0.5 text-[11px]" disabled={idx === namingRules.length - 1} onClick={() => void reorder(rule.id, 1)}>
                  <ArrowDown size={12} />
                </button>
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-semibold text-canvas-fg">{rule.name}</span>
                  <Badge tone={rule.mode === 'allow' ? 'ok' : 'warn'}>{rule.mode}</Badge>
                  <Badge>{rule.type}</Badge>
                  <Toggle checked={rule.enabled} onChange={async (v) => { await save({ ...rule, enabled: v }) }} />
                </div>
                <div className="mt-0.5 font-mono text-xs text-muted">{rule.pattern}</div>
                {rule.description ? <div className="mt-0.5 text-xs text-muted">{rule.description}</div> : null}
              </div>
              <div className="flex items-center gap-1">
                <button className="btn px-2" onClick={() => setEditRule({ ...rule })}>Edit</button>
                <button className="btn px-2" onClick={() => void remove(rule.id)}><Trash2 size={13} className="text-danger" /></button>
              </div>
            </Card>
          ))}
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
