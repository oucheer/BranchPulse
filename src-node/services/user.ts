import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto'
import type { StorageService } from './storage'
import type { RepositorySource, UserRole, UserSession } from '@shared/types'
import { newId, nowIso } from '../utils/ids'
import { decryptSecret, encryptSecret } from '../utils/secrets'

const SESSION_TTL_MS = 168 * 60 * 60 * 1000 // 7 days

export interface GitLabIdentity {
  userId: number
  username: string
  email: string
  displayName: string
  source: Exclude<RepositorySource, 'local'>
}

/** Strips the decrypted GitLab token before any UserSession reaches the browser. */
export function sanitizeUserSession(session: UserSession): UserSession {
  const { gitlabToken: _gitlabToken, ...rest } = session
  return rest
}

export class UserService {
  constructor(private readonly storage: StorageService) {}

  async init(): Promise<void> {
    const hasAdmin = this.storage.get<{ n: number }>('SELECT COUNT(*) AS n FROM users WHERE username = ?', ['admin'])
    if (!hasAdmin || hasAdmin.n === 0) {
      this.storage.insert('users', {
        id: newId(),
        username: 'admin',
        password_hash: this.hash('pantum'),
        role: 'admin',
        updated_at: nowIso()
      })
    }
    this.storage.run('DELETE FROM user_sessions WHERE expires_at < ?', [nowIso()])
  }

  hash(password: string): string {
    const salt = randomBytes(16).toString('hex')
    const derived = scryptSync(password, salt, 32).toString('hex')
    return `${salt}:${derived}`
  }

  verify(password: string, stored: string): boolean {
    const [salt, expected] = stored.split(':')
    if (!salt || !expected) return false
    const derived = scryptSync(password, salt, 32)
    const expectedBuf = Buffer.from(expected, 'hex')
    return derived.length === expectedBuf.length && timingSafeEqual(derived, expectedBuf)
  }

  async loginAdmin(username: string, password: string): Promise<UserSession | null> {
    const row = this.storage.get<{ id: string; username: string; password_hash: string; role: string }>(
      'SELECT * FROM users WHERE username = ?', [username]
    )
    if (!row || row.role !== 'admin' || !this.verify(password, row.password_hash)) return null
    return this.createSession('admin', null, {
      accountId: row.id,
      username: row.username,
      displayName: 'Administrator',
      source: null
    }, null)
  }

  async loginUser(email: string, identity: GitLabIdentity | null, gitlabToken?: string): Promise<UserSession | null> {
    if (!identity) return null
    return this.createSession('user', identity.email, {
      accountId: String(identity.userId),
      username: identity.username,
      displayName: identity.displayName,
      source: identity.source
    }, gitlabToken ? encryptSecret(gitlabToken) : null)
  }

  private createSession(
    role: UserRole,
    email: string | null,
    identity: {
      accountId: string | null
      username: string
      displayName: string
      source: RepositorySource | null
    },
    encryptedToken: string | null
  ): UserSession {
    const token = randomBytes(24).toString('hex')
    const now = Date.now()
    const forgeUserId = role === 'user' ? Number(identity.accountId) || null : null
    this.storage.insert('user_sessions', {
      token,
      role,
      email,
      username: identity.username,
      account_id: identity.accountId,
      source: identity.source,
      gitlab_user_id: forgeUserId,
      display_name: identity.displayName,
      gitlab_token_encrypted: encryptedToken,
      created_at: nowIso(),
      expires_at: new Date(now + SESSION_TTL_MS).toISOString()
    })
    this.storage.save()
    return {
      token,
      role,
      email: email ?? '',
      username: identity.username,
      accountId: identity.accountId,
      source: identity.source,
      gitlabUserId: forgeUserId,
      displayName: identity.displayName,
      hasGitlabToken: Boolean(encryptedToken),
      ...(encryptedToken ? { gitlabToken: decryptSecret(encryptedToken) } : {})
    }
  }

  getSession(token: string): UserSession | null {
    const row = this.storage.get<{
      role: string
      email: string | null
      username: string | null
      account_id: string | null
      source: string | null
      gitlab_user_id: number | null
      display_name: string | null
      expires_at: string
      gitlab_token_encrypted: string | null
    }>(
      'SELECT * FROM user_sessions WHERE token = ?', [token]
    )
    if (!row) return null
    if (new Date(row.expires_at).getTime() < Date.now()) {
      this.storage.delete('user_sessions', 'token = ?', [token])
      return null
    }
    return {
      token,
      role: row.role === 'admin' ? 'admin' : 'user',
      email: row.email ?? '',
      username: row.username ?? '',
      accountId: row.account_id ?? (row.gitlab_user_id == null ? null : String(row.gitlab_user_id)),
      source: row.source === 'gitlab' || row.source === 'github' || row.source === 'gitee' ? row.source : null,
      gitlabUserId: row.gitlab_user_id,
      displayName: row.display_name ?? '',
      hasGitlabToken: Boolean(row.gitlab_token_encrypted),
      ...(row.gitlab_token_encrypted ? { gitlabToken: decryptSecret(row.gitlab_token_encrypted) } : {})
    }
  }

  logout(token: string): void {
    this.storage.delete('user_sessions', 'token = ?', [token])
    this.storage.save()
  }

  changePassword(newPassword: string): boolean {
    const row = this.storage.get<{ n: number }>("SELECT COUNT(*) AS n FROM users WHERE username = 'admin'")
    if (!row || row.n === 0) return false
    this.storage.run(
      `UPDATE users SET password_hash = ?, updated_at = ? WHERE username = 'admin'`,
      [this.hash(newPassword), nowIso()]
    )
    this.storage.save()
    return true
  }
}
