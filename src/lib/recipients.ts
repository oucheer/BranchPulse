import type { EmailGroup, NotifyTarget } from '@shared/types'

export interface RecipientDraft {
  self: boolean
  creator: boolean
  leader: boolean
  manualRecipients: string[]
  groupTokens: string[]
}

export function splitRecipientTokens(value: string | null | undefined): string[] {
  return String(value ?? '')
    .split(/[,;\r\n\s]+/)
    .map((token) => token.trim())
    .filter(Boolean)
}

export function parseRecipientDraft(value: string | null | undefined, groups: EmailGroup[] = []): RecipientDraft {
  const groupNames = new Set(groups.map((group) => group.name.trim().toLowerCase()))
  const self = false
  const creator = false
  const leader = false
  const manualRecipients: string[] = []
  const groupTokens: string[] = []

  for (const token of splitRecipientTokens(value)) {
    const lower = token.toLowerCase()
    if (lower === 'self') continue
    if (lower === 'creator') continue
    if (lower === 'leader') continue
    if (lower === 'both') continue
    if (lower === 'none') continue
    if (groupNames.has(lower)) {
      if (!groupTokens.some((item) => item.toLowerCase() === lower)) groupTokens.push(token)
    } else if (!manualRecipients.some((item) => item.toLowerCase() === lower)) {
      manualRecipients.push(token)
    }
  }

  return { self, creator, leader, manualRecipients, groupTokens }
}

export function applyRecipientDraft(draft: RecipientDraft): NotifyTarget {
  const parts: string[] = []
  if (draft.self) parts.push('self')
  if (draft.creator) parts.push('creator')
  if (draft.leader) parts.push('leader')
  for (const token of [...draft.manualRecipients, ...draft.groupTokens]) {
    const lower = token.toLowerCase()
    if (lower === 'self' || lower === 'creator' || lower === 'leader' || lower === 'both' || lower === 'none') continue
    if (!parts.some((item) => item.toLowerCase() === lower)) parts.push(token)
  }
  return (parts.join(', ') || 'none') as NotifyTarget
}

export function resolveRecipientDisplay(
  value: string | null | undefined,
  groups: EmailGroup[],
  selfEmail = '',
  leaderEmail = ''
): string[] {
  const groupByName = new Map(groups.map((group) => [group.name.trim().toLowerCase(), group]))
  const out: string[] = []
  const seen = new Set<string>()
  const add = (recipient: string): void => {
    const trimmed = recipient.trim()
    if (!trimmed) return
    const key = trimmed.toLowerCase()
    if (seen.has(key)) return
    seen.add(key)
    out.push(trimmed)
  }

  const tokens = splitRecipientTokens(value)
  if (tokens.some((token) => ['self', 'both'].includes(token.toLowerCase())) && selfEmail.trim()) {
    add(selfEmail)
  }
  if (tokens.some((token) => token.toLowerCase() === 'leader') && leaderEmail.trim()) {
    add(leaderEmail)
  }

  for (const token of tokens) {
    const group = groupByName.get(token.toLowerCase())
    if (group) {
      for (const recipient of splitRecipientTokens(group.recipients)) add(recipient)
    } else if (!['self', 'creator', 'leader', 'both', 'none'].includes(token.toLowerCase())) {
      add(token)
    }
  }
  return out
}

export function hasGroupToken(value: string | null | undefined, groups: EmailGroup[]): boolean {
  const groupNames = new Set(groups.map((group) => group.name.trim().toLowerCase()))
  return splitRecipientTokens(value).some((token) => groupNames.has(token.toLowerCase()))
}
