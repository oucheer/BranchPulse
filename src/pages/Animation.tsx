import { Sparkles } from 'lucide-react'
import { useAppStore, tr } from '../stores/appStore'
import { Card, Toggle } from '../components/ui'
import { isEffectOn, useEffectSettings, type EffectKey } from '../lib/effects'
import type { BackgroundTheme, ColorTheme } from '@shared/types'

const colorThemes: Array<{ value: ColorTheme; label: string; dot: string }> = [
  { value: 'default', label: '默认橙', dot: 'rgb(255 122 24)' },
  { value: 'ocean', label: '海洋蓝', dot: 'rgb(59 130 246)' },
  { value: 'forest', label: '森林绿', dot: 'rgb(52 199 123)' },
  { value: 'violet', label: '雅紫', dot: 'rgb(139 92 246)' },
  { value: 'rose', label: '玫瑰红', dot: 'rgb(244 63 94)' },
  { value: 'cyan', label: '青碧', dot: 'rgb(34 211 238)' }
]

const backgroundThemes: Array<{ value: BackgroundTheme; label: string }> = [
  { value: 'dark', label: '深色' },
  { value: 'light', label: '浅色' }
]

interface EffectToggle {
  key: EffectKey
  labelZh: string
  labelEn: string
  descZh: string
  descEn: string
}

const effectToggles: EffectToggle[] = [
  {
    key: 'ambientBackground',
    labelZh: '环境背景',
    labelEn: 'Ambient background',
    descZh: '动态背景光影与碎片',
    descEn: 'Dynamic ambient light and shards'
  },
  {
    key: 'splashCursor',
    labelZh: '流体光标',
    labelEn: 'Fluid cursor',
    descZh: '鼠标移动时的流体拖尾',
    descEn: 'Fluid trail that follows the pointer'
  },
  {
    key: 'clickSpark',
    labelZh: '点击火花',
    labelEn: 'Click sparkles',
    descZh: '点击时的粒子迸发',
    descEn: 'Particle burst on click'
  },
  {
    key: 'depthText',
    labelZh: '立体标题',
    labelEn: 'Depth title',
    descZh: '侧栏标题的 3D 深度效果',
    descEn: '3D depth effect on the sidebar title'
  },
  {
    key: 'particleSplash',
    labelZh: '启动粒子',
    labelEn: 'Splash particles',
    descZh: '启动画面的粒子文字',
    descEn: 'Particle text on the splash screen'
  }
]

export default function Animation(): JSX.Element {
  const language = useAppStore((s) => s.language)
  const settings = useAppStore((s) => s.settings)
  const effectSettings = useEffectSettings()
  const setEffectSettings = useAppStore((s) => s.setEffectSettings)
  const toast = useAppStore((s) => s.toast)
  const refresh = useAppStore((s) => s.refresh)
  const zh = language === 'zh'

  const saveAppearance = async (colorTheme: ColorTheme, backgroundTheme: BackgroundTheme): Promise<void> => {
    try {
      await window.branchpulse.saveSettings({ ...settings, colorTheme, backgroundTheme })
      toast(tr('saved'), 'success')
      void refresh()
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), 'error')
    }
  }

  const toggleEffect = (key: EffectKey, value: boolean): void => {
    setEffectSettings({ [key]: value })
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-bold text-canvas-fg">{zh ? '动画' : 'Animation'}</h1>
      </div>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        <Card className="p-5">
          <div className="mb-4 flex items-center gap-2 text-sm font-semibold text-canvas-fg">
            <Sparkles size={15} className="text-primary" /> {zh ? '外观' : 'Appearance'}
          </div>
          <div className="space-y-4">
            <div>
              <div className="label mb-1.5">{zh ? '颜色主题' : 'Color theme'}</div>
              <div className="grid grid-cols-3 gap-2">
                {colorThemes.map((ct) => (
                  <button
                    key={ct.value}
                    className={`flex items-center gap-2 rounded-md border px-2.5 py-2 text-xs font-medium transition-colors ${
                      settings.colorTheme === ct.value ? 'border-primary/60 bg-primary/10 text-primary' : 'border-line bg-elevated text-muted hover:text-canvas-fg'
                    }`}
                    onClick={() => void saveAppearance(ct.value, settings.backgroundTheme)}
                  >
                    <span className="h-3 w-3 shrink-0 rounded-full border border-line" style={{ background: ct.dot }} />
                    {ct.label}
                  </button>
                ))}
              </div>
            </div>
            <div>
              <div className="label mb-1.5">{zh ? '背景主题' : 'Background theme'}</div>
              <div className="flex gap-2">
                {backgroundThemes.map((bt) => (
                  <button
                    key={bt.value}
                    className={`flex-1 rounded-md border px-3 py-2 text-sm font-medium transition-colors ${
                      settings.backgroundTheme === bt.value ? 'border-primary/60 bg-primary/10 text-primary' : 'border-line bg-elevated text-muted hover:text-canvas-fg'
                    }`}
                    onClick={() => void saveAppearance(settings.colorTheme, bt.value)}
                  >
                    {bt.label}
                  </button>
                ))}
              </div>
            </div>
          </div>
        </Card>

        <Card className="p-5">
          <div className="mb-4 flex items-center justify-between">
            <div className="flex items-center gap-2 text-sm font-semibold text-canvas-fg">
              <Sparkles size={15} className="text-secondary" /> {zh ? '动效总开关' : 'Master switch'}
            </div>
            <Toggle
              checked={effectSettings.enabled}
              onChange={(v) => setEffectSettings({ enabled: v })}
              label={zh ? '动效总开关' : 'Master switch'}
            />
          </div>
          <p className="mb-4 text-xs text-muted">
            {zh ? '关闭后将停用以下所有动效。' : 'Turning this off disables all effects below.'}
          </p>
          <div className="space-y-1">
            {effectToggles.map((item) => {
              const active = isEffectOn(effectSettings, item.key)
              const checked = effectSettings[item.key]
              return (
                <div
                  key={item.key}
                  className={`flex items-center justify-between rounded-md border border-transparent px-2 py-2 transition-colors ${
                    active ? 'hover:bg-surface-elevated' : 'opacity-40'
                  }`}
                >
                  <div className="min-w-0">
                    <div className="text-sm text-canvas-fg">{zh ? item.labelZh : item.labelEn}</div>
                    <div className="text-xs text-muted">{zh ? item.descZh : item.descEn}</div>
                  </div>
                  <Toggle
                    checked={checked}
                    disabled={!effectSettings.enabled}
                    onChange={(v) => toggleEffect(item.key, v)}
                    label={zh ? item.labelZh : item.labelEn}
                  />
                </div>
              )
            })}
          </div>
          <p className="mt-3 text-xs text-muted">
            {zh
              ? '系统开启"减少动态效果"时，所有动效会临时停用。'
              : 'All effects pause temporarily when the system "reduce motion" preference is on.'}
          </p>
        </Card>
      </div>
    </div>
  )
}
