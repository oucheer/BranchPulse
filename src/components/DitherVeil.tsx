import { useEffect, useRef } from 'react'

interface DitherVeilProps {
  className?: string
  opacity?: number
  src?: string
  pattern?: 'floyd' | 'ordered'
  pixelSize?: number
  inkColor?: string
  paperColor?: string
  revealRadius?: number
  softness?: number
  linger?: number
}

interface DitherFrame {
  width: number
  height: number
  bits: Uint8Array
  colors: Uint8ClampedArray
}

const DEFAULT_SRC = 'https://images.unsplash.com/photo-1737071371043-761e02b1ef95?q=80&w=1400&auto=format&fit=crop'

function clampByte(value: number): number {
  return Math.max(0, Math.min(255, Math.round(value)))
}

function buildDitherFrame(
  image: HTMLImageElement,
  width: number,
  height: number,
  pattern: 'floyd' | 'ordered'
): DitherFrame {
  const sample = document.createElement('canvas')
  sample.width = width
  sample.height = height
  const context = sample.getContext('2d', { willReadFrequently: true })
  if (!context) return { width, height, bits: new Uint8Array(width * height), colors: new Uint8ClampedArray(width * height * 4) }

  context.fillStyle = '#000'
  context.fillRect(0, 0, width, height)
  const sourceRatio = image.naturalWidth / image.naturalHeight
  const targetRatio = width / height
  let drawWidth = width
  let drawHeight = height
  if (sourceRatio > targetRatio) drawWidth = Math.round(height * sourceRatio)
  else drawHeight = Math.round(width / sourceRatio)
  context.drawImage(image, (width - drawWidth) / 2, (height - drawHeight) / 2, drawWidth, drawHeight)

  const data = context.getImageData(0, 0, width, height).data
  const gray = new Float32Array(width * height)
  const colors = new Uint8ClampedArray(width * height * 4)
  for (let index = 0; index < width * height; index++) {
    const offset = index * 4
    const red = data[offset]
    const green = data[offset + 1]
    const blue = data[offset + 2]
    colors[offset] = red
    colors[offset + 1] = green
    colors[offset + 2] = blue
    colors[offset + 3] = data[offset + 3]
    gray[index] = red * 0.299 + green * 0.587 + blue * 0.114
  }

  const bits = new Uint8Array(width * height)
  if (pattern === 'floyd') {
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const index = y * width + x
        const old = gray[index]
        const next = old < 128 ? 0 : 255
        bits[index] = next ? 1 : 0
        const error = old - next
        if (x + 1 < width) gray[index + 1] += error * 7 / 16
        if (y + 1 < height) {
          if (x > 0) gray[index + width - 1] += error * 3 / 16
          gray[index + width] += error * 5 / 16
          if (x + 1 < width) gray[index + width + 1] += error * 1 / 16
        }
      }
    }
  } else {
    const matrix = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5]
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const index = y * width + x
        const threshold = (matrix[(y % 4) * 4 + (x % 4)] + 0.5) * 16
        bits[index] = gray[index] > threshold ? 1 : 0
      }
    }
  }
  return { width, height, bits, colors }
}

function fallbackFrame(width: number, height: number): DitherFrame {
  const colors = new Uint8ClampedArray(width * height * 4)
  const gray = new Float32Array(width * height)
  const cx = width / 2
  const head = { cx, cy: height * 0.42, rx: width * 0.28, ry: height * 0.34 }
  const neck = { cx, cy: height * 0.9, rx: width * 0.16, ry: height * 0.24 }
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const index = y * width + x
      const headDistance = ((x - head.cx) / head.rx) ** 2 + ((y - head.cy) / head.ry) ** 2
      const neckDistance = ((x - neck.cx) / neck.rx) ** 2 + ((y - neck.cy) / neck.ry) ** 2
      const inside = headDistance <= 1 || neckDistance <= 1
      gray[index] = inside ? 150 + Math.sin((x / width) * 7 + (y / height) * 4) * 70 : 8
      colors[index * 4] = inside ? 220 : 150
      colors[index * 4 + 1] = inside ? 235 : 145
      colors[index * 4 + 2] = inside ? 255 : 160
      colors[index * 4 + 3] = 255
    }
  }
  const bits = new Uint8Array(width * height)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const index = y * width + x
      const old = gray[index]
      const next = old < 128 ? 0 : 255
      bits[index] = next ? 1 : 0
      const error = old - next
      if (x + 1 < width) gray[index + 1] += error * 7 / 16
      if (y + 1 < height) {
        if (x > 0) gray[index + width - 1] += error * 3 / 16
        gray[index + width] += error * 5 / 16
        if (x + 1 < width) gray[index + width + 1] += error * 1 / 16
      }
    }
  }
  return { width, height, bits, colors }
}

