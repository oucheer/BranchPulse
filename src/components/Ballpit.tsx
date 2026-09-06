import { useEffect, useRef } from 'react'
import {
  ACESFilmicToneMapping,
  AmbientLight,
  Color,
  MathUtils,
  MeshPhysicalMaterial,
  Object3D,
  PerspectiveCamera,
  Plane,
  PointLight,
  Raycaster,
  Scene,
  ShaderChunk,
  SphereGeometry,
  SRGBColorSpace,
  InstancedMesh,
  Timer,
  Vector2,
  Vector3,
  WebGLRenderer,
  PMREMGenerator
} from 'three'
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js'

export interface BallpitProps {
  count?: number
  colors?: number[]
  ambientColor?: number
  ambientIntensity?: number
  lightIntensity?: number
  materialParams?: {
    metalness?: number
    roughness?: number
    clearcoat?: number
    clearcoatRoughness?: number
  }
  minSize?: number
  maxSize?: number
  size0?: number
  gravity?: number
  friction?: number
  wallBounce?: number
  maxVelocity?: number
  maxX?: number
  maxY?: number
  maxZ?: number
  followCursor?: boolean
}

interface BallpitConfig {
  count: number
  colors: number[]
  ambientColor: number
  ambientIntensity: number
  lightIntensity: number
  materialParams: {
    metalness: number
    roughness: number
    clearcoat: number
    clearcoatRoughness: number
  }
  minSize: number
  maxSize: number
  size0: number
  gravity: number
  friction: number
  wallBounce: number
  maxVelocity: number
  maxX: number
  maxY: number
  maxZ: number
  controlSphere0: boolean
  followCursor: boolean
}

const DEFAULTS: BallpitConfig = {
  count: 200,
  colors: [0, 0, 0],
  ambientColor: 16777215,
  ambientIntensity: 1,
  lightIntensity: 200,
  materialParams: {
    metalness: 0.5,
    roughness: 0.5,
    clearcoat: 1,
    clearcoatRoughness: 0.15
  },
  minSize: 0.5,
  maxSize: 1,
  size0: 1,
  gravity: 0.5,
  friction: 0.9975,
  wallBounce: 0.95,
  maxVelocity: 0.15,
  maxX: 5,
  maxY: 5,
  maxZ: 2,
  controlSphere0: false,
  followCursor: true
}

// ─── Physics ────────────────────────────────────────────────────────────────

class Physics {
  config: BallpitConfig
  positionData: Float32Array
  velocityData: Float32Array
  sizeData: Float32Array
  center = new Vector3()

  constructor(config: BallpitConfig) {
    this.config = config
    this.positionData = new Float32Array(3 * config.count).fill(0)
    this.velocityData = new Float32Array(3 * config.count).fill(0)
    this.sizeData = new Float32Array(config.count).fill(1)
    this.init()
    this.setSizes()
  }

  private init(): void {
    const { config, positionData } = this
    this.center.toArray(positionData, 0)
    for (let i = 1; i < config.count; i++) {
      const s = 3 * i
      positionData[s] = MathUtils.randFloatSpread(2 * config.maxX)
      positionData[s + 1] = MathUtils.randFloatSpread(2 * config.maxY)
      positionData[s + 2] = MathUtils.randFloatSpread(2 * config.maxZ)
    }
  }

  setSizes(): void {
    const { config, sizeData } = this
    sizeData[0] = config.size0
    for (let i = 1; i < config.count; i++) {
      sizeData[i] = MathUtils.randFloat(config.minSize, config.maxSize)
    }
  }

