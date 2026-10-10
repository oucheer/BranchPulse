import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { Repository } from '@shared/types'

const exec = promisify(execFile)

export function validateAgentGitArgs(args: string[]): void {
  if (!args.length || args.length > 30 || args.some((arg) => arg.length > 300 || /[\r\n\0]/.test(arg))) throw new Error('无效的 Git 参数。')
  if (args[0] === 'branch' && args.some((arg) => /^-[^-]*[dD]/.test(arg) || arg.startsWith('--delete'))) throw new Error('禁止删除分支。')
  if (args[0] === 'push' || args[0] === 'update-ref') throw new Error('禁止删除远程分支或直接修改引用。')
  const flags: Record<string, RegExp> = {
    status: /^(--short|--branch|--porcelain(?:=v[12])?)$/,
    log: /^(--all|--oneline|--no-merges|--merges|--max-count=\d{1,4}|--author=[^\r\n]+|--since=[^\r\n]+|--until=[^\r\n]+)$/,
    branch: /^(--list|--all|--remotes|--verbose)$/,
    diff: /^(--stat|--name-only|--numstat|--no-ext-diff|--no-textconv)$/,
    show: /^(--stat|--name-only|--numstat|--oneline|--no-ext-diff|--no-textconv)$/,
    shortlog: /^(--all|-s|-n|-e|--summary|--numbered|--email)$/
  }
  if (!flags[args[0]] || args.slice(1).some((arg) => !flags[args[0]].test(arg) && !(args[0] !== 'branch' && args[0] !== 'status' && /^[a-f0-9]{7,40}$/.test(arg)))) throw new Error('命令或参数不在受控 Git 查询白名单中。')
}

export async function executeAgentGitCommand(repo: Repository, args: string[]): Promise<{ source: string; output: string; truncated: boolean }> {
  validateAgentGitArgs(args)
  if (repo.source !== 'local') throw new Error('该仓库没有本地检出目录，请使用业务 API 查询工具。')
  try {
    const result = await exec('git', ['--no-pager', ...args, ...(['diff', 'show'].includes(args[0]) ? ['--no-ext-diff', '--no-textconv'] : [])], {
      cwd: repo.path, shell: false, windowsHide: true, timeout: 15000, maxBuffer: 1024 * 1024,
      env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' }
    })
    return { source: 'local-git', output: result.stdout.slice(0, 12000), truncated: result.stdout.length > 12000 }
  } catch { throw new Error('Git 查询命令失败或超时。') }
}
