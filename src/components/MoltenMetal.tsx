import { useEffect, useRef } from 'react'
import { Renderer, Program, Mesh, Triangle } from 'ogl'
import './MoltenMetal.css'

const hexToRgb = (hex: string): [number, number, number] => {
  const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex)
  if (!result) return [1, 1, 1]
  return [
    Number.parseInt(result[1], 16) / 255,
    Number.parseInt(result[2], 16) / 255,
    Number.parseInt(result[3], 16) / 255
  ]
}

const colorModeToFloat = (mode: MoltenMetalProps['colorMode']): number =>
  mode === 'ember' ? 1 : mode === 'frost' ? 2 : 0

const vertex = `#version 300 es
in vec2 position;
void main() {
  gl_Position = vec4(position, 0.0, 1.0);
}
`

const fragment = `#version 300 es
precision highp float;
uniform vec2 iResolution;
uniform float iTime;
uniform float uSpeed;
uniform float uScale;
uniform float uDetail;
uniform float uGlow;
uniform float uCoreSize;
uniform float uSwirl;
uniform float uFold;
uniform float uBlackPoint;
uniform float uBrightness;
uniform float uColorMode;
uniform float uGrain;
uniform float uGrainIntensity;
uniform float uOpacity;
uniform vec2 uMouse;
uniform float uMouseStrength;
uniform bool uEnableMouse;
uniform vec3 uColor1;
uniform vec3 uColor2;
uniform vec3 uColor3;
uniform vec3 uBackgroundColor;
uniform bool uLightMode;
out vec4 fragColor;

float hash(vec2 p) {
  return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453);
}

void main() {
  float time = iTime * uSpeed;
  vec2 p = uScale * ((gl_FragCoord.xy - 0.5 * iResolution.xy) / iResolution.y) - 0.5;

  vec2 drift = vec2(0.0);
  if (uEnableMouse) {
    drift = (uMouse - 0.5) * uMouseStrength * 2.0;
  }
  p += drift;

  vec2 i = p;
  float c = 0.0;
  float r = length(p + vec2(sin(time), sin(time * 0.3 + 5.0)) * 0.5);
  float d = length(p);
  float rot = d + time + p.x * uSwirl;

  float cosRot = cos(rot);
  mat2 warp = mat2(cos(rot - sin(time / 5.0)), sin(rot), -sin(cosRot - time), cosRot) * uFold;
  float glowCore = uGlow * uCoreSize;

  for (float n = 0.0; n < 8.0; n++) {
    if (n >= uDetail) break;
    p *= warp;
    float t = r - time / (n + 3.0);
    i -= p + vec2(cos(t - i.x - r) + sin(t + i.y), sin(t - i.y) + cos(t + i.x) + r);
    c += glowCore / length(vec2(sin(i.x + t), cos(i.y + t)));
  }

  c /= 6.0;

  float intensity = max(c - uBlackPoint, 0.0) * uBrightness;
  float g = clamp(intensity, 0.0, 1.0);

  float mid = 0.5;
  if (uColorMode > 1.5) {
    mid = 0.65;
  } else if (uColorMode > 0.5) {
    mid = 0.35;
  }

  vec3 col = mix(uColor1, uColor2, smoothstep(0.0, mid, g));
  col = mix(col, uColor3, smoothstep(mid, 1.0, g));

  float a = g;
  if (uGrain > 0.5) {
    float gr = hash(gl_FragCoord.xy + iTime);
    a += (gr - 0.5) * uGrainIntensity;
  }
  a = clamp(a, 0.0, 1.0) * uOpacity;

  if (uLightMode) {
    float signal = 1.0 - exp(-max(c, 0.0) * 6.5);
    float body = smoothstep(0.075, 0.68, signal);
    float ridge = smoothstep(0.42, 0.92, signal);

    vec3 lightCol = mix(uColor1, uColor2, smoothstep(0.08, 0.52, signal));
    lightCol = mix(lightCol, uColor3, smoothstep(0.52, 0.96, signal));
    lightCol = mix(lightCol, lightCol * 0.72, ridge * 0.24);

    float coverage = body * mix(0.2, 0.86, signal) * uOpacity;
    if (uGrain > 0.5) {
      float gr = hash(gl_FragCoord.xy + iTime);
      coverage += (gr - 0.5) * uGrainIntensity * body * 0.16;
    }
    fragColor = vec4(mix(uBackgroundColor, lightCol, clamp(coverage, 0.0, 0.92)), 1.0);
  } else {
    fragColor = vec4(col * a, a);
  }
}
`

