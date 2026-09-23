import type { ParsedQuery, RangeFilter, NumericField } from '../types'

/**
 * Turn "competitors of Whatfix with revenue > $1B founded after 2015 in Europe"
 * into a target + hard filters + the leftover semantic text.
 *
 * Everything a pattern consumes is cut out of the string, so whatever survives
 * is genuinely the "what kind of company" part and nothing else.
 */

const MULT: Record<string, number> = {
  k: 1e3, thousand: 1e3,
  m: 1e6, mm: 1e6, million: 1e6,
  b: 1e9, bn: 1e9, billion: 1e9,
  t: 1e12, trillion: 1e12,
}

const MONEY = String.raw`\$?\s*([\d,]+(?:\.\d+)?)\s*(k|m|mm|bn|b|t|thousand|million|billion|trillion)?`
const GT = String.raw`(?:>|>=|over|above|more than|greater than|at least|north of)`
const LT = String.raw`(?:<|<=|under|below|less than|fewer than|at most|up to)`

const REGION_ALIASES: Record<string, string> = {
  europe: 'Europe', european: 'Europe', eu: 'Europe', emea: 'Europe',
  'north america': 'North America', america: 'North America', american: 'North America',
  us: 'North America', usa: 'North America', 'the us': 'North America', 'united states': 'North America',
  asia: 'Asia', asian: 'Asia', apac: 'Asia Pacific', 'asia pacific': 'Asia Pacific',
  india: 'Asia', indian: 'Asia',
  israel: 'Middle East', israeli: 'Middle East', 'middle east': 'Middle East',
}

const COUNTRY_WORDS: Record<string, string> = {
  germany: 'Germany', german: 'Germany', france: 'France', french: 'France',
  uk: 'United Kingdom', britain: 'United Kingdom', british: 'United Kingdom', england: 'United Kingdom',
  india: 'India', israel: 'Israel', canada: 'Canada', canadian: 'Canada',
  netherlands: 'Netherlands', dutch: 'Netherlands', spain: 'Spain', sweden: 'Sweden',
  denmark: 'Denmark', danish: 'Denmark', australia: 'Australia', australian: 'Australia',
  ireland: 'Ireland', italy: 'Italy', italian: 'Italy', belgium: 'Belgium', austria: 'Austria',
  norway: 'Norway', singapore: 'Singapore', czechia: 'Czechia', slovakia: 'Slovakia', malta: 'Malta',
  luxembourg: 'Luxembourg', switzerland: 'Switzerland', poland: 'Poland', portugal: 'Portugal',
}

const STAGE_WORDS: Record<string, string> = {
  public: 'public', listed: 'public', 'publicly traded': 'public',
  private: 'private', bootstrapped: 'bootstrapped', acquired: 'acquired',
  seed: 'seed', 'series a': 'series-a', 'series b': 'series-b', 'series c': 'series-c',
  'series d': 'series-d', 'series e': 'series-e', 'series f': 'series-f', 'series g': 'series-g',
  'late stage': 'late-stage', 'late-stage': 'late-stage',
}

function money(num: string, unit?: string): number {
  return parseFloat(num.replace(/,/g, '')) * (unit ? MULT[unit.toLowerCase()] ?? 1 : 1)
}

