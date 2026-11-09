import { useEffect, useRef } from 'react'
import { Renderer, Program, Mesh, Triangle, Texture, RenderTarget } from 'ogl'
import './DitherVeil.css'

interface DitherVeilProps {
  className?: string
  src?: string
  fit?: 'contain' | 'cover'
  pattern?: 'bayer' | 'noise' | 'atkinson' | 'floyd' | 'lines'
  pixelSize?: number
  levels?: number
  palette?: 'duotone' | 'rgb'
  inkColor?: string
  paperColor?: string
  contrast?: number
  brightness?: number
  revealRadius?: number
  softness?: number
  linger?: number
  rimColor?: string
  rim?: number
  reverse?: boolean
  wander?: boolean
  clickBurst?: boolean
}

interface DitherSettings {
  fit: 'contain' | 'cover'
  pattern: DitherVeilProps['pattern']
  pixelSize: number
  levels: number
  palette: 'duotone' | 'rgb'
  inkColor: string
  paperColor: string
  contrast: number
  brightness: number
  revealRadius: number
  softness: number
  linger: number
  rimColor: string
  rim: number
  reverse: boolean
  wander: boolean
  clickBurst: boolean
}

const DEFAULT_SRC = 'https://images.unsplash.com/photo-1737071371043-761e02b1ef95?q=80&w=1400&auto=format&fit=crop'
const ORDERED: Record<string, number> = { bayer: 0, noise: 1, lines: 2 }

const KERNELS: Record<string, number[][]> = {
  atkinson: [
    [1, 0, 1 / 8],
    [2, 0, 1 / 8],
    [-1, 1, 1 / 8],
    [0, 1, 1 / 8],
    [1, 1, 1 / 8],
    [0, 2, 1 / 8]
  ],
  floyd: [
    [1, 0, 7 / 16],
    [-1, 1, 3 / 16],
    [0, 1, 5 / 16],
    [1, 1, 1 / 16]
  ]
}

const MASK_SCALE = 0.5
const MAX_BURSTS = 4
const BURST_SECONDS = 1.2
const HOLD = 1.6
const INTRO_MS = 1100

const hexToRgb = (hex: string): number[] => {
  let value = String(hex || '').replace('#', '')
  if (value.length === 3) value = value.split('').map((char) => char + char).join('')
  const parsed = Number.parseInt(value.slice(0, 6), 16)
  if (Number.isNaN(parsed)) return [0, 0, 0]
  return [((parsed >> 16) & 255) / 255, ((parsed >> 8) & 255) / 255, (parsed & 255) / 255]
}

const fitScale = (width: number, height: number, imageWidth: number, imageHeight: number, contain: boolean): number[] => {
  const ratio = width / height / (imageWidth / imageHeight)
  if (contain) return ratio > 1 ? [ratio, 1] : [1, 1 / ratio]
  return ratio > 1 ? [1, 1 / ratio] : [ratio, 1]
}

const wanderAt = (time: number, width: number, height: number): number[] => [
  width * (0.5 + 0.33 * Math.sin(time * 0.53) + 0.08 * Math.sin(time * 1.31 + 0.6)),
  height * (0.5 + 0.28 * Math.sin(time * 0.71 + 1.1) + 0.07 * Math.cos(time * 1.57))
]

const measureEdge = (context: CanvasRenderingContext2D, image: HTMLImageElement): { matte: number[]; plain: boolean } => {
  const size = 32
  context.canvas.width = size
  context.canvas.height = size
  context.drawImage(image, 0, 0, size, size)
  const data = context.getImageData(0, 0, size, size).data
  const sum = [0, 0, 0]
  const squares = [0, 0, 0]
  let count = 0
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (x > 0 && y > 0 && x < size - 1 && y < size - 1) continue
      for (let channel = 0; channel < 3; channel++) {
        const value = data[(y * size + x) * 4 + channel] / 255
        sum[channel] += value
        squares[channel] += value * value
      }
      count++
    }
  }
  const matte = sum.map((total) => total / count)
  const spread = matte.reduce((total, mean, channel) => {
    return total + Math.sqrt(Math.max(0, squares[channel] / count - mean * mean))
  }, 0) / 3
  return { matte, plain: spread < 0.06 }
}

