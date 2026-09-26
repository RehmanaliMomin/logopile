#!/usr/bin/env node
/**
 * Match companies against SEC's registrant list to fill in `ticker`.
 *
 *   node scripts/resolve-tickers.mjs            # dry run, prints every match
 *   node scripts/resolve-tickers.mjs --write    # writes tickers into data/seed/*
 *
 * Why this exists: ingest-edgar.mjs keys off `ticker`, and the bulk-ingested
 * rows have none — so the revenue backfill silently matched nothing. This is the
 * missing link between the two.
 *
 * Matching is deliberately strict. A wrong ticker doesn't degrade gracefully, it
 * attaches one company's revenue to another, so anything ambiguous is skipped
 * and reported rather than guessed.
 */
import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const seedDir = join(root, 'data', 'seed')
const WRITE = process.argv.includes('--write')
// SEC's fair-access policy wants a contact address here, not a URL — send a
// URL and you get an HTML block page instead of JSON.
const UA = process.env.EDGAR_UA ?? 'logopile-dataset you@example.com'

/**
 * Legal-form suffixes only. Industry words — Software, Technologies, Systems,
 * Solutions, Group, Holdings — are load-bearing parts of a name: stripping them
 * collapsed "Lucid Software" and "Lucid Group" (the EV maker) onto the same key
 * and handed the software company an automaker's ticker.
 */
const SUFFIXES = /\b(incorporated|inc|corporation|corp|limited|ltd|plc|llc|lp|sa|nv|ag|ab|oyj|spa|asa|se|pte|pvt|the)\b/g

function norm(name) {
  return name
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(SUFFIXES, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

const sec = await (await fetch('https://www.sec.gov/files/company_tickers.json', { headers: { 'User-Agent': UA, 'Accept-Encoding': 'gzip, deflate' } })).json()

// Normalised SEC name -> set of tickers. A key claimed by more than one
// registrant is ambiguous and gets dropped entirely.
const byName = new Map()
for (const row of Object.values(sec)) {
  const k = norm(row.title)
  if (k.length < 4) continue
  if (!byName.has(k)) byName.set(k, new Set())
  byName.get(k).add(row.ticker.toUpperCase())
}
const ambiguous = new Set()
for (const [k, tickers] of byName) if (tickers.size > 1) ambiguous.add(k)

console.log(`SEC registrants: ${Object.keys(sec).length} · unique normalised names: ${byName.size} · ambiguous: ${ambiguous.size}\n`)

let matched = 0
let skippedAmbiguous = 0
let alreadyHad = 0
const hits = []
const rejectedWeak = []

const titleByTicker = new Map(Object.values(sec).map((r) => [r.ticker.toUpperCase(), r.title]))
const secTitleFor = (t) => titleByTicker.get(t) ?? ''

const words = (s) =>
  new Set(
    s.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/)
      .filter((w) => w.length > 2 && !/^(inc|incorporated|corp|corporation|company|ltd|limited|plc|llc|the|and|com)$/.test(w)),
  )

/** Every distinctive word we have must appear in the SEC title, or it isn't them. */
function plausible(ours, theirs) {
  const a = words(ours)
  const b = words(theirs)
  if (!a.size || !b.size) return false
  let shared = 0
  for (const w of a) if (b.has(w)) shared++
  return shared === a.size || (shared >= 2 && shared / a.size >= 0.75)
}

for (const file of readdirSync(seedDir).filter((f) => f.endsWith('.json'))) {
  const rows = JSON.parse(readFileSync(join(seedDir, file), 'utf8'))
  let touched = 0
  for (const row of rows) {
    if (row.ticker) { alreadyHad++; continue }
    const k = norm(row.name)
    if (k.length < 4) continue
    if (ambiguous.has(k)) { skippedAmbiguous++; continue }
    const set = byName.get(k)
    if (!set) continue
    // Second gate: the SEC registrant's own words must still look like this
    // company. Normalisation can only ever lose information, so verify against
    // the raw titles before trusting the key.
    const secTitle = secTitleFor([...set][0])
    if (!plausible(row.name, secTitle)) { rejectedWeak.push(`${row.name} ≠ ${secTitle}`); continue }
    const ticker = [...set][0]
    row.ticker = ticker
    // A company with a ticker is publicly listed; the ingested rows say 'unknown'.
    if (row.stage === 'unknown') row.stage = 'public'
    hits.push(`${row.name} → ${ticker}`)
    matched++
    touched++
  }
  if (WRITE && touched) {
    writeFileSync(join(seedDir, file), '[\n' + rows.map((r) => JSON.stringify(r)).join(',\n') + '\n]')
    console.log(`✓ ${file}: ${touched} tickers written`)
  }
}

console.log(`\nmatched ${matched} · already had one ${alreadyHad} · ambiguous ${skippedAmbiguous} · failed the name check ${rejectedWeak.length}`)
if (rejectedWeak.length) {
  console.log('\nrejected (normalised key collided, raw names disagree):')
  for (const r of rejectedWeak.slice(0, 15)) console.log('  ✗ ' + r)
}
console.log('\nsample of matches (eyeball these for false positives):')
for (const h of hits.slice(0, 40)) console.log('  ' + h)
if (!WRITE) console.log('\ndry run — pass --write to apply')
