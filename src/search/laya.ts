/**
 * Optional reranker backed by Laya (github.com/NandhaKishorM/laya) — an
 * open-source, Apache-2.0 non-autoregressive decision engine whose `noul` head
 * returns a calibrated yes/no probability, and a drop-in alternative to
 * TypeSafe's Jev API.
 *
 * OFF BY DEFAULT, and measured rather than assumed. Running it against this
 * corpus (laya 0.3.4, `convaiinnovations/laya`, asking "is this a direct
 * competitor of Whatfix?") produced:
 *
 *     Userlane 0.830   WalkMe 0.814   Stripe 0.770
 *     Toast    0.586   Pendo  0.506   NVIDIA 0.258
 *
 * It separates the extremes, but ranks Stripe — a payments company — above
 * Pendo, an actual digital-adoption rival. The `typed-decisions` checkpoint was
 * flatter still, every company landing between 0.35 and 0.50. On this task,
 * enabling it makes the ordering worse, not better, so the built-in blended
 * score stays the default and this is left as a wired, working integration for
 * anyone who wants to try a different checkpoint or prompt.
 *
 * To run it:
 *     python3 -m venv .venv && .venv/bin/pip install laya
 *     HF_TOKEN=... .venv/bin/python tools/laya_server.py
 *     echo 'VITE_LAYA_URL=http://localhost:8000' >> .env.local
 */
import type { Hit } from '../types'

const URL_BASE = (import.meta.env.VITE_LAYA_URL as string | undefined)?.replace(/\/$/, '')
const TIMEOUT_MS = 20000
/** One HTTP call per company — the API scores a single `state` at a time. */
const TOP_N = 12
const CONCURRENCY = 4

interface SystemOneResponse {
  answers?: Record<string, { noul?: number; confidence?: number }>
}

export function layaEnabled(): boolean {
  return Boolean(URL_BASE)
}

async function scoreOne(base: string, text: string, instructions: string, signal: AbortSignal): Promise<number | null> {
  const res = await fetch(`${base}/v1/systemone`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    signal,
    body: JSON.stringify({
      state: { body: text },
      questions: {
        competitor: {
          type: 'noul',
          instructions,
          criteria: { false: 'operates in a different market', true: 'direct competitor' },
        },
      },
    }),
  })
  if (!res.ok) return null
  const body = (await res.json()) as SystemOneResponse
  const noul = body.answers?.competitor?.noul
  return typeof noul === 'number' ? noul : null
}

/** Run `tasks` with a small concurrency cap rather than all at once. */
async function pool<T>(tasks: Array<() => Promise<T>>, limit: number): Promise<T[]> {
  const out: T[] = new Array(tasks.length)
  let next = 0
  await Promise.all(
    Array.from({ length: Math.min(limit, tasks.length) }, async () => {
      while (next < tasks.length) {
        const i = next++
        out[i] = await tasks[i]()
      }
    }),
  )
  return out
}

export async function rerank(hits: Hit[], query: string, targetName: string | null): Promise<Hit[]> {
  if (!URL_BASE || !hits.length) return hits

  const head = hits.slice(0, TOP_N)
  const instructions = targetName
    ? `Is this company a direct competitor of ${targetName}?`
    : `Does this company match the request: "${query}"?`

  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS)
  try {
    const scores = await pool(
      head.map((h) => () =>
        scoreOne(
          URL_BASE,
          `${h.company.name}. ${h.company.description} Categories: ${h.company.categories.join(', ')}.`,
          instructions,
          ctrl.signal,
        ).catch(() => null),
      ),
      CONCURRENCY,
    )
    if (scores.every((s) => s == null)) return hits

    const reranked = head.map((h, i) => {
      const p = scores[i]
      if (p == null) return h
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