let blueNoise: Uint8Array | null = null
const getBlueNoise = (): Uint8Array => {
  if (blueNoise) return blueNoise
  const size = 64
  const count = size * size
  const wrap = size - 1
  const taps: number[] = []
  for (let dy = -6; dy <= 6; dy++) {
    for (let dx = -6; dx <= 6; dx++) taps.push(dx, dy, Math.exp(-(dx * dx + dy * dy) / 4.5))
  }
  const energy = new Float32Array(count)
  const on = new Uint8Array(count)
  const splat = (index: number, sign: number): void => {
    const x = index % size
    const y = (index - x) / size
    for (let tap = 0; tap < taps.length; tap += 3) {
      energy[((y + taps[tap + 1]) & wrap) * size + ((x + taps[tap]) & wrap)] += sign * taps[tap + 2]
    }
  }
  const find = (state: number, highest: boolean): number => {
    let best = 0
    let value = highest ? -Infinity : Infinity
    for (let index = 0; index < count; index++) {
      if (on[index] !== state) continue
      if (highest ? energy[index] > value : energy[index] < value) {
        value = energy[index]
        best = index
      }
    }
    return best
  }
  let seed = 7
  const random = (): number => {
    seed = (seed * 16807) % 2147483647
    return seed / 2147483647
  }
  const initial = Math.round(count * 0.1)
  for (let placed = 0; placed < initial; ) {
    const index = Math.floor(random() * count)
    if (on[index]) continue
    on[index] = 1
    splat(index, 1)
    placed++
  }
  for (let guard = 0; guard < count; guard++) {
    const cluster = find(1, true)
    on[cluster] = 0
    splat(cluster, -1)
    const gap = find(0, false)
    on[gap] = 1
    splat(gap, 1)
    if (gap === cluster) break
  }
  const seedOn = on.slice()
  const seedEnergy = energy.slice()
  const rank = new Uint16Array(count)
  for (let rankValue = initial - 1; rankValue >= 0; rankValue--) {
    const cluster = find(1, true)
    on[cluster] = 0
    splat(cluster, -1)
    rank[cluster] = rankValue
  }
  on.set(seedOn)
  energy.set(seedEnergy)
  for (let rankValue = initial; rankValue < count; rankValue++) {
    const gap = find(0, false)
    on[gap] = 1
    splat(gap, 1)
    rank[gap] = rankValue
  }
  const data = new Uint8Array(count * 4)
  for (let index = 0; index < count; index++) {
    const value = Math.floor((rank[index] / count) * 256)
    data[index * 4] = value
    data[index * 4 + 1] = value
    data[index * 4 + 2] = value
    data[index * 4 + 3] = 255
  }
  blueNoise = data
  return data
}

const diffuse = (
  pixels: Uint8ClampedArray,
  columns: number,
  rows: number,
  kernel: number[][],
  levels: number,
  rgb: boolean,
  grade: (value: number) => number
): Uint8Array => {
  const channels = rgb ? 3 : 1
  const values = new Float32Array(columns * rows * channels)
  for (let index = 0; index < columns * rows; index++) {
    const red = pixels[index * 4] / 255
    const green = pixels[index * 4 + 1] / 255
    const blue = pixels[index * 4 + 2] / 255
    if (rgb) {
      values[index * 3] = grade(red)
      values[index * 3 + 1] = grade(green)
      values[index * 3 + 2] = grade(blue)
    } else {
      values[index] = grade(0.2126 * red + 0.7152 * green + 0.0722 * blue)
    }
  }
  const steps = levels - 1
  const output = new Uint8Array(columns * rows * 4)
  for (let y = 0; y < rows; y++) {
    const direction = y & 1 ? -1 : 1
    for (let position = 0; position < columns; position++) {
      const x = direction > 0 ? position : columns - 1 - position
      const pixel = y * columns + x
      for (let channel = 0; channel < channels; channel++) {
        const old = values[pixel * channels + channel]
        const quantized = Math.min(steps, Math.max(0, Math.round(old * steps))) / steps
        const error = old - quantized
        const byte = Math.round(quantized * 255)
        if (rgb) output[pixel * 4 + channel] = byte
        else output[pixel * 4] = output[pixel * 4 + 1] = output[pixel * 4 + 2] = byte
        for (let offset = 0; offset < kernel.length; offset++) {
          const nx = x + kernel[offset][0] * direction
          const ny = y + kernel[offset][1]
          if (nx < 0 || nx >= columns || ny >= rows) continue
          values[(ny * columns + nx) * channels + channel] += error * kernel[offset][2]
        }
      }
      output[pixel * 4 + 3] = 255
    }
  }
  return output
}

