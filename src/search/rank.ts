import type { Company, Hit, ParsedQuery, RangeFilter } from '../types'
import type { Dataset } from '../data/load'
import { Bm25 } from './bm25'
import { cosineAgainstCorpus, embedQuery, isReady } from './embed'
import { layaEnabled, rerank } from './laya'
import { editDistance, parseQuery } from './parse'

export interface SearchResult {
  hits: Hit[]
  parsed: ParsedQuery
  target: Company | null
  /** Rows dropped only because a filtered field was null — surfaced, not hidden. */
  excludedForMissingData: number
  semanticUsed: boolean
  layaUsed: boolean
}

const MAX_HITS = 24
/** A blended score at or above this reads as a confident match (see confidence). */
const STRONG_SCORE = 0.72

/**
 * How much this logo matters, 0..1, from valuation with revenue as a stand-in.
 * Pure tiebreak: when two companies are equally good answers, the one people
 * have actually heard of should sit higher in the pile.
 */
function prominence(c: Company): number {
  const v = c.valuationUsd ?? (c.revenueUsd != null ? c.revenueUsd * 4 : null)
  if (v == null) return 0.3
  // $10M → 0, $1T → 1
  return Math.max(0, Math.min(1, (Math.log10(v) - 7) / 5))
}

export class Ranker {
  private bm25: Bm25

  constructor(private ds: Dataset) {
    this.bm25 = new Bm25(ds.companies)
  }

  async search(raw: string): Promise<SearchResult> {
    const parsed = parseQuery(raw)
    const { companies } = this.ds

    const target = parsed.targetName ? resolveCompany(companies, parsed.targetName) : null

    // The query named a company we don't have. Ranking "everything vs nothing"
    // just surfaces the biggest logos in the pile, which reads as a confident
    // wrong answer — say we don't know it instead.
    if (parsed.targetName && !target) {
      return { hits: [], parsed, target: null, excludedForMissingData: 0, semanticUsed: false, layaUsed: false }
    }

    // Companies the query explicitly asked to leave out.
    const excluded = new Set<string>()
    for (const name of parsed.excludeNames) {
      const c = resolveCompany(companies, name)
      if (c) excluded.add(c.id)
    }

    // ---- hard filters ------------------------------------------------------
    let excludedForMissingData = 0
    const eligible: Company[] = []
    for (const c of companies) {
      if (target && c.id === target.id) continue
      if (excluded.has(c.id)) continue
      if (parsed.excludeRegions.includes(c.region)) continue
      if (parsed.excludeCountries.includes(c.hqCountry)) continue
      let ok = true
      let missing = false
      for (const r of parsed.ranges) {
        const v = c[r.field]
        if (v == null) { missing = true; ok = false; break }
        if (r.min != null && v < r.min) { ok = false; break }
        if (r.max != null && v > r.max) { ok = false; break }
      }
      if (ok && parsed.unicornOnly && !c.isUnicorn) ok = false
      if (ok && parsed.regions.length && !parsed.regions.includes(c.region)) ok = false
      if (ok && parsed.countries.length && !parsed.countries.includes(c.hqCountry)) ok = false
      if (ok && parsed.stages.length && !parsed.stages.includes(c.stage)) ok = false
      if (ok) eligible.push(c)
      else if (missing) excludedForMissingData++
    }
    if (!eligible.length) {
      return { hits: [], parsed, target, excludedForMissingData, semanticUsed: false, layaUsed: false }
    }

    // A short query that resolves to a company is an identity lookup, not a
    // search. "walkme" used to rank SAP first, because SAP's description
    // mentions WalkMe and SAP is a far bigger logo.
    const identity =
      !target && parsed.semantic && parsed.semantic.split(/\s+/).length <= 3
        ? resolveCompany(companies, parsed.semantic)
        : null

    // ---- signals -----------------------------------------------------------
    // Query text for the semantic/lexical side. On a bare "competitors of X"
    // the user gave us no descriptive words, so we borrow the target's own
    // description — that is the actual thing we want neighbours of.
    const queryText = [parsed.semantic, target ? `${target.description} ${target.categories.join(' ')}` : '']
      .filter(Boolean)
      .join(' ')
      .trim()

    const lexAll = queryText ? this.bm25.score(queryText) : new Float32Array(companies.length)

    let semAll: Float32Array | null = null
    if (queryText && this.ds.vectors) {
      const qvec = target && !parsed.semantic
        ? rowOf(this.ds.vectors, companies.indexOf(target), this.ds.dim) // exact target vector beats re-embedding its text
        : await embedQuery(queryText)
      if (qvec) semAll = cosineAgainstCorpus(qvec, this.ds.vectors, this.ds.dim, companies.length)
    }
    const semanticUsed = semAll != null

    const targetCats = target ? new Set(target.categories) : null
    const targetEdges = target ? new Set(target.competitors) : null
    // Shared-competitor overlap: two companies fought over by the same third
    // parties are competitors even when nobody listed them against each other.
    const targetSecondHop = new Set<string>()
    if (target) {
      for (const id of target.competitors) {
        for (const nb of this.ds.byId.get(id)?.competitors ?? []) if (nb !== target.id) targetSecondHop.add(nb)
      }
    }

    const W = target
      ? { semantic: 0.28, lexical: 0.07, category: 0.25, competitor: 0.32, prominence: 0.08 }
      : { semantic: 0.54, lexical: 0.25, category: 0.14, competitor: 0.0, prominence: 0.07 }
    if (!semanticUsed) {
      // Reweight instead of scoring everything 0 on the semantic axis.
      const share = W.semantic
      W.semantic = 0
      W.lexical += share * (target ? 0.4 : 0.65)
      W.category += share * (target ? 0.3 : 0.35)
      W.competitor += share * (target ? 0.3 : 0)
    }

    const indexOf = new Map(companies.map((c, i) => [c.id, i]))
    const hits: Hit[] = eligible.map((c) => {
      const i = indexOf.get(c.id)!
      const semantic = semAll ? semAll[i] : 0
      const lexical = lexAll[i]

      let category = 0
      const sharedCats: string[] = []
      if (targetCats) {
        for (const cat of c.categories) if (targetCats.has(cat)) sharedCats.push(cat)
        category = sharedCats.length / Math.max(1, Math.min(targetCats.size, c.categories.length))
      } else if (parsed.semantic) {
        const q = parsed.semantic
        for (const cat of c.categories) if (q.includes(cat) || cat.includes(q)) { category = 1; break }
      }

      let competitor = 0
      const reasons: string[] = []
      if (targetEdges?.has(c.id)) { competitor = 1; reasons.push(`Listed competitor of ${target!.name}`) }
      else if (targetSecondHop.has(c.id)) { competitor = 0.55; reasons.push(`Competes with ${target!.name}'s competitors`) }
      if (sharedCats.length) reasons.push(`Shares ${sharedCats.slice(0, 3).join(', ')}`)
      if (semantic > 0.72) reasons.push('Close product-description match')

      const score =
        W.semantic * semantic +
        W.lexical * lexical +
        W.category * category +
        W.competitor * competitor +
        W.prominence * prominence(c)

      return { company: c, score, confidence: 0, reasons, parts: { semantic, lexical, category, competitor } }
    })

    hits.sort((a, b) => b.score - a.score)

    // A pure-filter query ("bootstrapped companies with 1000+ employees") has no
    // text to score against, so every hit lands near zero and the relevance
    // floor would throw away a perfectly correct answer. The filter *is* the
    // answer here; order by prominence and keep everything that passed.
    const pureFilter = !queryText && !identity
    let top = pureFilter
      ? hits.slice(0, MAX_HITS)
      : hits.slice(0, MAX_HITS).filter((h) => h.score > 0.04)

    // ---- confidence --------------------------------------------------------
    // Weighted toward the absolute score, so a weak result set reads weak
    // instead of normalising its best bad answer up to 100%.
    // Laya replaces this wholesale with a calibrated probability when it's up.
    const best = top[0]?.score ?? 1
    for (const h of top) {
      if (pureFilter) {
        // Everything here satisfies the filter exactly; there is no "better".
        h.confidence = 99
        h.reasons.unshift('Matches every filter')
        continue
      }
      const rel = Math.pow(h.score / best, 1.15)
      const abs = Math.min(1, h.score / STRONG_SCORE)
      h.confidence = Math.max(3, Math.min(99, Math.round(100 * (0.4 * rel + 0.6 * abs))))
    }

    // Pin an identity lookup to the top; its neighbours follow underneath.
    if (identity) {
      const i = top.findIndex((h) => h.company.id === identity.id)
      if (i > 0) {
        const [hit] = top.splice(i, 1)
        hit.confidence = 99
        hit.reasons.unshift('Name match')
        top.unshift(hit)
      } else if (i === 0) {
        top[0].confidence = 99
      }
    }

    let layaUsed = false
    if (layaEnabled() && top.length) {
      const before = top
      top = await rerank(top, raw, target?.name ?? null)
      layaUsed = top !== before
    }

    return { hits: top, parsed, target, excludedForMissingData, semanticUsed, layaUsed }
  }

