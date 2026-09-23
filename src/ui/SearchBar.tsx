import { useEffect, useRef } from 'react'

const EXAMPLES = [
  'competitors of Whatfix',
  'digital adoption platforms',
  'competitors of Whatfix with revenue > $1B',
  'SaaS companies valued over $1B',
  'IT companies with revenue > $500M founded after 2015',
  'alternatives to WalkMe in Europe',
  'observability unicorns with more than 1000 employees',
  'European data governance companies founded after 2010',
]

export function SearchBar({
  value,
  onChange,
  onSubmit,
  busy,
  chips,
  count,
}: {
  value: string
  onChange: (v: string) => void
  onSubmit: () => void
  busy: boolean
  chips: string[]
  count: number | null
}) {
  const ref = useRef<HTMLInputElement>(null)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === '/' && document.activeElement !== ref.current) {
        e.preventDefault()
        ref.current?.focus()
      }
      if (e.key === 'Escape') ref.current?.blur()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  return (
    <div className="searchwrap">
      <div className={'search' + (busy ? ' is-busy' : '')}>
        <svg className="search-icon" viewBox="0 0 24 24" aria-hidden="true">
          <circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" />
        </svg>
        <input
          ref={ref}
          value={value}
          placeholder="competitors of Whatfix with revenue > $1B…"
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && onSubmit()}
          spellCheck={false}
          autoComplete="off"
        />
        {value && <button className="search-clear" onClick={() => onChange('')} aria-label="Clear">×</button>}
        <kbd className="search-kbd">/</kbd>
      </div>

      {chips.length > 0 && (
        <div className="chips chips-active">
          {chips.map((c) => <span className="chip chip-filter" key={c}>{c}</span>)}
          {count != null && <span className="chip chip-count">{count} match{count === 1 ? '' : 'es'}</span>}
        </div>
      )}

      {!value && (
        <div className="examples">
          {EXAMPLES.map((e) => (
            <button key={e} className="example" onClick={() => { onChange(e); queueMicrotask(onSubmit) }}>{e}</button>
          ))}
        </div>
      )}
    </div>
  )
}
