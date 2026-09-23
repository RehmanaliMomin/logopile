import type { Company } from '../types'

export interface Dataset {
  companies: Company[]
  byId: Map<string, Company>
  /** N × dim, L2-normalised, row i ↔ companies[i]. Null until the blob lands. */
  vectors: Float32Array | null
  dim: number
}

export async function loadDataset(): Promise<Dataset> {
  const companies: Company[] = await (await fetch('companies.json')).json()
  const byId = new Map(companies.map((c) => [c.id, c]))
  return { companies, byId, vectors: null, dim: 384 }
}

/** Precomputed vectors are optional — the app ranks fine without them. */
export async function loadVectors(ds: Dataset): Promise<void> {
  try {
    const meta = await (await fetch('embeddings.meta.json')).json()
    const buf = await (await fetch('embeddings.bin')).arrayBuffer()
    if (buf.byteLength !== meta.count * meta.dim * 4) throw new Error('embeddings.bin size mismatch — re-run `npm run embed`')
    ds.vectors = new Float32Array(buf)
    ds.dim = meta.dim
  } catch {
    ds.vectors = null
  }
}