const vertex = `#version 300 es
in vec2 position;
in vec2 uv;
out vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position, 0.0, 1.0);
}
`

const maskFragment = `#version 300 es
precision highp float;

uniform sampler2D tPrev;
uniform vec2 uSize;
uniform vec2 uFrom;
uniform vec2 uTo;
uniform float uRadius;
uniform float uSoftness;
uniform float uStrength;
uniform float uFade;
uniform float uHold;

in vec2 vUv;
out vec4 fragColor;

float strokeDistance(vec2 p, vec2 a, vec2 b) {
  vec2 ab = b - a;
  float h = clamp(dot(p - a, ab) / max(dot(ab, ab), 0.0001), 0.0, 1.0);
  return length(p - a - ab * h);
}

void main() {
  vec2 p = vec2(vUv.x, 1.0 - vUv.y) * uSize;
  float trail = max(texture(tPrev, vUv).r - uFade, 0.0);
  float band = max(uRadius * uSoftness, 1.0) * uHold;
  float d = strokeDistance(p, uFrom, uTo);
  trail = max(trail, clamp((uRadius - d) / band, 0.0, 1.0) * uStrength);
  fragColor = vec4(trail, 0.0, 0.0, 1.0);
}
`

const viewFragment = `#version 300 es
precision highp float;
precision highp int;

uniform sampler2D tImage;
uniform sampler2D tMask;
uniform sampler2D tNoise;
uniform sampler2D tDiffused;
uniform vec2 uResolution;
uniform vec2 uCover;
uniform float uLod;
uniform float uCell;
uniform int uPattern;
uniform int uPalette;
uniform float uLevels;
uniform vec3 uInk;
uniform vec3 uPaper;
uniform vec3 uRimColor;
uniform float uRim;
uniform float uContrast;
uniform float uBrightness;
uniform float uReverse;
uniform float uIntro;
uniform float uHold;
uniform vec3 uMatte;
uniform float uKey;
uniform vec2 uSize;
uniform vec4 uBursts[4];
uniform float uBurstWidth;

in vec2 vUv;
out vec4 fragColor;

float bayer(vec2 cell) {
  ivec2 p = ivec2(mod(cell, 8.0));
  int v = p.x ^ p.y;
  int m = ((v & 1) << 5) | ((p.y & 1) << 4) | ((v & 2) << 2) | ((p.y & 2) << 1) | ((v & 4) >> 1) | ((p.y & 4) >> 2);
  return (float(m) + 0.5) / 64.0;
}

float blueNoise(vec2 cell) {
  return (texelFetch(tNoise, ivec2(mod(cell, 64.0)), 0).r * 255.0 + 0.5) / 256.0;
}

float engraving(vec2 cell) {
  float period = 6.0;
  float f = (mod(cell.x + cell.y, period) + 0.5) / period;
  return clamp(abs(f * 2.0 - 1.0) + (bayer(cell) - 0.5) * (2.0 / period), 0.0, 1.0);
}

vec2 imageUv(vec2 uv) {
  return (uv - 0.5) * uCover + 0.5;
}

float within(vec2 p) {
  vec2 s = step(vec2(0.0), p) * step(p, vec2(1.0));
  return s.x * s.y;
}

vec3 grade(vec3 c) {
  return pow(clamp((c - 0.5) * uContrast + 0.5 + uBrightness, 0.0, 1.0), vec3(1.6));
}

float shockwave(vec2 p) {
  float value = 0.0;
  for (int i = 0; i < 4; i++) {
    vec4 burst = uBursts[i];
    if (burst.w <= 0.0) continue;
    float offset = distance(p, burst.xy) - burst.z;
    float edge = offset > 0.0 ? offset / (uBurstWidth * 0.35) : -offset / uBurstWidth;
    value = max(value, clamp(1.0 - edge, 0.0, 1.0) * burst.w);
  }
  return value;
}

vec3 toned(vec3 c) {
  return uPalette == 1 ? grade(c) : grade(vec3(dot(c, vec3(0.2126, 0.7152, 0.0722))));
}

vec3 quantize(vec3 v, float t) {
  float steps = max(uLevels - 1.0, 1.0);
  vec3 s = v * steps;
  vec3 base = floor(s);
  return min(base + step(vec3(t), s - base), vec3(steps)) / steps;
}

void main() {
  vec2 px = vec2(gl_FragCoord.x, uResolution.y - gl_FragCoord.y);
  vec2 cell = floor(px / uCell);
  vec2 center = (cell + 0.5) * uCell;
  vec2 cellUv = vec2(center.x / uResolution.x, 1.0 - center.y / uResolution.y);

  vec2 sampleUv = imageUv(cellUv);
  float framed = within(sampleUv);
  vec3 level;
  if (uPattern == 3) {
    level = texelFetch(tDiffused, ivec2(cell), 0).rgb;
  } else {
    vec3 c = mix(uMatte, textureLod(tImage, sampleUv, uLod).rgb, framed);
    float t = uPattern == 1 ? blueNoise(cell) : (uPattern == 2 ? engraving(cell) : bayer(cell));
    level = quantize(toned(c), t);
  }

  vec3 color = mix(uInk, mix(uInk, uPaper, level), max(framed, uKey));
  vec3 backdrop = mix(uInk, uPaper, toned(uMatte));
  vec2 photoUv = imageUv(vUv);
  vec3 raw = texture(tImage, photoUv).rgb;
  float plain = uKey * (1.0 - smoothstep(0.05, 0.22, distance(raw, uMatte)));
  vec3 photo = mix(mix(uInk, backdrop, uKey), mix(raw, backdrop, plain), within(photoUv));

  vec2 point = vec2(cellUv.x, 1.0 - cellUv.y) * uSize;
  float mask = max(clamp(texture(tMask, cellUv).r * uHold, 0.0, 1.0), shockwave(point));
  float shown = mix(mask, 1.0 - mask, uReverse);
  float order = bayer(cell.yx);
  float low = order * (1.0 - uRim);
  color = mix(color, uRimColor, step(low, shown) * step(0.001, uRim));
  color = mix(color, photo, step(low + uRim, shown));

  vec2 aspect = vec2(uResolution.x / uResolution.y, 1.0);
  float spread = length((cellUv - 0.5) * aspect) / length(aspect * 0.5);
  float appear = step(spread * 0.72 + bayer(cell + vec2(3.0, 5.0)) * 0.28, uIntro * 1.001);
  fragColor = vec4(mix(uInk, color, appear), 1.0);
}
`

