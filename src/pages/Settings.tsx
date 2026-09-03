import { useEffect, useState } from 'react'
import { CheckCircle2, Cloud, Mail, Save, Settings as SettingsIcon, Wrench } from 'lucide-react'
import { useAppStore, tr } from '../stores/appStore'
import { Badge, Card, Toggle } from '../components/ui'
import type { AppSettings, EmailConfig, LanguageCode, ThemeMode } from '@shared/types'

export default function Settings(): JSX.Element {
  const settings = useAppStore((s) => s.settings)
  const emailConfig = useAppStore((s) => s.emailConfig)
  const language = useAppStore((s) => s.language)
  const setLanguage = useAppStore((s) => s.setLanguage)
  const toast = useAppStore((s) => s.toast)
  const refresh = useAppStore((s) => s.refresh)

  const [draft, setDraft] = useState<AppSettings>(settings)
  const [emailDraft, setEmailDraft] = useState<EmailConfig & { password?: string }>({
    server: '',
    port: 587,
    username: '',
    hasPassword: false,
    from: '',
    secure: true,
    tls: false,
    testRecipient: '',
    enabled: false
  })
  const [savingApp, setSavingApp] = useState(false)
  const [savingEmail, setSavingEmail] = useState(false)
  const [testing, setTesting] = useState(false)
  const [gitlabBusy, setGitlabBusy] = useState(false)
  const [gitlabApiKey, setGitlabApiKey] = useState('')

  useEffect(() => {
    setDraft(settings)
  }, [settings])

  useEffect(() => {
    if (emailConfig) setEmailDraft(emailConfig)
  }, [emailConfig])

  const applyTheme = (theme: ThemeMode): void => {
    const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches
    const dark = theme === 'dark' || (theme === 'system' && prefersDark)
    document.documentElement.classList.toggle('light', !dark)
    document.documentElement.classList.toggle('dark', dark)
  }

  useEffect(() => {
    applyTheme(settings.theme)
  }, [settings.theme])

  const saveApp = async (): Promise<void> => {
    setSavingApp(true)
    try {
      const saved = await window.branchpulse.saveSettings(draft)
      setDraft(saved)
      applyTheme(saved.theme)
      setLanguage(saved.language)
      toast(tr('saved'), 'success')
      void refresh()
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), 'error')
    } finally {
      setSavingApp(false)
    }
  }

  const saveEmail = async (): Promise<void> => {
    setSavingEmail(true)
    try {
      const saved = await window.branchpulse.saveEmailConfig(emailDraft)
      setEmailDraft(saved)
      toast(tr('saveConfig') + ' OK', 'success')
      void refresh()
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), 'error')
    } finally {
      setSavingEmail(false)
    }
  }

  const testConnection = async (): Promise<void> => {
    setTesting(true)
    try {
      const result = await window.branchpulse.testEmailConnection()
      toast(result.message, result.ok ? 'success' : 'error')
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), 'error')
    } finally {
      setTesting(false)
    }
  }

  const testGitLab = async (): Promise<void> => {
    setGitlabBusy(true)
    try {
      const result = await window.branchpulse.testGitLabConnection({
        url: draft.gitlabUrl,
        ...(gitlabApiKey ? { apiKey: gitlabApiKey } : {})
      })
      toast(result.message, result.ok ? 'success' : 'error')
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), 'error')
    } finally {
      setGitlabBusy(false)
    }
  }

  const saveGitLab = async (): Promise<void> => {
    setGitlabBusy(true)
    try {
      const saved = await window.branchpulse.saveSettings({
        ...draft,
        gitlabUrl: draft.gitlabUrl,
        ...(gitlabApiKey ? { gitlabApiKey } : {})
      })
      setDraft(saved)
      setGitlabApiKey('')
      toast(tr('saved'), 'success')
      void refresh()
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), 'error')
    } finally {
      setGitlabBusy(false)
    }
  }

  const sendTest = async (): Promise<void> => {
    setTesting(true)
    try {
      const result = await window.branchpulse.sendTestEmail()
      toast(result.message, result.ok ? 'success' : 'error')
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), 'error')
    } finally {
      setTesting(false)
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-bold text-canvas-fg">{tr('settings')}</h1>
        <button className="btn btn-primary" disabled={savingApp} onClick={() => void saveApp()}>
          <Save size={15} /> {tr('save')}
        </button>
      </div>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        <Card className="p-5">
          <div className="mb-4 flex items-center gap-2 text-sm font-semibold text-canvas-fg">
            <SettingsIcon size={15} className="text-primary" /> Application
          </div>
          <div className="space-y-4">
            <div>
              <div className="label mb-1.5">{tr('theme')}</div>
              <div className="flex gap-2">
                {(['dark', 'light', 'system'] as ThemeMode[]).map((theme) => (
                  <button
                    key={theme}
                    className={`flex-1 rounded-md border px-3 py-2 text-sm font-medium transition-colors ${
                      draft.theme === theme ? 'border-primary/60 bg-primary/10 text-primary' : 'border-line bg-elevated text-muted hover:text-canvas-fg'
                    }`}
                    onClick={() => setDraft({ ...draft, theme })}
                  >
                    {theme[0].toUpperCase() + theme.slice(1)}
                  </button>
                ))}
              </div>
            </div>
            <div>
              <div className="label mb-1.5">{tr('language')}</div>
              <div className="flex gap-2">
                {(['en', 'zh'] as LanguageCode[]).map((lang) => (
                  <button
                    key={lang}
                    className={`flex-1 rounded-md border px-3 py-2 text-sm font-medium transition-colors ${
                      draft.language === lang ? 'border-primary/60 bg-primary/10 text-primary' : 'border-line bg-elevated text-muted hover:text-canvas-fg'
                    }`}
                    onClick={() => setDraft({ ...draft, language: lang })}
                  >
                    {lang === 'en' ? 'English' : '中文'}
                  </button>
                ))}
              </div>
            </div>
            <div>
              <div className="label mb-1.5">{tr('gitPath')}</div>
              <input className="input font-mono" value={draft.gitPath} onChange={(e) => setDraft({ ...draft, gitPath: e.target.value })} placeholder="git" />
            </div>
            <div>
              <div className="label mb-1.5">Fetch policy</div>
              <select className="input" value={draft.fetchPolicy} onChange={(e) => setDraft({ ...draft, fetchPolicy: e.target.value as 'auto' | 'manual' })}>
                <option value="auto">Auto</option>
                <option value="manual">Manual</option>
              </select>
            </div>
            <div className="space-y-3 border-t border-line pt-4">
              <div className="flex items-center justify-between">
                <div>
                  <div className="text-sm text-canvas-fg">{tr('notificationsEnabled')}</div>
                  <div className="text-xs text-muted">Allow desktop notifications</div>
                </div>
                <Toggle checked={draft.notificationsEnabled} onChange={(v) => setDraft({ ...draft, notificationsEnabled: v })} />
              </div>
              <div className="flex items-center justify-between">
                <div>
                  <div className="text-sm text-canvas-fg">{tr('trayEnabled')}</div>
                  <div className="text-xs text-muted">Keep running in system tray</div>
                </div>
                <Toggle checked={draft.trayEnabled} onChange={(v) => setDraft({ ...draft, trayEnabled: v })} />
              </div>
              <div className="flex items-center justify-between">
                <div>
                  <div className="text-sm text-canvas-fg">Launch minimized</div>
                  <div className="text-xs text-muted">Start hidden to tray</div>
                </div>
                <Toggle checked={draft.launchMinimized} onChange={(v) => setDraft({ ...draft, launchMinimized: v })} />
              </div>
              <div className="flex items-center justify-between">
                <div>
                  <div className="text-sm text-canvas-fg">Start with Windows</div>
                  <div className="text-xs text-muted">Launch on login</div>
                </div>
                <Toggle checked={draft.startWithWindows} onChange={(v) => setDraft({ ...draft, startWithWindows: v })} />
              </div>
            </div>
          </div>
        </Card>

        <Card className="p-5">
          <div className="mb-4 flex items-center gap-2 text-sm font-semibold text-canvas-fg">
            <Cloud size={15} className="text-primary" /> {tr('gitlabConnection')}
          </div>
          <div className="space-y-4">
            <div>
              <div className="label mb-1.5">{tr('gitlabUrl')}</div>
              <input className="input" value={draft.gitlabUrl} onChange={(e) => setDraft({ ...draft, gitlabUrl: e.target.value })} placeholder="https://gitlab.com" />
            </div>
            <div>
              <div className="label mb-1.5">{tr('gitlabApiKey')}</div>
              <input
                className="input"
                type="password"
                value={gitlabApiKey}
                onChange={(e) => setGitlabApiKey(e.target.value)}
                placeholder={draft.hasGitlabApiKey ? tr('apiKeySaved') : tr('gitlabApiKey')}
              />
            </div>
            <div className="flex items-center gap-2 border-t border-line pt-4">
              <button className="btn btn-primary" disabled={gitlabBusy} onClick={() => void saveGitLab()}>
                <Save size={14} /> {tr('save')}
              </button>
              <button className="btn" disabled={gitlabBusy || !draft.gitlabUrl} onClick={() => void testGitLab()}>
                <Wrench size={14} /> {tr('testConnection')}
              </button>
              <Badge tone={draft.hasGitlabApiKey ? 'ok' : 'default'}>{draft.hasGitlabApiKey ? 'connected' : 'not configured'}</Badge>
            </div>
          </div>
        </Card>

        <Card className="p-5">
          <div className="mb-4 flex items-center justify-between">
            <div className="flex items-center gap-2 text-sm font-semibold text-canvas-fg">
              <Mail size={15} className="text-secondary" /> SMTP
            </div>
            <Badge tone={emailDraft.enabled ? 'ok' : 'default'}>{emailDraft.enabled ? 'enabled' : 'disabled'}</Badge>
          </div>
          <div className="space-y-4">
            <div className="grid grid-cols-3 gap-3">
              <div className="col-span-2">
                <div className="label mb-1.5">{tr('smtpServer')}</div>
                <input className="input font-mono" value={emailDraft.server} onChange={(e) => setEmailDraft({ ...emailDraft, server: e.target.value })} placeholder="smtp.example.com" />
              </div>
              <div>
                <div className="label mb-1.5">{tr('smtpPort')}</div>
                <input type="number" className="input" value={emailDraft.port} onChange={(e) => setEmailDraft({ ...emailDraft, port: Number(e.target.value) || 0 })} />
              </div>
            </div>
            <div>
              <div className="label mb-1.5">{tr('username')}</div>
              <input className="input" value={emailDraft.username} onChange={(e) => setEmailDraft({ ...emailDraft, username: e.target.value })} />
            </div>
            <div>
              <div className="label mb-1.5">{tr('password')}</div>
              <input
                type="password"
                className="input"
                placeholder={emailDraft.hasPassword ? '•••••••• (saved)' : ''}
                value={emailDraft.password ?? ''}
                onChange={(e) => setEmailDraft({ ...emailDraft, password: e.target.value })}
              />
            </div>
            <div>
              <div className="label mb-1.5">{tr('from')}</div>
              <input className="input" value={emailDraft.from} onChange={(e) => setEmailDraft({ ...emailDraft, from: e.target.value })} placeholder="BranchPulse <no-reply@example.com>" />
            </div>
            <div>
              <div className="label mb-1.5">{tr('testRecipient')}</div>
              <input className="input" value={emailDraft.testRecipient} onChange={(e) => setEmailDraft({ ...emailDraft, testRecipient: e.target.value })} placeholder="you@example.com" />
            </div>
            <div className="flex items-center justify-between">
              <div>
                <div className="text-sm text-canvas-fg">Secure (SSL/TLS)</div>
                <div className="text-xs text-muted">Use secure connection on connect</div>
              </div>
              <Toggle checked={emailDraft.secure} onChange={(v) => setEmailDraft({ ...emailDraft, secure: v })} />
            </div>
            <div className="flex items-center justify-between">
              <div>
                <div className="text-sm text-canvas-fg">{tr('tls')}</div>
                <div className="text-xs text-muted">STARTTLS upgrade on plain connection</div>
              </div>
              <Toggle checked={emailDraft.tls} onChange={(v) => setEmailDraft({ ...emailDraft, tls: v })} />
            </div>
            <div className="flex items-center justify-between">
              <div>
                <div className="text-sm text-canvas-fg">Enabled</div>
                <div className="text-xs text-muted">Allow BranchPulse to send emails</div>
              </div>
              <Toggle checked={emailDraft.enabled} onChange={(v) => setEmailDraft({ ...emailDraft, enabled: v })} />
            </div>
            <div className="flex flex-wrap items-center gap-2 border-t border-line pt-4">
              <button className="btn btn-primary" disabled={savingEmail} onClick={() => void saveEmail()}>
                <Save size={14} /> {tr('saveConfig')}
              </button>
              <button className="btn" disabled={testing} onClick={() => void testConnection()}>
                <Wrench size={14} /> {tr('testConnection')}
              </button>
              <button className="btn" disabled={testing} onClick={() => void sendTest()}>
                <CheckCircle2 size={14} /> {tr('testEmail')}
              </button>
            </div>
          </div>
        </Card>
      </div>
    </div>
  )
}
