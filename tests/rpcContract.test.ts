import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { EVENTS_PATH, EXPOSED_METHODS, FOLDERS_PATH, RPC_PREFIX, reportDownloadPath, type ExposedMethod } from '@shared/rpc'
import { createBranchPulseApi, type AppServices, type BranchPulseApi } from '../src-node/api'
import { invoke, isExposedMethod } from '../server/rpc'

/**
 * Members the renderer uses but that never travel over HTTP: the progress sink
 * is server-side wiring, and the two `on*` subscriptions are implemented
 * locally against SSE rather than forwarded to the backend.
 */
const LOCAL_ONLY = ['setProgressSink', 'onScanProgress', 'onNavigate'] as const

type ApiMember = keyof BranchPulseApi
type MissingFromWhitelist = Exclude<ApiMember, ExposedMethod | (typeof LOCAL_ONLY)[number]>
type MissingFromApi = Exclude<ExposedMethod, ApiMember>

/**
 * Compile-time proof that the whitelist and the API surface describe the same
 * set. If a method is added to only one side these assignments stop type
 * checking, which `npm run typecheck` reports.
 */
const whitelistCoversApi: MissingFromWhitelist extends never ? true : never = true
const apiCoversWhitelist: MissingFromApi extends never ? true : never = true

/** Service graph stub: construction only wires callbacks, it never calls them. */
function stubServices(): AppServices {
  const target: Record<string | symbol, unknown> = {}
  return new Proxy(target, {
    get: (_, key) => (key === 'then' ? undefined : new Proxy(() => undefined, { apply: () => undefined })),
    set: () => true
  }) as unknown as AppServices
}

function realApi(): BranchPulseApi {
  return createBranchPulseApi(stubServices(), { appVersion: () => '0.0.0-test' })
}

describe('RPC whitelist', () => {
  it('keeps the compile-time proof meaningful', () => {
    expect(whitelistCoversApi).toBe(true)
    expect(apiCoversWhitelist).toBe(true)
  })

  it('exposes exactly the implemented methods, minus the local-only ones', () => {
    const exposed = new Set<string>(EXPOSED_METHODS)
    for (const member of LOCAL_ONLY) exposed.add(member)
    expect([...Object.keys(realApi())].sort()).toEqual([...exposed].sort())
  })

  it('does not list duplicates', () => {
    expect(new Set(EXPOSED_METHODS).size).toBe(EXPOSED_METHODS.length)
  })

  it('refuses the internal-only members', () => {
    for (const member of LOCAL_ONLY) expect(isExposedMethod(member)).toBe(false)
  })

  it('covers every method the renderer calls', () => {
    const srcDir = fileURLToPath(new URL('../src', import.meta.url))
    const called = new Set<string>()
    const walk = (dir: string): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name)
        if (entry.isDirectory()) {
          walk(full)
          continue
        }
        if (!/\.tsx?$/.test(entry.name)) continue
        const source = fs.readFileSync(full, 'utf8')
        for (const match of source.matchAll(/window\.branchpulse\.([A-Za-z0-9_]+)/g)) called.add(match[1])
      }
    }
    walk(srcDir)
    expect(called.size).toBeGreaterThan(0)
    const unknown = [...called].filter((name) => !isExposedMethod(name) && !LOCAL_ONLY.includes(name as never))
    expect(unknown).toEqual([])
  })
})

describe('RPC transport paths', () => {
  it('builds request paths the renderer and server agree on', () => {
    expect(RPC_PREFIX).toBe('/api/rpc/')
    expect(EVENTS_PATH).toBe('/api/events')
    expect(FOLDERS_PATH).toBe('/api/fs/folders')
    expect(reportDownloadPath('report-1')).toBe('/api/reports/report-1/download')
    expect(reportDownloadPath('a/b c')).toBe('/api/reports/a%2Fb%20c/download')
  })
})

describe('invoke', () => {
  function api(overrides: Record<string, unknown>): BranchPulseApi {
    return overrides as unknown as BranchPulseApi
  }

  it('rejects unknown methods with 404', async () => {
    const result = await invoke(api({}), 'definitelyNotAMethod', [])
    expect(result.status).toBe(404)
    expect(result.body).toMatchObject({ error: expect.stringContaining('Unknown method') })
  })

  it('rejects whitelisted methods that are not implemented', async () => {
    const result = await invoke(api({}), 'init', [])
    expect(result.status).toBe(404)
    expect(result.body).toMatchObject({ error: expect.stringContaining('not implemented') })
  })

  it('forwards positional arguments and wraps the result', async () => {
    const calls: unknown[][] = []
    const result = await invoke(
      api({ scanRepository: (...args: unknown[]) => { calls.push(args); return Promise.resolve({ id: 'run-1' }) } }),
      'scanRepository',
      ['repo-1', true]
    )
    expect(calls).toEqual([['repo-1', true]])
    expect(result).toEqual({ status: 200, body: { result: { id: 'run-1' } } })
  })

  it('normalises undefined to null so the body stays valid JSON', async () => {
    const result = await invoke(api({ clearNotifications: async () => undefined }), 'clearNotifications', [])
    expect(result).toEqual({ status: 200, body: { result: null } })
  })

  it('reports thrown errors as 500 without leaking the stack', async () => {
    const result = await invoke(api({ init: async () => { throw new Error('数据库已锁定') } }), 'init', [])
    expect(result.status).toBe(500)
    expect(result.body).toEqual({ error: '数据库已锁定' })
    expect(JSON.stringify(result.body)).not.toContain('at ')
  })

  it('stringifies non-Error rejections', async () => {
    const result = await invoke(api({ init: async () => { throw 'boom' } }), 'init', [])
    expect(result.body).toEqual({ error: 'boom' })
  })
})