export function parseQuery(raw: string): ParsedQuery {
  let s = ' ' + raw.toLowerCase().trim() + ' '
  const ranges: RangeFilter[] = []
  const regions: string[] = []
  const countries: string[] = []
  const stages: string[] = []
  let targetName: string | null = null
  let unicornOnly = false

  const eat = (re: RegExp, fn: (m: RegExpMatchArray) => void) => {
    let m: RegExpMatchArray | null
    while ((m = s.match(re))) {
      fn(m)
      s = s.slice(0, m.index!) + ' ' + s.slice(m.index! + m[0].length)
    }
  }

  // --- competitor / alternative intent (runs first; it owns the tail) -------
  const compRe = /\b(?:competitors?|alternatives?|rivals?|similar companies)\s+(?:of|to|for)\s+([a-z0-9][a-z0-9 .&'-]*?)(?=\s+(?:with|that|which|in|having|over|under|above|below|valued|founded|raising|raised|by|and|,)\b|$)/
  let m = s.match(compRe)
  if (!m) m = s.match(/\b(?:companies\s+)?(?:similar|comparable)\s+to\s+([a-z0-9][a-z0-9 .&'-]*?)(?=\s+(?:with|that|which|in|having|over|under|above|below|valued|founded|and|,)\b|$)/)
  if (!m) m = s.match(/\b([a-z0-9][a-z0-9 .&'-]*?)\s+(?:competitors|alternatives|rivals)\b/)
  if (m) {
    targetName = m[1].trim()
    s = s.slice(0, m.index!) + ' ' + s.slice(m.index! + m[0].length)
  }

  // --- numeric ranges -------------------------------------------------------
  const numeric: Array<[NumericField, string]> = [
    ['revenueUsd', String.raw`(?:annual\s+)?(?:revenue|arr|sales|turnover)`],
    ['valuationUsd', String.raw`(?:valuation|valued|market cap|worth)`],
    ['fundingTotalUsd', String.raw`(?:funding|raised|total funding|capital raised)`],
  ]
  for (const [field, word] of numeric) {
    eat(new RegExp(String.raw`\b${word}\s*(?:at|of|is)?\s*(?:between)\s+${MONEY}\s*(?:and|-|to)\s*${MONEY}`), (mm) =>
      ranges.push({ field, min: money(mm[1], mm[2]), max: money(mm[3], mm[4]), label: mm[0].trim() }),
    )
    eat(new RegExp(String.raw`\b${word}\s*(?:at|of|is)?\s*${GT}\s*${MONEY}`), (mm) =>
      ranges.push({ field, min: money(mm[1], mm[2]), label: mm[0].trim() }),
    )
    eat(new RegExp(String.raw`\b${word}\s*(?:at|of|is)?\s*${LT}\s*${MONEY}`), (mm) =>
      ranges.push({ field, max: money(mm[1], mm[2]), label: mm[0].trim() }),
    )
    // "$1B+ revenue" / "over $1B in revenue"
    eat(new RegExp(String.raw`\b${GT}\s*${MONEY}\s*(?:in\s+)?${word}`), (mm) =>
      ranges.push({ field, min: money(mm[1], mm[2]), label: mm[0].trim() }),
    )
    eat(new RegExp(String.raw`${MONEY}\s*\+\s*(?:in\s+)?${word}`), (mm) =>
      ranges.push({ field, min: money(mm[1], mm[2]), label: mm[0].trim() }),
    )
  }

  eat(/\bunicorns?\b/, () => { unicornOnly = true })

  // employees
  eat(new RegExp(String.raw`\b${GT}\s*([\d,]+)\s*(?:k\b)?\s*(?:employees|people|headcount|staff)`), (mm) =>
    ranges.push({ field: 'employees', min: parseFloat(mm[1].replace(/,/g, '')) * (/k\b/.test(mm[0]) ? 1000 : 1), label: mm[0].trim() }),
  )
  eat(new RegExp(String.raw`\b${LT}\s*([\d,]+)\s*(?:k\b)?\s*(?:employees|people|headcount|staff)`), (mm) =>
    ranges.push({ field: 'employees', max: parseFloat(mm[1].replace(/,/g, '')) * (/k\b/.test(mm[0]) ? 1000 : 1), label: mm[0].trim() }),
  )
  eat(/\b([\d,]+)\s*\+\s*(?:employees|people|headcount|staff)/, (mm) =>
    ranges.push({ field: 'employees', min: parseFloat(mm[1].replace(/,/g, '')), label: mm[0].trim() }),
  )

  // founded year
  eat(/\bfounded\s+(?:between)\s+(\d{4})\s*(?:and|-|to)\s*(\d{4})/, (mm) =>
    ranges.push({ field: 'founded', min: +mm[1], max: +mm[2], label: mm[0].trim() }),
  )
  eat(/\b(?:founded|started|established|launched)\s*(?:in)?\s*(?:after|since|post|>|>=|later than)\s*(\d{4})/, (mm) =>
    ranges.push({ field: 'founded', min: +mm[1], label: mm[0].trim() }),
  )
  eat(/\b(?:founded|started|established|launched)\s*(?:in)?\s*(?:before|prior to|pre|<|<=|earlier than)\s*(\d{4})/, (mm) =>
    ranges.push({ field: 'founded', max: +mm[1], label: mm[0].trim() }),
  )
  eat(/\b(?:founded|started|established|launched)\s+in\s+(\d{4})\b/, (mm) =>
    ranges.push({ field: 'founded', min: +mm[1], max: +mm[1], label: mm[0].trim() }),
  )

  // --- geography ------------------------------------------------------------
  for (const [word, country] of Object.entries(COUNTRY_WORDS)) {
    eat(new RegExp(String.raw`\b(?:in|from|based in|hq in|headquartered in)\s+(?:the\s+)?${word}\b`), () => {
      countries.push(country)
    })
  }
  for (const [word, region] of Object.entries(REGION_ALIASES)) {
    eat(new RegExp(String.raw`\b(?:in|from|based in|hq in|headquartered in|across)\s+(?:the\s+)?${word}\b`), () => {
      regions.push(region)
    })
  }
  // bare adjectives: "european SaaS companies", "indian IT services"
  for (const [word, region] of Object.entries(REGION_ALIASES)) {
    if (!/(?:ean|ian|ish|can)$/.test(word)) continue
    eat(new RegExp(String.raw`\b${word}\b`), () => { regions.push(region) })
  }

  // --- stage ----------------------------------------------------------------
  for (const [word, stage] of Object.entries(STAGE_WORDS)) {
    eat(new RegExp(String.raw`\b${word}(?=\s+(?:compan|business|firm|startup|saas|tech)|\s*$)`), () => { stages.push(stage) })
  }

  const semantic = s
    .replace(/\b(?:companies|company|startups?|firms?|businesses|show me|find|list|the|that|which|with|and|are|is|of|in|a|an|any|all)\b/g, ' ')
    .replace(/[^a-z0-9 .&+-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()

  return {
    raw,
    semantic,
    ranges,
    regions: [...new Set(regions)],
    countries: [...new Set(countries)],
    stages: [...new Set(stages)],
    targetName,
    unicornOnly,
  }
}

export function describeFilters(q: ParsedQuery): string[] {
  const out: string[] = []
  if (q.targetName) out.push(`competitors of ${q.targetName}`)
  for (const r of q.ranges) out.push(prettyRange(r))
  if (q.unicornOnly) out.push('unicorn (≥ $1B)')
  for (const r of q.regions) out.push(r)
  for (const c of q.countries) out.push(c)
  for (const s of q.stages) out.push(s)
  return out
}

const FIELD_LABEL: Record<NumericField, string> = {
  revenueUsd: 'revenue',
  valuationUsd: 'valuation',
  employees: 'employees',
  founded: 'founded',
  fundingTotalUsd: 'funding',
}

export function prettyRange(r: RangeFilter): string {
  const isMoney = r.field !== 'employees' && r.field !== 'founded'
  const v = (n: number) => (isMoney ? fmtMoney(n) : String(n))
  const label = FIELD_LABEL[r.field]
  if (r.min != null && r.max != null) return r.min === r.max ? `${label} ${v(r.min)}` : `${label} ${v(r.min)}–${v(r.max)}`
  if (r.min != null) return `${label} ≥ ${v(r.min)}`
  return `${label} ≤ ${v(r.max!)}`
}

export function fmtMoney(n: number): string {
  if (n >= 1e12) return `$${(n / 1e12).toFixed(n % 1e12 === 0 ? 0 : 1)}T`
  if (n >= 1e9) return `$${(n / 1e9).toFixed(n % 1e9 === 0 ? 0 : 1)}B`
  if (n >= 1e6) return `$${Math.round(n / 1e6)}M`
  if (n >= 1e3) return `$${Math.round(n / 1e3)}K`
  return `$${n}`
}
