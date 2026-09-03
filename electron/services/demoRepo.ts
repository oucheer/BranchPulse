import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import fs from 'node:fs'
import path from 'node:path'

const execFileAsync = promisify(execFile)

interface Author {
  name: string
  email: string
}

const AUTHORS: Author[] = [
  { name: 'Ada Lovelace', email: 'ada@example.com' },
  { name: 'Grace Hopper', email: 'grace@example.com' },
  { name: 'Linus Chen', email: 'linus.chen@example.com' },
  { name: 'Maya Zhang', email: 'maya.zhang@example.com' }
]

function daysAgo(days: number, hour = 9, minute = 30): Date {
  const d = new Date()
  d.setDate(d.getDate() - days)
  d.setHours(hour, minute, 0, 0)
  return d
}

async function run(args: string[], dir: string, env: NodeJS.ProcessEnv = {}): Promise<void> {
  await execFileAsync('git', args, {
    cwd: dir,
    env: { ...process.env, ...env },
    windowsHide: true,
    maxBuffer: 32 * 1024 * 1024
  })
}

async function commit(
  dir: string,
  branch: string,
  message: string,
  date: Date,
  author: Author,
  file: string,
  content: string
): Promise<void> {
  await run(['checkout', '-B', branch], dir)
  fs.writeFileSync(path.join(dir, file), content)
  await run(['add', '-A'], dir)
  const dateStr = date.toISOString()
  await run(
    ['commit', '-m', message],
    dir,
    {
      GIT_AUTHOR_NAME: author.name,
      GIT_AUTHOR_EMAIL: author.email,
      GIT_AUTHOR_DATE: dateStr,
      GIT_COMMITTER_NAME: author.name,
      GIT_COMMITTER_EMAIL: author.email,
      GIT_COMMITTER_DATE: dateStr
    }
  )
}

