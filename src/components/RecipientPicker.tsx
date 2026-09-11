import { Mail, UserRound } from 'lucide-react'
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
  label = '收件邮箱 / 邮箱分组',
  manualPlaceholder = 'you@example.com, team@example.com',
  rows = 4
}: RecipientPickerProps): JSX.Element {
  const tokens = splitRecipientTokens(value)
  const self = tokens.some((token) => ['self', 'both'].includes(token.toLowerCase()))
  const creator = tokens.some((token) => ['creator', 'both'].includes(token.toLowerCase()))
  const groupNames = new Set(groups.map((group) => group.name.trim().toLowerCase()))
  const selectedGroup = tokens.find((token) => groupNames.has(token.toLowerCase())) ?? ''
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
      groupTokens: next.groupTokens ?? (selectedGroup ? [selectedGroup] : [])
    }))
  }

  const readOnly = Boolean(selectedGroup)
  const displayRecipients = selectedGroup
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
        <select
          className="input max-w-[12rem]"
          value={selectedGroup}
          onChange={(event) => {
            const group = event.target.value
            if (!group) {
              apply({ groupTokens: [] })
              return
            }
            apply({ groupTokens: [group] })
          }}
        >
          <option value="">选择邮箱分组</option>
          {groups.map((group) => (
            <option key={group.id} value={group.name}>{group.name}</option>
          ))}
        </select>
        {readOnly ? (
          <button className="btn px-2 text-xs" type="button" onClick={() => apply({ groupTokens: [] })}>
            清除分组
          </button>
        ) : null}
      </div>
      {readOnly ? (
        <p className="text-xs text-muted">已按分组显示收件人，分组收件人不可直接编辑。</p>
      ) : (
        <p className="text-xs text-muted">可填写邮箱；选择分组后按分组配置只读展示并运行时解析收件人。</p>
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
              <div className="text-xs text-muted">勾选后已停更的分支将邮件通知对应创始人</div>
            </div>
          </div>
          <Toggle checked={creator} onChange={(next) => apply({ creator: next })} />
        </div>
      ) : null}
    </div>
  )
}
