#!/usr/bin/env node
/**
 * Assign every company to a visual zone, so the pile can sort itself by domain.
 *
 *   node scripts/build-clusters.mjs
 *
 * This started as k-means over the corpus vectors and the result was not worth
 * shipping: five of ten clusters came back 85-90% "software" with no character,
 * because every description shares the same boilerplate ("X is an American
 * software company that provides...") and the distinguishing signal is a small
 * component of the vector. The labels were actively misleading — a cluster
 * named "video game industry" held Meta, Zoom and Zendesk.
 *
 * Category tags are the signal that actually separates these companies, so the
 * zones are keyword rules over the tags, with the embedding used only as a
 * tiebreak for rows whose tags say nothing. Rules are legible and auditable;
 * a blob labelled by its most over-represented rare tag is neither.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const ZONES = [
  { id: 'security', label: 'Security', match: /security|cyber|dlp|siem|xdr|edr|zero trust|firewall|threat|vulnerability|identity|iam|pam|sase|casb|privacy|compliance|grc|fraud|encryption|password|antivirus|malware/ },
  { id: 'data', label: 'Data & Analytics', match: /data|analytics|warehouse|lakehouse|etl|elt|olap|database|sql|nosql|bi |business intelligence|metadata|catalog|governance|streaming|kafka|search|observability|monitoring|apm|telemetry/ },
  { id: 'ai', label: 'AI & ML', match: /\bai\b|artificial intelligence|machine learning|llm|generative|nlp|computer vision|mlops|neural|deep learning|robotics|voice ai|speech/ },
  { id: 'devtools', label: 'Developer Tools', match: /developer|devops|devsecops|ci-?cd|source control|version control|api|sdk|testing|container|kubernetes|infrastructure as code|feature flag|low-?code|no-?code|programming|compiler|ide|open source/ },
  { id: 'cloud', label: 'Cloud & Infra', match: /cloud|hosting|serverless|virtualization|hyperconverged|cdn|edge comput|networking|storage|data cent|hpc|semiconductor|computer hardware|operating system|infrastructure/ },
  { id: 'fintech', label: 'Fintech', match: /fintech|payment|banking|finance|financial|accounting|invoic|billing|insurance|insurtech|lending|crypto|blockchain|spend management|procurement|tax|trading|wealth/ },
  { id: 'gtm', label: 'Sales & Marketing', match: /crm|sales|marketing|advertis|revenue|lead|customer success|customer service|helpdesk|support|ecommerce|commerce|retail|seo|email marketing|cdp|customer data|enablement|martech/ },
  { id: 'people', label: 'HR & People', match: /\bhr\b|human resource|hris|hcm|payroll|recruit|talent|hiring|employee|workforce|benefits|learning|lms|e-?learning|training|onboarding|engagement|performance management/ },
  { id: 'work', label: 'Work & Collaboration', match: /collaboration|productivity|project management|work management|task|workflow|automation|rpa|document|content management|knowledge|wiki|design|whiteboard|video conferen|communication|messaging|meeting|calendar|note/ },
  { id: 'services', label: 'IT Services', match: /it services|consult|outsourcing|bpo|managed services|systems integration|staffing|engineering services|digital transformation|itsm|it management|msp/ },
  { id: 'vertical', label: 'Vertical Software', match: /healthcare|health|medical|biotech|pharma|legal|legaltech|education|edtech|govern|public sector|construction|real estate|proptech|logistics|supply chain|transport|fleet|manufactur|energy|agri|hospitality|restaurant|travel|automotive|telecom|media|gaming|video game|music|sports|nonprofit/ },
]

const kArg = process.argv.indexOf('--k')
const K = kArg > -1 ? Number(process.argv[kArg + 1]) : 10
const ITERATIONS = 40

const companies = JSON.parse(readFileSync(join(root, 'public', 'companies.json'), 'utf8'))
const meta = JSON.parse(readFileSync(join(root, 'public', 'embeddings.meta.json'), 'utf8'))
const buf = readFileSync(join(root, 'public', 'embeddings.bin'))
const q = new Int8Array(buf.buffer, buf.byteOffset, buf.byteLength)
const { dim, scale } = meta
const N = companies.length
if (N !== meta.count) throw new Error('companies.json and embeddings.bin disagree — run `npm run data`')

// Dequantise once; the tiebreak compares against zone centroids.
const X = new Float32Array(N * dim)
for (let i = 0; i < N * dim; i++) X[i] = q[i] / scale

/** Score every zone against a company's tags; strongest rule wins. */
function zoneByRules(c) {
  const hay = c.categories.join(' ').toLowerCase()
  let best = null
  let bestHits = 0
  for (const z of ZONES) {
    const hits = c.categories.filter((t) => z.match.test(t.toLowerCase())).length
    if (hits > bestHits) { bestHits = hits; best = z.id }
  }
  if (best) return best
  // Nothing in the tags; try the description, which is looser but better than nothing.
  for (const z of ZONES) if (z.match.test(`${hay} ${c.description}`.toLowerCase())) return z.id
  return null
}

const assign = new Array(N).fill(null)
let byRule = 0
for (let i = 0; i < N; i++) {
  const z = zoneByRules(companies[i])
  if (z) { assign[i] = z; byRule++ }
}

// Zone centroids from the confidently-assigned rows, used to place the rest.
const centroids = new Map()
for (const z of ZONES) {
  const members = []
  for (let i = 0; i < N; i++) if (assign[i] === z.id) members.push(i)
  if (members.length < 5) continue
  const c = new Float32Array(dim)
  for (const i of members) for (let d = 0; d < dim; d++) c[d] += X[i * dim + d]
  let norm = 0
  for (let d = 0; d < dim; d++) norm += c[d] ** 2
  norm = Math.sqrt(norm) || 1
  for (let d = 0; d < dim; d++) c[d] /= norm
  centroids.set(z.id, c)
}

let byVector = 0
for (let i = 0; i < N; i++) {
  if (assign[i]) continue
  let best = -Infinity
  let bestZ = ZONES[0].id
  for (const [id, c] of centroids) {
    let s = 0
    for (let d = 0; d < dim; d++) s += X[i * dim + d] * c[d]
    if (s > best) { best = s; bestZ = id }
  }
  assign[i] = bestZ
  byVector++
}

console.log(`assigned ${byRule} by category rules, ${byVector} by nearest zone centroid`)

const clusters = ZONES.map((z) => {
  const members = companies.filter((_, i) => assign[i] === z.id)
  return {
    id: z.id,
    label: z.label,
    size: members.length,
    examples: members
      .slice()
      .sort((a, b) => (b.valuationUsd ?? 0) - (a.valuationUsd ?? 0))
      .slice(0, 4)
      .map((c) => c.name),
  }
}).filter((z) => z.size > 0)

companies.forEach((c, i) => { c.cluster = assign[i] })
writeFileSync(join(root, 'public', 'companies.json'), JSON.stringify(companies))
writeFileSync(join(root, 'public', 'clusters.json'), JSON.stringify(clusters, null, 2))

console.log(`\n${clusters.length} zones over ${N} companies:\n`)
for (const c of [...clusters].sort((a, b) => b.size - a.size)) {
  console.log(`  ${String(c.size).padStart(4)}  ${c.label.padEnd(22)} ${c.examples.slice(0, 3).join(', ')}`)
}
