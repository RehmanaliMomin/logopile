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

  const sources = [c.logo, c.logoFallback]
  let i = 0
  const tryNext = () => {
    if (i >= sources.length) { asset.state = 'monogram'; return }
    const img = new Image()
    // Deliberately no crossOrigin: keyless logo CDNs send no CORS headers, and
    // requesting anonymous mode would make every one of them fail to load. We
    // only ever drawImage() these, never read the canvas back.
    img.referrerPolicy = 'no-referrer'
    img.onload = () => {
      // Favicon services answer unknown domains with a tiny generic placeholder.
      if (img.naturalWidth < 8) { i++; tryNext(); return }
      asset.image = img
      asset.state = 'ready'
    }
    img.onerror = () => { i++; tryNext() }
    img.src = sources[i]
  }
  tryNext()
  return asset
}
