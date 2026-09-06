import { useEffect, useRef } from 'react'
import { Renderer, Camera, Transform, Program, Mesh, Sphere, Vec3 } from 'ogl'

export interface BallpitProps {
  count?: number
  gravity?: number
  friction?: number
  wallBounce?: number
  followCursor?: boolean
  opacity?: number
}

interface BallState {
  x: number
  y: number
  z: number
  vx: number
  vy: number
  vz: number
  r: number
  colorIdx: number
}

const PALETTE = ['#5227FF', '#FF9FFC', '#C4B5FD', '#F0ABFC', '#A5B4FC']

export default function Ballpit({
  count = 200,
  gravity = 0.7,
  friction = 0.8,
  wallBounce = 0.95,
  followCursor = true,
  opacity = 0.35
}: BallpitProps): JSX.Element {
  const containerRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    const renderer = new Renderer({
      webgl: 2,
      alpha: true,
      premultipliedAlpha: true,
      antialias: true,
      dpr: Math.min(window.devicePixelRatio || 1, 2)
    })
    const gl = renderer.gl
    gl.clearColor(0, 0, 0, 0)
    const canvas = gl.canvas as HTMLCanvasElement
    canvas.style.width = '100%'
    canvas.style.height = '100%'
    canvas.style.display = 'block'
    container.appendChild(canvas)

    const camera = new Camera(gl, { fov: 35 })
    camera.position.set(0, 0, 12)
    const scene = new Transform()

    const vertex = /* glsl */ `
      attribute vec3 position;
      attribute vec3 normal;
      uniform mat4 modelViewMatrix;
      uniform mat4 projectionMatrix;
      uniform mat3 normalMatrix;
      varying vec3 vNormal;
      varying vec3 vPos;
      void main() {
        vNormal = normalize(normalMatrix * normal);
        vPos = position;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `

    const fragment = /* glsl */ `
      precision highp float;
      uniform vec3 uColor;
      uniform float uOpacity;
      varying vec3 vNormal;
      varying vec3 vPos;
      void main() {
        // Simple lambert lighting from top-left
        vec3 light = normalize(vec3(-0.4, 0.8, 0.5));
        float diffuse = max(dot(normalize(vNormal), light), 0.0);
        float ambient = 0.4;
        float alpha = uOpacity * (0.65 + diffuse * 0.35);
        vec3 col = uColor * (ambient + diffuse * 0.8);
        gl_FragColor = vec4(col, alpha);
      }
    `

    const geometry = new Sphere(gl, { radius: 1, widthSegments: 16, heightSegments: 12 })
    const programs = PALETTE.map(
      (hex) =>
        new Program(gl, {
          vertex,
          fragment,
          transparent: true,
          depthWrite: false,
          uniforms: {
            uColor: { value: new Vec3(...hexToRgb(hex)) },
            uOpacity: { value: opacity }
          }
        })
    )

    const worldSize = 7
    const balls: BallState[] = []
    const meshes: Mesh[] = []
    const paletteCount = PALETTE.length

    for (let i = 0; i < count; i++) {
      const r = 0.08 + Math.random() * 0.12
      const colorIdx = Math.floor(Math.random() * paletteCount)
      const mesh = new Mesh(gl, { geometry, program: programs[colorIdx] })
      mesh.scale.set(r, r, r)
      scene.addChild(mesh)
      meshes.push(mesh)
      balls.push({
        x: (Math.random() - 0.5) * worldSize,
        y: (Math.random() - 0.5) * worldSize * 0.6,
        z: (Math.random() - 0.5) * worldSize * 0.4,
        vx: (Math.random() - 0.5) * 0.02,
        vy: (Math.random() - 0.5) * 0.02,
        vz: (Math.random() - 0.5) * 0.01,
        r,
        colorIdx
      })
    }

    // Mouse tracking
    const targetMouse = { x: 0, y: 0 }
    const currentMouse = { x: 0, y: 0 }
    let mouseInside = false

    const handlePointerMove = (event: PointerEvent): void => {
      const rect = canvas.getBoundingClientRect()
      const nx = ((event.clientX - rect.left) / Math.max(1, rect.width)) * 2 - 1
      const ny = -(((event.clientY - rect.top) / Math.max(1, rect.height)) * 2 - 1)
      targetMouse.x = nx * (worldSize * 0.5)
      targetMouse.y = ny * (worldSize * 0.35)
      mouseInside = true
    }
    const handlePointerLeave = (): void => {
      mouseInside = false
    }
    window.addEventListener('pointermove', handlePointerMove)
    window.addEventListener('pointerleave', handlePointerLeave)

    const halfW = worldSize * 0.5
    const halfH = worldSize * 0.35
    const halfD = worldSize * 0.2

    const setSize = (): void => {
      const rect = container.getBoundingClientRect()
      const width = Math.max(1, Math.floor(rect.width))
      const height = Math.max(1, Math.floor(rect.height))
      renderer.setSize(width, height)
      camera.perspective({ aspect: width / height })
    }
    const resizeObserver = new ResizeObserver(setSize)
    resizeObserver.observe(container)
    setSize()

    let frameId = 0
    let visible = true
    let pageVisible = !document.hidden
    let time = 0

    const render = (): void => {
      time += 0.016

      // Smooth mouse
      currentMouse.x += (targetMouse.x - currentMouse.x) * 0.08
      currentMouse.y += (targetMouse.y - currentMouse.y) * 0.08

      const dt = 0.016
      for (let i = 0; i < balls.length; i++) {
        const b = balls[i]

        // Gravity
        b.vy -= gravity * dt

        // Mouse repulsion
        if (followCursor && mouseInside) {
          const dx = b.x - currentMouse.x
          const dy = b.y - currentMouse.y
          const dist = Math.sqrt(dx * dx + dy * dy)
          if (dist < 2.0 && dist > 0.01) {
            const force = (1 - dist / 2.0) * 0.08
            b.vx += (dx / dist) * force
            b.vy += (dy / dist) * force
          }
        }

        // Slight drift for liveliness
        b.vx += Math.sin(time * 0.5 + i * 0.1) * 0.001
        b.vz += Math.cos(time * 0.3 + i * 0.07) * 0.0005

        // Friction
        const fr = Math.pow(friction, dt * 60)
        b.vx *= fr
        b.vy *= fr
        b.vz *= fr

        // Integrate
        b.x += b.vx
        b.y += b.vy
        b.z += b.vz

        // Wall bounce
        if (b.x - b.r < -halfW) { b.x = -halfW + b.r; b.vx = Math.abs(b.vx) * wallBounce }
        if (b.x + b.r > halfW) { b.x = halfW - b.r; b.vx = -Math.abs(b.vx) * wallBounce }
        if (b.y - b.r < -halfH) { b.y = -halfH + b.r; b.vy = Math.abs(b.vy) * wallBounce }
        if (b.y + b.r > halfH) { b.y = halfH - b.r; b.vy = -Math.abs(b.vy) * wallBounce }
        if (b.z - b.r < -halfD) { b.z = -halfD + b.r; b.vz = Math.abs(b.vz) * wallBounce }
        if (b.z + b.r > halfD) { b.z = halfD - b.r; b.vz = -Math.abs(b.vz) * wallBounce }

        meshes[i].position.set(b.x, b.y, b.z)
      }

      renderer.render({ scene, camera })
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
      window.removeEventListener('pointermove', handlePointerMove)
      window.removeEventListener('pointerleave', handlePointerLeave)
      if (canvas.parentNode === container) container.removeChild(canvas)
      gl.getExtension('WEBGL_lose_context')?.loseContext()
    }
  }, [count, gravity, friction, wallBounce, followCursor, opacity])

  return <div ref={containerRef} className="pointer-events-none h-full w-full" aria-hidden="true" />
}

function hexToRgb(hex: string): [number, number, number] {
  const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex)
  if (!result) return [1, 1, 1]
  return [
    Number.parseInt(result[1], 16) / 255,
    Number.parseInt(result[2], 16) / 255,
    Number.parseInt(result[3], 16) / 255
  ]
}