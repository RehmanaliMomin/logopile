#!/usr/bin/env node
/**
 * Embed every company's searchText with all-MiniLM-L6-v2 and write a flat
 * Float32 blob: public/embeddings.bin  (N * 384 floats, L2-normalised, row i
 * = companies.json[i]).  Plus public/embeddings.meta.json for shape + model id.
 *
 * Downloads ~25MB of model weights on first run, then caches in scripts/.cache.
 * Run: npm run embed   (or npm run data, which rebuilds the dataset first)
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const MODEL = 'Xenova/all-MiniLM-L6-v2'
const DIM = 384

const { pipeline, env } = await import('@huggingface/transformers')
env.cacheDir = join(root, 'scripts', '.cache')

const companies = JSON.parse(readFileSync(join(root, 'public', 'companies.json'), 'utf8'))
console.log(`embedding ${companies.length} companies with ${MODEL} …`)

const extract = await pipeline('feature-extraction', MODEL, { dtype: 'fp32' })

const out = new Float32Array(companies.length * DIM)
const BATCH = 32
for (let i = 0; i < companies.length; i += BATCH) {
  const slice = companies.slice(i, i + BATCH)
  const res = await extract(slice.map((c) => c.searchText), { pooling: 'mean', normalize: true })
  const flat = res.data
  out.set(flat.subarray(0, slice.length * DIM), i * DIM)
  process.stdout.write(`\r  ${Math.min(i + BATCH, companies.length)}/${companies.length}`)
}
process.stdout.write('\n')

writeFileSync(join(root, 'public', 'embeddings.bin'), Buffer.from(out.buffer))
writeFileSync(
  join(root, 'public', 'embeddings.meta.json'),
  JSON.stringify({ model: MODEL, dim: DIM, count: companies.length, builtAt: new Date().toISOString() }, null, 2),
)
console.log(`✓ public/embeddings.bin — ${companies.length} × ${DIM} floats (${(out.byteLength / 1e6).toFixed(1)} MB)`)
