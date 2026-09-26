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
// SEC's fair-access policy wants a contact address here, not a URL — send a
// URL and you get an HTML block page instead of JSON.
const UA = process.env.EDGAR_UA ?? 'logopile-dataset you@example.com'

const TAGS = ['Revenues', 'RevenueFromContractWithCustomerExcludingAssessedTax', 'SalesRevenueNet']

const tickers = await (await fetch('https://www.sec.gov/files/company_tickers.json', { headers: { 'User-Agent': UA, 'Accept-Encoding': 'gzip, deflate' } })).json()
const cikByTicker = new Map(Object.values(tickers).map((t) => [t.ticker.toUpperCase(), String(t.cik_str).padStart(10, '0')]))

for (const file of readdirSync(seedDir).filter((f) => f.endsWith('.json'))) {
  const rows = JSON.parse(readFileSync(join(seedDir, file), 'utf8'))
  let touched = 0
  for (const row of rows) {
    const cik = row.ticker && cikByTicker.get(row.ticker.toUpperCase())
    if (!cik) continue
    // Collect across every tag and pick the most recent filing. Breaking on the
    // first tag that answers gives stale numbers: Apple still has rows under the
    // deprecated `Revenues` tag from FY2018, while its current figures live under
    // RevenueFromContractWithCustomerExcludingAssessedTax.
    let best = null
    for (const tag of TAGS) {
      try {
        const r = await fetch(`https://data.sec.gov/api/xbrl/companyconcept/CIK${cik}/us-gaap/${tag}.json`, {
          headers: { 'User-Agent': UA, 'Accept-Encoding': 'gzip, deflate' },
        })
        if (!r.ok) continue
        const units = (await r.json())?.units
        // Foreign private issuers report in their own currency and the shape
        // varies; anything that isn't a USD array is not something we can use,
        // and one odd response must not take down the whole run.
        const facts = Array.isArray(units?.USD) ? units.USD : []
        // 10-K is the domestic annual report, 20-F the foreign equivalent.
        const annual = facts.filter((f) => (f.form === '10-K' || f.form === '20-F') && f.fp === 'FY' && f.start && f.end)
        if (!annual.length) continue
        const latest = annual.sort((a, b) => b.end.localeCompare(a.end))[0]
        if (!best || latest.end > best.end) best = latest
      } catch (err) {
        console.log(`  ! ${row.id} (${row.ticker}) ${tag}: ${String(err).slice(0, 60)}`)
      }
    }
    await new Promise((r) => setTimeout(r, 120)) // EDGAR fair-use: <10 req/s
    if (!best) { console.log(`  ? ${row.id} (${row.ticker}) — no annual revenue fact`); continue }
    const value = best.val
    const year = Number(best.end.slice(0, 4))
    const before = row.revenueUsd
    if (before === value && row.revenueFiscalYear === year) continue
    console.log(`  ~ ${row.id}: ${fmt(before)} → ${fmt(value)} (FY${year})`)
    row.revenueUsd = value
    row.revenueEstimated = false
    row.revenueFiscalYear = year
    touched++
  }
  if (WRITE && touched) {
    writeFileSync(join(seedDir, file), JSON.stringify(rows, null, 0).replaceAll('},{', '},\n{').replace('[{', '[\n{').replace('}]', '}\n]'))
    console.log(`✓ ${file}: ${touched} updated`)
  }
}
if (!WRITE) console.log('\ndry run — pass --write to apply, then `npm run data`')

function fmt(n) { return n == null ? 'n/a' : '$' + (n / 1e9).toFixed(2) + 'B' }