  update(delta: number): void {
    const { config, center, positionData, sizeData, velocityData } = this
    const F = new Vector3()
    const I = new Vector3()
    const B = new Vector3()
    const O = new Vector3()
    const N = new Vector3()
    const D = new Vector3()
    const J = new Vector3()
    const H = new Vector3()
    const T = new Vector3()

    let start = 0
    if (config.controlSphere0) {
      start = 1
      F.fromArray(positionData, 0)
      F.lerp(center, 0.1).toArray(positionData, 0)
      new Vector3(0, 0, 0).toArray(velocityData, 0)
    }
    for (let idx = start; idx < config.count; idx++) {
      const base = 3 * idx
      I.fromArray(positionData, base)
      B.fromArray(velocityData, base)
      B.y -= delta * config.gravity * sizeData[idx]
      B.multiplyScalar(config.friction)
      B.clampLength(0, config.maxVelocity)
      I.add(B)
      I.toArray(positionData, base)
      B.toArray(velocityData, base)
    }
    for (let idx = start; idx < config.count; idx++) {
      const base = 3 * idx
      I.fromArray(positionData, base)
      B.fromArray(velocityData, base)
      const radius = sizeData[idx]
      for (let jdx = idx + 1; jdx < config.count; jdx++) {
        const otherBase = 3 * jdx
        O.fromArray(positionData, otherBase)
        N.fromArray(velocityData, otherBase)
        const otherRadius = sizeData[jdx]
        D.copy(O).sub(I)
        const dist = D.length()
        const sumRadius = radius + otherRadius
        if (dist < sumRadius) {
          const overlap = sumRadius - dist
          J.copy(D).normalize().multiplyScalar(0.5 * overlap)
          H.copy(J).multiplyScalar(Math.max(B.length(), 1))
          T.copy(J).multiplyScalar(Math.max(N.length(), 1))
          I.sub(J)
          B.sub(H)
          I.toArray(positionData, base)
          B.toArray(velocityData, base)
          O.add(J)
          N.add(T)
          O.toArray(positionData, otherBase)
          N.toArray(velocityData, otherBase)
        }
      }
      if (config.controlSphere0) {
        D.copy(F).sub(I)
        const dist = D.length()
        const sumRadius0 = radius + sizeData[0]
        if (dist < sumRadius0) {
          const diff = sumRadius0 - dist
          J.copy(D.normalize()).multiplyScalar(diff)
          H.copy(J).multiplyScalar(Math.max(B.length(), 2))
          I.sub(J)
          B.sub(H)
        }
      }
      if (Math.abs(I.x) + radius > config.maxX) {
        I.x = Math.sign(I.x) * (config.maxX - radius)
        B.x = -B.x * config.wallBounce
      }
      if (config.gravity === 0) {
        if (Math.abs(I.y) + radius > config.maxY) {
          I.y = Math.sign(I.y) * (config.maxY - radius)
          B.y = -B.y * config.wallBounce
        }
      } else if (I.y - radius < -config.maxY) {
        I.y = -config.maxY + radius
        B.y = -B.y * config.wallBounce
      }
      const maxBoundary = Math.max(config.maxZ, config.maxSize)
      if (Math.abs(I.z) + radius > maxBoundary) {
        I.z = Math.sign(I.z) * (maxBoundary - radius)
        B.z = -B.z * config.wallBounce
      }
      I.toArray(positionData, base)
      B.toArray(velocityData, base)
    }
  }
}

// ─── Physical material with sub-surface scattering ─────────────────────────

class BallMaterial extends MeshPhysicalMaterial {
  constructor(params?: Record<string, unknown>) {
    super(params)
    this.uniforms = {
      thicknessDistortion: { value: 0.1 },
      thicknessAmbient: { value: 0 },
      thicknessAttenuation: { value: 0.1 },
      thicknessPower: { value: 2 },
      thicknessScale: { value: 10 }
    }
    this.defines = this.defines ?? {}
    this.defines.USE_UV = ''
    this.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, this.uniforms)
      shader.fragmentShader =
        '\n        uniform float thicknessPower;\n        uniform float thicknessScale;\n        uniform float thicknessDistortion;\n        uniform float thicknessAmbient;\n        uniform float thicknessAttenuation;\n      ' +
        shader.fragmentShader
      shader.fragmentShader = shader.fragmentShader.replace(
        'void main() {',
        '\n        void RE_Direct_Scattering(const in IncidentLight directLight, const in vec2 uv, const in vec3 geometryPosition, const in vec3 geometryNormal, const in vec3 geometryViewDir, const in vec3 geometryClearcoatNormal, inout ReflectedLight reflectedLight) {\n          vec3 scatteringHalf = normalize(directLight.direction + (geometryNormal * thicknessDistortion));\n          float scatteringDot = pow(saturate(dot(geometryViewDir, -scatteringHalf)), thicknessPower) * thicknessScale;\n          #ifdef USE_COLOR\n            vec3 scatteringIllu = (scatteringDot + thicknessAmbient) * vColor;\n          #else\n            vec3 scatteringIllu = (scatteringDot + thicknessAmbient) * diffuse;\n          #endif\n          reflectedLight.directDiffuse += scatteringIllu * thicknessAttenuation * directLight.color;\n        }\n\n        void main() {\n      '
      )
      const replaced = ShaderChunk.lights_fragment_begin.replaceAll(
        'RE_Direct( directLight, geometryPosition, geometryNormal, geometryViewDir, geometryClearcoatNormal, material, reflectedLight );',
        '\n          RE_Direct( directLight, geometryPosition, geometryNormal, geometryViewDir, geometryClearcoatNormal, material, reflectedLight );\n          RE_Direct_Scattering(directLight, vUv, geometryPosition, geometryNormal, geometryViewDir, geometryClearcoatNormal, reflectedLight);\n        '
      )
      shader.fragmentShader = shader.fragmentShader.replace('#include <lights_fragment_begin>', replaced)
    }
  }

  uniforms: Record<string, { value: number }>
}

