#!/usr/bin/env node
/**
 * Merge every data/seed/*.json slice into one validated public/companies.json.
 *
 * Adds derived fields the app needs but nobody should hand-maintain:
 *   - logo        : resolved logo URL chain
 *   - searchText  : the string that gets embedded / BM25-indexed
 *   - isUnicorn   : valuation >= $1B
 *   - competitors : symmetrised (if A lists B, B gets A) and pruned of unknown ids
 *
 * Run:  npm run data
 */
import { readdirSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const seedDir = join(root, 'data', 'seed')

const LOGO_CDN = process.env.LOGO_CDN ?? null

const REQUIRED = ['id', 'name', 'domain', 'description', 'categories']

// Competitor ids written by hand that point at a company filed under another id.
const ALIAS = {
  '1password': 'onepassword',
  googleanalytics: 'google',
  firebase: 'google',
  tableau: 'salesforce',
  mulesoft: 'salesforce',
  chorus: 'zoominfo',
  opsgenie: 'atlassian',
  appdynamics: 'cisco',
  jenkins: 'circleci',
  signavio: 'uipathadjacent-signavio',
  trinet: 'justworks',
  ukg: 'ceridian',
}
const warnings = []

const files = readdirSync(seedDir).filter((f) => f.endsWith('.json')).sort()
const byId = new Map()

for (const f of files) {
  const rows = JSON.parse(readFileSync(join(seedDir, f), 'utf8'))
  for (const row of rows) {
    for (const k of REQUIRED) {
      if (!row[k]) throw new Error(`${f}: ${row.id ?? '??'} missing required field "${k}"`)
    }
    if (byId.has(row.id)) warnings.push(`duplicate id "${row.id}" (${f}) — later slice wins`)
    byId.set(row.id, { ...row, _source: f })
  }
}

// --- symmetrise the competitor graph, drop dangling edges -------------------
for (const c of byId.values()) {
  c.competitors = [...new Set((c.competitors ?? []).map((id) => ALIAS[id] ?? id))].filter((id) => id !== c.id)
}
for (const c of byId.values()) {
  for (const other of c.competitors) {
    if (!byId.has(other)) {
      warnings.push(`${c.id}: competitor "${other}" not in dataset — edge dropped`)
      continue
    }
    const back = byId.get(other)
    if (!back.competitors.includes(c.id)) back.competitors.push(c.id)
  }
}
for (const c of byId.values()) c.competitors = c.competitors.filter((id) => byId.has(id))

// --- derive ----------------------------------------------------------------
const companies = [...byId.values()]
  .map((c) => {
    const { _source, ...rest } = c
    return {
      ...rest,
      ticker: c.ticker ?? null,
      employees: c.employees ?? null,
      founded: c.founded ?? null,
      revenueUsd: c.revenueUsd ?? null,
      valuationUsd: c.valuationUsd ?? null,
      fundingTotalUsd: c.fundingTotalUsd ?? null,
      isUnicorn: (c.valuationUsd ?? 0) >= 1_000_000_000,
      // Keyless, no-signup logo sources. Both serve without CORS headers, so the
      // canvas draws them untainted-agnostic (we never read pixels back).
      // Set LOGO_CDN to a templated URL (e.g. a Logo.dev or Brandfetch endpoint
      // with your own token) for higher-resolution marks.
      // Google's favicon service returns a true 128px mark; DuckDuckGo's is
      // 32px, so it's the backstop rather than the default.
      logo: LOGO_CDN ? LOGO_CDN.replaceAll('{domain}', c.domain) : `https://www.google.com/s2/favicons?domain=${c.domain}&sz=128`,
      logoFallback: `https://icons.duckduckgo.com/ip3/${c.domain}.ico`,
      // What gets embedded. Repeating name + categories is deliberate: it lifts
      // both lexical and vector recall for "digital adoption platforms"-style queries.
      searchText: [
        c.name,
        c.description,
        c.categories.join(', '),
        `${c.hqCity}, ${c.hqCountry}, ${c.region}`,
        c.stage,
        c.ticker ? `ticker ${c.ticker}` : '',
      ]
        .filter(Boolean)
        .join('. '),
    }
  })
  .sort((a, b) => a.id.localeCompare(b.id))

mkdirSync(join(root, 'public'), { recursive: true })
writeFileSync(join(root, 'public', 'companies.json'), JSON.stringify(companies))

const withRev = companies.filter((c) => c.revenueUsd != null).length
const unicorns = companies.filter((c) => c.isUnicorn).length
console.log(`✓ ${companies.length} companies from ${files.length} slices`)
console.log(`  ${withRev} with revenue · ${unicorns} unicorns · ${new Set(companies.flatMap((c) => c.categories)).size} categories`)
if (warnings.length) {
  console.log(`\n${warnings.length} warning(s):`)
  for (const w of warnings.slice(0, 20)) console.log('  ! ' + w)
  if (warnings.length > 20) console.log(`  … ${warnings.length - 20} more`)
}
