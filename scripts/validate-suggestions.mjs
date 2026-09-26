/** Every generated suggestion must return results. Run: node scripts/validate-suggestions.mjs */
import { readFileSync, writeFileSync, rmSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'

writeFileSync('src/search/.validate-entry.ts', `
export { Ranker } from './rank'
export { setEmbedder } from './embed'
export { buildSuggestions } from './suggestions'
`)
execFileSync('npx', ['esbuild', 'src/search/.validate-entry.ts', '--bundle', '--format=esm',
  '--define:import.meta.env={}', '--outfile=/tmp/lp-sug.mjs', '--log-level=error'], { stdio: 'inherit' })

const { Ranker, setEmbedder, buildSuggestions } = await import(pathToFileURL('/tmp/lp-sug.mjs').href)
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

const r = new Ranker({ companies, byId: new Map(companies.map((c) => [c.id, c])), vectors, dim: meta.dim, scale: meta.scale })
const all = buildSuggestions(companies)
console.log(`validating ${all.length} suggestions…`)

const empty = []
const thin = []
for (const q of all) {
  const res = await r.search(q)
  if (!res.hits.length) empty.push(q)
  else if (res.hits.length < 3) thin.push(`${q} (${res.hits.length})`)
}
console.log(`\n✓ ${all.length - empty.length}/${all.length} return results`)
if (empty.length) {
  console.log(`\n✗ ${empty.length} EMPTY:`)
  for (const q of empty.slice(0, 40)) console.log('   ' + q)
}
if (thin.length) {
  console.log(`\n· ${thin.length} with fewer than 3 hits:`)
  for (const q of thin.slice(0, 20)) console.log('   ' + q)
}
rmSync('src/search/.validate-entry.ts', { force: true })
console.log(empty.length ? 'CHECK_FAIL validate-suggestions' : 'CHECK_OK validate-suggestions')

// onnxruntime's worker threads abort during process teardown ("mutex lock
// failed"), which turns a passing run into a non-zero exit. Release the session
// before we go.
await extract.dispose?.().catch(() => {})
process.exit(empty.length ? 1 : 0)
