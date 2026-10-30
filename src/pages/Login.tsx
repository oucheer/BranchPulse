import { useState } from 'react'
import { GitBranch, LogIn, Shield, User } from 'lucide-react'
import { useAppStore } from '../stores/appStore'
import { Card } from '../components/ui'

type Mode = 'admin' | 'user'

export default function Login(): JSX.Element {
  const login = useAppStore((s) => s.login)
  const toast = useAppStore((s) => s.toast)
  const language = useAppStore((s) => s.language)
  const zh = language === 'zh'
  const [mode, setMode] = useState<Mode>('admin')
  const [username, setUsername] = useState('admin')
  const [password, setPassword] = useState('')
  const [gitlabToken, setGitlabToken] = useState('')
  const [busy, setBusy] = useState(false)

  const submit = async (): Promise<void> => {
    setBusy(true)
    try {
      if (mode === 'admin') await login(username.trim(), password, null)
      else await login(null, null, null, gitlabToken.trim())
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), 'error')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex h-screen items-center justify-center bg-canvas px-4">
      <Card className="w-full max-w-sm p-6">
        <div className="mb-5 flex items-center gap-2.5">
          <div className="flex h-9 w-9 items-center justify-center rounded-md bg-gradient-to-br from-primary to-secondary">
            <GitBranch size={18} className="text-white" />
          </div>
          <div>
            <div className="text-base font-bold text-canvas-fg">GitManager</div>
            <div className="text-xs text-muted">{zh ? '请选择身份登录' : 'Sign in to continue'}</div>
          </div>
        </div>

        <div className="mb-4 grid grid-cols-2 gap-2">
          <button
            className={`flex items-center justify-center gap-1.5 rounded-md border px-3 py-2 text-sm font-medium transition-colors ${
              mode === 'admin' ? 'border-primary/60 bg-primary/10 text-primary' : 'border-line bg-elevated text-muted hover:text-canvas-fg'
            }`}
            onClick={() => setMode('admin')}
          >
            <Shield size={14} /> {zh ? '管理员' : 'Admin'}
          </button>
          <button
            className={`flex items-center justify-center gap-1.5 rounded-md border px-3 py-2 text-sm font-medium transition-colors ${
              mode === 'user' ? 'border-primary/60 bg-primary/10 text-primary' : 'border-line bg-elevated text-muted hover:text-canvas-fg'
            }`}
            onClick={() => setMode('user')}
          >
            <User size={14} /> {zh ? '普通用户' : 'User'}
          </button>
        </div>

        {mode === 'admin' ? (
          <div className="space-y-3">
            <div>
              <div className="label mb-1.5">{zh ? '账号' : 'Username'}</div>
              <input className="input w-full" value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="username" />
            </div>
            <div>
              <div className="label mb-1.5">{zh ? '密码' : 'Password'}</div>
              <input className="input w-full" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" />
            </div>
          </div>
        ) : (
          <div>
            <div className="label mb-1.5">{zh ? 'GitLab Access Token' : 'GitLab Access Token'}</div>
            <input className="input w-full" type="password" value={gitlabToken} onChange={(e) => setGitlabToken(e.target.value)} autoComplete="off" />
            <p className="mt-2 text-xs text-muted">{zh ? '使用 GitLab Personal Access Token 登录，需要 read_api 和 read_repository 权限。' : 'Use a GitLab Personal Access Token with read_api and read_repository access.'}</p>
          </div>
        )}

        <button className="btn btn-primary mt-5 w-full" disabled={busy} onClick={() => void submit()}>
          <LogIn size={14} /> {busy ? (zh ? '登录中…' : 'Signing in…') : (zh ? '登录' : 'Sign in')}
        </button>
      </Card>
    </div>
  )
}