interface MoltenMetalProps {
  color1?: string
  color2?: string
  color3?: string
  speed?: number
  scale?: number
  detail?: number
  glow?: number
  coreSize?: number
  swirl?: number
  fold?: number
  blackPoint?: number
  brightness?: number
  colorMode?: 'molten' | 'ember' | 'frost'
  grain?: boolean
  grainIntensity?: number
  mouseInteraction?: boolean
  mouseStrength?: number
  opacity?: number
  backgroundColor?: string
  lightMode?: boolean
  className?: string
}

interface MoltenMetalContext {
  renderer: Renderer
  program: Program
  mesh: Mesh
}

const contextMap = new WeakMap<HTMLElement, MoltenMetalContext>()

export default function MoltenMetal({
  color1 = '#5227FF',
  color2 = '#FF9FFC',
  color3 = '#FFFFFF',
  speed = 0.35,
  scale = 4,
  detail = 3,
  glow = 1.6,
  coreSize = 0.1,
  swirl = 1,
  fold = -0.2,
  blackPoint = 0.05,
  brightness = 1.3,
  colorMode = 'molten',
  grain = true,
  grainIntensity = 0.05,
  mouseInteraction = true,
  mouseStrength = 0.3,
  opacity = 1,
  backgroundColor = '#FFFFFF',
  lightMode = false,
  className = ''
}: MoltenMetalProps): JSX.Element {
  const containerRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    const renderer = new Renderer({
      webgl: 2,
      alpha: true,
      premultipliedAlpha: true,
      antialias: false,
      dpr: Math.min(window.devicePixelRatio || 1, 2)
    })

    const gl = renderer.gl
    gl.clearColor(0, 0, 0, 0)
    const canvas = gl.canvas as HTMLCanvasElement
    canvas.style.width = '100%'
    canvas.style.height = '100%'
    canvas.style.display = 'block'
    container.appendChild(canvas)

    const geometry = new Triangle(gl)
    const program = new Program(gl, {
      vertex,
      fragment,
      uniforms: {
        iTime: { value: 0 },
        iResolution: { value: new Float32Array([1, 1]) },
        uSpeed: { value: speed },
        uScale: { value: scale },
        uDetail: { value: detail },
        uGlow: { value: glow },
        uCoreSize: { value: Math.max(coreSize, 0.001) },
        uSwirl: { value: swirl },
        uFold: { value: fold },
        uBlackPoint: { value: blackPoint },
        uBrightness: { value: brightness },
        uColorMode: { value: colorModeToFloat(colorMode) },
        uGrain: { value: grain ? 1 : 0 },
        uGrainIntensity: { value: grainIntensity },
        uOpacity: { value: opacity },
        uMouse: { value: new Float32Array([0.5, 0.5]) },
        uMouseStrength: { value: mouseStrength },
        uEnableMouse: { value: mouseInteraction },
        uColor1: { value: new Float32Array(hexToRgb(color1)) },
        uColor2: { value: new Float32Array(hexToRgb(color2)) },
        uColor3: { value: new Float32Array(hexToRgb(color3)) },
        uBackgroundColor: { value: new Float32Array(hexToRgb(backgroundColor)) },
        uLightMode: { value: lightMode }
      }
    })

    const mesh = new Mesh(gl, { geometry, program })
    contextMap.set(container, { renderer, program, mesh })

    const setSize = (): void => {
      const rect = container.getBoundingClientRect()
      const width = Math.max(1, Math.floor(rect.width))
      const height = Math.max(1, Math.floor(rect.height))
      renderer.setSize(width, height)
      const resolution = program.uniforms.iResolution.value as Float32Array
      resolution[0] = gl.drawingBufferWidth
      resolution[1] = gl.drawingBufferHeight
      renderer.render({ scene: mesh })
    }

    const resizeObserver = new ResizeObserver(() => {
      const rect = container.getBoundingClientRect()
      visible = rect.width > 0 && rect.height > 0
      setSize()
    })
    resizeObserver.observe(container)
    setSize()

    const targetMouse: [number, number] = [0.5, 0.5]
    const currentMouse: [number, number] = [0.5, 0.5]

    const handleMouseMove = (event: MouseEvent): void => {
      const rect = canvas.getBoundingClientRect()
      targetMouse[0] = (event.clientX - rect.left) / Math.max(1, rect.width)
      targetMouse[1] = 1 - (event.clientY - rect.top) / Math.max(1, rect.height)
    }
    const handleMouseLeave = (): void => {
      targetMouse[0] = 0.5
      targetMouse[1] = 0.5
    }
    canvas.addEventListener('mousemove', handleMouseMove)
    canvas.addEventListener('mouseleave', handleMouseLeave)

    let frameId = 0
    let visible = true
    let pageVisible = !document.hidden
    const startedAt = performance.now()

    const render = (time: number): void => {
      const uniforms = program.uniforms
      uniforms.iTime.value = (time - startedAt) * 0.001
      currentMouse[0] += 0.05 * (targetMouse[0] - currentMouse[0])
      currentMouse[1] += 0.05 * (targetMouse[1] - currentMouse[1])
      const mouse = uniforms.uMouse.value as Float32Array
      mouse[0] = currentMouse[0]
      mouse[1] = currentMouse[1]
      renderer.render({ scene: mesh })
      frameId = window.requestAnimationFrame(render)
    }
    const tryStart = (): void => {
      if (visible && pageVisible && frameId === 0) frameId = window.requestAnimationFrame(render)
    }
    const tryStop = (): void => {
      if (frameId !== 0) {
        window.cancelAnimationFrame(frameId)
        frameId = 0
      }
    }

    const intersectionObserver = new IntersectionObserver(([entry]) => {
      visible = entry.isIntersecting
      if (visible) tryStart()
      else tryStop()
    }, { threshold: 0 })
    intersectionObserver.observe(container)
    const rect = container.getBoundingClientRect()
    if (rect.width > 0 && rect.height > 0) {
      visible = true
      tryStart()
    }

    const handleVisibility = (): void => {
      pageVisible = !document.hidden
      if (pageVisible) tryStart()
      else tryStop()
    }
    document.addEventListener('visibilitychange', handleVisibility)
    tryStart()

    return () => {
      tryStop()
      resizeObserver.disconnect()
      intersectionObserver.disconnect()
      document.removeEventListener('visibilitychange', handleVisibility)
      canvas.removeEventListener('mousemove', handleMouseMove)
      canvas.removeEventListener('mouseleave', handleMouseLeave)
      contextMap.delete(container)
      if (canvas.parentNode === container) container.removeChild(canvas)
      gl.getExtension('WEBGL_lose_context')?.loseContext()
    }
  }, [])

  useEffect(() => {
    const context = contextMap.get(containerRef.current as HTMLElement)
    if (!context) return

    const uniforms = context.program.uniforms
    uniforms.uSpeed.value = speed
    uniforms.uScale.value = scale
    uniforms.uDetail.value = detail
    uniforms.uGlow.value = glow
    uniforms.uCoreSize.value = Math.max(coreSize, 0.001)
    uniforms.uSwirl.value = swirl
    uniforms.uFold.value = fold
    uniforms.uBlackPoint.value = blackPoint
    uniforms.uBrightness.value = brightness
    uniforms.uColorMode.value = colorModeToFloat(colorMode)
    uniforms.uGrain.value = grain ? 1 : 0
    uniforms.uGrainIntensity.value = grainIntensity
    uniforms.uOpacity.value = opacity
    uniforms.uMouseStrength.value = mouseStrength
    uniforms.uEnableMouse.value = mouseInteraction
    uniforms.uLightMode.value = lightMode

    const color1Value = uniforms.uColor1.value as Float32Array
    const color2Value = uniforms.uColor2.value as Float32Array
    const color3Value = uniforms.uColor3.value as Float32Array
    const backgroundValue = uniforms.uBackgroundColor.value as Float32Array
    color1Value.set(hexToRgb(color1))
    color2Value.set(hexToRgb(color2))
    color3Value.set(hexToRgb(color3))
    backgroundValue.set(hexToRgb(backgroundColor))
  }, [
    backgroundColor,
    blackPoint,
    brightness,
    color1,
    color2,
    color3,
    colorMode,
    coreSize,
    detail,
    fold,
    glow,
    grain,
    grainIntensity,
    lightMode,
    mouseInteraction,
    mouseStrength,
    opacity,
    scale,
    speed,
    swirl
  ])

  return <div ref={containerRef} className={`molten-metal-container ${className}`.trim()} />
}
