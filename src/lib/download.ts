import { reportDownloadPath } from '@shared/rpc'

function fileNameFrom(disposition: string, fallback: string): string {
  const match = /filename="?([^";]+)"?/i.exec(disposition)
  if (!match) return fallback
  try {
    return decodeURIComponent(match[1])
  } catch {
    return match[1]
  }
}

/**
 * Fetches a server-side file and hands it to the browser as a download.
 *
 * Used as the fallback when the backend cannot reveal a file in the operating
 * system's file manager, which is the normal case for a browser that is not on
 * the machine running the server.
 */
export async function downloadReportFile(id: string): Promise<void> {
  const response = await fetch(reportDownloadPath(id))
  if (!response.ok) {
    const detail = await response.text()
    throw new Error(detail || `报告文件不可下载（HTTP ${response.status}）。`)
  }
  const blob = await response.blob()
  const name = fileNameFrom(response.headers.get('content-disposition') ?? '', `report-${id}`)
  const objectUrl = URL.createObjectURL(blob)
  try {
    const link = document.createElement('a')
    link.href = objectUrl
    link.download = name
    document.body.appendChild(link)
    link.click()
    link.remove()
  } finally {
    URL.revokeObjectURL(objectUrl)
  }
}
