import { readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'
execFileSync('npx', ['esbuild', 'src/search/smoke-entry.ts', '--bundle', '--format=esm',
  '--define:import.meta.env={}', '--outfile=/tmp/lp-rank.mjs', '--log-level=error'], { stdio: 'inherit' })
const { Ranker, setEmbedder } = await import(pathToFileURL('/tmp/lp-rank.mjs').href)
const companies = JSON.parse(readFileSync('public/companies.json', 'utf8'))
const meta = JSON.parse(readFileSync('public/embeddings.meta.json', 'utf8'))
const buf = readFileSync('public/embeddings.bin')
const vectors = new Int8Array(buf.buffer, buf.byteOffset, buf.byteLength)
const { pipeline, env } = await import('@huggingface/transformers')
env.cacheDir = 'scripts/.cache'
// onnxruntime's multi-threaded pool aborts during process teardown ("mutex lock
// failed"), turning a passing harness into a non-zero exit. One thread is
// plenty for embedding a handful of query strings.
env.backends.onnx.wasm.numThreads = 1
const extract = await pipeline('feature-extraction', meta.model, { dtype: 'fp32' })
setEmbedder(async (t) => new Float32Array((await extract(t, { pooling: 'mean', normalize: true })).data))
const r = new Ranker({
  companies,
  byId: new Map(companies.map((c) => [c.id, c])),
  vectors,
  dim: meta.dim,
  scale: meta.scale ?? 127,
})

const Q = process.argv.slice(2).length ? process.argv.slice(2) : [
  // vague / conversational
  'something like slack but for security',
  'tools my IT team would use',
  'who makes a good CRM',
  'cheap alternatives to salesforce',
  'best company',
  'ai',
  // negation & comparison (known-hard)
  'SaaS companies that are not American',
  'observability but not Datadog',
  'bigger than Snowflake',
  // multi-constraint
  'German or French companies with revenue over $500M',
  'bootstrapped companies with more than 1000 employees',
  'public cybersecurity companies founded before 2005 with revenue over $1B',
  'series B startups in India',
  // domain / ticker / odd identifiers
  'CRWD',
  'pendo.io',
  'walkme',
  // typos and casing
  'DIGITAL ADOPTION PLATFORMS',
  'obsevability tools',
  'competitors of whatfx',
  // intent edge cases
  'competitors of Microsoft',
  'alternatives to Excel',
  'Zoom competitors in Europe with revenue > $1B',
  // numeric formats
  'revenue between $100M and $500M',
  'companies with 10k+ employees',
  'valuation over 5 billion',
  'raised more than $1B',
  'founded in 2019',
  // Target resolution must refuse rather than invent a match.
  'competitors of A Company That Does Not Exist',
  'competitors of the company',
  'competitors of Zzzqqx Corp',
  'competitors of walkme',
  'competitors of Palo Alto',
]
for (const q of Q) {
  const res = await r.search(q)
  const f = [
    res.target ? `target=${res.target.name}` : (res.parsed.targetName ? `UNRESOLVED(${res.parsed.targetName})` : null),
    ...res.parsed.ranges.map((x) => `${x.field}${x.min != null ? '≥' + fmt(x.min) : ''}${x.max != null ? '≤' + fmt(x.max) : ''}`),
    res.parsed.regions.length ? 'region=' + res.parsed.regions : null,
    res.parsed.countries.length ? 'country=' + res.parsed.countries : null,
    res.parsed.stages.length ? 'stage=' + res.parsed.stages : null,
    res.parsed.unicornOnly ? 'unicorn' : null,
    res.parsed.semantic ? `sem="${res.parsed.semantic}"` : null,
  ].filter(Boolean).join(' | ') || '(no filters)'
  console.log(`\n▸ ${q}\n  ${f}`)
  console.log('  ' + (res.hits.length ? res.hits.slice(0, 6).map((h) => `${h.company.name} ${h.confidence}%`).join(' · ') : '— NO RESULTS —'))
}
function fmt(n){ return n>=1e9?(n/1e9)+'B':n>=1e6?(n/1e6)+'M':String(n) }

console.log('CHECK_OK stress')
process.exit(0)
