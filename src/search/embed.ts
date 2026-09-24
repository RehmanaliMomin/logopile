/**
 * Query-side embedding. The corpus vectors are precomputed at build time; this
 * only ever embeds the one string the user typed.
 *
 * transformers.js is pulled from a CDN on first search rather than bundled, so
 * the app boots instantly and lexical + filter search works while the ~25MB
 * model streams in. If it never arrives, ranking silently drops the semantic
 * term and reweights — no error path for the user.
 */
const CDN = 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.3.3'
const MODEL = 'Xenova/all-MiniLM-L6-v2'

type Extractor = (text: string, opts: object) => Promise<{ data: Float32Array }>

let extractor: Extractor | null = null
let loading: Promise<Extractor | null> | null = null
const cache = new Map<string, Float32Array>()

/**
 * Swap in a different embedding backend — a Node-side model for the smoke test,
 * a self-hosted inference endpoint, or a larger model like bge-small. It must
 * return L2-normalised vectors of the same dimension as the corpus blob.
 */
export function setEmbedder(fn: (text: string) => Promise<Float32Array>): void {
  extractor = async (text: string) => ({ data: await fn(text) })
  cache.clear()
}

export function isReady(): boolean {
  return extractor != null
}

export function warmUp(): Promise<Extractor | null> {
  if (extractor) return Promise.resolve(extractor)
  if (loading) return loading
  loading = (async () => {
    try {
      const lib = await import(/* @vite-ignore */ CDN)
      lib.env.allowLocalModels = false
      extractor = await lib.pipeline('feature-extraction', MODEL, { dtype: 'q8' })
      return extractor
    } catch (err) {
      console.warn('[embed] semantic search unavailable, falling back to lexical:', err)
      return null
    }
  })()
  return loading
}

export async function embedQuery(text: string): Promise<Float32Array | null> {
  const hit = cache.get(text)
  if (hit) return hit
  const ex = await warmUp()
  if (!ex) return null
  const res = await ex(text, { pooling: 'mean', normalize: true })
  const vec = new Float32Array(res.data)
  cache.set(text, vec)
  return vec
}

/**
 * Both sides are L2-normalised, so the dot product is the cosine. The corpus is
 * stored int8, so each dot is divided by the quantisation scale once at the end
 * rather than per component.
 */
export function cosineAgainstCorpus(
  query: Float32Array,
  corpus: Int8Array,
  dim: number,
  n: number,
  scale = 127,
): Float32Array {
  const out = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    let dot = 0
    const off = i * dim
    for (let d = 0; d < dim; d++) dot += query[d] * corpus[off + d]
    out[i] = (dot / scale + 1) / 2 // -1..1 → 0..1
  }
  return out
}