/** The React Bits DitherVeil effect, adapted for the compact sidebar host. */
export default function DitherVeil({
  className = '',
  src = DEFAULT_SRC,
  fit = 'contain',
  pattern = 'floyd',
  pixelSize = 2,
  levels = 2,
  palette = 'duotone',
  inkColor = '#120f17',
  paperColor = '#f4f1ea',
  contrast = 1.15,
  brightness = 0,
  revealRadius = 200,
  softness = 0.6,
  linger = 1,
  rimColor = '#a78bfa',
  rim = 0,
  reverse = false,
  wander = false,
  clickBurst = true
}: DitherVeilProps): JSX.Element {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const settingsRef = useRef<DitherSettings | null>(null)
  const wakeRef = useRef<() => void>(() => {})

  useEffect(() => {
    settingsRef.current = {
      fit, pattern, pixelSize, levels, palette, inkColor, paperColor, contrast, brightness,
      revealRadius, softness, linger, rimColor, rim, reverse, wander, clickBurst
    }
    wakeRef.current()
  })

  useEffect(() => {
    const container = containerRef.current
    if (!container) return undefined
    const reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
    const renderer = new Renderer({ dpr: Math.min(window.devicePixelRatio || 1, 2), alpha: false, antialias: false, preserveDrawingBuffer: true })
    const gl = renderer.gl
    const canvas = gl.canvas as HTMLCanvasElement
    canvas.style.display = 'block'
    canvas.style.width = '100%'
    canvas.style.height = '100%'
    container.appendChild(canvas)

    const floatMask = renderer.isWebgl2 && !!renderer.getExtension('EXT_color_buffer_float')
    const geometry = new Triangle(gl)
    const createDataTexture = (): Texture => new Texture(gl, {
      image: new Uint8Array(4),
      width: 1,
      height: 1,
      generateMipmaps: false,
      flipY: false,
      minFilter: gl.NEAREST,
      magFilter: gl.NEAREST
    })
    const imageTexture = new Texture(gl, { minFilter: gl.LINEAR_MIPMAP_LINEAR, magFilter: gl.LINEAR })
    const noiseTexture = createDataTexture()
    const diffusedTexture = createDataTexture()

    const createMask = (width: number, height: number): RenderTarget => new RenderTarget(gl, {
      width, height, depth: false,
      type: floatMask ? WebGL2RenderingContext.HALF_FLOAT : gl.UNSIGNED_BYTE,
      internalFormat: floatMask ? WebGL2RenderingContext.RGBA16F : gl.RGBA,
      minFilter: gl.LINEAR,
      magFilter: gl.LINEAR
    })
    const destroyMask = (target: RenderTarget): void => {
      gl.deleteFramebuffer(target.buffer)
      gl.deleteTexture(target.texture.texture)
    }
    let masks = [createMask(2, 2), createMask(2, 2)]

    const maskUniforms = {
      tPrev: { value: masks[0].texture },
      uSize: { value: [1, 1] },
      uFrom: { value: [0, 0] },
      uTo: { value: [0, 0] },
      uRadius: { value: 1 },
      uSoftness: { value: 0.5 },
      uStrength: { value: 0 },
      uFade: { value: 1 },
      uHold: { value: HOLD }
    }
    const viewUniforms = {
      tImage: { value: imageTexture },
      tMask: { value: masks[0].texture },
      tNoise: { value: noiseTexture },
      tDiffused: { value: diffusedTexture },
      uResolution: { value: [1, 1] },
      uCover: { value: [1, 1] },
      uLod: { value: 0 },
      uCell: { value: 3 },
      uPattern: { value: 0 },
      uPalette: { value: 0 },
      uLevels: { value: 2 },
      uInk: { value: [0, 0, 0] },
      uPaper: { value: [1, 1, 1] },
      uRimColor: { value: [1, 1, 1] },
      uRim: { value: 0 },
      uContrast: { value: 1 },
      uBrightness: { value: 0 },
      uReverse: { value: 0 },
      uIntro: { value: 0 },
      uHold: { value: HOLD },
      uMatte: { value: [0, 0, 0] },
      uKey: { value: 0 },
      uSize: { value: [1, 1] },
      uBursts: { value: Array.from({ length: MAX_BURSTS * 4 }, () => 0) },
      uBurstWidth: { value: 60 }
    }
    const createProgram = (fragment: string, uniforms: Record<string, unknown>): Program => new Program(gl, {
      vertex, fragment, uniforms, depthTest: false, depthWrite: false
    })
    const maskMesh = new Mesh(gl, { geometry, program: createProgram(maskFragment, maskUniforms) })
    const viewMesh = new Mesh(gl, { geometry, program: createProgram(viewFragment, viewUniforms) })

    const sampler = document.createElement('canvas')
    const samplerContext = sampler.getContext('2d', { willReadFrequently: true })
    let image: HTMLImageElement | null = null
    let introStart = 0
    let diffusedKey = ''
    let diffusionBlocked = false
    let width = 1
    let height = 1
    let visible = true
    let frame = 0
    let last = performance.now()
    let trailUntil = 0
    let presence = 0
    let drift = 0
    const pointer = { x: 0, y: 0, inside: false, fresh: true, placed: false }
    const brush = { x: 0, y: 0, px: 0, py: 0 }
    const bursts: Array<{ x: number; y: number; start: number }> = []

    const layout = (): void => {
      width = Math.max(1, container.clientWidth)
      height = Math.max(1, container.clientHeight)
      renderer.setSize(width, height)
      viewUniforms.uResolution.value = [canvas.width, canvas.height]
      maskUniforms.uSize.value = [width, height]
      viewUniforms.uSize.value = [width, height]
      const maskWidth = Math.max(2, Math.round(width * MASK_SCALE))
      const maskHeight = Math.max(2, Math.round(height * MASK_SCALE))
      if (maskWidth !== masks[0].width || maskHeight !== masks[0].height) {
        masks.forEach(destroyMask)
        masks = [createMask(maskWidth, maskHeight), createMask(maskWidth, maskHeight)]
      }
      if (!pointer.placed) {
        pointer.x = width / 2
        pointer.y = height / 2
      }
    }

    const updateDiffusion = (cell: number, settings: DitherSettings): void => {
      if (!image || !samplerContext) return
      const columns = Math.ceil(canvas.width / cell)
      const rows = Math.ceil(canvas.height / cell)
      const key = [
        settings.pattern, settings.levels, settings.palette, settings.contrast, settings.brightness,
        settings.fit, columns, rows, canvas.width, canvas.height
      ].join('|')
      if (key === diffusedKey) return
      diffusedKey = key
      const [coverX, coverY] = viewUniforms.uCover.value as number[]
      const imageWidth = image.naturalWidth
      const imageHeight = image.naturalHeight
      sampler.width = columns
      sampler.height = rows
      samplerContext.imageSmoothingEnabled = true
      samplerContext.imageSmoothingQuality = 'high'
      const [matteRed, matteGreen, matteBlue] = viewUniforms.uMatte.value as number[]
      samplerContext.fillStyle = `rgb(${matteRed * 255}, ${matteGreen * 255}, ${matteBlue * 255})`
      samplerContext.fillRect(0, 0, columns, rows)
      const sourceX = (0.5 - 0.5 * coverX) * imageWidth
      const sourceY = (0.5 - 0.5 * coverY) * imageHeight
      const sourceWidth = ((columns * cell) / canvas.width) * coverX * imageWidth
      const sourceHeight = ((rows * cell) / canvas.height) * coverY * imageHeight
      const x0 = Math.max(sourceX, 0)
      const y0 = Math.max(sourceY, 0)
      const x1 = Math.min(sourceX + sourceWidth, imageWidth)
      const y1 = Math.min(sourceY + sourceHeight, imageHeight)
      if (x1 > x0 && y1 > y0) {
        samplerContext.drawImage(
          image,
          x0, y0, x1 - x0, y1 - y0,
          ((x0 - sourceX) / sourceWidth) * columns,
          ((y0 - sourceY) / sourceHeight) * rows,
          ((x1 - sourceX) / sourceWidth) * columns,
          ((y1 - sourceY) / sourceHeight) * rows
        )
      }
      const grade = (value: number): number => Math.pow(
        Math.min(1, Math.max(0, (value - 0.5) * settings.contrast + 0.5 + settings.brightness)), 1.6
      )
      const pixels = samplerContext.getImageData(0, 0, columns, rows).data
      diffusedTexture.image = diffuse(
        pixels, columns, rows, KERNELS[settings.pattern || 'floyd'], settings.levels,
        settings.palette === 'rgb', grade
      )
      diffusedTexture.width = columns
      diffusedTexture.height = rows
      diffusedTexture.needsUpdate = true
    }

    const renderFrame = (now: number): void => {
      frame = 0
      const settings = settingsRef.current
      if (!settings) return
      const delta = Math.min(0.05, Math.max(0, (now - last) / 1000))
      last = now
      const wanderOn = settings.wander && !reducedMotion
      let targetX = pointer.x
      let targetY = pointer.y
      if (!pointer.inside && wanderOn) {
        drift = Math.min(1, drift + delta / 1.2)
        const [wanderX, wanderY] = wanderAt(now / 1000, width, height)
        const blend = drift * drift * (3 - 2 * drift)
        targetX += (wanderX - targetX) * blend
        targetY += (wanderY - targetY) * blend
      } else {
        drift = 0
      }
      presence += ((pointer.inside || wanderOn ? 1 : 0) - presence) * (1 - Math.exp(-delta / 0.16))
      if (pointer.fresh) {
        brush.x = brush.px = targetX
        brush.y = brush.py = targetY
        pointer.fresh = false
      } else {
        const follow = 1 - Math.exp(-delta / 0.035)
        brush.x += (targetX - brush.x) * follow
        brush.y += (targetY - brush.y) * follow
      }
      const burstData = viewUniforms.uBursts.value as number[]
      burstData.fill(0)
      for (let index = bursts.length - 1; index >= 0; index--) {
        if ((now - bursts[index].start) / 1000 >= BURST_SECONDS) bursts.splice(index, 1)
      }
      bursts.forEach((burst, index) => {
        const progress = Math.max(0, (now - burst.start) / 1000 / BURST_SECONDS)
        const reach = Math.hypot(
          Math.max(burst.x, width - burst.x), Math.max(burst.y, height - burst.y)
        ) + (viewUniforms.uBurstWidth.value as number)
        burstData[index * 4] = burst.x
        burstData[index * 4 + 1] = burst.y
        burstData[index * 4 + 2] = reach * Math.sin((progress * Math.PI) / 2)
        burstData[index * 4 + 3] = 1 - progress * progress * progress
      })
      if (presence > 0.002) trailUntil = now + settings.linger * 1000 + 150
      const minFade = floatMask ? 0 : 1.5 / 255
      const fade = settings.linger > 0 ? delta / settings.linger : 1
      maskUniforms.tPrev.value = masks[0].texture
      maskUniforms.uFrom.value = [brush.px, brush.py]
      maskUniforms.uTo.value = [brush.x, brush.y]
      maskUniforms.uRadius.value = settings.revealRadius * (0.45 + 0.55 * presence)
      maskUniforms.uSoftness.value = settings.softness
      maskUniforms.uStrength.value = presence
      maskUniforms.uFade.value = Math.max(fade, minFade)
      viewUniforms.uBurstWidth.value = Math.max(60, settings.revealRadius * 0.9)
      renderer.render({ scene: maskMesh, target: masks[1] })
      masks.reverse()
      brush.px = brush.x
      brush.py = brush.y

      const cell = Math.max(1, Math.round(settings.pixelSize * renderer.dpr))
      if (image) {
        viewUniforms.uCover.value = fitScale(
          canvas.width, canvas.height, image.naturalWidth, image.naturalHeight, settings.fit === 'contain'
        )
      }
      let patternIndex = ORDERED[settings.pattern || 'floyd'] ?? 0
      if (KERNELS[settings.pattern || 'floyd']) {
        patternIndex = 0
        if (image && !diffusionBlocked) {
          try {
            updateDiffusion(cell, settings)
            patternIndex = 3
          } catch {
            diffusionBlocked = true
          }
        }
      }
      if (patternIndex === 1 && noiseTexture.width !== 64) {
        noiseTexture.image = getBlueNoise()
        noiseTexture.width = 64
        noiseTexture.height = 64
        noiseTexture.needsUpdate = true
      }
      const texelsPerPixel = image
        ? ((viewUniforms.uCover.value as number[])[0] * image.naturalWidth) / canvas.width
        : 1
      viewUniforms.tMask.value = masks[0].texture
      viewUniforms.uCell.value = cell
      viewUniforms.uLod.value = Math.log2(Math.max(cell * texelsPerPixel, 1))
      viewUniforms.uPattern.value = patternIndex
      viewUniforms.uPalette.value = settings.palette === 'rgb' ? 1 : 0
      viewUniforms.uLevels.value = Math.max(2, Math.round(settings.levels))
      viewUniforms.uInk.value = hexToRgb(settings.inkColor)
      viewUniforms.uPaper.value = hexToRgb(settings.paperColor)
      viewUniforms.uRimColor.value = hexToRgb(settings.rimColor)
      viewUniforms.uRim.value = Math.min(Math.max(settings.rim, 0), 0.95)
      viewUniforms.uContrast.value = settings.contrast
      viewUniforms.uBrightness.value = settings.brightness
      viewUniforms.uReverse.value = settings.reverse ? 1 : 0
      const intro = image ? Math.min(1, (now - introStart) / INTRO_MS) : 0
      viewUniforms.uIntro.value = 1 - Math.pow(1 - intro, 2)
      renderer.render({ scene: viewMesh })
      if (!image) {
        gl.clearColor(0.957, 0.945, 0.918, 1)
        gl.clear(gl.COLOR_BUFFER_BIT)
      }
      const busy = pointer.inside || wanderOn || presence > 0.002 || bursts.length > 0 || now < trailUntil || (!!image && intro < 1)
      if (busy && visible) frame = requestAnimationFrame(renderFrame)
    }

    const wake = (): void => {
      if (frame || !visible) return
      last = performance.now()
      frame = requestAnimationFrame(renderFrame)
    }
    wakeRef.current = wake

    const img = new Image()
    img.crossOrigin = 'anonymous'
    img.decoding = 'async'
    img.onload = (): void => {
      image = img
      imageTexture.image = img
      try {
        if (samplerContext) {
          const edge = measureEdge(samplerContext, img)
          viewUniforms.uMatte.value = edge.matte
          viewUniforms.uKey.value = edge.plain ? 1 : 0
        }
      } catch {
        /* leave neutral matte values */
      }
      introStart = performance.now()
      wake()
    }
    img.src = src

    const locate = (event: PointerEvent): void => {
      const rect = container.getBoundingClientRect()
      pointer.x = event.clientX - rect.left
      pointer.y = event.clientY - rect.top
      pointer.placed = true
    }
    const onMove = (event: PointerEvent): void => {
      locate(event)
      if (!pointer.inside) {
        pointer.inside = true
        pointer.fresh = true
      }
      wake()
    }
    const onLeave = (): void => {
      pointer.inside = false
      wake()
    }
    const onDown = (event: PointerEvent): void => {
      onMove(event)
      if (!settingsRef.current?.clickBurst || (event.pointerType === 'mouse' && event.button !== 0)) return
      bursts.push({ x: pointer.x, y: pointer.y, start: performance.now() })
      if (bursts.length > MAX_BURSTS) bursts.shift()
    }
    container.addEventListener('pointermove', onMove, { passive: true })
    container.addEventListener('pointerenter', onMove, { passive: true })
    container.addEventListener('pointerdown', onDown, { passive: true })
    container.addEventListener('pointerleave', onLeave, { passive: true })
    container.addEventListener('pointercancel', onLeave, { passive: true })
    const resizeObserver = new ResizeObserver(() => {
      layout()
      wake()
    })
    resizeObserver.observe(container)
    const intersectionObserver = new IntersectionObserver(([entry]) => {
      visible = entry.isIntersecting
      wake()
    })
    intersectionObserver.observe(container)
    layout()
    wake()

    return () => {
      cancelAnimationFrame(frame)
      wakeRef.current = () => {}
      resizeObserver.disconnect()
      intersectionObserver.disconnect()
      img.onload = null
      container.removeEventListener('pointermove', onMove)
      container.removeEventListener('pointerenter', onMove)
      container.removeEventListener('pointerdown', onDown)
      container.removeEventListener('pointerleave', onLeave)
      container.removeEventListener('pointercancel', onLeave)
      gl.getExtension('WEBGL_lose_context')?.loseContext()
      if (canvas.parentNode) canvas.parentNode.removeChild(canvas)
    }
  }, [src])

  return <div ref={containerRef} className={`dither-veil ${className}`.trim()} />
}
