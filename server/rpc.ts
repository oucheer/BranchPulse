import { EXPOSED_METHODS, type ExposedMethod } from '@shared/rpc'
import type { BranchPulseApi } from '../src-node/api'

export type { ExposedMethod }

const exposed = new Set<string>(EXPOSED_METHODS)

export function isExposedMethod(name: string): name is ExposedMethod {
  return exposed.has(name)
}

export function exposeMethods(): ExposedMethod[] {
  return [...EXPOSED_METHODS]
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message
  return String(err)
}

export interface RpcResult {
  status: number
  body: unknown
}

/**
 * Invokes one renderer-facing method. Arguments arrive as a positional JSON
 * array, exactly matching the previous `ipcRenderer.invoke(channel, ...args)`
 * call sites, so no renderer code had to change.
 */
export async function invoke(api: BranchPulseApi, method: string, args: unknown[]): Promise<RpcResult> {
  if (!isExposedMethod(method)) {
    return { status: 404, body: { error: `Unknown method: ${method}` } }
  }
  const fn = (api as unknown as Record<string, unknown>)[method]
  if (typeof fn !== 'function') {
    return { status: 404, body: { error: `Method not implemented: ${method}` } }
  }
  try {
    const value = await (fn as (...a: unknown[]) => unknown).apply(api, args)
    return { status: 200, body: { result: value === undefined ? null : value } }
  } catch (err) {
    return { status: 500, body: { error: errorMessage(err) } }
  }
}
