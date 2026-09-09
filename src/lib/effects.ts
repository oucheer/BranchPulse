import { useSyncExternalStore } from 'react'

export type EffectKey = 'ambientBackground' | 'splashCursor' | 'clickSpark' | 'depthText' | 'particleSplash'

export interface EffectSettings {
  enabled: boolean
  ambientBackground: boolean
  splashCursor: boolean
  clickSpark: boolean
  depthText: boolean
  particleSplash: boolean
}

const STORAGE_KEY = 'branchpulse:effectSettings'
const CHANGE_EVENT = 'branchpulse:effect-settings-change'

const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)'
const GL_RENDERER = 0x1f01

const DEFAULT_SETTINGS: EffectSettings = {
  enabled: true,
  ambientBackground: true,
  splashCursor: false,
  clickSpark: true,
  depthText: true,
  particleSplash: true
}

export const EFFECT_KEYS: EffectKey[] = [
  'ambientBackground',
  'splashCursor',
  'clickSpark',
  'depthText',
  'particleSplash'
]

let cachedWebGLAvailable: boolean | null = null
let cachedSettings: EffectSettings | null = null
let cachedRaw: string | null = null

function detectSoftwareWebGL(): boolean {
  try {
    const canvas = document.createElement('canvas')
    const gl = (canvas.getContext('webgl2') ??
      canvas.getContext('webgl') ??
      canvas.getContext('experimental-webgl')) as WebGLRenderingContext | null
    if (!gl) return true
    const ext = gl.getExtension('WEBGL_debug_renderer_info')
    const raw = ext ? String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)) : ''
    const renderer = raw || String(gl.getParameter(GL_RENDERER))
    return /swiftshader|llvmpipe|softpipe|software|microsoft basic render|basic render driver/i.test(renderer)
  } catch {
    return true
  }
}

export function computeWebGLAvailable(): boolean {
  if (cachedWebGLAvailable === null) cachedWebGLAvailable = !detectSoftwareWebGL()
  return cachedWebGLAvailable
}

export function readEffectSettings(): EffectSettings {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (raw === cachedRaw && cachedSettings !== null) return cachedSettings
    if (!raw) {
      cachedRaw = null
      cachedSettings = { ...DEFAULT_SETTINGS }
      return cachedSettings
    }
    const parsed = JSON.parse(raw) as Partial<EffectSettings>
    const merged = { ...DEFAULT_SETTINGS }
    for (const key of ['enabled', ...EFFECT_KEYS] as const) {
      if (typeof parsed[key] === 'boolean') merged[key] = parsed[key] as boolean
    }
    cachedRaw = raw
    cachedSettings = merged
    return merged
  } catch {
    cachedRaw = null
    cachedSettings = { ...DEFAULT_SETTINGS }
    return cachedSettings
  }
}

export function persistEffectSettings(next: EffectSettings): void {
  cachedRaw = null
  cachedSettings = null
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
  } catch {
    /* ignore storage errors */
  }
  window.dispatchEvent(new Event(CHANGE_EVENT))
}

function subscribeEffectSettings(onChange: () => void): () => void {
  const query = window.matchMedia(REDUCED_MOTION_QUERY)
  const onMediaChange = (): void => onChange()
  query.addEventListener('change', onMediaChange)
  window.addEventListener(CHANGE_EVENT, onChange)
  return () => {
    query.removeEventListener('change', onMediaChange)
    window.removeEventListener(CHANGE_EVENT, onChange)
  }
}

export function useEffectSettings(): EffectSettings {
  return useSyncExternalStore(subscribeEffectSettings, readEffectSettings, () => DEFAULT_SETTINGS)
}

/** Whether a specific effect should render, combining master switch + user toggle. */
export function isEffectOn(settings: EffectSettings, key: EffectKey): boolean {
  return settings.enabled && settings[key] && !prefersReducedMotion()
}

function prefersReducedMotion(): boolean {
  return typeof window.matchMedia === 'function' && window.matchMedia(REDUCED_MOTION_QUERY).matches
}
