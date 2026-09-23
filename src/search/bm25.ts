import type { Company } from '../types'

/** Tiny in-memory BM25. 279 docs — no need for a library. */
const K1 = 1.4
const B = 0.75

const STOP = new Set(['the', 'a', 'an', 'and', 'or', 'of', 'for', 'to', 'in', 'on', 'with', 'that', 'is', 'are', 'by', 'as', 'at', 'from', 'its'])

export function tokenize(s: string): string[] {
  return s
    .toLowerCase()
    .split(/[^a-z0-9+#.]+/)
    .filter((t) => t.length > 1 && !STOP.has(t))
}

export class Bm25 {
  private df = new Map<string, number>()
  private tf: Array<Map<string, number>> = []
  private len: number[] = []
  private avgLen = 0
  private n = 0

  constructor(companies: Company[]) {
    this.n = companies.length
    for (const c of companies) {
      const terms = tokenize(c.searchText)
      const counts = new Map<string, number>()
      for (const t of terms) counts.set(t, (counts.get(t) ?? 0) + 1)
      for (const t of counts.keys()) this.df.set(t, (this.df.get(t) ?? 0) + 1)
      this.tf.push(counts)
      this.len.push(terms.length)
    }
    this.avgLen = this.len.reduce((a, b) => a + b, 0) / Math.max(1, this.n)
  }

  /** Raw BM25 per doc, then min-max scaled to 0..1 so it can be blended. */
  score(query: string): Float32Array {
    const out = new Float32Array(this.n)
    const terms = tokenize(query)
    if (!terms.length) return out
    for (const t of terms) {
      const df = this.df.get(t)
      if (!df) continue
      const idf = Math.log(1 + (this.n - df + 0.5) / (df + 0.5))
      for (let i = 0; i < this.n; i++) {
        const f = this.tf[i].get(t)
        if (!f) continue
        out[i] += (idf * (f * (K1 + 1))) / (f + K1 * (1 - B + (B * this.len[i]) / this.avgLen))
      }
    }
    let max = 0
    for (const v of out) if (v > max) max = v
    if (max > 0) for (let i = 0; i < out.length; i++) out[i] /= max
    return out
  }
}
