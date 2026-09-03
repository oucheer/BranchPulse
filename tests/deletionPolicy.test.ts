import { describe, expect, it } from 'vitest'
import type { BranchSummary, DeleteAuthorization } from '@shared/types'
import { DeleteBlockLabels } from '@shared/types'
import { DeletionPolicyEngine } from '../electron/services/deletion'

const baseProtection: BranchSummary['protection'] = {
  whitelisted: false,
  isDefault: false,
  protected: false,
  rules: []
}

function branch(
  overrides: Partial<Pick<BranchSummary, 'name' | 'protection' | 'existsLocally' | 'existsRemotely'>> = {}
): Pick<BranchSummary, 'name' | 'protection' | 'existsLocally' | 'existsRemotely'> {
  return {
    name: 'feature/test',
    protection: baseProtection,
    existsLocally: true,
    existsRemotely: true,
    ...overrides
  }
}

function auth(overrides: Partial<DeleteAuthorization> = {}): DeleteAuthorization {
  return {
    authorized: true,
    targetType: 'local',
    repositoryId: 'repo-1',
    branch: 'feature/test',
    confirmationToken: 'token-1',
    confirmed: true,
    ...overrides
  }
}

function target(existsLocally = true, existsRemotely = true): { existsLocally: boolean; existsRemotely: boolean } {
  return { existsLocally, existsRemotely }
}

describe('DeletionPolicyEngine', () => {
  const engine = new DeletionPolicyEngine()

  it('allows deletion when every check passes', () => {
    const decision = engine.evaluate(branch(), auth(), target())
    expect(decision.allowed).toBe(true)
    expect(decision.code).toBeNull()
    expect(decision.checks.every((c) => c.passed)).toBe(true)
  })

  it('blocks whitelisted branches', () => {
    const decision = engine.evaluate(branch({ protection: { ...baseProtection, whitelisted: true } }), auth(), target())
    expect(decision).toMatchObject({ allowed: false, code: 'WHITELIST' })
    expect(decision.message).toBe(DeleteBlockLabels.WHITELIST)
  })

  it('blocks default branches', () => {
    const decision = engine.evaluate(branch({ protection: { ...baseProtection, isDefault: true } }), auth(), target())
    expect(decision).toMatchObject({ allowed: false, code: 'DEFAULT_BRANCH' })
    expect(decision.message).toBe(DeleteBlockLabels.DEFAULT_BRANCH)
  })

  it('blocks protected branches', () => {
    const decision = engine.evaluate(branch({ protection: { ...baseProtection, protected: true } }), auth(), target())
    expect(decision).toMatchObject({ allowed: false, code: 'PROTECTED_BRANCH' })
    expect(decision.message).toBe(DeleteBlockLabels.PROTECTED_BRANCH)
  })

  it('blocks when the local target no longer exists', () => {
    const decision = engine.evaluate(branch(), auth({ targetType: 'local' }), target(false, true))
    expect(decision).toMatchObject({ allowed: false, code: 'TARGET_MISSING' })
    expect(decision.message).toBe(DeleteBlockLabels.TARGET_MISSING)
  })

  it('blocks when the remote target no longer exists', () => {
    const decision = engine.evaluate(branch(), auth({ targetType: 'remote' }), target(true, false))
    expect(decision).toMatchObject({ allowed: false, code: 'TARGET_MISSING' })
    expect(decision.message).toBe(DeleteBlockLabels.TARGET_MISSING)
  })

  it('blocks without explicit user authorization', () => {
    const decision = engine.evaluate(branch(), auth({ authorized: false }), target())
    expect(decision).toMatchObject({ allowed: false, code: 'USER_NOT_AUTHORIZED' })
    expect(decision.message).toBe(DeleteBlockLabels.USER_NOT_AUTHORIZED)
  })

  it('blocks when the confirmation checkbox is not checked', () => {
    const decision = engine.evaluate(branch(), auth({ confirmed: false }), target())
    expect(decision).toMatchObject({ allowed: false, code: 'NOT_CONFIRMED' })
    expect(decision.message).toBe(DeleteBlockLabels.NOT_CONFIRMED)
  })
})
