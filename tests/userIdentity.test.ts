import { describe, expect, it } from 'vitest'
import { matchesUserToCreator } from '../shared/identity'

const user = {
  email: 'person@example.com',
  username: 'same-login',
  accountId: '42',
  source: 'github' as const
}

describe('forge-scoped user identity matching', () => {
  it('matches an exact email across providers', () => {
    expect(matchesUserToCreator(user, { email: ' PERSON@example.com ', username: 'other', accountId: '99' }, 'gitee')).toBe(true)
  })

  it('matches account id and username only on the authenticated provider', () => {
    expect(matchesUserToCreator(user, { email: '', username: 'different', accountId: '42' }, 'github')).toBe(true)
    expect(matchesUserToCreator(user, { email: '', username: 'same-login', accountId: '99' }, 'github')).toBe(true)
    expect(matchesUserToCreator(user, { email: '', username: 'same-login', accountId: '42' }, 'gitlab')).toBe(false)
  })

  it('does not use profile display names as account identifiers', () => {
    expect(matchesUserToCreator(user, { email: '', username: 'Person Name', accountId: '' }, 'github')).toBe(false)
  })
})
