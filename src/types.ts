export type Region = 'North America' | 'Europe' | 'Asia' | 'Asia Pacific' | 'Middle East' | 'South America' | 'Africa'

export interface Company {
  id: string
  name: string
  domain: string
  description: string
  categories: string[]
  hqCity: string
  hqCountry: string
  region: Region
  founded: number | null
  employees: number | null
  stage: string
  ticker: string | null
  revenueUsd: number | null
  revenueEstimated: boolean
  valuationUsd: number | null
  valuationEstimated: boolean
  fundingTotalUsd: number | null
  isUnicorn: boolean
  competitors: string[]
  logo: string
  logoFallback: string
  searchText: string
}

export type NumericField = 'revenueUsd' | 'valuationUsd' | 'employees' | 'founded' | 'fundingTotalUsd'

export interface RangeFilter {
  field: NumericField
  min?: number
  max?: number
  /** The slice of the raw query this came from — rendered as a chip. */
  label: string
}

export interface ParsedQuery {
  raw: string
  /** What's left after filters are stripped — this is what gets embedded. */
  semantic: string
  ranges: RangeFilter[]
  regions: string[]
  countries: string[]
  stages: string[]
  /** Set when the query is "competitors of X" / "alternatives to X". */
  targetName: string | null
  unicornOnly: boolean
  /** Negated constraints: "SaaS companies that are not American". */
  excludeRegions: string[]
  excludeCountries: string[]
  excludeNames: string[]
}

export interface Hit {
  company: Company
  score: number
  confidence: number
  /** Why it matched — shown on the detail card. */
  reasons: string[]
  parts: { semantic: number; lexical: number; category: number; competitor: number }
}