export async function createDemoRepository(targetDir: string): Promise<void> {
  const originDir = `${targetDir}.git`
  fs.rmSync(targetDir, { recursive: true, force: true })
  fs.rmSync(originDir, { recursive: true, force: true })
  fs.mkdirSync(targetDir, { recursive: true })

  await run(['init', '-b', 'main'], targetDir)
  await run(['config', 'user.name', 'BranchPulse Demo'], targetDir)
  await run(['config', 'user.email', 'demo@branchpulse.local'], targetDir)
  await run(['config', 'commit.gpgsign', 'false'], targetDir)

  const file = 'README.md'
  const content = (text: string): string => `# demo-service\n\n${text}\n`

  await commit(targetDir, 'main', 'chore: initialize project', daysAgo(180), AUTHORS[0], file, content('Project scaffold and initial documentation.'))
  await commit(targetDir, 'develop', 'feat: add build pipeline', daysAgo(170), AUTHORS[1], file, content('CI pipeline with lint, typecheck and tests.'))
  await commit(targetDir, 'main', 'feat: add API skeleton', daysAgo(150), AUTHORS[2], file, content('HTTP API skeleton with routing and middleware.'))
  await commit(targetDir, 'develop', 'refactor: split domain modules', daysAgo(120), AUTHORS[1], file, content('Split domain logic into focused modules.'))
  await commit(targetDir, 'develop', 'feat: introduce persistence layer', daysAgo(90), AUTHORS[0], file, content('SQLite-backed persistence for domain entities.'))
  await commit(targetDir, 'main', 'feat: wire up auth middleware', daysAgo(100), AUTHORS[3], file, content('Authentication middleware for protected routes.'))
  await commit(targetDir, 'main', 'fix: resolve pagination bug', daysAgo(40), AUTHORS[2], file, content('Fix off-by-one pagination in list endpoints.'))

  // Active branch
  await commit(targetDir, 'feature/login', 'feat: social login providers', daysAgo(12), AUTHORS[1], file, content('Social login with GitHub and Google.'))
  await commit(targetDir, 'feature/login', 'feat: session refresh flow', daysAgo(3), AUTHORS[1], file, content('Refresh token rotation and session expiry handling.'))

  // Grace period branch (16 days ago, threshold 14)
  await commit(targetDir, 'feature/ai-agent', 'feat: AI agent scaffolding', daysAgo(40), AUTHORS[0], file, content('Agent tooling with prompt orchestration.'))
  await commit(targetDir, 'feature/ai-agent', 'feat: agent executor', daysAgo(16), AUTHORS[0], file, content('Executor loop with tool dispatch.'))

  // Grace period branch (17 days)
  await commit(targetDir, 'feature/payment', 'feat: payment webhooks', daysAgo(30), AUTHORS[2], file, content('Webhook receiver for payment provider.'))
  await commit(targetDir, 'feature/payment', 'fix: webhook signature', daysAgo(17), AUTHORS[2], file, content('Validate webhook signature before processing.'))

  // Grace expired cleanup candidate
  await commit(targetDir, 'bugfix/payment', 'fix: currency rounding', daysAgo(35), AUTHORS[3], file, content('Correct currency rounding for international payments.'))
  await commit(targetDir, 'bugfix/payment', 'fix: invoice totals', daysAgo(30), AUTHORS[3], file, content('Recalculate invoice totals on discount change.'))

  // Active protected-ish hotfix
  await commit(targetDir, 'hotfix/security', 'fix: harden token validation', daysAgo(8), AUTHORS[2], file, content('Reject malformed tokens with clear error.'))

  // Active release
  await commit(targetDir, 'release/1.0.0', 'chore: prepare release 1.0.0', daysAgo(5), AUTHORS[0], file, content('Release candidate with version bump and changelog.'))

  // Merged feature
  await commit(targetDir, 'merged-feature', 'feat: audit trail export', daysAgo(35), AUTHORS[1], file, content('Export audit trail to CSV and JSON.'))
  await run(['checkout', 'main'], targetDir)
  await run(['merge', '--no-ff', 'merged-feature', '-m', 'Merge merged-feature into main'], targetDir, {
    GIT_AUTHOR_NAME: AUTHORS[2].name,
    GIT_AUTHOR_EMAIL: AUTHORS[2].email,
    GIT_AUTHOR_DATE: daysAgo(30).toISOString(),
    GIT_COMMITTER_NAME: AUTHORS[2].name,
    GIT_COMMITTER_EMAIL: AUTHORS[2].email,
    GIT_COMMITTER_DATE: daysAgo(30).toISOString()
  })

  // Naming invalid, active
  await commit(targetDir, 'invalid_branch', 'feat: experimental work', daysAgo(2), AUTHORS[3], file, content('Experimental workstream not following naming rules.'))

  // Naming invalid, active
  await commit(targetDir, 'test', 'test: exploration branch', daysAgo(10), AUTHORS[0], file, content('Exploration branch without conventional prefix.'))

  // Old feature: stale, grace expired, naming invalid
  await commit(targetDir, 'old-feature', 'feat: legacy reporting', daysAgo(90), AUTHORS[1], file, content('Legacy reporting module from an earlier sprint.'))
  await commit(targetDir, 'old-feature', 'fix: legacy chart colors', daysAgo(45), AUTHORS[1], file, content('Adjust legacy chart palette.'))

  // Whitelisted, old
  await commit(targetDir, 'whitelisted-feature', 'feat: customer-specific logic', daysAgo(50), AUTHORS[3], file, content('Customer-specific integration kept for compliance.'))
  await commit(targetDir, 'whitelisted-feature', 'fix: customer mapping', daysAgo(35), AUTHORS[3], file, content('Update customer tenant mapping.'))

  // Recent main commit
  await commit(targetDir, 'main', 'chore: bump dependencies', daysAgo(1), AUTHORS[2], file, content('Update dependency lockfile.'))

  // Set up an origin so remote branches exist too.
  await run(['init', '--bare', originDir], targetDir)
  await run(['remote', 'add', 'origin', originDir], targetDir)
  await run(['push', '-u', 'origin', '--all'], targetDir)
  await run(['branch', '--set-upstream-to', 'origin/main', 'main'], targetDir)
  await run(['fetch', '--all', '--prune'], targetDir)
  await run(['checkout', 'main'], targetDir)

  fs.rmSync(originDir, { recursive: true, force: true })
}
