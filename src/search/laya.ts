/**
 * Optional reranker backed by Laya (github.com/NandhaKishorM/laya) — an
 * open-source, Apache-2.0 non-autoregressive decision engine, and a drop-in
 * alternative to TypeSafe's Jev API.
 *
 * Why bother: the blended score below is a relevance ordering, not a
 * probability. Laya's `noul` head returns a *calibrated* yes/no probability, so
 * "87%" on a logo stops being a normalised cosine and starts meaning something.
 *
 *   docker run -p 8000:8000 ghcr.io/nandhakishorm/laya:latest
 *   echo 'VITE_LAYA_URL=http://localhost:8000' >> .env.local
 *
 * Off by default. Every failure mode (unset, down, slow, malformed) falls back
 * to the local score without surfacing an error.
 */
import type { Hit } from '../types'

const URL_BASE = (import.meta.env.VITE_LAYA_URL as string | undefined)?.replace(/\/$/, '')
const TIMEOUT_MS = 4000
const TOP_N = 30

export function layaEnabled(): boolean {
  return Boolean(URL_BASE)
}

export async function rerank(hits: Hit[], query: string, targetName: string | null): Promise<Hit[]> {
  if (!URL_BASE || !hits.length) return hits

  const head = hits.slice(0, TOP_N)
  const question = targetName
    ? `Is this company a direct competitor of ${targetName}?`
    : `Does this company match the request: "${query}"?`

  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS)
  try {
    const res = await fetch(`${URL_BASE}/v1/decide`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      signal: ctrl.signal,
      body: JSON.stringify({
        type: 'noul',
        question,
        inputs: head.map((h) => `${h.company.name}. ${h.company.description} Categories: ${h.company.categories.join(', ')}.`),
      }),
    })
    if (!res.ok) return hits
    const body = (await res.json()) as { results?: Array<{ probability?: number; score?: number }> }
    const results = body.results
    if (!Array.isArray(results) || results.length !== head.length) return hits

    const reranked = head.map((h, i) => {
      const p = results[i]?.probability ?? results[i]?.score
      if (typeof p !== 'number') return h
      return {
        ...h,
        confidence: Math.round(p * 100),
        // Keep a little of the local score so ties break sensibly.
        score: p * 0.85 + h.score * 0.15,
        reasons: [...h.reasons, 'Laya calibrated'],
      }
    })
    reranked.sort((a, b) => b.score - a.score)
    return [...reranked, ...hits.slice(TOP_N)]
  } catch {
    return hits
  } finally {
    clearTimeout(timer)
  }
}
