#!/usr/bin/env node
/**
 * Bulk-ingest IT/SaaS companies from Wikipedia + Wikidata into a seed slice.
 *
 *   node scripts/ingest-wikipedia.mjs --limit 4000        # writes data/seed/90-wikipedia.json
 *   node scripts/ingest-wikipedia.mjs --dry               # counts only, writes nothing
 *
 * Why Wikipedia and not a SPARQL dump: semantic search lives or dies on the
 * description. Wikipedia's intro paragraph ("Datadog is an American company
 * that provides an observability service for cloud-scale applications…") is a
 * real sentence about what the company sells. Wikidata's one-liner ("American
 * software company") is not, and a corpus full of those makes every vector
 * neighbour look plausible and none of them useful.
 *
 * Pipeline per company:
 *   category members  → the candidate list
 *   prop=extracts     → the description (batched 20/call)
 *   wbgetentities     → website, founded, employees, country, industry (50/call)
 *
 * Curated rows in data/seed/0*.json always win; anything already covered by
 * domain or id is skipped.
 */
import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const UA = 'logopile-dataset/0.1 (https://github.com/RehmanaliMomin/logopile)'
const WP = 'https://en.wikipedia.org/w/api.php'
const WD = 'https://www.wikidata.org/w/api.php'

const args = process.argv.slice(2)
const LIMIT = Number(args[args.indexOf('--limit') + 1]) || 4000
const DRY = args.includes('--dry')

/** Wikipedia categories to sweep. Ordered roughly by how on-topic they are. */
const CATEGORIES = [
  'Software companies of the United States',
  'Cloud computing providers',
  'Computer security companies',
  'Software as a service',
  'Business software companies',
  'Enterprise software companies',
  'Information technology consulting firms',
  'Companies-of-the-United-States-by-industry-placeholder', // replaced below
  'Software companies of India',
  'Software companies of the United Kingdom',
  'Software companies of Germany',
  'Software companies of France',
  'Software companies of Israel',
  'Software companies of Canada',
  'Software companies of Australia',
  'Software companies of the Netherlands',
  'Software companies of Sweden',
  'Software companies of Ireland',
  'Software companies of Spain',
  'Software companies of Japan',
  'Software companies of Singapore',
  'Financial technology companies',
  'Data management software companies',
  'Customer relationship management software companies',
  'Web development software companies',
  'Artificial intelligence companies',
  'Internet technology companies',
  'Big data companies',
  'Companies providing DevOps tools',
  'Software companies of Switzerland',
  'Software companies of Denmark',
  'Software companies of Norway',
  'Software companies of Finland',
  'Software companies of Poland',
  'Software companies of Italy',
  'Software companies of Belgium',
  'Software companies of Austria',
  'Software companies of Brazil',
  'Software companies of China',
  'Software companies of Japan',
  'Software companies of South Korea',
  'Software companies of Estonia',
  'Software companies of Czechia',
  'Software companies of Portugal',
  'Software companies of New Zealand',
  'Computer companies of the United States',
  'Web service providers',
  'Project management software companies',
  'Health software companies',
  'Educational software companies',
  'Supply chain software companies',
  'Human resource management software companies',
  'Marketing automation companies',
  'E-commerce companies',
  'Database companies',
  'Networking hardware companies',
  'Semiconductor companies',
  'Outsourcing companies',
  'Telecommunications companies',
].filter((c) => !c.includes('placeholder'))

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function api(base, params) {
  const url = new URL(base)
  for (const [k, v] of Object.entries({ format: 'json', origin: '*', ...params })) url.searchParams.set(k, v)
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': UA } })
      if (res.status === 429 || res.status >= 500) { await sleep(1200 * (attempt + 1)); continue }
      if (!res.ok) return null
      return await res.json()
    } catch {
      await sleep(800 * (attempt + 1))
    }
  }
  return null
}

// ---------------------------------------------------------------- discover --
const titles = new Map() // title -> Set(category)
for (const cat of CATEGORIES) {
  let cont
  let got = 0
  do {
    const r = await api(WP, {
      action: 'query', list: 'categorymembers', cmtitle: `Category:${cat}`,
      cmlimit: '500', cmnamespace: '0', ...(cont ? { cmcontinue: cont } : {}),
    })
    const members = r?.query?.categorymembers ?? []
    for (const m of members) {
      if (!titles.has(m.title)) titles.set(m.title, new Set())
      titles.get(m.title).add(cat)
    }
    got += members.length
    cont = r?.continue?.cmcontinue
    await sleep(60)
  } while (cont && got < 3000)
  process.stdout.write(`\r  categories: ${titles.size} unique titles`)
}
console.log(`\n✓ ${titles.size} candidate pages from ${CATEGORIES.length} categories`)

// ------------------------------------------------------- extracts + wikibase
const all = [...titles.keys()].slice(0, LIMIT)
const pages = new Map()

