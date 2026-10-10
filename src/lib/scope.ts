import type { Repository } from '@shared/types'

/**
 * 仓库范围的统一展示文案。空数组表示「没有仓库」，不再表示「全部仓库」。
 */
export function repositoryScopeLabel(repositoryIds: string[], repositories: Repository[]): string {
  if (repositoryIds.length === 0) return '未选择仓库'
  return repositoryIds
    .map((id) => repositories.find((repo) => repo.id === id)?.name ?? '已删除仓库')
    .join('、')
}

/** 任务/报告范围是否完全落在当前勾选范围内（完全覆盖才允许写操作）。 */
export function isScopeFullySelected(repositoryIds: string[], selectedRepositoryIds: string[]): boolean {
  if (repositoryIds.length === 0) return false
  const selected = new Set(selectedRepositoryIds)
  return repositoryIds.every((id) => selected.has(id))
}
