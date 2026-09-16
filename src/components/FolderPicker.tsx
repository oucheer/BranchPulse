import { useCallback, useEffect, useState } from 'react'
import { ArrowUp, CornerDownLeft, Folder, FolderOpen, HardDrive, RefreshCw, Star } from 'lucide-react'
import { FOLDERS_PATH } from '@shared/rpc'
import type { FolderListing } from '@shared/types'
import { tr } from '../stores/appStore'
import { Modal } from './ui'

interface FolderPickerProps {
  open: boolean
  /**
   * `folder` picks a directory (backup folder, export target), `file` picks an
   * existing file, `save` picks a directory plus a file name (config export).
   */
  mode?: 'folder' | 'file' | 'save'
  title?: string
  /** Extensions accepted in `file` mode, lower case and without a dot. */
  extensions?: string[]
  /** Directory the picker opens with. Empty starts at the quick locations. */
  initialPath?: string
  /** Pre-filled file name in `save` mode. */
  defaultFileName?: string
  /** Label of the confirm button; defaults to the "use this" wording. */
  confirmLabel?: string
  onSelect: (path: string) => void
  onClose: () => void
}

const emptyListing = (): FolderListing => ({ path: '', parent: '', entries: [], files: [], roots: [] })

/** Joins a directory and a file name using the separator the path already uses. */
export function joinPath(directory: string, name: string): string {
  const separator = directory.includes('\\') ? '\\' : '/'
  return `${directory.replace(/[\\/]+$/, '')}${separator}${name}`
}

/**
 * In-page replacement for the desktop folder dialog.
 *
 * Lists directories (and optionally files) straight from the backend, because a
 * browser has no way to open a native picker that yields a real server path.
 * The button that opens it is unchanged, so the page layout stays identical.
 */
export default function FolderPicker({
  open,
  mode = 'folder',
  title,
  extensions = [],
  initialPath = '',
  defaultFileName = '',
  confirmLabel,
  onSelect,
  onClose
}: FolderPickerProps): JSX.Element | null {
  const [listing, setListing] = useState<FolderListing>(emptyListing)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [fileName, setFileName] = useState(defaultFileName)

  // `extensions` defaults to a fresh `[]` on every render, so depending on the
  // array itself would rebuild `load` each time and make the effect below fetch
  // in a loop: setState → render → new callback → effect → fetch → setState.
  // The joined string is compared by value, which keeps `load` stable.
  const extensionKey = extensions.join(',')

  const load = useCallback(
    async (target: string): Promise<void> => {
      setLoading(true)
      setError('')
      try {
        const params = new URLSearchParams()
        params.set('path', target)
        if (mode === 'file') {
          params.set('files', '1')
          if (extensionKey) params.set('ext', extensionKey)
        }
        const response = await fetch(`${FOLDERS_PATH}?${params.toString()}`)
        const payload = (await response.json()) as FolderListing & { error?: string }
        if (!response.ok || payload.error) throw new Error(payload.error ?? '无法读取目录')
        setListing(payload)
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err))
        setListing(emptyListing())
      } finally {
        setLoading(false)
      }
    },
    [extensionKey, mode]
  )

  useEffect(() => {
    if (!open) return
    setFileName(defaultFileName)
    void load(initialPath)
  }, [defaultFileName, initialPath, load, open])

  const canPick = listing.path !== ''
  const resolvedTitle = title ?? (mode === 'file' ? tr('pickFileTitle') : tr('pickFolderTitle'))
  const fileMode = mode === 'file'
  const saveMode = mode === 'save'
  const canConfirm = canPick && (!saveMode || fileName.trim() !== '')

  return (
    <Modal
      open={open}
      title={resolvedTitle}
      width={620}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            {tr('cancel')}
          </button>
          {fileMode ? null : (
            <button
              className="btn btn-primary"
              disabled={!canConfirm}
              onClick={() => {
                if (!canConfirm) return
                onSelect(saveMode ? joinPath(listing.path, fileName.trim()) : listing.path)
              }}
            >
              <CornerDownLeft size={14} /> {confirmLabel ?? (saveMode ? tr('save') : tr('useThisFolder'))}
            </button>
          )}
        </>
      }
    >
      <div className="space-y-3">
        {saveMode ? (
          <div>
            <div className="label mb-1.5">{tr('fileName')}</div>
            <input className="input font-mono text-xs" value={fileName} onChange={(e) => setFileName(e.target.value)} />
          </div>
        ) : null}
        <div className="flex items-center gap-2">
          <button className="btn px-2" disabled={!listing.parent || loading} onClick={() => void load(listing.parent)} title={tr('parentFolder')}>
            <ArrowUp size={14} />
          </button>
          <input className="input flex-1 font-mono text-xs" value={listing.path} readOnly placeholder={tr('currentFolder')} />
          <button className="btn px-2" disabled={loading} onClick={() => void load(listing.path || initialPath)} title={tr('refresh')}>
            <RefreshCw size={14} className={loading ? 'animate-spin' : undefined} />
          </button>
        </div>

        <div className="flex flex-wrap gap-1.5">
          {listing.roots.map((root) => (
            <button key={root.path} className="btn px-2 text-[11px]" onClick={() => void load(root.path)} title={root.path}>
              {root.path === listing.path ? <FolderOpen size={12} /> : <Star size={12} />} {root.name}
            </button>
          ))}
        </div>

        <div className="max-h-72 overflow-y-auto rounded-md border border-line">
          {error ? (
            <div className="px-3 py-4 text-sm text-danger">{error}</div>
          ) : (
            <>
              {listing.entries.map((entry) => (
                <button
                  key={entry.path}
                  className="flex w-full items-center gap-2 border-b border-line/60 px-3 py-2 text-left text-sm text-muted hover:bg-line/30 hover:text-canvas-fg"
                  onClick={() => void load(entry.path)}
                >
                  <Folder size={14} className="text-secondary" /> <span className="truncate">{entry.name}</span>
                </button>
              ))}
              {listing.files.map((file) => (
                <button
                  key={file.path}
                  className="flex w-full items-center gap-2 border-b border-line/60 px-3 py-2 text-left text-sm text-muted hover:bg-line/30 hover:text-canvas-fg"
                  onClick={() => onSelect(file.path)}
                >
                  <HardDrive size={14} className="text-primary" /> <span className="truncate">{file.name}</span>
                </button>
              ))}
              {!loading && listing.entries.length === 0 && listing.files.length === 0 ? (
                <div className="px-3 py-4 text-sm text-muted">
                  {listing.path === '' ? tr('quickLocations') : fileMode ? tr('noMatchingFiles') : tr('noSubfolders')}
                </div>
              ) : null}
            </>
          )}
        </div>
      </div>
    </Modal>
  )
}
