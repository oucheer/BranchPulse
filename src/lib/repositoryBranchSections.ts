export interface RepositoryBranchSection<Repository, Branch> {
  repository: Repository
  branches: Branch[]
}

/**
 * Keep every repository in its own section, in the same order as the selected
 * repository list. A branch is never merged into another repository merely
 * because both repositories contain a branch with the same name.
 */
export function groupBranchesByRepository<
  Repository extends { id: string },
  Branch extends { repositoryId: string }
>(
  repositories: readonly Repository[],
  branches: readonly Branch[]
): Array<RepositoryBranchSection<Repository, Branch>> {
  return repositories.map((repository) => ({
    repository,
    branches: branches.filter((branch) => branch.repositoryId === repository.id)
  }))
}
