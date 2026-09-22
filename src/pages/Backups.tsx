import { useState } from 'react'
import { FolderOpen, FolderDown, Trash2, HardDrive } from 'lucide-react'
import { useAppStore, tr } from '../stores/appStore'
import { Badge, Card, EmptyState } from '../components/ui'
import { timeAgo } from '../lib/format'
import type { BackupRecord } from '@shared/types'

const statusTone = (status: BackupRecord['status']): 'ok' | 'warn' | 'danger' =>
  status === 'success' ? 'ok' : status === 'failed' ? 'danger' : 'warn'

export default function Backups(): JSX.Element {
  const repositories = useAppStore((s) => s.repositories)
  const backups = useAppStore((s) => s.backups)
  const selectedRepositoryIds = useAppStore((s) => s.selectedRepositoryIds)
  const toast = useAppStore((s) => s.toast)
  const refresh = useAppStore((s) => s.refresh)
  const [folderPath, setFolderPath] = useState('')
  const [busy, setBusy] = useState(false)

  const noSelection = selectedRepositoryIds.length === 0

  const startBackup = async (): Promise<void> => {
    if (noSelection) return
    setBusy(true)
    try {
      const records = await window.gitmanager.startBackups({
        repositoryIds: selectedRepositoryIds,
        folderPath: folderPath || undefined
      })
      if (records.length === 0) {
        toast('未选择仓库：请先勾选仓库', 'warn')
        return
      }
      const succeeded = records.filter((record) => record.status === 'success')
      const failed = records.filter((record) => record.status !== 'success')
      const summary = `备份完成：成功 ${succeeded.length} 个，失败 ${failed.length} 个（共 ${records.length} 个仓库）`
      toast(
        failed.length === 0 ? summary : `${summary}\n失败仓库：${failed.map((r) => `${r.repositoryName}（${r.error ?? '未知错误'}）`).join('；')}`,
        failed.length === 0 ? 'success' : failed.length === records.length ? 'error' : 'warn'
      )
      void refresh()
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), 'error')
    } finally {
      setBusy(false)
    }
  }

  const chooseFolder = async (): Promise<void> => {
    try {
      const selected = await window.gitmanager.selectBackupFolder()
      if (selected) setFolderPath(selected)
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), 'error')
    }
  }

  const deleteBackup = async (id: string): Promise<void> => {
    try {
      await window.gitmanager.deleteBackup(id)
      toast('备份已删除', 'success')
      void refresh()
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), 'error')
    }
  }

  const openBackupFolder = async (backupPath: string): Promise<void> => {
    try {
      await window.gitmanager.openBackupFolder(backupPath)
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), 'error')
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-lg font-bold text-canvas-fg">{tr('backup')}</h1>
          <div className="text-xs text-muted">{backups.length} 条备份记录</div>
        </div>
      </div>

      <Card className="p-4">
        <div className="mb-3 flex items-center gap-2 text-sm font-semibold text-canvas-fg">
          <HardDrive size={15} className="text-primary" /> 一键备份
        </div>
        <div className={`mb-3 rounded-md border px-3 py-2 text-xs ${noSelection ? 'border-warn/40 bg-warn/10 text-warn' : 'border-line bg-surface/60 text-muted'}`}>
          {noSelection
            ? '未选择仓库：请先在仓库页勾选仓库，一键备份只处理勾选范围内的仓库。'
            : `备份范围：已勾选 ${selectedRepositoryIds.length} 个仓库（可在仓库页或顶栏调整），将按顺序逐个备份。`}
        </div>
        <div className="grid gap-3 md:grid-cols-[1fr_auto] md:items-end">
          <div>
            <div className="label mb-1.5">备份目录</div>
            <div className="flex items-center gap-2">
              <input className="input" value={folderPath} placeholder="默认使用应用数据目录下的 backups" readOnly />
              <button className="btn px-3" onClick={() => void chooseFolder()}>
                <FolderOpen size={14} /> 选择
              </button>
            </div>
          </div>
          <button
            className="btn btn-primary"
            disabled={busy || noSelection || repositories.length === 0}
            title={noSelection ? '未选择仓库：请先勾选仓库' : undefined}
            onClick={() => void startBackup()}
          >
            <FolderDown size={14} /> {busy ? '备份中...' : `备份勾选的 ${selectedRepositoryIds.length} 个仓库`}
          </button>
        </div>
      </Card>

      {backups.length === 0 ? (
        <EmptyState title="暂无备份记录" />
      ) : (
        <div className="space-y-2">
          {backups.map((backup) => (
            <Card key={backup.id} className="p-3">
              <div className="flex min-w-0 items-start gap-3">
                <div className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-secondary/10 text-secondary">
                  <HardDrive size={16} />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="truncate text-sm font-semibold text-canvas-fg">{backup.repositoryName}</span>
                    <Badge tone={statusTone(backup.status)}>{backup.status}</Badge>
                    <span className="text-xs text-muted">{timeAgo(backup.startedAt)}</span>
                  </div>
                  <div className="mt-1 truncate text-xs text-muted">{backup.path}</div>
                  {backup.error ? <div className="mt-1 text-xs text-danger">{backup.error}</div> : null}
                </div>
                <div className="flex items-center gap-1">
                  <button className="btn px-2" title="打开备份目录" onClick={() => void openBackupFolder(backup.path)}>
                    <FolderOpen size={14} />
                  </button>
                  <button className="btn px-2" title="删除备份" onClick={() => void deleteBackup(backup.id)}>
                    <Trash2 size={14} className="text-danger" />
                  </button>
                </div>
              </div>
            </Card>
          ))}
        </div>
      )}
    </div>
  )
}
