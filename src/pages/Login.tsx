import { useState } from 'react'
import { GitBranch, LogIn, Shield, User, ArrowRight } from 'lucide-react'
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
  const [email, setEmail] = useState('')
  const [accessToken, setAccessToken] = useState('')
  const [busy, setBusy] = useState(false)

  const submit = async (): Promise<void> => {
    if (busy) return
    if (mode === 'admin' ? !username.trim() || !password : !email.trim() || !accessToken.trim()) {
      toast(zh ? '请填写全部登录信息。' : 'Please complete all sign-in fields.', 'error')
      return
    }
    setBusy(true)
    try {
      if (mode === 'admin') await login(username.trim(), password, null)
      else await login(null, null, email.trim(), accessToken.trim())
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), 'error')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="login-scene relative flex min-h-screen items-center justify-center overflow-hidden bg-canvas px-4 py-8">
      <div className="login-glow login-glow-one" /><div className="login-glow login-glow-two" />
      <Card className="login-panel relative z-10 w-full max-w-md p-7 sm:p-9">
        <div className="mb-7 flex items-center gap-3">
          <div className="login-mark flex h-11 w-11 items-center justify-center rounded-xl"><GitBranch size={21} className="text-white" /></div>
          <div><div className="text-lg font-bold text-canvas-fg">GitManager</div><div className="mt-1 text-xs text-muted">{zh ? '统一查看代码协作与研发活动' : 'Your engineering activity workspace'}</div></div>
        </div>
        <h1 className="mb-1 text-xl font-semibold text-canvas-fg">{zh ? '欢迎回来' : 'Welcome back'}</h1>
        <p className="mb-6 text-sm text-muted">{zh ? '登录以继续使用 GitManager' : 'Sign in to continue to GitManager'}</p>

        <div className="mb-4 grid grid-cols-2 gap-2">
          <button
            className={`flex items-center justify-center gap-1.5 rounded-md border px-3 py-2.5 text-sm font-medium transition-colors ${
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

        <form onSubmit={(event) => { event.preventDefault(); void submit() }}>
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
          <div className="space-y-5">
            <div>
              <div className="label mb-1.5">{zh ? '邮箱' : 'Email'}</div>
              <input className="input w-full" type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="name@example.com" autoComplete="email" />
            </div>
            <div>
              <div className="label mb-1.5">Access Token</div>
              <input className="input w-full" type="password" value={accessToken} onChange={(e) => setAccessToken(e.target.value)} autoComplete="off" />
              <p className="mt-2 text-xs text-muted">{zh ? '使用当前平台（GitLab / GitHub / Gitee）的 Access Token 登录，需要读取仓库和账号信息的权限。' : 'Use an Access Token for the configured platform (GitLab / GitHub / Gitee) with permission to read repositories and account details.'}</p>
            </div>
          </div>
        )}

        <button type="submit" className="login-submit btn btn-primary mt-6 w-full justify-between" disabled={busy}>
          <span className="flex items-center gap-2"><LogIn size={15} />{busy ? (zh ? '登录中…' : 'Signing in…') : (zh ? '登录' : 'Sign in')}</span><ArrowRight size={16} />
        </button>
        </form>
      </Card>
    </div>
  )
}
