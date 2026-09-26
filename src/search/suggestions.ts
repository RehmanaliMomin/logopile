import type { Company } from '../types'
import { fmtMoney } from './parse'

/**
 * Query suggestions, generated from the dataset rather than hand-written.
 *
 * A hardcoded list goes stale the moment the data changes and can suggest a
 * query that returns nothing. Everything here is built from counts taken off
 * the corpus, so a suggestion only exists if enough companies actually satisfy
 * it — "cybersecurity companies in Israel" is offered because 9 of them are in
 * there, not because someone guessed.
 */

/** Showcase queries pinned to the front: each one exercises a hard code path. */
const SHOWCASE = [
  'competitors of Whatfix',
  'nightfall direct competetors',
  'competitors of Whatfix with revenue > $1B',
  'alternatives to WalkMe in Europe',
  'SaaS companies that are not American',
  'bootstrapped companies with more than 1000 employees',
  'who competes with CrowdStrike',
  'observability unicorns with more than 1000 employees',
]

/** Categories that read better pluralised than suffixed with "companies". */
const PLURALISABLE = /(platform|tool|database|provider|vendor|service|engine|gateway|framework)$/

function phrase(category: string): string {
  return PLURALISABLE.test(category) ? `${category}s` : `${category} companies`
}

/** Country names that read wrong without an article. */
const NEEDS_THE = new Set([
  'United States', 'United Kingdom', 'Netherlands', 'Philippines',
  'United Arab Emirates', 'Czech Republic', 'Bahamas',
])

function place(name: string): string {
  return NEEDS_THE.has(name) ? `the ${name}` : name
}

function countBy<T>(items: T[], key: (t: T) => string | null | undefined): Map<string, number> {
  const m = new Map<string, number>()
  for (const it of items) {
    const k = key(it)
    if (k) m.set(k, (m.get(k) ?? 0) + 1)
  }
  return m
}

/** Prefer categories that lots of companies share but that aren't generic filler. */
const BORING = new Set(['software', 'saas', 'computer', 'technology', 'internet', 'business software', 'enterprise software'])

export function buildSuggestions(companies: Company[]): string[] {
  const out: string[] = [...SHOWCASE]
  const push = (s: string) => { if (s) out.push(s) }

  // ---- category vocabulary -------------------------------------------------
  const catCount = countBy(companies.flatMap((c) => c.categories.map((x) => x)), (x) => x)
  const goodCats = [...catCount.entries()]
    .filter(([cat, n]) => n >= 4 && !BORING.has(cat) && cat.length > 3 && !/^\d/.test(cat))
    .sort((a, b) => b[1] - a[1])
    .map(([cat]) => cat)

  for (const cat of goodCats.slice(0, 120)) push(phrase(cat))

  // ---- competitor lookups, biggest logos first -----------------------------
  const withEdges = companies
    .filter((c) => c.competitors.length >= 2)
    .sort((a, b) => (b.valuationUsd ?? 0) - (a.valuationUsd ?? 0))
  for (const c of withEdges.slice(0, 90)) push(`competitors of ${c.name}`)
  for (const c of withEdges.slice(0, 25)) push(`alternatives to ${c.name}`)

  // ---- category × geography, only where the pair actually exists -----------
  const pairCount = new Map<string, number>()
  for (const c of companies) {
    for (const cat of c.categories) {
      if (BORING.has(cat) || catCount.get(cat)! < 4) continue
      if (c.hqCountry && c.hqCountry !== 'Unknown') {
        const k = `${cat}\u0000country\u0000${c.hqCountry}`
        pairCount.set(k, (pairCount.get(k) ?? 0) + 1)
      }
      if (c.region && c.region !== 'Unknown') {
        const k = `${cat}\u0000region\u0000${c.region}`
        pairCount.set(k, (pairCount.get(k) ?? 0) + 1)
      }
    }
  }
  const pairs = [...pairCount.entries()].filter(([, n]) => n >= 3).sort((a, b) => b[1] - a[1])
  for (const [key] of pairs.slice(0, 140)) {
    const [cat, kind, where] = key.split('\u0000')
    push(`${phrase(cat)} in ${kind === 'country' ? place(where) : where}`)
  }

  // ---- category × structured filter ---------------------------------------
  const unicornCats = countBy(companies.filter((c) => c.isUnicorn).flatMap((c) => c.categories), (x) => x)
  for (const [cat, n] of [...unicornCats].sort((a, b) => b[1] - a[1])) {
    if (n >= 3 && !BORING.has(cat)) push(`${cat} unicorns`)
  }

  const recentCats = countBy(companies.filter((c) => (c.founded ?? 0) >= 2015).flatMap((c) => c.categories), (x) => x)
  for (const [cat, n] of [...recentCats].sort((a, b) => b[1] - a[1]).slice(0, 40)) {
    if (n >= 3 && !BORING.has(cat)) push(`${phrase(cat)} founded after 2015`)
  }

  const bigCats = countBy(
    companies.filter((c) => (c.revenueUsd ?? 0) >= 1e9).flatMap((c) => c.categories),
    (x) => x,
  )
  for (const [cat, n] of [...bigCats].sort((a, b) => b[1] - a[1]).slice(0, 30)) {
    if (n >= 3 && !BORING.has(cat)) push(`${phrase(cat)} with revenue > $1B`)
  }

  // ---- pure structured filters --------------------------------------------
  for (const v of [1e9, 5e9, 1e10]) push(`companies valued over ${fmtMoney(v)}`)
  for (const v of [1e8, 5e8, 1e9, 1e10]) push(`companies with revenue > ${fmtMoney(v)}`)
  for (const n of [500, 1000, 5000, 10000]) push(`companies with more than ${n.toLocaleString()} employees`)
  for (const y of [2010, 2015, 2018, 2020]) push(`companies founded after ${y}`)
  for (const v of [1e8, 5e8, 1e9]) push(`companies that raised more than ${fmtMoney(v)}`)

  const regions = [...countBy(companies, (c) => (c.region === 'Unknown' ? null : c.region))]
    .filter(([, n]) => n >= 10)
    .map(([r]) => r)
  for (const r of regions) {
    push(`unicorns in ${r}`)
    push(`companies in ${r} with revenue > $1B`)
  }

  const countries = [...countBy(companies, (c) => (c.hqCountry === 'Unknown' ? null : c.hqCountry))]
    .filter(([, n]) => n >= 8)
    .sort((a, b) => b[1] - a[1])
    .map(([c]) => c)
  for (const c of countries.slice(0, 20)) push(`software companies in ${place(c)}`)

  // Dedupe, preserving the showcase order at the front.
  return [...new Set(out)]
}

/** Fisher–Yates over everything after the pinned showcase block. */
export function shuffleTail<T>(items: T[], pinned: number): T[] {
  const head = items.slice(0, pinned)
  const tail = items.slice(pinned)
  for (let i = tail.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[tail[i], tail[j]] = [tail[j], tail[i]]
  }
  return [...head, ...tail]
}

export const PINNED_SUGGESTIONS = SHOWCASE.length
