import { useEffect, useRef } from 'react'

interface DitherVeilProps {
  className?: string
  opacity?: number
}

const CANVAS_WIDTH = 32
const CANVAS_HEIGHT = 32

function buildPortraitMask(width: number, height: number): Uint8Array {
  const mask = new Uint8Array(width * height)
  const cx = width / 2
  const head = { cx, cy: height * 0.39, rx: width * 0.18, ry: height * 0.19 }
  const shoulders = { cx, cy: height * 0.83, rx: width * 0.31, ry: height * 0.23 }
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const headDistance = ((x - head.cx) / head.rx) ** 2 + ((y - head.cy) / head.ry) ** 2
      const bodyDistance = ((x - shoulders.cx) / shoulders.rx) ** 2 + ((y - shoulders.cy) / shoulders.ry) ** 2
      if (headDistance <= 1 || bodyDistance <= 1) mask[y * width + x] = 1
    }
  }
  return mask
}

/** A compact dithered portrait that stays inside its navigation container. */
export default function DitherVeil({ className = '', opacity = 0.24 }: DitherVeilProps): JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    const host = canvas?.parentElement
    if (!canvas || !host) return
    const context = canvas.getContext('2d')
    if (!context) return
    const mask = buildPortraitMask(CANVAS_WIDTH, CANVAS_HEIGHT)
    const accent = getComputedStyle(document.documentElement).getPropertyValue('--primary').trim() || '124 92 252'
    let frame = 0
    let width = 1
    let height = 1
    let pointer = { x: -1000, y: -1000 }
    let target = { x: -1000, y: -1000 }

    const resize = (): void => {
      const ratio = Math.min(window.devicePixelRatio || 1, 2)
      width = Math.max(1, host.clientWidth)
      height = Math.max(1, host.clientHeight)
      canvas.width = Math.round(width * ratio)
      canvas.height = Math.round(height * ratio)
      canvas.style.width = `${width}px`
      canvas.style.height = `${height}px`
      context.setTransform(ratio, 0, 0, ratio, 0, 0)
    }
    const move = (event: PointerEvent): void => {
      const rect = host.getBoundingClientRect()
      target = { x: event.clientX - rect.left, y: event.clientY - rect.top }
    }
    const leave = (): void => { target = { x: -1000, y: -1000 } }
    const draw = (time: number): void => {
      pointer.x += (target.x - pointer.x) * 0.08
      pointer.y += (target.y - pointer.y) * 0.08
      context.clearRect(0, 0, width, height)
      const scaleX = width / CANVAS_WIDTH
      const scaleY = height / CANVAS_HEIGHT
      const pulse = 0.5 + Math.sin(time / 1700) * 0.22
      for (let y = 0; y < CANVAS_HEIGHT; y++) {
        for (let x = 0; x < CANVAS_WIDTH; x++) {
          if (!mask[y * CANVAS_WIDTH + x]) continue
          const centerX = (x + 0.5) * scaleX
          const centerY = (y + 0.5) * scaleY
          const distance = Math.hypot(centerX - pointer.x, centerY - pointer.y)
          const reveal = Math.max(0, 1 - distance / Math.max(width, 45))
          const brightness = 0.28 + pulse * 0.18 + reveal * 0.54
          if (brightness <= 0.26) continue
          const size = 1.4 + reveal * 1.1
          context.fillStyle = `rgb(${accent} / ${Math.min(0.85, brightness * opacity)})`
          context.fillRect(centerX - size / 2, centerY - size / 2, size, size)
        }
      }
      frame = requestAnimationFrame(draw)
    }
    const observer = new ResizeObserver(resize)
    observer.observe(host)
    host.addEventListener('pointermove', move, { passive: true })
    host.addEventListener('pointerleave', leave, { passive: true })
    resize()
    frame = requestAnimationFrame(draw)
    return () => {
      cancelAnimationFrame(frame)
      observer.disconnect()
      host.removeEventListener('pointermove', move)
      host.removeEventListener('pointerleave', leave)
    }
  }, [opacity])

  return <canvas ref={canvasRef} aria-hidden="true" className={`pointer-events-none absolute inset-0 z-0 h-full w-full overflow-hidden ${className}`} />
}
