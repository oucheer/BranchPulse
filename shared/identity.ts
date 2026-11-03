import type { CreatorInfo, RepositorySource, UserSession } from './types'

export function normalizedEmail(value: string | null | undefined): string {
  return String(value ?? '').trim().toLowerCase()
}

export function normalizedUsername(value: string | null | undefined): string {
  return String(value ?? '').trim().toLowerCase()
}

export function normalizedAccountId(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return ''
  return String(value).trim()
}

/**
 * Email is the only identity that safely crosses forge boundaries. Account ids
 * and logins are platform-scoped and are compared only when both sides come
 * from the same source.
 */
export function matchesUserToCreator(
  session: Pick<UserSession, 'email' | 'username' | 'accountId' | 'source'> | null,
  creator: Pick<CreatorInfo, 'email' | 'username' | 'accountId'> | null | undefined,
  repositorySource: RepositorySource
): boolean {
  if (!session || !creator) return false
  const sessionEmail = normalizedEmail(session.email)
  const creatorEmail = normalizedEmail(creator.email)
  if (sessionEmail && sessionEmail === creatorEmail) return true
  if (!session.source || session.source !== repositorySource) return false

  const sessionAccountId = normalizedAccountId(session.accountId)
  const creatorAccountId = normalizedAccountId(creator.accountId)
  if (sessionAccountId && sessionAccountId === creatorAccountId) return true

  const sessionUsername = normalizedUsername(session.username)
  const creatorUsername = normalizedUsername(creator.username)
  return Boolean(sessionUsername && sessionUsername === creatorUsername)
}
