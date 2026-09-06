/**
 * AeroShards — Ambient background layer.
 * Very light pearl + soft purple + subtle orange shards.
 * Low density, low speed, low glow. Content-safe (never covers UI).
 * Falls back to static CSS when WebGL is unavailable.
 */
import { useEffect, useRef } from 'react'
import { ambient } from '../design-system/tokens'

interface Shard {
  x: number
  y: number
  w: number
  h: number
  rotation: number
  rotSpeed: number
  driftX: number
  driftY: number
  hue: number
  alpha: number
}

function isWebGLAvailable(): boolean {
  try {
    const canvas = document.createElement('canvas')
    return Boolean(canvas.getContext('webgl2') || canvas.getContext('webgl'))
  } catch {
    return false
  }
}

export default function AeroShards(): JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const webgl = useRef(isWebGLAvailable())

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const context = canvas.getContext('2d')
    if (!context) return

    let animationId = 0
    let running = true
    let width = 0
    let height = 0
    let dpr = Math.min(window.devicePixelRatio || 1, 1.5)
    const pointer = { x: -9999, y: -9999 }
    let shards: Shard[] = []

    const buildShards = (): void => {
      const count = Math.max(3, Math.round(ambient.density * (width / 1440)))
      shards = Array.from({ length: count }, (_, i) => ({
        x: Math.random() * width,
        y: Math.random() * height,
        w: 60 + Math.random() * 160,
        h: 30 + Math.random() * 80,
        rotation: Math.random() * Math.PI * 2,
        rotSpeed: (Math.random() - 0.5) * 0.0004,
        driftX: (Math.random() - 0.5) * 0.06,
        driftY: -0.03 - Math.random() * 0.05,
        hue: i % 3 === 0 ? 28 : i % 3 === 1 ? 258 : 230,
        alpha: 0.02 + Math.random() * ambient.opacity
      }))
    }

    const resize = (): void => {
      dpr = Math.min(window.devicePixelRatio || 1, 1.5)
      width = window.innerWidth
      height = window.innerHeight
      canvas.width = width * dpr
      canvas.height = height * dpr
      canvas.style.width = `${width}px`
      canvas.style.height = `${height}px`
      context.setTransform(dpr, 0, 0, dpr, 0, 0)
      buildShards()
    }

    const onMove = (e: PointerEvent): void => {
      pointer.x = e.clientX
      pointer.y = e.clientY
    }

    const draw = (time: number): void => {
      if (!running) return
      context.clearRect(0, 0, width, height)
      const dark = document.documentElement.classList.contains('dark')
      const sat = dark ? 60 : 45
      const light = dark ? 30 : 82

      for (const s of shards) {
        s.x += s.driftX
        s.y += s.driftY
        s.rotation += s.rotSpeed
        if (s.y < -s.h) s.y = height + s.h
        if (s.x < -s.w) s.x = width + s.w
        if (s.x > width + s.w) s.x = -s.w

        // Pointer repel — very gentle
        const dx = s.x + s.w / 2 - pointer.x
        const dy = s.y + s.h / 2 - pointer.y
        const dist = Math.sqrt(dx * dx + dy * dy)
        let ox = 0
        let oy = 0
        if (dist < ambient.pointerRepel && dist > 0) {
          const f = (1 - dist / ambient.pointerRepel) * ambient.cursorRepelStrength * 100
          ox = (dx / dist) * f
          oy = (dy / dist) * f
        }

        context.save()
        context.translate(s.x + ox, s.y + oy)
        context.rotate(s.rotation)
        context.beginPath()
        context.moveTo(-s.w / 2, -s.h / 2)
        context.lineTo(s.w / 2, -s.h / 3)
        context.lineTo(s.w / 3, s.h / 2)
        context.lineTo(-s.w / 3, s.h / 3)
        context.closePath()
        context.fillStyle = `hsla(${s.hue}, ${sat}%, ${light}%, ${s.alpha})`
        context.fill()
        context.restore()
      }
      animationId = window.requestAnimationFrame(draw)
    }

    const pause = (): void => {
      running = false
      cancelAnimationFrame(animationId)
    }
    const resume = (): void => {
      if (!running) {
        running = true
        animationId = window.requestAnimationFrame(draw)
      }
    }
    const onVisibility = (): void => {
      if (document.hidden) pause()
      else resume()
    }

    resize()
    animationId = window.requestAnimationFrame(draw)
    window.addEventListener('resize', resize)
    window.addEventListener('pointermove', onMove)
    document.addEventListener('visibilitychange', onVisibility)
    window.addEventListener('blur', pause)
    window.addEventListener('focus', resume)
    return () => {
      pause()
      window.removeEventListener('resize', resize)
      window.removeEventListener('pointermove', onMove)
      document.removeEventListener('visibilitychange', onVisibility)
      window.removeEventListener('blur', pause)
      window.removeEventListener('focus', resume)
    }
  }, [])

  // Static CSS fallback when no WebGL
  if (!webgl.current) {
    return (
      <div
        className="pointer-events-none fixed inset-0 z-0"
        aria-hidden="true"
        style={{
          background:
            'radial-gradient(ellipse 60% 50% at 20% 30%, rgb(124 92 252 / 0.03), transparent 70%),' +
            'radial-gradient(ellipse 50% 40% at 80% 70%, rgb(249 115 22 / 0.02), transparent 70%)',
          backgroundSize: '100% 100%'
        }}
      />
    )
  }

  return <canvas ref={canvasRef} className="pointer-events-none fixed inset-0 z-0" aria-hidden="true" />
}