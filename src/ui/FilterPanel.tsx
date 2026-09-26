import { useEffect, useRef, useState } from 'react'
import type { Company } from '../types'
import { fmtMoney } from '../search/parse'

/**
 * Structured filters as controls, for people who would rather click than type.
 *
 * These compose *into the query string* rather than running a parallel filter
 * path — pressing a control appends "with revenue > $1B" to what you typed. One
 * code path decides what a filter means, the text box stays the source of
 * truth, and the URL keeps working as a shareable link.
 */

const REVENUE = [1e8, 5e8, 1e9, 1e10]
const VALUATION = [1e9, 1e10, 1e11]
const EMPLOYEES = [100, 1000, 10000]
const FOUNDED = [2000, 2010, 2015, 2020]

export function FilterPanel({
  companies,
  query,
  onChange,
}: {
  companies: Company[]
  query: string
  onChange: (q: string) => void
}) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false)
    document.addEventListener('mousedown', onDoc)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDoc)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  const regions = [...new Set(companies.map((c) => c.region))].filter((r) => r !== 'Unknown').sort()

  /** Append a clause, replacing any earlier clause of the same kind. */
  const apply = (clause: string, replaces: RegExp) => {
    const base = query.replace(replaces, '').replace(/\s+/g, ' ').trim()
    onChange(`${base} ${clause}`.trim())
  }

  return (
    <div className="filters" ref={ref}>
      <button className={'tool' + (open ? ' is-on' : '')} onClick={() => setOpen((o) => !o)}>
        Filters
      </button>

      {open && (
        <div className="filters-pop">
          <Group label="Revenue">
            {REVENUE.map((v) => (
              <Pill key={v} onClick={() => apply(`with revenue > ${fmtMoney(v)}`, /\bwith revenue [<>][^,]*/gi)}>
                &gt; {fmtMoney(v)}
              </Pill>
            ))}
          </Group>

          <Group label="Valuation">
            {VALUATION.map((v) => (
              <Pill key={v} onClick={() => apply(`valued over ${fmtMoney(v)}`, /\bvalued over \S+/gi)}>
                &gt; {fmtMoney(v)}
              </Pill>
            ))}
            <Pill onClick={() => apply('unicorns', /\bunicorns?\b/gi)}>🦄 unicorn</Pill>
          </Group>

          <Group label="Employees">
            {EMPLOYEES.map((n) => (
              <Pill key={n} onClick={() => apply(`with more than ${n} employees`, /\bwith more than [\d,]+k? employees/gi)}>
                &gt; {n.toLocaleString()}
              </Pill>
            ))}
          </Group>

          <Group label="Founded after">
            {FOUNDED.map((y) => (
              <Pill key={y} onClick={() => apply(`founded after ${y}`, /\bfounded (after|before|in) \d{4}/gi)}>
                {y}
              </Pill>
            ))}
          </Group>

          <Group label="Region">
            {regions.map((r) => (
              <Pill key={r} onClick={() => apply(`in ${r}`, new RegExp(`\\bin (${regions.join('|')})\\b`, 'gi'))}>
                {r}
              </Pill>
            ))}
          </Group>

          <button className="filters-clear" onClick={() => onChange('')}>
            Clear everything
          </button>
        </div>
      )}
    </div>
  )
}

function Group({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="filter-group">
      <span className="filter-label">{label}</span>
      <div className="filter-pills">{children}</div>
    </div>
  )
}

function Pill({ onClick, children }: { onClick: () => void; children: React.ReactNode }) {
  return (
    <button className="filter-pill" onClick={onClick}>
      {children}
    </button>
  )
}
