import { useEffect, useRef } from 'react'

export default function LiquidLines(): JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const context = canvas.getContext('2d')
    if (!context) return

    let animationId = 0
    let width = 0
    let height = 0
    let dpr = Math.min(window.devicePixelRatio || 1, 2)
    const pointer = { x: -1, y: -1, active: false }

    const resize = (): void => {
      dpr = Math.min(window.devicePixelRatio || 1, 2)
      width = window.innerWidth
      height = window.innerHeight
      canvas.width = width * dpr
      canvas.height = height * dpr
      canvas.style.width = `${width}px`
      canvas.style.height = `${height}px`
      context.setTransform(dpr, 0, 0, dpr, 0, 0)
    }

    const onMove = (event: PointerEvent): void => {
      pointer.x = event.clientX
      pointer.y = event.clientY
      pointer.active = true
    }

    const onLeave = (): void => {
      pointer.active = false
    }

    const draw = (time: number): void => {
      context.clearRect(0, 0, width, height)
      const dark = document.documentElement.classList.contains('dark')
      const hue = 216
      for (let i = 0; i < 8; i += 1) {
        const depth = i / 7
        context.beginPath()
        for (let x = 0; x <= width; x += 12) {
          const phase = time * 0.00012 + i * 0.7
          const wave =
            Math.sin(x * 0.0016 + phase) * 44 * (1 - depth) +
            Math.sin(x * 0.0042 + phase * 1.7) * 18
          const swell = Math.sin(x * 0.0007 - phase) * 70
          const y = height * 0.56 + wave + swell * depth + i * 18
          if (x === 0) context.moveTo(x, y)
          else context.lineTo(x, y)
        }
        context.strokeStyle = `hsla(${hue}, 85%, ${dark ? 58 + i * 4 : 44 + i * 5}%, ${(0.10 + depth * 0.05).toFixed(3)})`
        context.lineWidth = 1 + (1 - depth) * 1.4
        context.stroke()
      }

      if (pointer.active) {
        for (let i = 0; i < 3; i += 1) {
          context.beginPath()
          for (let x = 0; x <= width; x += 16) {
            const distance = Math.abs(x - pointer.x)
            const influence = Math.exp(-(distance * distance) / 24000)
            const ripple = Math.sin(x * 0.02 + time * 0.004 + i * 1.3) * 5
            const y = pointer.y + i * 7 + ripple + influence * 40
            if (x === 0) context.moveTo(x, y)
            else context.lineTo(x, y)
          }
          context.strokeStyle = `hsla(196, 90%, 62%, ${(0.09 - i * 0.02).toFixed(3)})`
          context.lineWidth = 1
          context.stroke()
        }
      }
      animationId = window.requestAnimationFrame(draw)
    }

    resize()
    animationId = window.requestAnimationFrame(draw)
    window.addEventListener('resize', resize)
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerleave', onLeave)
    return () => {
      window.cancelAnimationFrame(animationId)
      window.removeEventListener('resize', resize)
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerleave', onLeave)
    }
  }, [])

  return <canvas ref={canvasRef} className="pointer-events-none fixed inset-0 z-0" aria-hidden="true" />
}
