import { ChevronDown, Mail, UserRound } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
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
  label = '收件邮箱 / 邮箱分组',
  manualPlaceholder = 'you@example.com, team@example.com',
  rows = 4
}: RecipientPickerProps): JSX.Element {
  const [groupsOpen, setGroupsOpen] = useState(false)
  const groupsRef = useRef<HTMLDivElement | null>(null)
  const tokens = splitRecipientTokens(value)
  const self = tokens.some((token) => ['self', 'both'].includes(token.toLowerCase()))
  const creator = tokens.some((token) => ['creator', 'both'].includes(token.toLowerCase()))
  const groupNames = new Set(groups.map((group) => group.name.trim().toLowerCase()))
  // Several groups can be combined, so every matching token is kept and the new
  // engineering mail group (for example "leaders") is just another entry.
  const selectedGroups = tokens.filter((token) => groupNames.has(token.toLowerCase()))
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
      groupTokens: next.groupTokens ?? selectedGroups
    }))
  }

  const toggleGroup = (name: string, checked: boolean): void => {
    const lower = name.trim().toLowerCase()
    const next = checked
      ? [...selectedGroups.filter((token) => token.toLowerCase() !== lower), name]
      : selectedGroups.filter((token) => token.toLowerCase() !== lower)
    apply({ groupTokens: next })
  }

  const readOnly = selectedGroups.length > 0
  useEffect(() => {
    if (!groupsOpen) return
    const closeOnOutside = (event: MouseEvent): void => {
      if (groupsRef.current && !groupsRef.current.contains(event.target as Node)) setGroupsOpen(false)
    }
    document.addEventListener('mousedown', closeOnOutside)
    return () => document.removeEventListener('mousedown', closeOnOutside)
  }, [groupsOpen])
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
      {groups.length > 0 ? (
        <div className="relative max-w-md" ref={groupsRef}>
          <button
            type="button"
            className="input flex min-h-10 w-full items-center justify-between gap-3 text-left"
            aria-expanded={groupsOpen}
            disabled={disabled}
            onClick={() => setGroupsOpen((open) => !open)}
          >
            <span className="min-w-0 truncate text-sm">
              <span className="text-muted">邮箱分组（可多选）</span>
              {selectedGroups.length ? <span className="ml-2 text-canvas-fg">{selectedGroups.join('、')}</span> : <span className="ml-2 text-muted">未选择</span>}
            </span>
            <ChevronDown size={14} className={`shrink-0 text-muted transition-transform ${groupsOpen ? 'rotate-180' : ''}`} />
          </button>
          {groupsOpen ? (
            <div className="absolute left-0 top-full z-30 mt-1 max-h-56 w-full overflow-y-auto rounded-md border border-line bg-surface p-1 shadow-panel">
              {groups.map((group) => {
                const lower = group.name.trim().toLowerCase()
                const checked = selectedGroups.some((token) => token.toLowerCase() === lower)
                return (
                  <label key={group.id} className="flex cursor-pointer items-center gap-2 rounded px-2 py-2 text-sm text-canvas-fg hover:bg-line/30">
                    <input
                      type="checkbox"
                      className="no-specular h-3.5 w-3.5 shrink-0 cursor-pointer accent-[rgb(var(--primary))]"
                      checked={checked}
                      onChange={(event) => toggleGroup(group.name, event.target.checked)}
                    />
                    <span className="truncate">{group.name}</span>
                  </label>
                )
              })}
              {readOnly ? (
                <button className="w-full border-t border-line px-2 py-2 text-left text-xs text-muted hover:text-canvas-fg" type="button" onClick={() => apply({ groupTokens: [] })}>
                  清除已选分组
                </button>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}
      {readOnly ? (
        <p className="text-xs text-muted">已按分组显示收件人，分组收件人不可直接编辑；勾选多个分组会合并到同一封邮件。</p>
      ) : (
        <p className="text-xs text-muted">可填写邮箱；勾选邮箱分组后按分组配置只读展示并运行时解析收件人。</p>
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
