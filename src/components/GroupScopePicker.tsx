import { Users } from 'lucide-react'
import type { EmailGroup } from '@shared/types'

interface GroupScopePickerProps {
  value: string[]
  onChange: (value: string[]) => void
  groups: EmailGroup[]
  label?: string
  disabled?: boolean
  /** 空选时展示的说明，默认为「不限分组」。 */
  emptyHint?: string
}

/**
 * 「只检查 / 只统计这些分组」的范围选择。
 *
 * 口径与分支列表的分组筛选一致：分支创始人命中组员即归属该组。空数组表示
 * 不限分组（即全仓库），这样调度任务的默认行为保持原样。
 */
export default function GroupScopePicker({
  value,
  onChange,
  groups,
  label = '分组范围',
  disabled = false,
  emptyHint = '不选则不限分组，检查全部仓库范围内的分支。'
}: GroupScopePickerProps): JSX.Element {
  const selected = new Set(value)

  const toggle = (id: string): void => {
    onChange(selected.has(id) ? value.filter((item) => item !== id) : [...value, id])
  }

  return (
    <div className={disabled ? 'pointer-events-none space-y-2 opacity-50' : 'space-y-2'}>
      <div className="flex items-center justify-between">
        <div className="label flex items-center gap-1.5">
          <Users size={13} /> {label}
        </div>
        {value.length > 0 ? (
          <button className="btn px-2 text-xs" type="button" onClick={() => onChange([])}>
            清除分组范围
          </button>
        ) : null}
      </div>
      {groups.length === 0 ? (
        <div className="rounded-md bg-surface-elevated px-3 py-2 text-xs text-muted">
          还没有分支组，可先在设置页新建分组后再按组限定范围。
        </div>
      ) : (
        <div className="flex flex-wrap gap-1.5">
          {groups.map((group) => {
            const active = selected.has(group.id)
            return (
              <button
                key={group.id}
                type="button"
                className={`rounded-md px-2.5 py-1 text-xs font-medium transition-colors ${active ? 'bg-primary/10 text-primary' : 'bg-line/20 text-muted hover:text-canvas-fg'}`}
                onClick={() => toggle(group.id)}
              >
                {group.name}
              </button>
            )
          })}
        </div>
      )}
      <p className="text-xs text-muted">
        {value.length > 0
          ? `只处理这些分组组员的分支：${groups.filter((group) => selected.has(group.id)).map((group) => group.name).join('、')}。`
          : emptyHint}
      </p>
    </div>
  )
}
