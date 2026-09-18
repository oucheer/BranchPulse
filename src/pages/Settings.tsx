import { useEffect, useState } from 'react'
import {
  CheckCircle2,
  Cloud,
  Download,
  Eye,
  EyeOff,
  Mail,
  Plus,
  Save,
  Settings as SettingsIcon,
  Trash2 as TrashIcon,
  Upload,
  Users,
  Wrench,
  X
} from 'lucide-react'
import { useAppStore, tr } from '../stores/appStore'
import { Badge, Card, Modal, Toggle } from '../components/ui'
import FolderPicker from '../components/FolderPicker'
import type { AppSettings, BranchSummary, EmailConfig, EmailGroup, EmailGroupMember, LanguageCode } from '@shared/types'
import { branchesForGroup, groupBranchStats, groupMemberNames } from '@shared/groups'

interface GroupDraft {
  id?: string
  name: string
  recipients: string
  members: EmailGroupMember[]
}

function emptyGroupDraft(): GroupDraft {
  return { name: '', recipients: '', members: [{ name: '', email: '' }] }
}

/**
 * 组的一行摘要。分支归属按「分支创始人命中组员」判定，与后端 GroupService 用同一份
 * @shared/groups 实现，避免两边口径漂移。
 */
function groupSummary(group: EmailGroup, members: BranchSummary[]): string {
  const stats = groupBranchStats(members)
  if (stats.total === 0) return '当前没有归属该组的分支'
  return [
    '分支 ' + stats.total + ' 个',
    '活跃 ' + stats.active,
    '已停更 ' + stats.stale,
    '命名不规范 ' + stats.namingInvalid
  ].join(' · ')
}

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
  const branches = useAppStore((s) => s.branches)
  const activeRepositoryId = useAppStore((s) => s.activeRepositoryId)
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
  const [showEmailPassword, setShowEmailPassword] = useState(false)
  const [groupDraft, setGroupDraft] = useState<GroupDraft>(emptyGroupDraft())
  const [groupBusy, setGroupBusy] = useState('')
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
      const saved = await window.gitmanager.saveSettings(draft)
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
      const saved = await window.gitmanager.saveEmailConfig(emailDraft)
      setEmailDraft({ ...saved, password: '' })
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
      const saved = await window.gitmanager.saveSettings({
        ...draft,
        gitlabUrl: draft.gitlabUrl,
        ...(gitlabApiKey ? { gitlabApiKey } : {})
      })
      setDraft(saved)
      await window.gitmanager.listGitLabProjects({ url: saved.gitlabUrl })
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
      await window.gitmanager.saveEmailGroup({
        ...(groupDraft.id ? { id: groupDraft.id } : {}),
        name: groupDraft.name,
        recipients: groupDraft.recipients,
        members: groupDraft.members.filter((member) => member.name.trim() || member.email.trim())
      })
      setGroupDraft(emptyGroupDraft())
      toast('分支组已保存', 'success')
      void refresh()
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), 'error')
    }
  }

  const branchesForGroupId = (groupId: string): BranchSummary[] => {
    const group = emailGroups.find((item) => item.id === groupId)
    return group ? branchesForGroup(group, branches) : []
  }

  const editGroup = (group: EmailGroup): void => {
    setGroupDraft({
      id: group.id,
      name: group.name,
      recipients: group.recipients,
      members: group.members.length > 0 ? group.members.map((member) => ({ ...member })) : [{ name: '', email: '' }]
    })
  }

  const updateMember = (index: number, patch: Partial<EmailGroupMember>): void => {
    setGroupDraft((current) => ({
      ...current,
      members: current.members.map((member, i) => (i === index ? { ...member, ...patch } : member))
    }))
  }

  const addMember = (): void => setGroupDraft((current) => ({ ...current, members: [...current.members, { name: '', email: '' }] }))

  const removeMember = (index: number): void =>
    setGroupDraft((current) => ({ ...current, members: current.members.filter((_, i) => i !== index) }))

  /** 导出该组的分支数据；HTML 与 CSV 都落在报告目录并出现在报告页。 */
  const exportGroup = async (group: EmailGroup, format: 'html' | 'csv'): Promise<void> => {
    setGroupBusy(group.id + ':' + format)
    try {
      const report = await window.gitmanager.exportGroupBranches(group.id, format, activeRepositoryId)
      toast('已导出「' + group.name + '」分支数据（' + format.toUpperCase() + '）：' + report.summary.totalBranches + ' 个分支', 'success')
      void refresh()
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), 'error')
    } finally {
      setGroupBusy('')
    }
  }

  /** 把该组自己的分支情况发给组员。 */
  const emailGroupMembers = async (group: EmailGroup): Promise<void> => {
    setGroupBusy(group.id + ':mail')
    try {
      const result = await window.gitmanager.emailGroupBranches(group.id, activeRepositoryId)
      toast(result.message, result.sent > 0 ? 'success' : 'warn')
      void refresh()
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), 'error')
    } finally {
      setGroupBusy('')
    }
  }

  const deleteGroup = async (id: string): Promise<void> => {
    try {
      await window.gitmanager.deleteEmailGroup(id)
      toast('分支组已删除', 'success')
      void refresh()
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), 'error')
    }
  }

  const testConnection = async (): Promise<void> => {
    setTesting(true)
    try {
      const result = await window.gitmanager.testEmailConnection(emailDraft)
      toast(result.message, result.ok ? 'success' : 'error')
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), 'error')
    } finally {
      setTesting(false)
    }
  }

  const sendTest = async (): Promise<void> => {

    setTesting(true)
    try {
      const result = await window.gitmanager.sendTestEmail(emailDraft)
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
              <input className="input" value={emailDraft.username} onChange={(e) => setEmailDraft({ ...emailDraft, username: e.target.value })} placeholder="notify@example.com" autoComplete="off" />
            </div>
            <div>
              <div className="label mb-1.5">{tr('password')}</div>
              <div className="flex items-center gap-2">
                <input
                  type={showEmailPassword ? 'text' : 'password'}
                  className="input flex-1"
                  placeholder={emailDraft.hasPassword ? '••••••••（已保存）' : ''}
                  value={emailDraft.password ?? ''}
                  onChange={(e) => setEmailDraft({ ...emailDraft, password: e.target.value })}
                  autoComplete="new-password"
                />
                <button
                  className="btn px-2"
                  type="button"
                  onClick={() => setShowEmailPassword(!showEmailPassword)}
                  title={showEmailPassword ? '隐藏密码' : '显示密码'}
                >
                  {showEmailPassword ? <EyeOff size={14} /> : <Eye size={14} />}
                </button>
              </div>
              <p className="mt-1 text-xs text-muted">密码加密保存在本机，不会随配置导出。</p>
            </div>
            <div>
              <div className="label mb-1.5">{tr('from')}</div>
              <input className="input" value={emailDraft.from} onChange={(e) => setEmailDraft({ ...emailDraft, from: e.target.value })} placeholder="GitManager <notify@example.com>" />
            </div>
            <div>
              <div className="label mb-1.5">我的个人邮箱</div>
              <input
                className="input"
                type="email"
                value={emailDraft.selfEmail}
                onChange={(e) => setEmailDraft({ ...emailDraft, selfEmail: e.target.value })}
                placeholder="your@email.com"
              />
              <p className="mt-1 text-xs text-muted">勾选“通知自己”时发送到这个邮箱。所有邮件均由上方配置的发件邮箱账户发送。</p>
            </div>
            <div>
              <div className="label mb-1.5">{tr('testRecipient')}</div>
              <input className="input" value={emailDraft.testRecipient} onChange={(e) => setEmailDraft({ ...emailDraft, testRecipient: e.target.value })} placeholder="you@example.com" />
            </div>
            <div className="flex items-center justify-between">
              <div>
                <div className="text-sm text-canvas-fg">Secure (SSL/TLS)</div>
                <div className="text-xs text-muted">连接时直接使用加密通道（465 端口）</div>
              </div>
              <Toggle checked={emailDraft.secure} onChange={(v) => setEmailDraft({ ...emailDraft, secure: v })} />
            </div>
            <div className="flex items-center justify-between">
              <div>
                <div className="text-sm text-canvas-fg">{tr('tls')}</div>
                <div className="text-xs text-muted">在明文连接上协商 STARTTLS（587 端口）</div>
              </div>
              <Toggle checked={emailDraft.tls} onChange={(v) => setEmailDraft({ ...emailDraft, tls: v })} />
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
              <button className="btn" disabled={testing || !emailDraft.server} onClick={() => void testConnection()}>
                <Wrench size={14} /> {tr('testConnection')}
              </button>
              <button className="btn" disabled={testing || !emailDraft.enabled || !emailDraft.server || !(emailDraft.testRecipient || emailDraft.selfEmail)} onClick={() => void sendTest()}>
                <CheckCircle2 size={14} /> {tr('testEmail')}
              </button>
            </div>
          </div>
        </Card>

        <Card className="p-5 xl:col-span-2">
          <div className="mb-4 flex items-center justify-between">
            <div className="flex items-center gap-2 text-sm font-semibold text-canvas-fg">
              <Users size={15} className="text-secondary" /> 分支组（组名与组员）
            </div>
            <Badge tone="default">{emailGroups.length} 个组</Badge>
          </div>
          <p className="mb-4 text-xs text-muted">
            组员填「人名 + 邮箱」：分支的分支创始人命中组员人名或邮箱时，该分支就属于这个组。
            组名作为收件人填写时，只把该组自己的分支情况发给组员；在监控页、定时调度、报告计划里同样生效。
          </p>

          <div className="rounded-md border border-line p-3">
            <div className="grid grid-cols-1 gap-3 lg:grid-cols-[12rem_1fr]">
              <input
                className="input"
                placeholder="组名，如 支付组"
                value={groupDraft.name}
                onChange={(e) => setGroupDraft({ ...groupDraft, name: e.target.value })}
              />
              <textarea
                className="input min-h-[72px] font-mono text-sm"
                rows={3}
                placeholder="组内额外收件邮箱（选填），如 group@example.com"
                value={groupDraft.recipients}
                onChange={(e) => setGroupDraft({ ...groupDraft, recipients: e.target.value })}
              />
            </div>

            <div className="mt-3 space-y-2">
              <div className="flex items-center justify-between">
                <span className="label">组员（人名用于匹配分支创始人）</span>
                <button className="btn px-2 text-xs" onClick={addMember} type="button">
                  <Plus size={13} /> 添加组员
                </button>
              </div>
              {groupDraft.members.length === 0 ? (
                <div className="rounded-md bg-surface-elevated px-3 py-2 text-xs text-muted">还没有组员，添加后该组才会有归属分支。</div>
              ) : (
                groupDraft.members.map((member, index) => (
                  <div key={index} className="grid grid-cols-1 gap-2 sm:grid-cols-[1fr_1fr_auto]">
                    <input
                      className="input"
                      placeholder="人名，如 张三"
                      value={member.name}
                      onChange={(e) => updateMember(index, { name: e.target.value })}
                    />
                    <input
                      className="input font-mono"
                      placeholder="邮箱，如 zhangsan@example.com"
                      value={member.email}
                      onChange={(e) => updateMember(index, { email: e.target.value })}
                    />
                    <button className="btn px-2" onClick={() => removeMember(index)} title="移除组员" type="button">
                      <X size={13} className="text-danger" />
                    </button>
                  </div>
                ))
              )}
            </div>

            <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-line pt-3">
              <button className="btn btn-primary" disabled={!groupDraft.name.trim()} onClick={() => void saveGroup()}>
                <Save size={14} /> {groupDraft.id ? '更新组' : '保存组'}
              </button>
              {groupDraft.id ? (
                <button className="btn" onClick={() => setGroupDraft(emptyGroupDraft())}>
                  <X size={14} /> 取消编辑
                </button>
              ) : null}
            </div>
          </div>

          <div className="mt-4 space-y-2">
            {emailGroups.length === 0 ? (
              <div className="rounded-md bg-surface-elevated p-4 text-center text-sm text-muted">暂无分支组</div>
            ) : (
              emailGroups.map((group) => {
                const names = groupMemberNames(group)
                return (
                  <div key={group.id} className="rounded-md border border-line p-3">
                    <div className="flex items-start gap-3">
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="text-sm font-semibold text-canvas-fg">{group.name}</span>
                          <Badge tone="default">{group.members.length} 位组员</Badge>
                        </div>
                        <div className="mt-0.5 break-all text-xs text-muted">
                          {names.length > 0 ? names.join('、') : '未配置人名'}
                          {group.recipients ? ' · ' + group.recipients : ''}
                        </div>
                      </div>
                      <button className="btn px-2" onClick={() => editGroup(group)} title="编辑组">
                        <SettingsIcon size={13} />
                      </button>
                      <button className="btn px-2" onClick={() => void deleteGroup(group.id)} title="删除组">
                        <TrashIcon size={13} className="text-danger" />
                      </button>
                    </div>
                    <div className="mt-2 flex flex-wrap items-center gap-2 border-t border-line/60 pt-2">
                      <span className="text-xs text-muted">
                        {groupSummary(group, branchesForGroupId(group.id))}
                      </span>
                      <div className="flex-1" />
                      <button
                        className="btn px-2 text-xs"
                        disabled={groupBusy !== ''}
                        onClick={() => void exportGroup(group, 'html')}
                        title="导出该组分支数据（HTML）"
                      >
                        <Download size={12} /> HTML
                      </button>
                      <button
                        className="btn px-2 text-xs"
                        disabled={groupBusy !== ''}
                        onClick={() => void exportGroup(group, 'csv')}
                        title="导出该组分支数据（CSV）"
                      >
                        <Download size={12} /> CSV
                      </button>
                      <button
                        className="btn px-2 text-xs"
                        disabled={groupBusy !== '' || !emailConfig?.enabled}
                        onClick={() => void emailGroupMembers(group)}
                        title={emailConfig?.enabled ? '把该组的分支情况发给组员' : '邮件发送未启用'}
                      >
                        <Mail size={12} /> 发送给组员
                      </button>
                    </div>
                  </div>
                )
              })
            )}
          </div>
        </Card>

        <Card className="p-5 xl:col-span-2">
          <div className="mb-4 flex items-center justify-between">
            <div className="flex items-center gap-2 text-sm font-semibold text-canvas-fg">
              <Download size={15} className="text-primary" /> 配置导入 / 导出
            </div>
            <Badge tone="default">换机迁移</Badge>
          </div>
          <p className="text-sm text-muted">
            导出内容包含命名规则、监控配置、定时调度、报告计划、白名单与保护分支、分支组、外观与动效设置、语言、远程仓库连接信息和 GitLab 地址，导入后即可在另一台电脑还原当前配置。
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
        defaultFileName={`gitmanager-config-${configDateStamp()}.json`}
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
          <p className="font-medium text-canvas-fg">导入将覆盖当前的规则、设置、分支组、监控配置和仓库连接信息。</p>
          <p className="text-xs">API Token、邮箱密码等敏感信息不会从配置文件写入，本机已保存的凭据保持不变。此操作无法撤销。</p>
        </div>
      </Modal>
    </div>
  )
}
