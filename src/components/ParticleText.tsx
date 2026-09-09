import { useEffect, useRef } from 'react'

interface Particle {
  x: number
  y: number
  z: number
  tx: number
  ty: number
  tz: number
  size: number
  color: string
}

interface ParticleTextProps {
  text: string
  duration?: number
  onComplete: () => void
}

const ACCENTS = ['#f97316', '#fb923c', '#38bdf8', '#818cf8']

export default function ParticleText({ text, duration = 3400, onComplete }: ParticleTextProps): JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const completeRef = useRef(onComplete)

  useEffect(() => {
    completeRef.current = onComplete
  }, [onComplete])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const context = canvas.getContext('2d')
    if (!context) {
      const fallback = window.setTimeout(() => completeRef.current(), 1200)
      return () => window.clearTimeout(fallback)
    }

    let width = 0
    let height = 0
    let dpr = Math.min(window.devicePixelRatio || 1, 2)
    let particles: Particle[] = []
    let raf = 0
    let finished = false
    const startedAt = performance.now()
    const mouse = { x: 0, y: 0 }
    const rotation = { x: 0, y: 0 }

    const resize = (): void => {
      const rect = canvas.getBoundingClientRect()
      width = Math.max(320, rect.width)
      height = Math.max(180, rect.height)
      dpr = Math.min(window.devicePixelRatio || 1, 2)
      canvas.width = Math.floor(width * dpr)
      canvas.height = Math.floor(height * dpr)
      context.setTransform(dpr, 0, 0, dpr, 0, 0)
      buildParticles()
    }

    const buildParticles = (): void => {
      const offscreen = document.createElement('canvas')
      const offWidth = Math.min(1100, Math.max(560, width))
      const offHeight = Math.min(300, Math.max(170, height * 0.72))
      offscreen.width = offWidth
      offscreen.height = offHeight
      const offContext = offscreen.getContext('2d')
      if (!offContext) return
      const fontSize = Math.min(offWidth / (text.length * 0.72), offHeight * 0.66, 132)
      offContext.fillStyle = '#fff'
      offContext.font = `800 ${fontSize}px "Inter Variable", Inter, "Segoe UI", system-ui, sans-serif`
      offContext.textAlign = 'center'
      offContext.textBaseline = 'middle'
      offContext.fillText(text, offWidth / 2, offHeight / 2)
      const image = offContext.getImageData(0, 0, offWidth, offHeight).data
      const step = offWidth > 900 ? 4 : 3
      const sampled: Array<{ x: number; y: number }> = []
      for (let y = 0; y < offHeight; y += step) {
        for (let x = 0; x < offWidth; x += step) {
          if (image[(y * offWidth + x) * 4 + 3] > 140) sampled.push({ x, y })
        }
      }
      const maxParticles = Math.min(3200, sampled.length)
      const stride = Math.max(1, Math.floor(sampled.length / maxParticles))
      const centerX = width / 2
      const centerY = height / 2
      const scaleX = Math.min(1, (width * 0.86) / offWidth)
      const scaleY = Math.min(1, (height * 0.7) / offHeight)
      const scale = Math.min(scaleX, scaleY)
      particles = sampled.filter((_, index) => index % stride === 0).map((point) => {
        const tx = centerX + (point.x - offWidth / 2) * scale
        const ty = centerY + (point.y - offHeight / 2) * scale
        return {
          x: centerX + (Math.random() - 0.5) * width * 1.3,
          y: centerY + (Math.random() - 0.5) * height * 1.3,
          z: (Math.random() - 0.5) * 620,
          tx,
          ty,
          tz: (Math.random() - 0.5) * 34,
          size: 1.05 + Math.random() * 1.35,
          color: ACCENTS[Math.floor(Math.random() * ACCENTS.length)]
        }
      })
    }

    const onPointerMove = (event: PointerEvent): void => {
      const rect = canvas.getBoundingClientRect()
      mouse.x = ((event.clientX - rect.left) / rect.width - 0.5) * 2
      mouse.y = ((event.clientY - rect.top) / rect.height - 0.5) * 2
    }

    const finish = (): void => {
      if (finished) return
      finished = true
      cancelAnimationFrame(raf)
      completeRef.current()
    }

    const draw = (now: number): void => {
      if (finished) return
      const elapsed = now - startedAt
      const life = Math.min(1, elapsed / duration)
      const exit = life > 0.88 ? Math.pow((life - 0.88) / 0.12, 2) : 0
      rotation.y += (mouse.x * 0.24 - rotation.y) * 0.06
      rotation.x += (-mouse.y * 0.14 - rotation.x) * 0.06
      const focalLength = 620
      context.clearRect(0, 0, width, height)
      context.globalAlpha = Math.max(0, 1 - exit)

      for (const particle of particles) {
        particle.x += (particle.tx - particle.x) * 0.085
        particle.y += (particle.ty - particle.y) * 0.085
        particle.z += (particle.tz - particle.z) * 0.075
        const cosy = Math.cos(rotation.y)
        const siny = Math.sin(rotation.y)
        const cosx = Math.cos(rotation.x)
        const sinx = Math.sin(rotation.x)
        const x1 = particle.x - width / 2
        const y1 = particle.y - height / 2
        const z1 = particle.z
        const x2 = x1 * cosy - z1 * siny
        const z2 = x1 * siny + z1 * cosy
        const y2 = y1 * cosx - z2 * sinx
        const z3 = y1 * sinx + z2 * cosx
        const scale = focalLength / (focalLength + z3)
        const screenX = width / 2 + x2 * scale
        const screenY = height / 2 + y2 * scale
        context.beginPath()
        context.fillStyle = particle.color
        context.arc(screenX, screenY, Math.max(0.2, particle.size * scale), 0, Math.PI * 2)
        context.fill()
      }

      context.globalAlpha = 1
      if (life >= 1) {
        finish()
        return
      }
      raf = requestAnimationFrame(draw)
    }

    resize()
    void document.fonts?.load('800 64px "Inter Variable"').then(() => {
      if (!finished) resize()
    })
    window.addEventListener('resize', resize)
    canvas.addEventListener('pointermove', onPointerMove)
    raf = requestAnimationFrame(draw)
    const safety = window.setTimeout(finish, duration + 500)

    return () => {
      finished = true
      cancelAnimationFrame(raf)
      window.clearTimeout(safety)
      window.removeEventListener('resize', resize)
      canvas.removeEventListener('pointermove', onPointerMove)
    }
  }, [duration, text])

  return <canvas ref={canvasRef} className="h-full w-full cursor-crosshair" aria-label={text} />
}