for (let i = 0; i < all.length; i += 20) {
  const batch = all.slice(i, i + 20)
  const r = await api(WP, {
    action: 'query', prop: 'extracts|pageprops', exintro: '1', explaintext: '1',
    exsentences: '3', titles: batch.join('|'), ppprop: 'wikibase_item',
  })
  for (const p of Object.values(r?.query?.pages ?? {})) {
    if (!p.extract || p.missing !== undefined) continue
    pages.set(p.title, { title: p.title, extract: p.extract, qid: p.pageprops?.wikibase_item ?? null })
  }
  process.stdout.write(`\r  extracts: ${pages.size}/${Math.min(i + 20, all.length)}`)
  await sleep(60)
}
console.log(`\n✓ ${pages.size} pages with an intro extract`)

const qids = [...pages.values()].map((p) => p.qid).filter(Boolean)
const facts = new Map()
for (let i = 0; i < qids.length; i += 50) {
  const batch = qids.slice(i, i + 50)
  const r = await api(WD, {
    action: 'wbgetentities', ids: batch.join('|'),
    props: 'claims', languages: 'en',
  })
  for (const [qid, ent] of Object.entries(r?.entities ?? {})) facts.set(qid, ent.claims ?? {})
  process.stdout.write(`\r  wikidata: ${facts.size}/${qids.length}`)
  await sleep(60)
}
console.log(`\n✓ ${facts.size} entities with claims`)

// Resolve the country and industry QIDs we actually saw, in one pass.
const refQids = new Set()
for (const claims of facts.values()) {
  for (const prop of ['P17', 'P452']) {
    for (const c of claims[prop] ?? []) {
      const id = c.mainsnak?.datavalue?.value?.id
      if (id) refQids.add(id)
    }
  }
}
const labels = new Map()
const refList = [...refQids]
for (let i = 0; i < refList.length; i += 50) {
  const r = await api(WD, {
    action: 'wbgetentities', ids: refList.slice(i, i + 50).join('|'),
    props: 'labels', languages: 'en',
  })
  for (const [qid, ent] of Object.entries(r?.entities ?? {})) {
    if (ent.labels?.en?.value) labels.set(qid, ent.labels.en.value)
  }
  await sleep(60)
}
console.log(`✓ ${labels.size} country/industry labels resolved`)

// ------------------------------------------------------------------ shape ---
const REGION_BY_COUNTRY = {
  'United States': 'North America', 'United States of America': 'North America',
  Canada: 'North America', Mexico: 'North America',
  'United Kingdom': 'Europe', Germany: 'Europe', France: 'Europe', Netherlands: 'Europe',
  Sweden: 'Europe', Denmark: 'Europe', Norway: 'Europe', Finland: 'Europe', Ireland: 'Europe',
  Spain: 'Europe', Italy: 'Europe', Belgium: 'Europe', Austria: 'Europe', Switzerland: 'Europe',
  Poland: 'Europe', Portugal: 'Europe', Czechia: 'Europe', 'Czech Republic': 'Europe',
  Slovakia: 'Europe', Estonia: 'Europe', Luxembourg: 'Europe', Malta: 'Europe', Romania: 'Europe',
  Israel: 'Middle East', 'United Arab Emirates': 'Middle East', Turkey: 'Middle East',
  India: 'Asia', China: 'Asia', Japan: 'Asia', Singapore: 'Asia', 'South Korea': 'Asia',
  Taiwan: 'Asia', Indonesia: 'Asia', Vietnam: 'Asia', Philippines: 'Asia', Malaysia: 'Asia',
  Australia: 'Asia Pacific', 'New Zealand': 'Asia Pacific',
  Brazil: 'South America', Argentina: 'South America', Chile: 'South America', Colombia: 'South America',
  'South Africa': 'Africa', Nigeria: 'Africa', Kenya: 'Africa', Egypt: 'Africa',
}

const claimValue = (claims, prop) => claims?.[prop]?.[0]?.mainsnak?.datavalue?.value
const claimIds = (claims, prop) =>
  (claims?.[prop] ?? []).map((c) => c.mainsnak?.datavalue?.value?.id).filter(Boolean)

function domainOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '').toLowerCase()
  } catch { return null }
}

function slug(name) {
  return name.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 40)
}

// Curated rows are authoritative — never shadow one.
const taken = { ids: new Set(), domains: new Set() }
for (const f of readdirSync(join(root, 'data', 'seed')).filter((f) => /^0\d/.test(f))) {
  for (const row of JSON.parse(readFileSync(join(root, 'data', 'seed', f), 'utf8'))) {
    taken.ids.add(row.id)
    taken.domains.add(row.domain.toLowerCase())
  }
}

const rejected = { noWebsite: 0, noDescription: 0, duplicate: 0, notACompany: 0, shortDescription: 0, sharedDomain: 0 }
const out = []
/** domain -> index in `out`, so a second claimant can be compared, not blindly added. */
const byDomain = new Map()

/** Does this page's name plausibly own this domain? "AdMob" does not own google.com. */
function ownsDomain(name, domain) {
  const host = domain.split('.')[0].replace(/[^a-z0-9]/g, '')
  const n = name.toLowerCase().replace(/[^a-z0-9]/g, '')
  return host.includes(n) || n.includes(host)
}

