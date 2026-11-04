import { useEffect, useRef } from 'react'

interface DitherVeilProps {
  className?: string
  opacity?: number
}

/** A small, dependency-free dither veil for shell surfaces. It stays behind navigation content. */
export default function DitherVeil({ className = '', opacity = 0.24 }: DitherVeilProps): JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    const host = canvas?.parentElement
    if (!canvas || !host) return
    const context = canvas.getContext('2d')
    if (!context) return
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
      const spacing = 7
      const pulse = 0.5 + Math.sin(time / 1800) * 0.12
      for (let y = spacing / 2; y < height; y += spacing) {
        for (let x = spacing / 2; x < width; x += spacing) {
          const distance = Math.hypot(x - pointer.x, y - pointer.y)
          const reveal = Math.max(0, 1 - distance / 150)
          const alpha = (0.16 + pulse * 0.12) * (1 - reveal * 0.8)
          const size = 1 + reveal * 1.5
          context.fillStyle = `rgb(${accent} / ${alpha * opacity})`
          context.fillRect(x, y, size, size)
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
