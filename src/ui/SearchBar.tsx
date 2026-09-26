import { useEffect, useMemo, useRef, useState } from 'react'

/** Chips shown at once. One "More" press advances by exactly this many. */
const PAGE = 9

export function SearchBar({
  value,
  onChange,
  onSubmit,
  busy,
  chips,
  count,
  suggestions,
}: {
  value: string
  onChange: (v: string) => void
  onSubmit: () => void
  busy: boolean
  chips: string[]
  count: number | null
  /** Every suggestion the dataset supports, showcase entries first. */
  suggestions: string[]
}) {
  const ref = useRef<HTMLInputElement>(null)
  const [page, setPage] = useState(0)

  const shown = useMemo(() => {
    if (!suggestions.length) return []
    const start = (page * PAGE) % suggestions.length
    const slice = suggestions.slice(start, start + PAGE)
    // Wrap rather than running short on the last page.
    return slice.length < PAGE ? [...slice, ...suggestions.slice(0, PAGE - slice.length)] : slice
  }, [suggestions, page])

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

      {!value && shown.length > 0 && (
        <div className="examples">
          {shown.map((e) => (
            <button key={e} className="example" onClick={() => { onChange(e); queueMicrotask(onSubmit) }}>{e}</button>
          ))}
          <button
            className="example example-more"
            onClick={() => setPage((p) => p + 1)}
            title="Show a different set of suggestions"
          >
            More ↻
          </button>
        </div>
      )}
    </div>
  )
}