// ─── Instanced sphere group ─────────────────────────────────────────────────

const tmpObj = new Object3D()

class BallGroup extends InstancedMesh {
  config: BallpitConfig
  physics: Physics
  ambientLight: AmbientLight
  light: PointLight

  constructor(renderer: WebGLRenderer, configOverrides: Partial<BallpitConfig> = {}) {
    const config: BallpitConfig = { ...DEFAULTS, ...configOverrides }
    if (configOverrides.materialParams) {
      config.materialParams = { ...config.materialParams, ...configOverrides.materialParams }
    }
    const env = new RoomEnvironment()
    const envTexture = new PMREMGenerator(renderer).fromScene(env, 0.04).texture
    const geometry = new SphereGeometry()
    const material = new BallMaterial({ envMap: envTexture, ...config.materialParams })
    material.envMapRotation.x = -Math.PI / 2
    super(geometry, material, config.count)
    this.config = config
    this.physics = new Physics(config)
    this.ambientLight = new AmbientLight(config.ambientColor, config.ambientIntensity)
    this.add(this.ambientLight)
    this.light = new PointLight(config.colors[0], config.lightIntensity)
    this.add(this.light)
    this.setColors(config.colors)
  }

  setColors(colors: number[]): void {
    if (!Array.isArray(colors) || colors.length <= 1) return
    const palette = colors.map((c) => new Color(c))
    const getColorAt = (ratio: number, out = new Color()): Color => {
      const scaled = Math.max(0, Math.min(1, ratio)) * (palette.length - 1)
      const idx = Math.floor(scaled)
      if (idx >= palette.length - 1) return palette[palette.length - 1].clone()
      const alpha = scaled - idx
      return out.copy(palette[idx]).lerp(palette[idx + 1], alpha)
    }
    for (let idx = 0; idx < this.count; idx++) {
      this.setColorAt(idx, getColorAt(idx / this.count))
      if (idx === 0) this.light.color.copy(getColorAt(idx / this.count))
    }
    if (this.instanceColor) this.instanceColor.needsUpdate = true
  }

  update(delta: number): void {
    this.physics.update(delta)
    for (let idx = 0; idx < this.count; idx++) {
      tmpObj.position.fromArray(this.physics.positionData, 3 * idx)
      if (idx === 0 && this.config.followCursor === false) {
        tmpObj.scale.setScalar(0)
      } else {
        tmpObj.scale.setScalar(this.physics.sizeData[idx])
      }
      tmpObj.updateMatrix()
      this.setMatrixAt(idx, tmpObj.matrix)
      if (idx === 0) this.light.position.copy(tmpObj.position)
    }
    this.instanceMatrix.needsUpdate = true
  }
}

