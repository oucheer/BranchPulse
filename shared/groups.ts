import type { BranchSummary, EmailGroup, EmailGroupMember } from './types'

/**
 * 分支组：组员匹配与分支归属规则，前后端共用同一份实现。
 *
 * 归属规则（唯一口径）：分支的「分支创始人」人名或邮箱命中组内已配置的组员时，
 * 该分支属于这个组。人名/邮箱按忽略大小写与首尾空格的精确匹配，不做模糊匹配，
 * 否则「张三」会连带命中「张三丰」。
 *
 * 组内额外的收件邮箱（`recipients`，不绑定人名）同样参与邮箱侧匹配，这样
 * 「只知道邮箱、不知道真人姓名」的组也能用。
 */

/** 空格 / 逗号 / 分号 / 换行分隔的 token 列表。 */
export function splitGroupTokens(value: string | null | undefined): string[] {
  return String(value ?? '')
    .split(/[,;\r\n\s]+/)
    .map((token) => token.trim())
    .filter(Boolean)
}

function normalize(value: string | null | undefined): string {
  return String(value ?? '').trim().toLowerCase()
}

/** 组员以 JSON 存在 `email_groups.members`，这里做防御性解析。 */
export function parseGroupMembers(raw: unknown): EmailGroupMember[] {
  if (Array.isArray(raw)) return normalizeMembers(raw as Array<Partial<EmailGroupMember>>)
  if (typeof raw !== 'string' || !raw.trim()) return []
  try {
    const parsed = JSON.parse(raw) as unknown
    return Array.isArray(parsed) ? normalizeMembers(parsed as Array<Partial<EmailGroupMember>>) : []
  } catch {
    return []
  }
}

