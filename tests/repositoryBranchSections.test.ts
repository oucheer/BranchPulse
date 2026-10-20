import { describe, expect, it } from 'vitest'
import { groupBranchesByRepository } from '../src/lib/repositoryBranchSections'

describe('repository branch sections', () => {
  it('keeps the same branch name in each repository section', () => {
    const repositories = [
      { id: 'repo-a', name: 'Alpha' },
      { id: 'repo-b', name: 'Beta' }
    ]
    const branches = [
      { id: 'a-feature', repositoryId: 'repo-a', name: 'feature/shared' },
      { id: 'b-feature', repositoryId: 'repo-b', name: 'feature/shared' },
      { id: 'a-main', repositoryId: 'repo-a', name: 'main' }
    ]

    const sections = groupBranchesByRepository(repositories, branches)

    expect(sections.map((section) => section.repository.name)).toEqual(['Alpha', 'Beta'])
    expect(sections[0].branches.map((branch) => branch.id)).toEqual(['a-feature', 'a-main'])
    expect(sections[1].branches.map((branch) => branch.id)).toEqual(['b-feature'])
  })

  it('preserves repositories that have no matching branches', () => {
    const sections = groupBranchesByRepository(
      [{ id: 'repo-a' }, { id: 'repo-empty' }],
      [{ id: 'branch-a', repositoryId: 'repo-a' }]
    )

    expect(sections.map((section) => section.branches.length)).toEqual([1, 0])
  })
})
