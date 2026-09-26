import type { Company, Zone } from '../types'

export interface Dataset {
  companies: Company[]
  byId: Map<string, Company>
  /** N × dim int8 (value ≈ component × scale), row i ↔ companies[i]. */
  zones: Zone[]
  vectors: Int8Array | null
  dim: number
  /** Divisor that turns a stored int8 back into a unit-vector component. */
  scale: number
}

const asset = (name: string) => import.meta.env.BASE_URL + name

export async function loadDataset(): Promise<Dataset> {
  const companies: Company[] = await (await fetch(asset('companies.json'))).json()
  const byId = new Map(companies.map((c) => [c.id, c]))
  // Zones are cosmetic; the app works without them.
  const zones: Zone[] = await fetch(asset('clusters.json'))
    .then((r) => (r.ok ? r.json() : []))
    .catch(() => [])
  return { companies, byId, zones, vectors: null, dim: 384, scale: 127 }
}

/** Precomputed vectors are optional — the app ranks fine without them. */
export async function loadVectors(ds: Dataset): Promise<void> {
  try {
    const meta = await (await fetch(asset('embeddings.meta.json'))).json()
    const buf = await (await fetch(asset('embeddings.bin'))).arrayBuffer()
    if (buf.byteLength !== meta.count * meta.dim) throw new Error('embeddings.bin size mismatch — re-run `npm run embed`')
    ds.vectors = new Int8Array(buf)
    ds.dim = meta.dim
    ds.scale = meta.scale ?? 127
  } catch {
    ds.vectors = null
  }
}