/** A compact image-based dithered portrait that stays inside its navigation container. */
export default function DitherVeil({
  className = '',
  opacity = 0.24,
  src = DEFAULT_SRC,
  pattern = 'floyd',
  pixelSize = 2,
  inkColor = '#f4f1ea',
  paperColor = '#120f17',
  revealRadius = 200,
  softness = 0.6,
  linger = 1
}: DitherVeilProps): JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const frameRef = useRef<DitherFrame | null>(null)
  const imageRef = useRef<HTMLImageElement | null>(null)
  const revealRef = useRef<Float32Array | null>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    const host = canvas?.parentElement
    if (!canvas || !host) return
    const context = canvas.getContext('2d')
    if (!context) return
    let frame = 0
    let width = 1
    let height = 1
    let pointer = { x: -1000, y: -1000 }
    let target = { x: -1000, y: -1000 }

    const ensureFrame = (): void => {
      const cell = Math.max(1, Math.min(pixelSize, Math.floor(host.clientWidth / 48) || 1))
      const frameWidth = Math.max(8, Math.floor(host.clientWidth / cell))
      const frameHeight = Math.max(8, Math.floor(host.clientHeight / cell))
      const previous = frameRef.current
      if (previous && previous.width === frameWidth && previous.height === frameHeight) return
      try {
        frameRef.current = imageRef.current
          ? buildDitherFrame(imageRef.current, frameWidth, frameHeight, pattern)
          : fallbackFrame(frameWidth, frameHeight)
      } catch {
        imageRef.current = null
        frameRef.current = fallbackFrame(frameWidth, frameHeight)
      }
      revealRef.current = new Float32Array(frameWidth * frameHeight)
    }

    const loadImage = (): void => {
      const image = new Image()
      image.crossOrigin = 'anonymous'
      image.onload = () => {
        imageRef.current = image
        frameRef.current = null
      }
      image.onerror = () => {
        imageRef.current = null
        frameRef.current = null
      }
      image.src = src
    }

    const resize = (): void => {
      const ratio = Math.min(window.devicePixelRatio || 1, 2)
      width = Math.max(1, host.clientWidth)
      height = Math.max(1, host.clientHeight)
      canvas.width = Math.round(width * ratio)
      canvas.height = Math.round(height * ratio)
      canvas.style.width = `${width}px`
      canvas.style.height = `${height}px`
      context.setTransform(ratio, 0, 0, ratio, 0, 0)
      frameRef.current = null
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
      ensureFrame()
      const activeFrame = frameRef.current
      const reveal = revealRef.current
      if (!activeFrame || !reveal) {
        frame = requestAnimationFrame(draw)
        return
      }
      context.fillStyle = paperColor
      context.fillRect(0, 0, width, height)
      const cellX = width / activeFrame.width
      const cellY = height / activeFrame.height
      const radius = Math.max(8, revealRadius)
      const lingerDecay = Math.exp(-1 / (60 * Math.max(0.05, linger)))
      for (let index = 0; index < reveal.length; index++) reveal[index] *= lingerDecay
      for (let y = 0; y < activeFrame.height; y++) {
        for (let x = 0; x < activeFrame.width; x++) {
          const index = y * activeFrame.width + x
          const centerX = (x + 0.5) * cellX
          const centerY = (y + 0.5) * cellY
          const distance = Math.hypot(centerX - pointer.x, centerY - pointer.y)
          const falloff = Math.max(0, 1 - distance / radius)
          const revealAmount = Math.pow(falloff, 1 / Math.max(0.05, softness))
          reveal[index] = Math.max(reveal[index], revealAmount)
          const current = reveal[index]
          // The reference animation shows the full ink portrait before the
          // cursor reveals colour; dimming it here turns tiny nav cells black.
          const brightness = activeFrame.bits[index] ? 1 : current
          const offset = index * 4
          const red = activeFrame.colors[offset]
          const green = activeFrame.colors[offset + 1]
          const blue = activeFrame.colors[offset + 2]
          const maxColor = Math.max(red, green, blue)
          const minColor = Math.min(red, green, blue)
          const saturation = maxColor === 0 ? 0 : (maxColor - minColor) / maxColor
          const useAccent = saturation > 0.35 && maxColor > 90
          context.globalAlpha = Math.min(1, brightness * opacity)
          const dotColor = current > 0.01
            ? `rgb(${clampByte(red)} ${clampByte(green)} ${clampByte(blue)})`
            : useAccent
            ? `rgb(${clampByte(red)} ${clampByte(green)} ${clampByte(blue)})`
            : inkColor
          context.fillStyle = dotColor
          // Tiny nav cells are subpixel-sized; fractional fills get antialiased
          // into near-black noise. Snap each dither cell to the pixel grid.
          const left = Math.round(x * cellX)
          const top = Math.round(y * cellY)
          const right = Math.round((x + 1) * cellX)
          const bottom = Math.round((y + 1) * cellY)
          context.fillRect(left, top, right - left, bottom - top)
        }
      }
      context.globalAlpha = 1
      frame = requestAnimationFrame(draw)
    }
    const observer = new ResizeObserver(resize)
    observer.observe(host)
    loadImage()
    window.addEventListener('pointermove', move, { passive: true })
    window.addEventListener('pointerleave', leave, { passive: true })
    resize()
    frame = requestAnimationFrame(draw)
    return () => {
      cancelAnimationFrame(frame)
      observer.disconnect()
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerleave', leave)
    }
  }, [opacity, src, pattern, pixelSize, inkColor, paperColor, revealRadius, softness, linger])

  return <canvas ref={canvasRef} aria-hidden="true" className={`pointer-events-none absolute inset-0 z-0 h-full w-full overflow-hidden ${className}`} />
}
