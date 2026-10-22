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
    label: '功能分支 a/b_c',
    name: 'Feature a/b_c',
    pattern: '^feature\\/[A-Za-z0-9][A-Za-z0-9_.]*$',
    description: 'feature/b_c，b/c 以字母或数字开头，可含字母、数字、_、.'
  },
  {
    label: '修复分支 a/b_c',
    name: 'Bugfix/Hotfix a/b_c',
    pattern: '^(bugfix|hotfix)\\/[A-Za-z0-9][A-Za-z0-9_.]*$',
    description: 'bugfix/b_c 或 hotfix/b_c，建议 bugfix/123456'
  },
  {
    label: '发布分支（完整项目名）',
    name: 'Release 项目名',
    pattern: '^release\\/[A-Za-z0-9][A-Za-z0-9_.-]*$',
    description: 'release/完整项目名，如 release/LP-7265V1R1，仅项目名可带 -'
  },
  {
    label: '临时开发分支 develop_XX',
    name: 'Develop 临时规则',
    pattern: '^develop_[A-Za-z0-9][A-Za-z0-9_.]*$',
    description: '特殊（临时规则）允许 develop_XX，如 develop_XC；develop 不允许带 /'
  }
]

export default function NamingRules(): JSX.Element {
  const namingRules = useAppStore((s) => s.namingRules)
  const selectedRepositoryIds = useAppStore((s) => s.selectedRepositoryIds)
  const scopedRepositoryId = selectedRepositoryIds[0] ?? null
  const toast = useAppStore((s) => s.toast)
  const refresh = useAppStore((s) => s.refresh)
  const language = useAppStore((s) => s.language)
  const zh = language === 'zh'
  const [editRule, setEditRule] = useState<Partial<NamingRule> & { id?: string } | null>(null)
  const [validateName, setValidateName] = useState('')
  const [validationResult, setValidationResult] = useState<{ status: string; ruleName?: string; reason?: string } | null>(null)

  const save = async (rule: Partial<NamingRule> & { id?: string }): Promise<void> => {
    try {
      await window.gitmanager.saveNamingRule({ ...rule, repositoryId: scopedRepositoryId })
      toast(tr('saved'), 'success')
      setEditRule(null)
      void refresh()
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), 'error')
    }
  }

  const remove = async (id: string): Promise<void> => {
    try {
      await window.gitmanager.deleteNamingRule(id, scopedRepositoryId)
      toast('Rule deleted', 'success')
      void refresh()
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), 'error')
    }
  }

  const reorder = async (id: string, direction: -1 | 1): Promise<void> => {
    try {
      await window.gitmanager.reorderNamingRule(id, direction, scopedRepositoryId)
      void refresh()
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), 'error')
    }
  }

  const validate = async (): Promise<void> => {
    if (!validateName) return
    try {
      const result = await window.gitmanager.validateBranchName(validateName, scopedRepositoryId)
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
          {selectedRepositoryIds.length === 0
            ? <span className="ml-2 text-sm font-medium text-muted">未选择仓库</span>
            : selectedRepositoryIds.length === 1
              ? <span className="ml-2 text-sm font-medium text-muted">当前仓库隔离</span>
              : <span className="ml-2 text-sm font-medium text-muted">使用第一个勾选仓库</span>}
        </h1>
        <button className="btn btn-primary" onClick={() => setEditRule({ ...emptyRule(scopedRepositoryId) })}>
          <Plus size={15} /> {tr('addRule')}
        </button>
      </div>

      <Card className="p-4">
        <div className="mb-3 rounded-md border border-line bg-surface/60 p-3 text-xs leading-relaxed text-muted">
          <div className="mb-1 text-sm font-semibold text-canvas-fg">命名规则说明</div>
          分支命名风格为 <span className="font-mono">a/b_c</span>：
          <span className="font-mono">main</span> 禁止后缀、禁止删除；
          <span className="font-mono">develop</span> 不允许带 <span className="font-mono">/</span>，特殊临时规则允许 <span className="font-mono">develop_XX</span>（如 develop_XC）；
          feature 为短期过渡分支，长期保留需申请记录在案；
          release 为长期分支，b 必须为完整项目名（如 <span className="font-mono">release/LP-7265V1R1</span>），仅项目名可带 <span className="font-mono">-</span>；
          bugfix 建议 <span className="font-mono">bugfix/bug_id</span>（如 bugfix/123456）。
          b/c 以大写或小写字母、数字开头，后续可含大小写字母、数字、<span className="font-mono">_</span>、<span className="font-mono">.</span>；禁止中文；禁止纯数字或工程师名字等随意命名；禁止拉取版本分支（版本号仅用于 release）。
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
                <button className="btn px-2" onClick={() => setEditRule({ ...rule })}>{tr('edit')}</button>
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