export default function Ballpit({
  className = '',
  followCursor = true,
  ...props
}: BallpitProps & { className?: string }): JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return

    // ─── Renderer / Scene / Camera ────────────────────────────────────────
    const renderer = new WebGLRenderer({
      canvas,
      antialias: true,
      alpha: true,
      powerPreference: 'high-performance'
    })
    renderer.outputColorSpace = SRGBColorSpace
    renderer.toneMapping = ACESFilmicToneMapping

    const scene = new Scene()
    const camera = new PerspectiveCamera()
    const cameraFov = camera.fov
    camera.position.set(0, 0, 20)
    camera.lookAt(0, 0, 0)
    const cameraMaxAspect = 1.5

    const size = { width: 0, height: 0, wWidth: 0, wHeight: 0, ratio: 0, pixelRatio: 0 }
    let spheres: BallGroup | null = null
    let animationId = 0
    const timer = new Timer()

    const updateWorldSize = (): void => {
      const fov = (camera.fov * Math.PI) / 180
      size.wHeight = 2 * Math.tan(fov / 2) * camera.position.length()
      size.wWidth = size.wHeight * camera.aspect
    }

    const applyCameraAspect = (): void => {
      camera.aspect = size.width / Math.max(1, size.height)
      if (cameraMaxAspect && camera.aspect > cameraMaxAspect) {
        const fov = 2 * Math.atan(Math.tan(MathUtils.degToRad(cameraFov / 2)) / (camera.aspect / cameraMaxAspect))
        camera.fov = 2 * MathUtils.radToDeg(fov)
      } else {
        camera.fov = cameraFov
      }
      camera.updateProjectionMatrix()
      updateWorldSize()
    }

    const resize = (): void => {
      const parent = canvas.parentElement
      const width = parent?.offsetWidth ?? window.innerWidth
      const height = parent?.offsetHeight ?? window.innerHeight
      size.width = width
      size.height = height
      size.ratio = width / height
      applyCameraAspect()
      renderer.setSize(width, height)
      let pr = window.devicePixelRatio
      if (pr > 2) pr = 2
      renderer.setPixelRatio(pr)
      size.pixelRatio = pr
      if (spheres) {
        spheres.config.maxX = size.wWidth / 2
        spheres.config.maxY = size.wHeight / 2
      }
    }

    const createSpheres = (config: Partial<BallpitConfig>): void => {
      if (spheres) {
        scene.remove(spheres)
        spheres.dispose()
      }
      spheres = new BallGroup(renderer, config)
      scene.add(spheres)
      spheres.config.maxX = size.wWidth / 2
      spheres.config.maxY = size.wHeight / 2
    }

    resize()

    // ─── Pointer interaction ──────────────────────────────────────────────
    const mouse = new Vector2()
    const ndc = new Vector2()
    const raycaster = new Raycaster()
    const plane = new Plane(new Vector3(0, 0, 1), 0)
    const hit = new Vector3()
    let pointerInside = false
    let paused = false

    const inBounds = (): boolean => {
      const rect = canvas.getBoundingClientRect()
      return mouse.x >= rect.left && mouse.x <= rect.right && mouse.y >= rect.top && mouse.y <= rect.bottom
    }

    const updatePointer = (): void => {
      const rect = canvas.getBoundingClientRect()
      const px = mouse.x - rect.left
      const py = mouse.y - rect.top
      ndc.x = (px / rect.width) * 2 - 1
      ndc.y = -(py / rect.height) * 2 + 1
    }

    const onPointerMove = (e: PointerEvent): void => {
      mouse.set(e.clientX, e.clientY)
      if (!inBounds()) {
        if (pointerInside) {
          pointerInside = false
          if (spheres) spheres.config.controlSphere0 = false
        }
        return
      }
      pointerInside = true
      updatePointer()
      raycaster.setFromCamera(ndc, camera)
      camera.getWorldDirection(plane.normal)
      raycaster.ray.intersectPlane(plane, hit)
      if (spheres) {
        spheres.physics.center.copy(hit)
        spheres.config.controlSphere0 = true
      }
    }
    const onPointerLeave = (): void => {
      pointerInside = false
      if (spheres) spheres.config.controlSphere0 = false
    }

    document.body.addEventListener('pointermove', onPointerMove)
    document.body.addEventListener('pointerleave', onPointerLeave)
    canvas.style.touchAction = 'none'
    canvas.style.userSelect = 'none'

    // ─── Resize / visibility ──────────────────────────────────────────────
    const parent = canvas.parentElement
    let resizeTimer: number | undefined
    const onDocResize = (): void => {
      if (resizeTimer) window.clearTimeout(resizeTimer)
      resizeTimer = window.setTimeout(resize, 100)
    }
    let resizeObserver: ResizeObserver | null = null
    if (parent) {
      resizeObserver = new ResizeObserver(onDocResize)
      resizeObserver.observe(parent)
    }
    window.addEventListener('resize', onDocResize)

    let inView = true
    const intersectionObserver = new IntersectionObserver(([entry]) => {
      inView = entry.isIntersecting
      if (inView && !document.hidden) start()
      else stop()
    }, { threshold: 0 })
    intersectionObserver.observe(canvas)
    const onVisibility = (): void => {
      if (document.hidden) stop()
      else if (inView) start()
    }
    document.addEventListener('visibilitychange', onVisibility)

    const render = (): void => {
      renderer.render(scene, camera)
    }
    const animate = (): void => {
      animationId = requestAnimationFrame(animate)
      timer.update()
      const delta = timer.getDelta()
      if (spheres && !paused) spheres.update(delta)
      render()
    }
    const start = (): void => {
      if (animationId === 0) animationId = requestAnimationFrame(animate)
    }
    const stop = (): void => {
      if (animationId !== 0) {
        cancelAnimationFrame(animationId)
        animationId = 0
      }
    }

    const overrides: Partial<BallpitConfig> = { ...props, followCursor } as Partial<BallpitConfig>
    if (overrides.materialParams) {
      overrides.materialParams = { ...DEFAULTS.materialParams, ...overrides.materialParams }
    }
    createSpheres(overrides)
    start()

    return () => {
      stop()
      resizeObserver?.disconnect()
      window.removeEventListener('resize', onDocResize)
      intersectionObserver.disconnect()
      document.removeEventListener('visibilitychange', onVisibility)
      document.body.removeEventListener('pointermove', onPointerMove)
      document.body.removeEventListener('pointerleave', onPointerLeave)
      if (spheres) {
        scene.remove(spheres)
        spheres.dispose()
      }
      renderer.dispose()
      renderer.forceContextLoss()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return <canvas className={className} ref={canvasRef} style={{ width: '100%', height: '100%' }} />
}