for (const page of pages.values()) {
  const claims = page.qid ? facts.get(page.qid) : null
  const website = claimValue(claims, 'P856')
  const domain = website ? domainOf(website) : null
  if (!domain) { rejected.noWebsite++; continue }

  const name = page.title.replace(/\s*\([^)]*\)\s*$/, '').trim()
  const id = slug(name)
  if (!id || taken.ids.has(id) || taken.domains.has(domain)) { rejected.duplicate++; continue }

  // The extract has to actually describe a company, not a product or a concept.
  const description = page.extract.replace(/\s+/g, ' ').trim()
  if (description.length < 80) { rejected.shortDescription++; continue }
  if (!/\b(company|corporation|firm|provider|vendor|startup|platform|software|technology|Inc|Ltd|GmbH|SA|business)\b/i.test(description)) {
    rejected.notACompany++
    continue
  }

  // A subsidiary page ("AdMob") often carries the parent's website. Whoever
  // actually owns the hostname keeps it; the other is dropped rather than
  // shipped as a second logo pointing at the same brand.
  const prior = byDomain.get(domain)
  if (prior !== undefined) {
    const challengerOwns = ownsDomain(name, domain)
    const incumbentOwns = ownsDomain(out[prior].name, domain)
    if (challengerOwns && !incumbentOwns) {
      rejected.sharedDomain++
      out[prior] = null
    } else {
      rejected.sharedDomain++
      continue
    }
  }

  const countryQid = claimIds(claims, 'P17')[0]
  const hqCountry = countryQid ? labels.get(countryQid) ?? null : null
  const industries = claimIds(claims, 'P452').map((q) => labels.get(q)).filter(Boolean)
  const categories = [...new Set([...industries.map((s) => s.toLowerCase()), ...[...(titles.get(page.title) ?? [])].map(categoryToTag)].filter(Boolean))]

  const inception = claimValue(claims, 'P571')?.time
  const founded = inception ? Number(inception.slice(1, 5)) || null : null
  const employees = Number(claimValue(claims, 'P1128')?.amount?.replace('+', '')) || null

  byDomain.set(domain, out.length)
  out.push({
    id,
    name,
    domain,
    description: description.length > 420 ? description.slice(0, 417).replace(/\s\S*$/, '') + '…' : description,
    categories: categories.length ? categories.slice(0, 8) : ['software'],
    hqCity: '',
    hqCountry: hqCountry ?? 'Unknown',
    region: REGION_BY_COUNTRY[hqCountry] ?? 'Unknown',
    founded: founded && founded > 1800 && founded <= new Date().getFullYear() ? founded : null,
    employees: employees && employees > 0 ? employees : null,
    stage: 'unknown',
    ticker: null,
    revenueUsd: null,
    revenueEstimated: true,
    valuationUsd: null,
    valuationEstimated: true,
    fundingTotalUsd: null,
    competitors: [],
    source: 'wikipedia',
  })
}

function categoryToTag(cat) {
  const c = cat.toLowerCase()
  if (c.includes('cloud computing')) return 'cloud computing'
  if (c.includes('computer security')) return 'cybersecurity'
  if (c.includes('software as a service')) return 'saas'
  if (c.includes('enterprise software')) return 'enterprise software'
  if (c.includes('business software')) return 'business software'
  if (c.includes('consulting')) return 'it services'
  if (c.includes('financial technology')) return 'fintech'
  if (c.includes('artificial intelligence')) return 'ai'
  if (c.includes('data management')) return 'data management'
  if (c.includes('customer relationship')) return 'crm'
  if (c.includes('big data')) return 'data platform'
  if (c.includes('devops')) return 'devops'
  if (c.includes('web development')) return 'developer tools'
  if (c.includes('internet technology')) return 'internet'
  return 'software'
}

// Drop rows displaced by a better claimant on the same domain.
for (let i = out.length - 1; i >= 0; i--) if (out[i] === null) out.splice(i, 1)

console.log('\n--- yield ---')
console.log(`accepted           ${out.length}`)
for (const [k, v] of Object.entries(rejected)) console.log(`rejected ${k.padEnd(18)}${v}`)
const withCountry = out.filter((c) => c.hqCountry !== 'Unknown').length
const withFounded = out.filter((c) => c.founded).length
const withEmployees = out.filter((c) => c.employees).length
const avgDesc = Math.round(out.reduce((a, c) => a + c.description.length, 0) / Math.max(1, out.length))
console.log(`\nwith country ${withCountry} · founded ${withFounded} · employees ${withEmployees} · avg description ${avgDesc} chars`)

if (DRY) {
  console.log('\ndry run — sample:')
  for (const c of out.slice(0, 5)) console.log(`  ${c.name} (${c.domain}) [${c.categories.join(', ')}]\n    ${c.description.slice(0, 150)}…`)
} else {
  out.sort((a, b) => a.id.localeCompare(b.id))
  writeFileSync(join(root, 'data', 'seed', '90-wikipedia.json'), '[\n' + out.map((c) => JSON.stringify(c)).join(',\n') + '\n]')
  console.log(`\n✓ wrote data/seed/90-wikipedia.json (${out.length} companies)`)
  console.log('  next: npm run data')
}
