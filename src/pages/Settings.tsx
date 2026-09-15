import { useEffect, useState } from 'react'
import {
  CheckCircle2,
  Cloud,
  Download,
  Eye,
  EyeOff,
  Mail,
  Save,
  Settings as SettingsIcon,
  Trash2 as TrashIcon,
  Upload
} from 'lucide-react'
import { useAppStore, tr } from '../stores/appStore'
import { Badge, Card, Modal, Toggle } from '../components/ui'
import FolderPicker from '../components/FolderPicker'
import type { AppSettings, EmailConfig, EmailGroup, LanguageCode } from '@shared/types'

/** Mirrors the server-side file name stamp used for exported config bundles. */
function configDateStamp(): string {
  const now = new Date()
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`
}

export default function Settings(): JSX.Element {
  const settings = useAppStore((s) => s.settings)
  const emailConfig = useAppStore((s) => s.emailConfig)
  const emailGroups = useAppStore((s) => s.emailGroups)
  const language = useAppStore((s) => s.language)
  const setLanguage = useAppStore((s) => s.setLanguage)
  const toast = useAppStore((s) => s.toast)
  const refresh = useAppStore((s) => s.refresh)
  const zh = language === 'zh'

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
    selfEmail: '',
    enabled: false
  })
  const [savingApp, setSavingApp] = useState(false)
  const [savingEmail, setSavingEmail] = useState(false)
  const [testing, setTesting] = useState(false)
  const [portBusy, setPortBusy] = useState<'export' | 'import' | null>(null)
  const [gitlabBusy, setGitlabBusy] = useState(false)
  const [gitlabApiKey, setGitlabApiKey] = useState('')
  const [showGitlabApiKey, setShowGitlabApiKey] = useState(false)
  const [groupDraft, setGroupDraft] = useState<{ id?: string; name: string; recipients: string }>({ name: '', recipients: '' })
  const [portPicker, setPortPicker] = useState<'export' | 'import' | null>(null)
  const [pendingImport, setPendingImport] = useState('')
  useEffect(() => {
    setDraft(settings)
  }, [settings])

  useEffect(() => {
    setGitlabApiKey(settings.gitlabApiKey ?? '')
  }, [settings.gitlabApiKey])

  useEffect(() => {
    if (emailConfig) setEmailDraft(emailConfig)
  }, [emailConfig])

  const saveApp = async (): Promise<void> => {
    setSavingApp(true)
    try {
      const saved = await window.branchpulse.saveSettings(draft)
      setDraft(saved)
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

  const connectGitLab = async (): Promise<void> => {
    setGitlabBusy(true)
    try {
      const saved = await window.branchpulse.saveSettings({
        ...draft,
        gitlabUrl: draft.gitlabUrl,
        ...(gitlabApiKey ? { gitlabApiKey } : {})
      })
      setDraft(saved)
      await window.branchpulse.listGitLabProjects({ url: saved.gitlabUrl })
      toast('远程仓库 API 已连接', 'success')
      void refresh()
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), 'error')
    } finally {
      setGitlabBusy(false)
    }
  }
  const saveGroup = async (): Promise<void> => {
    try {
      await window.branchpulse.saveEmailGroup(groupDraft)
      setGroupDraft({ name: '', recipients: '' })
      toast('邮箱分组已保存', 'success')
      void refresh()
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), 'error')
    }
  }

  const deleteGroup = async (id: string): Promise<void> => {
    try {
      await window.branchpulse.deleteEmailGroup(id)
      toast('邮箱分组已删除', 'success')
      void refresh()
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), 'error')
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

  // The desktop build opened native save/open dialogs and confirmed the import
  // overwrite with a message box inside the main process. The web build collects
  // the same choices in the page, with the identical wording.
  const exportConfig = async (filePath: string): Promise<void> => {
    setPortBusy('export')
    try {
      const result = await useAppStore.getState().exportConfig(filePath)
      if (!result.ok) {
        if (result.error) toast(result.error, 'error')
        return
      }
      toast(`配置已导出到 ${result.path}`, 'success')
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), 'error')
    } finally {
      setPortBusy(null)
    }
  }

  const importConfig = async (filePath: string): Promise<void> => {
    setPortBusy('import')
    try {
      const result = await useAppStore.getState().importConfig(filePath)
      if (!result.ok) {
        if (result.error) toast(result.error, 'error')
        return
      }
      toast(`配置导入完成，共应用 ${result.applied.length} 项配置`, 'success')
      result.warnings.forEach((warning) => toast(warning, 'warn'))
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), 'error')
    } finally {
      setPortBusy(null)
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
            <SettingsIcon size={15} className="text-primary" /> {tr('application')}
          </div>
          <div className="space-y-4">
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
            <div className="space-y-3 border-t border-line pt-4">
              <div className="flex items-center gap-2 text-xs text-muted">
                <Badge tone="default">桌面版专有</Badge>
                <span>以下开关仅对桌面版生效，Web 版保留设置项、保存值不丢弃。</span>
              </div>
              <div className="flex items-center justify-between">
                <div>
                  <div className="text-sm text-canvas-fg">{tr('trayEnabled')}</div>
                  <div className="text-xs text-muted">关闭时驻留系统托盘，继续运行（桌面版专有）</div>
                </div>
                <Toggle checked={draft.trayEnabled} onChange={(v) => setDraft({ ...draft, trayEnabled: v })} />
              </div>
              <div className="flex items-center justify-between">
                <div>
                  <div className="text-sm text-canvas-fg">启动时最小化</div>
                  <div className="text-xs text-muted">启动时隐藏到托盘（桌面版专有）</div>
                </div>
                <Toggle checked={draft.launchMinimized} onChange={(v) => setDraft({ ...draft, launchMinimized: v })} />
              </div>
              <div className="flex items-center justify-between">
                <div>
                  <div className="text-sm text-canvas-fg">随 Windows 启动</div>
                  <div className="text-xs text-muted">登录系统时自动启动（桌面版专有）</div>
                </div>
                <Toggle checked={draft.startWithWindows} onChange={(v) => setDraft({ ...draft, startWithWindows: v })} />
              </div>
            </div>
          </div>
        </Card>

        <Card className="p-5">
          <div className="mb-4 flex items-center gap-2 text-sm font-semibold text-canvas-fg">
            <Cloud size={15} className="text-primary" /> 远程仓库连接
          </div>
          <div className="space-y-4">
            <div>
              <div className="label mb-1.5">远程仓库地址</div>
              <input className="input" value={draft.gitlabUrl} onChange={(e) => setDraft({ ...draft, gitlabUrl: e.target.value })} placeholder="https://gitlab.com 或 https://github.com/owner/repo" />
            </div>
            <div>
              <div className="label mb-1.5">API Token</div>
              <div className="flex items-center gap-2">
                <input
                  className="input flex-1"
                  type={showGitlabApiKey ? 'text' : 'password'}
                  value={gitlabApiKey}
                  onChange={(e) => setGitlabApiKey(e.target.value)}
                  placeholder={draft.hasGitlabApiKey ? tr('apiKeySaved') : tr('remoteApiKey')}
                />
                <button
                  className="btn px-2"
                  type="button"
                  onClick={() => setShowGitlabApiKey(!showGitlabApiKey)}
                  title={showGitlabApiKey ? '隐藏 API Token' : '显示 API Token'}
                >
                  {showGitlabApiKey ? <EyeOff size={14} /> : <Eye size={14} />}
                </button>
              </div>
            </div>
            <div className="flex items-center gap-2 border-t border-line pt-4">
              <button className="btn btn-primary" disabled={gitlabBusy || !draft.gitlabUrl} onClick={() => void connectGitLab()}>
                <Cloud size={14} /> 连接
              </button>
              <Badge tone={draft.hasGitlabApiKey ? 'ok' : 'default'}>{draft.hasGitlabApiKey ? '已保存' : '未配置'}</Badge>
            </div>
          </div>
        </Card>

        <Card className="p-5">
          <div className="mb-4 flex items-center justify-between">
            <div className="flex items-center gap-2 text-sm font-semibold text-canvas-fg">
              <Mail size={15} className="text-secondary" /> 通知邮箱
            </div>
            <Badge tone={emailDraft.enabled ? 'ok' : 'default'}>{emailDraft.enabled ? '已启用' : '未启用'}</Badge>
          </div>
          <div className="space-y-4">
            <div>
              <div className="label mb-1.5">我的个人邮箱</div>
              <input
                className="input"
                type="email"
                value={emailDraft.selfEmail}
                onChange={(e) => setEmailDraft({ ...emailDraft, selfEmail: e.target.value })}
                placeholder="your@email.com"
              />
              <p className="mt-1 text-xs text-muted">勾选“通知自己”时发送到这个邮箱。邮件统一通过本机 Outlook 当前登录账户发送，无需在此配置发件账号或密码。</p>
            </div>
            <div className="flex items-center justify-between">
              <div>
                <div className="text-sm text-canvas-fg">启用邮件通知</div>
                <div className="text-xs text-muted">关闭后不再发送邮件提醒</div>
              </div>
              <Toggle checked={emailDraft.enabled} onChange={(v) => setEmailDraft({ ...emailDraft, enabled: v })} />
            </div>
            <div className="flex flex-wrap items-center gap-2 border-t border-line pt-4">
              <button className="btn btn-primary" disabled={savingEmail} onClick={() => void saveEmail()}>
                <Save size={14} /> {tr('saveConfig')}
              </button>
              <button className="btn" disabled={testing || !emailDraft.enabled || !emailDraft.selfEmail} onClick={() => void sendTest()}>
                <CheckCircle2 size={14} /> {tr('testEmail')}
              </button>
            </div>
          </div>
        </Card>

        <Card className="p-5 xl:col-span-2">
          <div className="mb-4 flex items-center justify-between">
            <div className="flex items-center gap-2 text-sm font-semibold text-canvas-fg">
              <Mail size={15} className="text-secondary" /> 全局邮箱分组
            </div>
            <Badge tone="default">{emailGroups.length} 个分组</Badge>
          </div>
          <div className="grid grid-cols-1 gap-3 lg:grid-cols-[12rem_1fr_auto]">
            <input
              className="input"
              placeholder="分组名称，如 aaa"
              value={groupDraft.name}
              onChange={(e) => setGroupDraft({ ...groupDraft, name: e.target.value })}
            />
            <textarea
              className="input min-h-[72px] font-mono text-sm"
              rows={3}
              placeholder="111@qq.com, 222@qq.com（多个邮箱用逗号、分号或换行分隔）"
              value={groupDraft.recipients}
              onChange={(e) => setGroupDraft({ ...groupDraft, recipients: e.target.value })}
            />
            <button className="btn btn-primary h-fit" disabled={!groupDraft.name || !groupDraft.recipients} onClick={() => void saveGroup()}>
              <Save size={14} /> 保存分组
            </button>
          </div>
          <div className="mt-4 space-y-2">
            {emailGroups.length === 0 ? (
              <div className="rounded-md bg-surface-elevated p-4 text-center text-sm text-muted">暂无邮箱分组</div>
            ) : (
              emailGroups.map((group) => (
                <div key={group.id} className="flex items-start gap-3 rounded-md border border-line p-3">
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-semibold text-canvas-fg">{group.name}</div>
                    <div className="mt-0.5 break-all text-xs text-muted">{group.recipients}</div>
                  </div>
                  <button
                    className="btn px-2"
                    onClick={() => setGroupDraft({ id: group.id, name: group.name, recipients: group.recipients })}
                    title="编辑分组"
                  >
                    <SettingsIcon size={13} />
                  </button>
                  <button className="btn px-2" onClick={() => void deleteGroup(group.id)} title="删除分组">
                    <TrashIcon size={13} className="text-danger" />
                  </button>
                </div>
              ))
            )}
          </div>
          <p className="mt-3 text-xs text-muted">邮箱分组为全局配置，可在监控、定时调度、报告收件人处直接选择分组名。</p>
        </Card>

        <Card className="p-5 xl:col-span-2">
          <div className="mb-4 flex items-center justify-between">
            <div className="flex items-center gap-2 text-sm font-semibold text-canvas-fg">
              <Download size={15} className="text-primary" /> 配置导入 / 导出
            </div>
            <Badge tone="default">换机迁移</Badge>
          </div>
          <p className="text-sm text-muted">
            导出内容包含命名规则、监控配置、定时调度、报告计划、白名单与保护分支、邮箱分组、外观与动效设置、语言、远程仓库连接信息和 GitLab 地址，导入后即可在另一台电脑还原当前配置。
          </p>
          <p className="mt-2 text-xs text-muted">
            API Token、邮箱密码等敏感凭据不会写入配置文件；导入时保留本机已保存的凭据，不会被覆盖。
          </p>
          <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-line pt-4">
            <button className="btn btn-primary" disabled={portBusy !== null} onClick={() => setPortPicker('export')}>
              <Download size={14} /> {portBusy === 'export' ? '导出中…' : '导出配置'}
            </button>
            <button className="btn" disabled={portBusy !== null} onClick={() => setPortPicker('import')}>
              <Upload size={14} /> {portBusy === 'import' ? '导入中…' : '导入配置'}
            </button>
          </div>
        </Card>
      </div>

      <FolderPicker
        open={portPicker === 'export'}
        mode="save"
        initialPath=""
        defaultFileName={`branchpulse-config-${configDateStamp()}.json`}
        confirmLabel="导出"
        onClose={() => setPortPicker(null)}
        onSelect={(filePath) => {
          setPortPicker(null)
          void exportConfig(filePath)
        }}
      />
      <FolderPicker
        open={portPicker === 'import'}
        mode="file"
        initialPath=""
        extensions={['json']}
        onClose={() => setPortPicker(null)}
        onSelect={(filePath) => {
          setPortPicker(null)
          setPendingImport(filePath)
        }}
      />
      <Modal
        open={pendingImport !== ''}
        title="导入配置"
        onClose={() => setPendingImport('')}
        footer={
          <>
            <button className="btn" onClick={() => setPendingImport('')}>
              取消
            </button>
            <button
              className="btn btn-primary"
              onClick={() => {
                const filePath = pendingImport
                setPendingImport('')
                void importConfig(filePath)
              }}
            >
              覆盖导入
            </button>
          </>
        }
      >
        <div className="space-y-2 text-sm text-muted">
          <p className="font-medium text-canvas-fg">导入将覆盖当前的规则、设置、邮箱分组、监控配置和仓库连接信息。</p>
          <p className="text-xs">API Token、邮箱密码等敏感信息不会从配置文件写入，本机已保存的凭据保持不变。此操作无法撤销。</p>
        </div>
      </Modal>
    </div>
  )
}
