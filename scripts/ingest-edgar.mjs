#!/usr/bin/env node
/**
 * Enrich public companies with real revenue straight from SEC EDGAR — free, no key.
 *
 *   node scripts/ingest-edgar.mjs            # dry run, prints a diff
 *   node scripts/ingest-edgar.mjs --write    # rewrites revenueUsd in the seed slices
 *
 * Matches on the `ticker` field, pulls us-gaap:Revenues (falling back to
 * RevenueFromContractWithCustomerExcludingAssessedTax), takes the latest annual
 * 10-K value, and sets revenueEstimated:false on anything it lands.
 */
import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const seedDir = join(root, 'data', 'seed')
const WRITE = process.argv.includes('--write')
// EDGAR requires a descriptive UA with contact info or it 403s.
const UA = process.env.EDGAR_UA ?? 'logopile-dataset/0.1 (contact: you@example.com)'

const TAGS = ['Revenues', 'RevenueFromContractWithCustomerExcludingAssessedTax', 'SalesRevenueNet']

const tickers = await (await fetch('https://www.sec.gov/files/company_tickers.json', { headers: { 'User-Agent': UA } })).json()
const cikByTicker = new Map(Object.values(tickers).map((t) => [t.ticker.toUpperCase(), String(t.cik_str).padStart(10, '0')]))

for (const file of readdirSync(seedDir).filter((f) => f.endsWith('.json'))) {
  const rows = JSON.parse(readFileSync(join(seedDir, file), 'utf8'))
  let touched = 0
  for (const row of rows) {
    const cik = row.ticker && cikByTicker.get(row.ticker.toUpperCase())
    if (!cik) continue
    let value = null
    for (const tag of TAGS) {
      const r = await fetch(`https://data.sec.gov/api/xbrl/companyconcept/CIK${cik}/us-gaap/${tag}.json`, { headers: { 'User-Agent': UA } })
      if (!r.ok) continue
      const facts = (await r.json()).units?.USD ?? []
      const annual = facts.filter((f) => f.form === '10-K' && f.fp === 'FY' && f.start && f.end)
      if (!annual.length) continue
      value = annual.sort((a, b) => b.end.localeCompare(a.end))[0].val
      break
    }
    await new Promise((r) => setTimeout(r, 120)) // EDGAR fair-use: <10 req/s
    if (value == null) { console.log(`  ? ${row.id} (${row.ticker}) — no annual revenue fact`); continue }
    const before = row.revenueUsd
    if (before === value) continue
    console.log(`  ~ ${row.id}: ${fmt(before)} → ${fmt(value)}`)
    row.revenueUsd = value
    row.revenueEstimated = false
    touched++
  }
  if (WRITE && touched) {
    writeFileSync(join(seedDir, file), JSON.stringify(rows, null, 0).replaceAll('},{', '},\n{').replace('[{', '[\n{').replace('}]', '}\n]'))
    console.log(`✓ ${file}: ${touched} updated`)
  }
}
if (!WRITE) console.log('\ndry run — pass --write to apply, then `npm run data`')

function fmt(n) { return n == null ? 'n/a' : '$' + (n / 1e9).toFixed(2) + 'B' }
