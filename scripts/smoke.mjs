/** Node smoke test for the parser + ranker (no browser, no embeddings). */
import { readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'

execFileSync('npx', ['esbuild', 'src/search/smoke-entry.ts', '--bundle', '--format=esm',
  '--define:import.meta.env={}', '--outfile=/tmp/logopile-rank.mjs', '--log-level=error'], { stdio: 'inherit' })

const { Ranker, setEmbedder } = await import(pathToFileURL('/tmp/logopile-rank.mjs').href)
const companies = JSON.parse(readFileSync('public/companies.json', 'utf8'))

let vectors = null
if (process.argv.includes('--semantic')) {
  const meta = JSON.parse(readFileSync('public/embeddings.meta.json', 'utf8'))
  vectors = new Float32Array(readFileSync('public/embeddings.bin').buffer.slice(0))
  const { pipeline, env } = await import('@huggingface/transformers')
  env.cacheDir = 'scripts/.cache'
  const extract = await pipeline('feature-extraction', meta.model, { dtype: 'fp32' })
  setEmbedder(async (text) => new Float32Array((await extract(text, { pooling: 'mean', normalize: true })).data))
  console.log(`(semantic on — ${meta.model})`)
}

const ds = { companies, byId: new Map(companies.map((c) => [c.id, c])), vectors, dim: 384 }
const r = new Ranker(ds)

const QUERIES = [
  'competitors of Whatfix',
  'digital adoption platforms',
  'competitors of Whatfix with revenue > $1B',
  'SaaS companies valued over $1B',
  'IT companies with revenue > $500M founded after 2015',
  'alternatives to WalkMe in Europe',
  'observability unicorns with more than 1000 employees',
  'European data governance companies founded after 2010',
  'cybersecurity companies in Israel',
  'competitors of Pendo',
  'nightfall direct competetors',
  'who competes with CrowdStrike',
  'show me Datadog alternatves',
  'Snowflake rivals',
  'competitors of Acme Nonexistent Corp',
]

for (const q of QUERIES) {
  const res = await r.search(q)
  const f = [
    res.target ? `target=${res.target.name}` : null,
    ...res.parsed.ranges.map((x) => `${x.field}${x.min != null ? '≥' + x.min : ''}${x.max != null ? '≤' + x.max : ''}`),
    res.parsed.regions.length ? 'region=' + res.parsed.regions : null,
    res.parsed.countries.length ? 'country=' + res.parsed.countries : null,
    res.parsed.unicornOnly ? 'unicorn' : null,
    res.parsed.semantic ? `sem="${res.parsed.semantic}"` : null,
  ].filter(Boolean).join(' | ')
  console.log(`\n▸ ${q}\n  ${f}`)
  console.log('  ' + res.hits.slice(0, 8).map((h) => `${h.company.name} ${h.confidence}%`).join(' · '))
  if (res.excludedForMissingData) console.log(`  (${res.excludedForMissingData} excluded for missing data)`)
}
