import { useEffect, useRef, useState } from 'react'
import { ChevronDown, Mail, UserRound } from 'lucide-react'
import { Toggle } from './ui'
import type { EmailGroup, NotifyTarget } from '@shared/types'
import { applyRecipientDraft, resolveRecipientDisplay, splitRecipientTokens } from '../lib/recipients'

interface RecipientPickerProps {
  value: string | NotifyTarget
  onChange: (value: NotifyTarget) => void
  groups: EmailGroup[]
  selfEmail?: string
  disabled?: boolean
  allowSelf?: boolean
  allowCreator?: boolean
  creatorHint?: string
  label?: string
  manualPlaceholder?: string
  rows?: number
}

export default function RecipientPicker({
  value,
  onChange,
  groups,
  selfEmail = '',
  disabled = false,
  allowSelf = false,
  allowCreator = false,
  creatorHint = '勾选后已停更的分支将邮件通知对应创始人',
  label = '收件邮箱 / 分支组',
  manualPlaceholder = 'you@example.com, team@example.com',
  rows = 4
}: RecipientPickerProps): JSX.Element {
  const [groupMenuOpen, setGroupMenuOpen] = useState(false)
  const groupMenuRef = useRef<HTMLDivElement | null>(null)
  const tokens = splitRecipientTokens(value)
  const self = tokens.some((token) => ['self', 'both'].includes(token.toLowerCase()))
  const creator = tokens.some((token) => ['creator', 'both'].includes(token.toLowerCase()))
  const groupNames = new Set(groups.map((group) => group.name.trim().toLowerCase()))
  const selectedGroupTokens = tokens.filter((token) => groupNames.has(token.toLowerCase()))
  const manualRecipients = tokens.filter((token) => {
    const lower = token.toLowerCase()
    return !['self', 'creator', 'both', 'none'].includes(lower) && !groupNames.has(lower)
  })

  const apply = (next: {
    self?: boolean
    creator?: boolean
    manualRecipients?: string[]
    groupTokens?: string[]
  }): void => {
    onChange(applyRecipientDraft({
      self: next.self ?? self,
      creator: next.creator ?? creator,
      manualRecipients: next.manualRecipients ?? manualRecipients,
    groupTokens: next.groupTokens ?? selectedGroupTokens
    }))
  }

  useEffect(() => {
    if (!groupMenuOpen) return
    const close = (event: MouseEvent): void => {
      if (!groupMenuRef.current?.contains(event.target as Node)) setGroupMenuOpen(false)
    }
    document.addEventListener('mousedown', close)
    return () => document.removeEventListener('mousedown', close)
  }, [groupMenuOpen])

  const readOnly = selectedGroupTokens.length > 0
  const displayRecipients = readOnly
    ? resolveRecipientDisplay(value, groups, self ? selfEmail : '')
    : manualRecipients

  return (
    <div className={disabled ? 'pointer-events-none space-y-2 opacity-50' : 'space-y-2'}>
      <div className="label flex items-center gap-1.5">
        <Mail size={13} /> {label}
      </div>
      <textarea
        className="input min-h-[96px] font-mono text-sm"
        rows={rows}
        placeholder={manualPlaceholder}
        value={displayRecipients.join(', ')}
        readOnly={readOnly}
        aria-readonly={readOnly}
        onChange={(event) => {
          const nextManual = splitRecipientTokens(event.target.value)
          apply({ manualRecipients: nextManual, groupTokens: [] })
        }}
      />
      <div className="flex flex-wrap items-center gap-2">
        <div ref={groupMenuRef} className="relative">
          <button
            type="button"
            className="input flex items-center justify-between gap-2 text-left"
            onClick={() => setGroupMenuOpen((open) => !open)}
          >
            <span className={selectedGroupTokens.length ? 'text-canvas-fg' : 'text-muted'}>
              {selectedGroupTokens.length
                ? `已选 ${selectedGroupTokens.length} 个分支组`
                : '选择分支组'}
            </span>
            <ChevronDown size={14} className="shrink-0 text-muted" />
          </button>
          {groupMenuOpen ? (
            <div className="absolute z-20 mt-1 max-h-56 w-full overflow-y-auto rounded-md border border-line bg-canvas shadow-lg">
              {groups.length === 0 ? (
                <div className="px-3 py-2 text-xs text-muted">还没有分支组，可先在设置页新建。</div>
              ) : (
                groups.map((group) => {
                  const checked = selectedGroupTokens.some((token) => token.toLowerCase() === group.name.trim().toLowerCase())
                  return (
                    <label
                      key={group.id}
                      className="flex cursor-pointer items-center gap-2 px-3 py-1.5 text-sm text-canvas-fg hover:bg-surface-elevated"
                    >
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={() => {
                          const next = checked
                            ? selectedGroupTokens.filter((token) => token.toLowerCase() !== group.name.trim().toLowerCase())
                            : [...selectedGroupTokens, group.name]
                          apply({ groupTokens: next })
                        }}
                      />
                      {group.name}
                    </label>
                  )
                })
              )}
            </div>
          ) : null}
        </div>
        {readOnly ? (
          <button className="btn px-2 text-xs" type="button" onClick={() => apply({ groupTokens: [] })}>
            清除分支组
          </button>
        ) : null}
      </div>
      {readOnly ? (
        <p className="text-xs text-muted">
          勾选多个分支组时，邮件会同时发给这些组的组员；检查 / 报告范围不变，仍是当前范围的全部分支。
        </p>
      ) : (
        <p className="text-xs text-muted">可填写邮箱或分支组名；填写组名时把本次结果发给该组组员，检查 / 报告范围不受影响。</p>
      )}

      {allowSelf ? (
        <div className="flex items-center justify-between rounded-md border border-line px-3 py-2">
          <div>
            <div className="text-sm text-canvas-fg">通知自己</div>
            <div className="text-xs text-muted">{selfEmail ? selfEmail : '请先在设置中填写我的个人邮箱。'}</div>
          </div>
          <Toggle checked={self} onChange={(next) => apply({ self: next })} />
        </div>
      ) : null}

      {allowCreator ? (
        <div className="flex items-center justify-between rounded-md border border-line px-3 py-2">
          <div className="flex items-center gap-1.5">
            <UserRound size={13} className="text-secondary" />
            <div>
              <div className="text-sm text-canvas-fg">通知分支创始人</div>
              <div className="text-xs text-muted">{creatorHint}</div>
            </div>
          </div>
          <Toggle checked={creator} onChange={(next) => apply({ creator: next })} />
        </div>
      ) : null}
    </div>
  )
}
