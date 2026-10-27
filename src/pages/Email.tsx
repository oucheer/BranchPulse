import { useEffect, useState } from 'react'
import {
  CheckCircle2,
  Download,
  Eye,
  EyeOff,
  Mail,
  Plus,
  Save,
  Settings as SettingsIcon,
  Trash2 as TrashIcon,
  Users,
  Wrench,
  X
} from 'lucide-react'
import { useAppStore, tr } from '../stores/appStore'
import { Badge, Card, Toggle } from '../components/ui'
import { resolveSmtpPreset, type SmtpPreset } from '../lib/emailPresets'
import type { BranchSummary, EmailConfig, EmailGroup, EmailGroupMember } from '@shared/types'
import { branchesForGroup, groupBranchStats, groupMemberNames } from '@shared/groups'

interface GroupDraft {
  id?: string
  name: string
  deliveryMode: 'to' | 'cc'
  recipients: string
  members: EmailGroupMember[]
}

function emptyGroupDraft(): GroupDraft {
  return { name: '', deliveryMode: 'to', recipients: '', members: [{ name: '', email: '' }] }
}

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

export default function Email(): JSX.Element {
  const emailConfig = useAppStore((s) => s.emailConfig)
  const emailGroups = useAppStore((s) => s.emailGroups)
  const branches = useAppStore((s) => s.branches)
  const selectedRepositoryIds = useAppStore((s) => s.selectedRepositoryIds)
  const language = useAppStore((s) => s.language)
  const toast = useAppStore((s) => s.toast)
  const refresh = useAppStore((s) => s.refresh)
  const zh = language === 'zh'

  const [emailDraft, setEmailDraft] = useState<EmailConfig & { password?: string }>({
    server: '',
    port: 587,
    username: '',
    hasPassword: false,
    from: '',
    secure: false,
    tls: true,
    testRecipient: '',
    selfEmail: '',
    enabled: false
  })
  const [savingEmail, setSavingEmail] = useState(false)
  const [testing, setTesting] = useState(false)
  const [showEmailPassword, setShowEmailPassword] = useState(false)
  const [autoPreset, setAutoPreset] = useState<SmtpPreset | null>(null)
  const [groupDraft, setGroupDraft] = useState<GroupDraft>(emptyGroupDraft())
  const [groupBusy, setGroupBusy] = useState('')

  useEffect(() => {
    if (emailConfig) {
      setEmailDraft(emailConfig)
      setAutoPreset(resolveSmtpPreset(emailConfig.username))
    }
  }, [emailConfig])

  const handleEmailUsernameChange = (value: string): void => {
    const preset = resolveSmtpPreset(value)
    setAutoPreset(preset)
    setEmailDraft((prev) => {
      if (!preset) return { ...prev, username: value }
      return {
        ...prev,
        username: value,
        server: preset.server,
        port: preset.port,
        secure: preset.secure,
        tls: preset.tls,
        ...(prev.from ? {} : { from: value })
      }
    })
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

  const saveGroup = async (): Promise<void> => {
    try {
      await window.gitmanager.saveEmailGroup({
        ...(groupDraft.id ? { id: groupDraft.id } : {}),
        name: groupDraft.name,
        deliveryMode: groupDraft.deliveryMode,
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
      deliveryMode: group.deliveryMode ?? 'to',
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

  const exportGroup = async (group: EmailGroup, format: 'html' | 'csv'): Promise<void> => {
    setGroupBusy(group.id + ':' + format)
    try {
      const report = await window.gitmanager.exportGroupBranches(group.id, format, selectedRepositoryIds)
      toast('已导出「' + group.name + '」分支数据（' + format.toUpperCase() + '）：' + report.summary.totalBranches + ' 个分支', 'success')
      void refresh()
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), 'error')
    } finally {
      setGroupBusy('')
    }
  }

  const emailGroupMembers = async (group: EmailGroup): Promise<void> => {
    setGroupBusy(group.id + ':mail')
    try {
      const result = await window.gitmanager.emailGroupBranches(group.id, selectedRepositoryIds)
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
      toast(result.technical ? `${result.message}（${result.technical}）` : result.message, result.ok ? 'success' : 'error')
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
      toast(result.technical ? `${result.message}（${result.technical}）` : result.message, result.ok ? 'success' : 'error')
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), 'error')
    } finally {
      setTesting(false)
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h1 className="text-lg font-bold text-canvas-fg">{zh ? '邮箱' : 'Email'}</h1>
          <p className="mt-1 text-xs text-muted">配置邮件发送账户、通知邮箱和分支组。</p>
        </div>
        <Badge tone={emailDraft.enabled ? 'ok' : 'default'}>{emailDraft.enabled ? '已启用' : '未启用'}</Badge>
      </div>

      <Card className="p-5">
        <div className="mb-4 flex items-center gap-2 text-sm font-semibold text-canvas-fg">
          <Mail size={15} className="text-secondary" /> 通知邮箱
        </div>
        <div className="space-y-4">
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1fr)_9rem]">
            <div>
              <div className="label mb-1.5">{tr('smtpServer')}</div>
              <input className="input font-mono" value={emailDraft.server} onChange={(e) => setEmailDraft({ ...emailDraft, server: e.target.value })} placeholder="smtp.example.com" />
            </div>
            <div>
              <div className="label mb-1.5">{tr('smtpPort')}</div>
              <input type="number" className="input" value={emailDraft.port} onChange={(e) => setEmailDraft({ ...emailDraft, port: Number(e.target.value) || 0 })} />
            </div>
          </div>
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            <div>
              <div className="label mb-1.5">{tr('username')}</div>
              <input className="input" value={emailDraft.username} onChange={(e) => handleEmailUsernameChange(e.target.value)} placeholder="abc.123@pantum.local" autoComplete="off" />
              <p className="mt-1 text-xs text-muted">
                {autoPreset
                  ? `已自动填充 ${autoPreset.server}:${autoPreset.port}（STARTTLS）`
                  : '输入完整邮箱后自动填充服务器、端口和加密方式。'}
              </p>
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
                <button className="btn px-2" type="button" onClick={() => setShowEmailPassword(!showEmailPassword)} title={showEmailPassword ? '隐藏密码' : '显示密码'}>
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
            <div className="lg:col-span-2">
              <div className="label mb-1.5">{tr('testRecipient')}</div>
              <input className="input" value={emailDraft.testRecipient} onChange={(e) => setEmailDraft({ ...emailDraft, testRecipient: e.target.value })} placeholder="you@example.com" />
            </div>
          </div>
          <div className="grid grid-cols-1 gap-3 border-t border-line pt-4 lg:grid-cols-3">
            <div className="flex items-center justify-between gap-3 rounded-md border border-line px-3 py-2.5">
              <div>
                <div className="text-sm text-canvas-fg">Secure (SSL/TLS)</div>
                <div className="text-xs text-muted">连接时直接使用加密通道（465 端口）</div>
              </div>
              <Toggle checked={emailDraft.secure} onChange={(v) => setEmailDraft({ ...emailDraft, secure: v })} />
            </div>
            <div className="flex items-center justify-between gap-3 rounded-md border border-line px-3 py-2.5">
              <div>
                <div className="text-sm text-canvas-fg">{tr('tls')}</div>
                <div className="text-xs text-muted">在明文连接上协商 STARTTLS（587 端口）</div>
              </div>
              <Toggle checked={emailDraft.tls} onChange={(v) => setEmailDraft({ ...emailDraft, tls: v })} />
            </div>
            <div className="flex items-center justify-between gap-3 rounded-md border border-line px-3 py-2.5">
              <div>
                <div className="text-sm text-canvas-fg">启用邮件通知</div>
                <div className="text-xs text-muted">关闭后不再发送邮件提醒</div>
              </div>
              <Toggle checked={emailDraft.enabled} onChange={(v) => setEmailDraft({ ...emailDraft, enabled: v })} />
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2 border-t border-line pt-4">
            <button className="btn" disabled={testing || !emailDraft.server} onClick={() => void testConnection()}>
              <Wrench size={14} /> {tr('testConnection')}
            </button>
            <button className="btn" disabled={testing || !emailDraft.enabled || !emailDraft.server || !(emailDraft.testRecipient || emailDraft.selfEmail)} onClick={() => void sendTest()}>
              <CheckCircle2 size={14} /> {tr('testEmail')}
            </button>
            <button className="btn btn-primary ml-auto" disabled={savingEmail} onClick={() => void saveEmail()}>
              <Save size={14} /> {tr('saveConfig')}
            </button>
          </div>
        </div>
      </Card>

      <Card className="p-5">
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
          <div className="mt-3 max-w-xs">
            <div className="label mb-1.5">邮件用途</div>
            <select
              className="input"
              value={groupDraft.deliveryMode}
              onChange={(e) => setGroupDraft({ ...groupDraft, deliveryMode: e.target.value as 'to' | 'cc' })}
            >
              <option value="to">收件人</option>
              <option value="cc">抄送</option>
            </select>
            <p className="mt-1 text-xs text-muted">填写组名作收件人时，该组组员按这里的用途加入邮件。</p>
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
                        <Badge tone={group.deliveryMode === 'cc' ? 'info' : 'default'}>
                          {group.deliveryMode === 'cc' ? '抄送' : '收件人'}
                        </Badge>
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
                    <button className="btn px-2 text-xs" disabled={groupBusy !== ''} onClick={() => void exportGroup(group, 'html')} title="导出该组分支数据（HTML）">
                      <Download size={12} /> HTML
                    </button>
                    <button className="btn px-2 text-xs" disabled={groupBusy !== ''} onClick={() => void exportGroup(group, 'csv')} title="导出该组分支数据（CSV）">
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
    </div>
  )
}
