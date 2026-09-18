import type { BranchApi, ScanProgress } from '@shared/types'
import { EVENTS_PATH, EXPOSED_METHODS, RPC_PREFIX } from '@shared/rpc'

/**
 * Browser implementation of the `window.gitmanager` bridge.
 *
 * The renderer keeps calling the exact same methods it called through
 * `ipcRenderer.invoke`; only the transport changes: every call becomes
 * `POST /api/rpc/<method>` with the positional arguments as a JSON array, and
 * the two push channels (`scan-progress` / `navigate`) arrive over SSE.
 */

type Unsubscribe = () => void

async function callRpc(method: string, args: unknown[]): Promise<unknown> {
  let response: Response
  try {
    response = await fetch(`${RPC_PREFIX}${encodeURIComponent(method)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(args)
    })
  } catch (err) {
    throw new Error(`无法连接 GitManager 后端：${err instanceof Error ? err.message : String(err)}`)
  }
  const text = await response.text()
  let payload: unknown = null
  try {
    payload = text ? JSON.parse(text) : null
  } catch {
    throw new Error(`后端返回了非 JSON 响应（HTTP ${response.status}）。`)
  }
  const body = (payload ?? {}) as { result?: unknown; error?: string }
  if (!response.ok || body.error) {
    throw new Error(body.error ?? `请求失败（HTTP ${response.status}）。`)
  }
  return body.result ?? null
}

/**
 * One shared `EventSource` per event name. `EventSource` reconnects on its own,
 * so the connection is only closed once the last subscriber unsubscribes.
 */
function createEventChannel<T>(event: string): (listener: (payload: T) => void) => Unsubscribe {
  const listeners = new Set<(payload: T) => void>()
  let source: EventSource | null = null

  const ensureSource = (): void => {
    if (source || typeof EventSource === 'undefined') return
    source = new EventSource(EVENTS_PATH)
    source.addEventListener(event, (message) => {
      let payload: T
      try {
        payload = JSON.parse((message as MessageEvent<string>).data) as T
      } catch {
        return
      }
      for (const listener of [...listeners]) listener(payload)
    })
    // `onerror` is informational: the browser retries the connection itself.
    source.onerror = () => undefined
  }

  return (listener) => {
    listeners.add(listener)
    ensureSource()
    return () => {
      listeners.delete(listener)
      if (listeners.size === 0 && source) {
        source.close()
        source = null
      }
    }
  }
}

const onScanProgress = createEventChannel<ScanProgress>('scan-progress')
const onNavigate = createEventChannel<string>('navigate')

export function createWebBridge(): BranchApi {
  const bridge: Record<string, unknown> = {}
  for (const method of EXPOSED_METHODS) {
    bridge[method] = (...args: unknown[]): Promise<unknown> => callRpc(method, args)
  }
  bridge.onScanProgress = onScanProgress
  bridge.onNavigate = onNavigate
  return bridge as unknown as BranchApi
}

/**
 * Installs the bridge unless a desktop preload already provided one. Layout
 * calls `window.gitmanager.onScanProgress` unconditionally, so this has to run
 * before the first render and must never throw.
 */
export function installWebBridge(): void {
  if (typeof window === 'undefined') return
  if (!window.gitmanager) window.gitmanager = createWebBridge()
}
