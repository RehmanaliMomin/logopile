import type { Company } from '../types'

/**
 * Logo loading with a fallback chain: Brandfetch CDN → Google favicon →
 * generated monogram. Nothing ever renders as a broken image.
 */
export interface LogoAsset {
  image: HTMLImageElement | null
  monogram: { text: string; hue: number }
  state: 'loading' | 'ready' | 'monogram'
}

const cache = new Map<string, LogoAsset>()

/**
 * Pre-rendered tile sprite: rounded plate + drop shadow + logo, drawn once and
 * then blitted every frame.
 *
 * Re-drawing 420 rounded rects with `shadowBlur` per frame is what actually
 * costs — it doesn't show up in a JS timer because the expense is rasterisation,
 * but it took the pile from 60fps to 26. Baking the shadow into a sprite makes
 * it free.
 */
const SPRITE_PX = 128
/** Fraction of the sprite reserved around the plate for the baked shadow. */
export const SPRITE_PAD = 0.14

const sprites = new Map<string, HTMLCanvasElement>()

export function getSprite(c: Company, dpr: number): HTMLCanvasElement | null {
  const asset = getLogo(c)
  if (asset.state === 'loading') return null

  const key = `${c.id}@${dpr}`
  const hit = sprites.get(key)
  if (hit) return hit

  const px = Math.round(SPRITE_PX * dpr)
  const canvas = document.createElement('canvas')
  canvas.width = px
  canvas.height = px
  const ctx = canvas.getContext('2d')
  if (!ctx) return null

  const pad = px * SPRITE_PAD
  const plate = px - pad * 2
  const r = plate * 0.26

  ctx.shadowColor = 'rgba(0,0,0,0.5)'
  ctx.shadowBlur = pad * 0.8
  ctx.shadowOffsetY = pad * 0.22
  roundRectPath(ctx, pad, pad, plate, plate, r)
  ctx.fillStyle = '#f7f8fb'
  ctx.fill()
  ctx.shadowBlur = 0
  ctx.shadowOffsetY = 0

  const inner = plate * 0.66
  const cx = px / 2
  if (asset.state === 'ready' && asset.image) {
    const img = asset.image
    const scale = Math.min(inner / img.naturalWidth, inner / img.naturalHeight)
    const w = img.naturalWidth * scale
    const h = img.naturalHeight * scale
    try { ctx.drawImage(img, cx - w / 2, cx - h / 2, w, h) } catch { /* decoding */ }
  } else {
    ctx.fillStyle = `hsl(${asset.monogram.hue} 68% 46%)`
    roundRectPath(ctx, cx - inner / 2, cx - inner / 2, inner, inner, inner * 0.28)
    ctx.fill()
    ctx.fillStyle = '#fff'
    ctx.font = `700 ${Math.round(inner * 0.44)}px Inter, system-ui, sans-serif`
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText(asset.monogram.text, cx, cx + 1)
  }

  sprites.set(key, canvas)
  return canvas
}

function roundRectPath(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath()
  ctx.moveTo(x + r, y)
  ctx.arcTo(x + w, y, x + w, y + h, r)
  ctx.arcTo(x + w, y + h, x, y + h, r)
  ctx.arcTo(x, y + h, x, y, r)
  ctx.arcTo(x, y, x + w, y, r)
  ctx.closePath()
}

function hue(s: string): number {
  let h = 0
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) % 360
  return h
}

function monogramOf(name: string): string {
  const words = name.replace(/[^A-Za-z0-9 ]/g, ' ').split(/\s+/).filter(Boolean)
  if (words.length >= 2) return (words[0][0] + words[1][0]).toUpperCase()
  return name.slice(0, 2).toUpperCase()
}

export function getLogo(c: Company): LogoAsset {
  const hit = cache.get(c.id)
  if (hit) return hit

  const asset: LogoAsset = { image: null, monogram: { text: monogramOf(c.name), hue: hue(c.id) }, state: 'loading' }
  cache.set(c.id, asset)

  // Each source needs its own sanity check, because neither 404s — they answer
  // with a generic grey globe instead, which is worse than a monogram.
  // Measured: Google serves 128x128 when it has the real mark and 16x16 for its
  // placeholder; DuckDuckGo serves 32x32 real and 48x48 placeholder.
  const sources: Array<{ url: string; accept: (w: number) => boolean }> = [
    { url: c.logo, accept: (w) => w >= 64 },
    { url: c.logoFallback, accept: (w) => w >= 8 && w <= 40 },
  ]
  let i = 0
  const tryNext = () => {
    if (i >= sources.length) { asset.state = 'monogram'; return }
    const img = new Image()
    // Deliberately no crossOrigin: keyless logo CDNs send no CORS headers, and
    // requesting anonymous mode would make every one of them fail to load. We
    // only ever drawImage() these, never read the canvas back.
    img.referrerPolicy = 'no-referrer'
    img.onload = () => {
      if (!sources[i].accept(img.naturalWidth)) { i++; tryNext(); return }
      asset.image = img
      asset.state = 'ready'
      // The sprite was baked with a monogram; drop it so it re-bakes with the logo.
      for (const key of [...sprites.keys()]) if (key.startsWith(c.id + '@')) sprites.delete(key)
    }
    img.onerror = () => {
      i++
      if (i >= sources.length) for (const key of [...sprites.keys()]) if (key.startsWith(c.id + '@')) sprites.delete(key)
      tryNext()
    }
    img.src = sources[i].url
  }
  tryNext()
  return asset
}
