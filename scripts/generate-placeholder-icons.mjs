/**
 * Generates a placeholder application icon at build/icon.png.
 *
 * electron-builder derives .ico (Windows) and .icns (macOS) from this PNG, so
 * one 512x512 source is enough to bootstrap packaging. Replace build/icon.png
 * with real artwork (1024x1024 recommended) and re-run `npm run icons` is not
 * required -- the build reads the PNG directly.
 *
 * Usage: node scripts/generate-placeholder-icons.mjs
 */
import { deflateSync } from 'node:zlib'
import { writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const SIZE = 512
const SAMPLES = 3 // supersampling factor per axis, for anti-aliasing

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const OUTPUT = join(ROOT, 'build', 'icon.png')

/** Brand gradient endpoints (indigo -> violet). */
const TOP = [0x4f, 0x46, 0xe5]
const BOTTOM = [0xb1, 0x4d, 0xff]

const CRC_TABLE = (() => {
  const table = new Int32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c
  }
  return table
})()

function crc32(buf) {
  let c = -1
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ -1) >>> 0
}

function chunk(type, data) {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length, 0)

  const typeAndData = Buffer.concat([Buffer.from(type, 'ascii'), data])

  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(typeAndData), 0)

  return Buffer.concat([length, typeAndData, crc])
}

/** Signed distance to a rounded square centred at (cx, cy). */
function roundedSquareSdf(x, y, half, radius) {
  const qx = Math.abs(x) - half + radius
  const qy = Math.abs(y) - half + radius
  const outside = Math.hypot(Math.max(qx, 0), Math.max(qy, 0))
  return outside + Math.min(Math.max(qx, qy), 0) - radius
}

/** Coverage of the four-pointed "spark" glyph, sampled by supersampling. */
function sparkCoverage(x, y) {
  // sqrt(|x|/a) + sqrt(|y|/a) === 1 is a concave four-pointed star of half-size a.
  const half = 148
  const value = Math.sqrt(Math.abs(x) / half) + Math.sqrt(Math.abs(y) / half)
  // Anti-alias across a narrow band around the boundary, in normalized units.
  const edge = 1.5 / half
  if (value <= 1 - edge) return 1
  if (value >= 1 + edge) return 0
  return (1 + edge - value) / (2 * edge)
}

function renderPixel(px, py) {
  const cx = SIZE / 2
  const cy = SIZE / 2

  let rSum = 0
  let gSum = 0
  let bSum = 0
  let aSum = 0

  for (let sy = 0; sy < SAMPLES; sy++) {
    for (let sx = 0; sx < SAMPLES; sx++) {
      const x = px + (sx + 0.5) / SAMPLES - cx
      const y = py + (sy + 0.5) / SAMPLES - cy

      const square = roundedSquareSdf(x, y, cx - 8, 112)
      if (square > 0) continue // outside the rounded square -> transparent

      // Vertical gradient background.
      const t = (py + (sy + 0.5) / SAMPLES) / SIZE
      let r = TOP[0] + (BOTTOM[0] - TOP[0]) * t
      let g = TOP[1] + (BOTTOM[1] - TOP[1]) * t
      let b = TOP[2] + (BOTTOM[2] - TOP[2]) * t

      // Blend in the white spark.
      const cov = sparkCoverage(x, y)
      r += (255 - r) * cov
      g += (255 - g) * cov
      b += (255 - b) * cov

      rSum += r
      gSum += g
      bSum += b
      aSum += 255
    }
  }

  const total = SAMPLES * SAMPLES
  const alpha = aSum / total

  if (alpha === 0) return [0, 0, 0, 0]

  const scale = 255 / aSum
  return [Math.round(rSum * scale), Math.round(gSum * scale), Math.round(bSum * scale), Math.round(alpha)]
}

function buildPng() {
  // Raw scanlines: one filter byte (0 = None) per row, then RGBA pixels.
  const raw = Buffer.alloc(SIZE * (1 + SIZE * 4))

  let offset = 0
  for (let y = 0; y < SIZE; y++) {
    raw[offset++] = 0
    for (let x = 0; x < SIZE; x++) {
      const [r, g, b, a] = renderPixel(x, y)
      raw[offset++] = r
      raw[offset++] = g
      raw[offset++] = b
      raw[offset++] = a
    }
  }

  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(SIZE, 0)
  ihdr.writeUInt32BE(SIZE, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // colour type: truecolour with alpha
  ihdr[10] = 0 // deflate
  ihdr[11] = 0 // adaptive filtering
  ihdr[12] = 0 // no interlace

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ])
}

mkdirSync(dirname(OUTPUT), { recursive: true })
writeFileSync(OUTPUT, buildPng())

console.log(`Wrote ${OUTPUT} (${SIZE}x${SIZE})`)
