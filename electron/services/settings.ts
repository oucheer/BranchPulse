import type { AppSettings } from '@shared/types'
import type { StorageService } from './storage'
import { decryptSecret, encryptSecret } from './gitlab'

export class SettingsService {
  constructor(private readonly storage: StorageService) {}

  get(): AppSettings {
    const row = this.storage.get<Record<string, unknown>>('SELECT * FROM app_settings WHERE id = 1')
    return {
      theme: (row?.theme as AppSettings['theme']) ?? 'dark',
      colorTheme: ((row?.color_theme as AppSettings['colorTheme']) ?? 'default'),
      backgroundTheme: ((row?.background_theme as AppSettings['backgroundTheme']) ?? 'dark'),
      language: (row?.language as AppSettings['language']) ?? 'zh',
      notificationsEnabled: Number(row?.notifications_enabled ?? 1) === 1,
      trayEnabled: Number(row?.tray_enabled ?? 1) === 1,
      launchMinimized: Number(row?.launch_minimized ?? 0) === 1,
      startWithWindows: Number(row?.start_with_windows ?? 0) === 1,
      gitPath: String(row?.git_path ?? ''),
      fetchPolicy: ((row?.fetch_policy as AppSettings['fetchPolicy']) ?? 'auto'),
      gitlabUrl: String(row?.gitlab_url ?? ''),
      gitlabApiKey: decryptSecret(String(row?.gitlab_api_key ?? '')),
      hasGitlabApiKey: Number(row?.gitlab_has_key ?? 0) === 1,
      activeRepositoryId: (row?.active_repository_id as string | null) ?? null,
      deletionDisabled: Number(row?.deletion_disabled ?? 0) === 1
    }
  }

  save(settings: AppSettings): AppSettings {
    const current = this.get()
    const currentRow = this.storage.get<Record<string, unknown>>('SELECT gitlab_api_key FROM app_settings WHERE id = 1')
    let encryptedKey = String(currentRow?.gitlab_api_key ?? '')
    if (settings.gitlabApiKey !== undefined) {
      encryptedKey = encryptSecret(settings.gitlabApiKey)
    }
    this.storage.update(
      'app_settings',
      {
        theme: settings.theme,
        color_theme: settings.colorTheme,
        background_theme: settings.backgroundTheme,
        language: settings.language,
        notifications_enabled: settings.notificationsEnabled ? 1 : 0,
        tray_enabled: settings.trayEnabled ? 1 : 0,
        launch_minimized: settings.launchMinimized ? 1 : 0,
        start_with_windows: settings.startWithWindows ? 1 : 0,
        git_path: settings.gitPath,
        gitlab_url: settings.gitlabUrl || current.gitlabUrl,
        gitlab_api_key: encryptedKey,
      gitlab_has_key: encryptedKey ? 1 : 0,
        fetch_policy: settings.fetchPolicy,
        active_repository_id: settings.activeRepositoryId ?? null,
        deletion_disabled: settings.deletionDisabled ? 1 : 0
      },
      'id = 1'
    )
    return this.get()
  }

  getGitLabToken(): string {
    const row = this.storage.get<Record<string, unknown>>('SELECT gitlab_api_key FROM app_settings WHERE id = 1')
    return decryptSecret(String(row?.gitlab_api_key ?? ''))
  }
}
