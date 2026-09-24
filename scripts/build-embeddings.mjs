#!/usr/bin/env node
/**
 * Embed every company's searchText with all-MiniLM-L6-v2 and write a flat
 * int8 blob: public/embeddings.bin  (N * 384 bytes, row i = companies.json[i]).
 * Plus public/embeddings.meta.json for shape, model id and scale.
 *
 * Vectors are L2-normalised, so every component is in [-1, 1] and quantising to
 * int8 (v * 127, rounded) costs ~0.4% cosine error — invisible in a ranking —
 * while cutting the download 4x. Float32 does not compress; the blob was 3.8MB
 * raw and 3.5MB gzipped, which is not a reasonable thing to ship to a browser.
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

const SCALE = 127
const out = new Int8Array(companies.length * DIM)
const BATCH = 32
for (let i = 0; i < companies.length; i += BATCH) {
  const slice = companies.slice(i, i + BATCH)
  const res = await extract(slice.map((c) => c.searchText), { pooling: 'mean', normalize: true })
  const flat = res.data
  for (let j = 0; j < slice.length * DIM; j++) {
    out[i * DIM + j] = Math.max(-127, Math.min(127, Math.round(flat[j] * SCALE)))
  }
  process.stdout.write(`\r  ${Math.min(i + BATCH, companies.length)}/${companies.length}`)
}
process.stdout.write('\n')

writeFileSync(join(root, 'public', 'embeddings.bin'), Buffer.from(out.buffer))
writeFileSync(
  join(root, 'public', 'embeddings.meta.json'),
  JSON.stringify(
    { model: MODEL, dim: DIM, count: companies.length, dtype: 'int8', scale: SCALE, builtAt: new Date().toISOString() },
    null,
    2,
  ),
)
console.log(`✓ public/embeddings.bin — ${companies.length} × ${DIM} int8 (${(out.byteLength / 1e6).toFixed(2)} MB)`)
