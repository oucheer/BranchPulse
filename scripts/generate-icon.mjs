import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { PNG } from 'pngjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const outDir = path.join(root, 'build')
fs.mkdirSync(outDir, { recursive: true })

const SIZES = [16, 32, 48, 64, 128, 256]
const pngBuffers = SIZES.map((size) => renderPng(size))
writeIco(path.join(outDir, 'icon.ico'), pngBuffers)
console.log(`Wrote build/icon.ico (${pngBuffers.reduce((s, b) => s + b.length, 0)} bytes)`)

function renderPng(size) {
  const png = new PNG({ width: size, height: size })
  const scale = size / 256
  const radius = 52 * scale
  const bgFrom = [35, 24, 43]
  const bgTo = [13, 15, 24]
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const nx = x / size
      const ny = y / size
      const r = Math.round(bgFrom[0] + (bgTo[0] - bgFrom[0]) * (nx + ny) / 2)
      const g = Math.round(bgFrom[1] + (bgTo[1] - bgFrom[1]) * (nx + ny) / 2)
      const b = Math.round(bgFrom[2] + (bgTo[2] - bgFrom[2]) * (nx + ny) / 2)
      const alpha = roundedRectAlpha(x, y, size, radius)
      const idx = (y * size + x) * 4
      png.data[idx] = r
      png.data[idx + 1] = g
      png.data[idx + 2] = b
      png.data[idx + 3] = Math.round(alpha * 255)
    }
  }

  // Pulse line
  drawPolyline(png, size, [
    [36, 188], [106, 188], [124, 138], [142, 224], [162, 96], [178, 188], [222, 188]
  ], 11 * scale, [255, 122, 24, 255])

  // Trunk
  drawPolyline(png, size, [
    [128, 208], [128, 148], [88, 84]
  ], 13 * scale, [246, 239, 250, 255])
  drawPolyline(png, size, [
    [128, 148], [166, 86]
  ], 13 * scale, [246, 239, 250, 255])

  // Merge node
  fillCircle(png, size, 128, 206, 14 * scale, [246, 239, 250, 255])
  fillCircle(png, size, 128, 206, 7 * scale, [124, 92, 252, 255])

  // Tip nodes
  fillCircle(png, size, 86, 78, 12 * scale, [124, 92, 252, 255])
  fillCircle(png, size, 86, 78, 5 * scale, [246, 239, 250, 255])
  fillCircle(png, size, 170, 80, 12 * scale, [124, 92, 252, 255])
  fillCircle(png, size, 170, 80, 5 * scale, [246, 239, 250, 255])

  return PNG.sync.write(png)
}

function roundedRectAlpha(x, y, size, radius) {
  const inset = 4
  const x0 = inset
  const y0 = inset
  const x1 = size - inset
  const y1 = size - inset
  if (x < x0 || y < y0 || x >= x1 || y >= y1) return 0
  const cx = Math.max(x0 + radius, Math.min(x1 - radius, x))
  const cy = Math.max(y0 + radius, Math.min(y1 - radius, y))
  const dx = x - cx
  const dy = y - cy
  const dist = Math.sqrt(dx * dx + dy * dy)
  if (dist <= radius) return 1
  const edge = Math.max(0, dist - radius)
  return Math.max(0, 1 - edge * 1.5)
}

function drawPolyline(png, size, points, width, color) {
  for (let i = 1; i < points.length; i += 1) {
    const [x1, y1] = points[i - 1]
    const [x2, y2] = points[i]
    const length = Math.max(1, Math.hypot(x2 - x1, y2 - y1))
    for (let d = 0; d <= length; d += 0.5) {
      const t = d / length
      fillCircle(png, size, x1 + (x2 - x1) * t, y1 + (y2 - y1) * t, width / 2, color)
    }
  }
}

function fillCircle(png, size, cx, cy, radius, color) {
  const minX = Math.max(0, Math.floor(cx - radius))
  const maxX = Math.min(size - 1, Math.ceil(cx + radius))
  const minY = Math.max(0, Math.floor(cy - radius))
  const maxY = Math.min(size - 1, Math.ceil(cy + radius))
  for (let y = minY; y <= maxY; y += 1) {
    for (let x = minX; x <= maxX; x += 1) {
      const d = Math.hypot(x - cx, y - cy)
      if (d <= radius) {
        const idx = (y * size + x) * 4
        png.data[idx] = color[0]
        png.data[idx + 1] = color[1]
        png.data[idx + 2] = color[2]
        png.data[idx + 3] = color[3]
      }
    }
  }
}

function writeIco(file, buffers) {
  const header = Buffer.alloc(6)
  header.writeUInt16LE(0, 0)
  header.writeUInt16LE(1, 2)
  header.writeUInt16LE(buffers.length, 4)
  const dirSize = buffers.length * 16
  const body = Buffer.concat(buffers)
  const out = Buffer.alloc(header.length + dirSize + body.length)
  header.copy(out, 0)
  let offset = header.length + dirSize
  buffers.forEach((buf, index) => {
    const size = 256 / Math.pow(2, Math.floor(Math.log2(256 / bufWidth(buf))))
    const entry = Buffer.alloc(16)
    entry[0] = size === 256 ? 0 : size
    entry[1] = size === 256 ? 0 : size
    entry[2] = 0
    entry[3] = 0
    entry.writeUInt16LE(1, 4)
    entry.writeUInt16LE(32, 6)
    entry.writeUInt32LE(buf.length, 8)
    entry.writeUInt32LE(offset, 12)
    entry.copy(out, header.length + index * 16)
    buf.copy(out, offset)
    offset += buf.length
  })
  fs.writeFileSync(file, out)
}

function bufWidth(buf) {
  // PNG width is stored big-endian at byte offset 16
  return buf.readUInt32BE(16)
}
