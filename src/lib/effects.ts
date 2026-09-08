import { useSyncExternalStore } from 'react'

export type EffectsMode = 'auto' | 'off'

export const EFFECTS_MODE_KEY = 'branchpulse:effectsMode'
export const EFFECTS_CHANGE_EVENT = 'branchpulse:effects-change'

const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)'
const GL_RENDERER = 0x1f01

let cachedSoftwareWebGL: boolean | null = null

export function readEffectsMode(): EffectsMode {
  try {
    return window.localStorage.getItem(EFFECTS_MODE_KEY) === 'off' ? 'off' : 'auto'
  } catch {
    return 'auto'
  }
}

export function persistEffectsMode(mode: EffectsMode): void {
  try {
    window.localStorage.setItem(EFFECTS_MODE_KEY, mode)
  } catch {
    /* ignore storage errors */
  }
  window.dispatchEvent(new Event(EFFECTS_CHANGE_EVENT))
}

function prefersReducedMotion(): boolean {
  return typeof window.matchMedia === 'function' && window.matchMedia(REDUCED_MOTION_QUERY).matches
}

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

function isLowPowerDevice(): boolean {
  const cores = navigator.hardwareConcurrency
  return typeof cores === 'number' && cores > 0 && cores <= 4
}

export function computeEffectsEnabled(mode: EffectsMode): boolean {
  if (mode === 'off') return false
  if (prefersReducedMotion() || isLowPowerDevice()) return false
  if (cachedSoftwareWebGL === null) cachedSoftwareWebGL = detectSoftwareWebGL()
  return !cachedSoftwareWebGL
}

function subscribeEffectsChange(onChange: () => void): () => void {
  const query = window.matchMedia(REDUCED_MOTION_QUERY)
  const onMediaChange = (): void => onChange()
  query.addEventListener('change', onMediaChange)
  window.addEventListener(EFFECTS_CHANGE_EVENT, onChange)
  return () => {
    query.removeEventListener('change', onMediaChange)
    window.removeEventListener(EFFECTS_CHANGE_EVENT, onChange)
  }
}

export function useEffectsEnabled(effectsMode: EffectsMode): boolean {
  return useSyncExternalStore(subscribeEffectsChange, () => computeEffectsEnabled(effectsMode))
}