  /** Semantic search is a progressive upgrade — the UI re-runs once it lands. */
  get semanticReady(): boolean {
    return isReady() && this.ds.vectors != null
  }
}

function rowOf(vectors: Float32Array, i: number, dim: number): Float32Array {
  return vectors.subarray(i * dim, (i + 1) * dim)
}

/** "whatfix" / "Whatfix" / "walkme.com" / "Palo Alto" → the company. */
export function resolveCompany(companies: Company[], name: string): Company | null {
  const q = name.trim().toLowerCase().replace(/[^a-z0-9. ]/g, '')
  if (!q) return null
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9. ]/g, '')
  const squash = (x: string) => x.replace(/[ .]/g, '')
  return (
    companies.find((c) => norm(c.name) === q || c.id === squash(q) || norm(c.domain) === q) ??
    companies.find((c) => c.ticker != null && c.ticker.toLowerCase() === q) ??
    companies.find((c) => norm(c.domain).split('.')[0] === squash(q)) ??
    companies.find((c) => norm(c.name).startsWith(q) && q.length >= 3) ??
    companies.find((c) => norm(c.name).includes(q) && q.length >= 4) ??
    // Last resort: one or two typos in the company name itself ("whatfx").
    (q.length >= 5
      ? companies.find((c) => editDistance(squash(norm(c.name)), squash(q), 2) <= 2) ??
        companies.find((c) => editDistance(norm(c.domain).split('.')[0], squash(q), 2) <= 2)
      : undefined) ??
    null
  )
}

export function matchesRange(c: Company, r: RangeFilter): boolean {
  const v = c[r.field]
  if (v == null) return false
  return (r.min == null || v >= r.min) && (r.max == null || v <= r.max)
}
