#!/usr/bin/env node
/**
 * Give the bulk-ingested tier a competitor graph, derived from the embeddings.
 *
 *   node scripts/infer-competitors.mjs         # writes inferredCompetitors into companies.json
 *   node scripts/infer-competitors.mjs --dry   # report only
 *
 * Hand-written edges exist only for the curated rows, so "competitors of
 * <ingested company>" had nothing but raw semantic distance to work with. This
 * fills the gap with k-NN over the corpus vectors — but keeps the result in a
 * SEPARATE field, because an inferred edge is a guess and a stated one is not,
 * and the ranker and the UI should both be able to tell them apart.
 *
 * Runs after build-embeddings; it adds a field without touching `searchText`,
 * so the vectors stay valid.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const DRY = process.argv.includes('--dry')

const K = 8
/** Cosine below this is not a competitor, it is just another software company. */
const MIN_COSINE = 0.45
/** A shared category is the sanity check on the vector's opinion. */
const REQUIRE_SHARED_CATEGORY = true

const companies = JSON.parse(readFileSync(join(root, 'public', 'companies.json'), 'utf8'))
const meta = JSON.parse(readFileSync(join(root, 'public', 'embeddings.meta.json'), 'utf8'))
const buf = readFileSync(join(root, 'public', 'embeddings.bin'))
const vec = new Int8Array(buf.buffer, buf.byteOffset, buf.byteLength)
const { dim, scale } = meta

if (companies.length !== meta.count) throw new Error('companies.json and embeddings.bin disagree — run `npm run data`')

const cos = (a, b) => {
  let d = 0
  for (let i = 0; i < dim; i++) d += vec[a * dim + i] * vec[b * dim + i]
  return d / (scale * scale)
}

const cats = companies.map((c) => new Set(c.categories))
// Categories so common they say nothing about who competes with whom.
const catFreq = new Map()
for (const c of companies) for (const k of c.categories) catFreq.set(k, (catFreq.get(k) ?? 0) + 1)
const GENERIC = new Set([...catFreq].filter(([, n]) => n > companies.length * 0.12).map(([k]) => k))

let filled = 0
let skippedHasEdges = 0
let noCandidates = 0
const samples = []

for (let i = 0; i < companies.length; i++) {
  const c = companies[i]
  if (c.competitors.length > 0) { skippedHasEdges++; c.inferredCompetitors = []; continue }

  const scored = []
  for (let j = 0; j < companies.length; j++) {
    if (j === i) continue
    const s = cos(i, j)
    if (s < MIN_COSINE) continue
    if (REQUIRE_SHARED_CATEGORY) {
      let shared = false
      for (const k of cats[j]) if (cats[i].has(k) && !GENERIC.has(k)) { shared = true; break }
      if (!shared) continue
    }
    scored.push([j, s])
  }
  scored.sort((a, b) => b[1] - a[1])
  const top = scored.slice(0, K).map(([j]) => companies[j].id)
  c.inferredCompetitors = top
  if (top.length) {
    filled++
    if (samples.length < 14 && top.length >= 4) {
      samples.push(`${c.name}  →  ${top.slice(0, 5).map((id) => companies.find((x) => x.id === id).name).join(', ')}`)
    }
  } else {
    noCandidates++
  }
}

console.log(`inferred edges for ${filled} companies`)
console.log(`  ${skippedHasEdges} already had stated edges · ${noCandidates} had no candidate above the bar`)
console.log(`  generic categories ignored: ${[...GENERIC].join(', ') || '(none)'}`)
console.log('\nsample:')
for (const s of samples) console.log('  ' + s)

if (!DRY) {
  writeFileSync(join(root, 'public', 'companies.json'), JSON.stringify(companies))
  console.log('\n✓ wrote public/companies.json')
} else {
  console.log('\ndry run — omit --dry to write')
}
