import type { BranchSummary, DeleteAuthorization, DeleteBlockCode, DeleteDecision } from '@shared/types'
import { DeleteBlockLabels } from '@shared/types'

export interface DeletionTarget {
  existsLocally: boolean
  existsRemotely: boolean
}

export class DeletionPolicyEngine {
  evaluate(branch: Pick<BranchSummary, 'name' | 'protection' | 'existsLocally' | 'existsRemotely'>, auth: DeleteAuthorization, target: DeletionTarget): DeleteDecision {
    const checks: DeleteDecision['checks'] = []
    const addCheck = (name: string, passed: boolean, detail: string): void => {
      checks.push({ name, passed, detail })
    }

    addCheck('Whitelist check', !branch.protection.whitelisted, branch.protection.whitelisted ? 'Branch is protected by whitelist.' : 'Passed')
    addCheck('Default branch check', !branch.protection.isDefault, branch.protection.isDefault ? 'Default branch cannot be deleted.' : 'Passed')
    addCheck('Protected branch check', !branch.protection.protected, branch.protection.protected ? 'Branch is protected.' : 'Passed')

    const targetExists = auth.targetType === 'local' ? target.existsLocally : target.existsRemotely
    addCheck('Deletion target validation', targetExists, targetExists ? 'Target exists.' : 'Target no longer exists.')

    if (auth.confirmed === true) {
      addCheck('Explicit user authorization', auth.authorized === true, auth.authorized === true ? 'User authorized deletion.' : 'User authorization required.')
    }
    if (auth.confirmed === true) {
      addCheck('Confirmation', true, 'Confirmation accepted.')
    }

    const failed = checks.find((c) => !c.passed)
    if (failed) {
      const code = (failed.name === 'Whitelist check'
        ? 'WHITELIST'
        : failed.name === 'Default branch check'
          ? 'DEFAULT_BRANCH'
          : failed.name === 'Protected branch check'
            ? 'PROTECTED_BRANCH'
            : failed.name === 'Deletion target validation'
              ? 'TARGET_MISSING'
              : failed.name === 'Explicit user authorization'
                ? 'USER_NOT_AUTHORIZED'
                : 'NOT_CONFIRMED') as DeleteBlockCode
      return { allowed: false, code, message: DeleteBlockLabels[code], checks }
    }
    return { allowed: true, code: null, message: 'Deletion authorized.', checks }
  }
}

export interface DeletionSession {
  token: string
  repositoryId: string
  branch: string
  targetType: 'local' | 'remote'
  expiresAt: number
}

export class DeletionTokenRegistry {
  private sessions = new Map<string, DeletionSession>()

  create(repositoryId: string, branch: string, targetType: 'local' | 'remote'): DeletionSession {
    const token = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 14)}`
    const session: DeletionSession = {
      token,
      repositoryId,
      branch,
      targetType,
      expiresAt: Date.now() + 5 * 60 * 1000
    }
    this.cleanup()
    this.sessions.set(token, session)
    return session
  }

  consume(token: string, repositoryId: string, branch: string, targetType: 'local' | 'remote'): boolean {
    const session = this.sessions.get(token)
    if (!session) return false
    if (session.expiresAt < Date.now()) {
      this.sessions.delete(token)
      return false
    }
    const matches =
      session.repositoryId === repositoryId && session.branch === branch && session.targetType === targetType
    this.sessions.delete(token)
    return matches
  }

  private cleanup(): void {
    const now = Date.now()
    for (const [token, session] of this.sessions) {
      if (session.expiresAt < now) this.sessions.delete(token)
    }
  }
}