function normalizeMembers(rows: Array<Partial<EmailGroupMember>>): EmailGroupMember[] {
  const out: EmailGroupMember[] = []
  const seen = new Set<string>()
  for (const row of rows) {
    const name = String(row?.name ?? '').trim()
    const email = String(row?.email ?? '').trim()
    if (!name && !email) continue
    const key = `${normalize(name)}|${normalize(email)}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push({ name, email })
  }
  return out
}

export function serializeGroupMembers(members: EmailGroupMember[] | null | undefined): string {
  return JSON.stringify(normalizeMembers(members ?? []))
}

/** 组员的去重邮箱列表。 */
export function groupMemberEmails(group: Pick<EmailGroup, 'members'>): string[] {
  return uniqueEmails((group.members ?? []).map((member) => member.email))
}

/** 组内实际收件人：组员邮箱 + 额外填写的收件邮箱。 */
export function groupRecipients(group: Pick<EmailGroup, 'members' | 'recipients'>): string[] {
  return uniqueEmails([...groupMemberEmails(group), ...splitGroupTokens(group.recipients)])
}

function uniqueEmails(values: string[]): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const value of values) {
    const trimmed = value.trim()
    if (!trimmed) continue
    const key = normalize(trimmed)
    if (seen.has(key)) continue
    seen.add(key)
    out.push(trimmed)
  }
  return out
}

/** 组内配置的全部人名（用于展示与筛选下拉）。 */
export function groupMemberNames(group: Pick<EmailGroup, 'members'>): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const member of group.members ?? []) {
    const name = String(member.name ?? '').trim()
    if (!name) continue
    const key = normalize(name)
    if (seen.has(key)) continue
    seen.add(key)
    out.push(name)
  }
  return out
}

/** 组员的人名与邮箱是否命中给定的创始人信息。 */
export function groupCoversCreator(
  group: Pick<EmailGroup, 'members' | 'recipients'>,
  creator: { name?: string | null; email?: string | null }
): boolean {
  const name = normalize(creator.name)
  const email = normalize(creator.email)
  for (const member of group.members ?? []) {
    if (name && normalize(member.name) === name) return true
    if (email && normalize(member.email) === email) return true
  }
  if (email && groupMemberEmails(group).some((item) => normalize(item) === email)) return true
  return false
}

export function branchBelongsToGroup(
  group: Pick<EmailGroup, 'members' | 'recipients'>,
  branch: BranchSummary
): boolean {
  return groupCoversCreator(group, branch.creator)
}

export function branchesForGroup(group: Pick<EmailGroup, 'members' | 'recipients'>, branches: BranchSummary[]): BranchSummary[] {
  return branches.filter((branch) => branchBelongsToGroup(group, branch))
}

/** 命中的组名列表，用于分支行/详情里标注「属于哪些组」。 */
export function groupNamesForBranch(groups: EmailGroup[], branch: BranchSummary): string[] {
  return groups.filter((group) => branchBelongsToGroup(group, branch)).map((group) => group.name)
}

export interface GroupBranchStats {
  total: number
  active: number
  stale: number
  gracePeriod: number
  graceExpired: number
  namingInvalid: number
  cleanupCandidates: number
  /** 组内出现过的分支创始人，用于「这个组有哪些人」一目了然。 */
  creators: string[]
}

export function groupBranchStats(branches: BranchSummary[]): GroupBranchStats {
  const count = (fn: (branch: BranchSummary) => boolean): number => branches.filter(fn).length
  const creators: string[] = []
  const seen = new Set<string>()
  for (const branch of branches) {
    const name = String(branch.creator.name ?? '').trim()
    if (!name || name === 'Unknown') continue
    const key = normalize(name)
    if (seen.has(key)) continue
    seen.add(key)
    creators.push(name)
  }
  return {
    total: branches.length,
    active: count((branch) => branch.state === 'active'),
    stale: count((branch) => branch.stale),
    gracePeriod: count((branch) => branch.state === 'grace_period'),
    graceExpired: count((branch) => branch.state === 'grace_expired'),
    namingInvalid: count((branch) => branch.naming.status === 'invalid'),
    cleanupCandidates: count((branch) => branch.cleanupCandidate),
    creators: creators.sort((a, b) => a.localeCompare(b))
  }
}

/**
 * 把收件人 token 拆成「命中的组」与「其余 token」。
 *
 * 监控页、定时调度、报告计划里的收件人输入框都允许直接写组名。组名必须被单独
 * 处理：组名 token 的语义是「把这个组自己的分支情况发给这个组的组员」，而不是
 * 「把整份汇总也发一遍给这些人」，否则组员会同时收到两封邮件。
 */
export function partitionRecipientTokens(
  value: string | null | undefined,
  groups: EmailGroup[]
): { matched: EmailGroup[]; plain: string } {
  const byName = new Map(groups.map((group) => [normalize(group.name), group]))
  const matched: EmailGroup[] = []
  const seen = new Set<string>()
  const plain: string[] = []
  for (const token of splitGroupTokens(value)) {
    const lower = normalize(token)
    if (lower === 'self' || lower === 'creator' || lower === 'both' || lower === 'none') continue
    const group = byName.get(lower)
    if (group) {
      if (!seen.has(lower)) {
        seen.add(lower)
        matched.push(group)
      }
      continue
    }
    plain.push(token)
  }
  return { matched, plain: plain.join(', ') }
}

/** 筛选人员下拉的候选项：所有出现过的分支创始人。 */
export interface CreatorOption {
  name: string
  email: string
  branches: number
}

export function creatorOptions(branches: BranchSummary[]): CreatorOption[] {
  const byKey = new Map<string, CreatorOption>()
  for (const branch of branches) {
    const name = String(branch.creator.name ?? '').trim()
    const email = String(branch.creator.email ?? '').trim()
    if (!name && !email) continue
    if (name === 'Unknown' && !email) continue
    const key = normalize(name || email)
    const existing = byKey.get(key)
    if (existing) {
      existing.branches += 1
      if (!existing.email && email) existing.email = email
      continue
    }
    byKey.set(key, { name: name === 'Unknown' ? '' : name, email, branches: 1 })
  }
  return [...byKey.values()].sort((a, b) => b.branches - a.branches || a.name.localeCompare(b.name))
}

/** 人员筛选命中的分支：按人名或邮箱匹配创始人，空值视为「未指定人员」。 */
export function branchMatchesCreatorOption(branch: BranchSummary, option: CreatorOption): boolean {
  const name = normalize(branch.creator.name)
  const email = normalize(branch.creator.email)
  if (option.email && email && normalize(option.email) === email) return true
  if (option.name && name && normalize(option.name) === name) return true
  if (!option.name && !option.email) return !name && !email
  return false
}

export function creatorOptionKey(option: CreatorOption): string {
  return `${normalize(option.name)}|${normalize(option.email)}`
}
