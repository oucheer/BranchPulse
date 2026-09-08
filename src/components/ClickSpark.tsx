/**
 * ClickSpark — global mouse click sparkle overlay.
 * Adapted from the React Bits <ClickSpark /> component (MIT):
 *   - Rendered as a fixed, pointer-events-none canvas above the app shell,
 *     so sparks appear wherever the user clicks.
 *   - The animation loop only runs while sparks are alive (no idle 60fps cost).
 * Mounted only while app effects are enabled (see Layout + src/lib/effects.ts).
 */
import { useEffect, useRef } from 'react'

type Easing = 'linear' | 'ease-in' | 'ease-out' | 'ease-in-out'

export interface ClickSparkProps {
  sparkColor?: string
  sparkSize?: number
  sparkRadius?: number
  sparkCount?: number
  duration?: number
  easing?: Easing
  extraScale?: number
}

interface Spark {
  x: number
  y: number
  angle: number
  startTime: number
}

interface SparkParams {
  sparkColor: string
  sparkSize: number
  sparkRadius: number
  sparkCount: number
  duration: number
  easing: Easing
  extraScale: number
}

const MAX_LIVE_SPARKS = 320

export default function ClickSpark({
  sparkColor = '#ffffff',
  sparkSize = 10,
  sparkRadius = 15,
  sparkCount = 8,
  duration = 400,
  easing = 'ease-out',
  extraScale = 1
}: ClickSparkProps): JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const sparksRef = useRef<Spark[]>([])
  const rafRef = useRef<number | null>(null)
  const paramsRef = useRef<SparkParams>({ sparkColor, sparkSize, sparkRadius, sparkCount, duration, easing, extraScale })
  paramsRef.current = { sparkColor, sparkSize, sparkRadius, sparkCount, duration, easing, extraScale }

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const context = canvas.getContext('2d')
    if (!context) return

    let running = false

    const ease = (t: number): number => {
      switch (paramsRef.current.easing) {
        case 'linear':
          return t
        case 'ease-in':
          return t * t
        case 'ease-in-out':
          return t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t
        default:
          return t * (2 - t)
      }
    }

    const resize = (): void => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2)
      const width = window.innerWidth
      const height = window.innerHeight
      canvas.width = Math.floor(width * dpr)
      canvas.height = Math.floor(height * dpr)
      canvas.style.width = `${width}px`
      canvas.style.height = `${height}px`
      context.setTransform(dpr, 0, 0, dpr, 0, 0)
    }

    const stop = (): void => {
      running = false
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current)
        rafRef.current = null
      }
    }

    const frame = (timestamp: number): void => {
      const params = paramsRef.current
      context.clearRect(0, 0, window.innerWidth, window.innerHeight)

      const alive: Spark[] = []
      for (const spark of sparksRef.current) {
        const elapsed = timestamp - spark.startTime
        if (elapsed >= params.duration) continue
        alive.push(spark)

        const progress = elapsed / params.duration
        const eased = ease(progress)
        const distance = eased * params.sparkRadius * params.extraScale
        const lineLength = params.sparkSize * (1 - eased)
        const x1 = spark.x + distance * Math.cos(spark.angle)
        const y1 = spark.y + distance * Math.sin(spark.angle)
        const x2 = spark.x + (distance + lineLength) * Math.cos(spark.angle)
        const y2 = spark.y + (distance + lineLength) * Math.sin(spark.angle)

        context.strokeStyle = params.sparkColor
        context.lineWidth = 2
        context.lineCap = 'round'
        context.beginPath()
        context.moveTo(x1, y1)
        context.lineTo(x2, y2)
        context.stroke()
      }

      sparksRef.current = alive
      if (alive.length > 0) {
        rafRef.current = requestAnimationFrame(frame)
      } else {
        running = false
        rafRef.current = null
        context.clearRect(0, 0, window.innerWidth, window.innerHeight)
      }
    }

    const start = (): void => {
      if (running) return
      running = true
      rafRef.current = requestAnimationFrame(frame)
    }

    const onClick = (event: MouseEvent): void => {
      const params = paramsRef.current
      const now = performance.now()
      const next: Spark[] = Array.from({ length: params.sparkCount }, (_, i) => ({
        x: event.clientX,
        y: event.clientY,
        angle: (2 * Math.PI * i) / params.sparkCount,
        startTime: now
      }))
      sparksRef.current.push(...next)
      if (sparksRef.current.length > MAX_LIVE_SPARKS) {
        sparksRef.current = sparksRef.current.slice(-MAX_LIVE_SPARKS)
      }
      start()
    }

    resize()
    window.addEventListener('resize', resize)
    window.addEventListener('click', onClick, { passive: true })

    return () => {
      stop()
      window.removeEventListener('resize', resize)
      window.removeEventListener('click', onClick)
    }
  }, [])

  return (
    <canvas
      ref={canvasRef}
      aria-hidden="true"
      className="pointer-events-none fixed inset-0"
      style={{ zIndex: 70, display: 'block' }}
    />
  )
}
