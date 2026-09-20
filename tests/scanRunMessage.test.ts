import { describe, expect, it } from 'vitest'
import type { ScanRun } from '@shared/types'
import { describeScanRun } from '../src/lib/format'

/**
 * The toast is the only place a manual scan reports back, so an "0 branches"
 * success message for a run that actually failed is a dead end for the user:
 * the failure reason has to be the headline.
 */

function run(patch: Partial<ScanRun> = {}): ScanRun {
  return {
    id: 'run-1',
    startedAt: '2026-09-20T00:00:00.000Z',
    finishedAt: '2026-09-20T00:00:01.000Z',
    status: 'completed',
    trigger: 'scan_repository',
    repositories: 1,
    branches: 0,
    active: 0,
    stale: 0,
    merged: 0,
    namingInvalid: 0,
    cleanupCandidates: 0,
    notifications: 0,
    emailsSent: 0,
    error: null,
    activity: [],
    ...patch
  }
}

describe('describeScanRun', () => {
  it('reports the failure reason rather than an empty success', () => {
    const result = describeScanRun(run({ status: 'failed', error: 'alpha: Remote repository API 404 Not Found' }))
    expect(result.level).toBe('error')
    expect(result.message).toContain('404')
  })

  it('keeps a partial failure short by showing only the first repository', () => {
    const result = describeScanRun(run({ branches: 3, error: 'alpha: boom | beta: bang' }))
    expect(result.level).toBe('warn')
    expect(result.message).toContain('alpha: boom')
    expect(result.message).not.toContain('bang')
  })

  it('celebrates a genuinely empty repository as a success', () => {
    expect(describeScanRun(run({ branches: 0 })).level).toBe('success')
    expect(describeScanRun(run({ branches: 12 })).message).toContain('12')
  })
})
