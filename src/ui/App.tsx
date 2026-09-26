import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Company, Hit } from '../types'
import { loadDataset, loadVectors, type Dataset } from '../data/load'
import { Ranker, type SearchResult } from '../search/rank'
import { describeFilters } from '../search/parse'
import { warmUp } from '../search/embed'
import { buildSuggestions, PINNED_SUGGESTIONS, shuffleTail } from '../search/suggestions'
import { layaEnabled } from '../search/laya'
import { Pile } from '../physics/pile'
import { SearchBar } from './SearchBar'
import { FilterPanel } from './FilterPanel'
import { DetailCard } from './DetailCard'

export function App() {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const pileRef = useRef<Pile | null>(null)
  const rankerRef = useRef<Ranker | null>(null)
  const seqRef = useRef(0)

  const [ds, setDs] = useState<Dataset | null>(null)
  // The query lives in the URL so a search can be linked to and survives reload.
  const [query, setQuery] = useState(() => new URLSearchParams(window.location.search).get('q') ?? '')
  const [result, setResult] = useState<SearchResult | null>(null)
  const [busy, setBusy] = useState(false)
  const [selected, setSelected] = useState<Company | null>(null)
  const [hovered, setHovered] = useState<Company | null>(null)
  const [semanticReady, setSemanticReady] = useState(false)
  const [tilt, setTilt] = useState(false)
  const [lean, setLean] = useState(false)
  const [note, setNote] = useState<string | null>(null)
  const [sorting, setSorting] = useState(false)

  // ---- boot ---------------------------------------------------------------
  useEffect(() => {
    let pile: Pile | null = null
    let cancelled = false
    ;(async () => {
      const dataset = await loadDataset()
      if (cancelled) return
      rankerRef.current = new Ranker(dataset)
      setDs(dataset)

      if (canvasRef.current) {
        pile = new Pile(canvasRef.current, dataset.companies, {
          onSelect: (c) => setSelected(c),
          onHover: (c) => setHovered(c),
          // Matter.js is comfortable with a few hundred colliding bodies, not a
          // few thousand. The heap shows the most prominent slice; everything
          // else is still searchable and spawns in when it matches.
          //
          // Scaled to the viewport: 500 bodies is right on a laptop and buries a
          // phone, where the same heap filled the screen and left room for three
          // results out of twenty-four.
          maxBodies: bodyBudget(),
        })
        pile.setZones(dataset.zones)
        pileRef.current = pile
        // Handy for poking at the simulation from the console during dev.
        if (import.meta.env.DEV) (window as unknown as { pile: Pile }).pile = pile
      }

      // Vectors + model are a progressive upgrade; lexical search works now.
      await loadVectors(dataset)
      await warmUp()
      if (!cancelled) setSemanticReady(true)
    })().catch((err) => console.error('[logopile] boot failed:', err))

    const onResize = () => pileRef.current?.resize()
    window.addEventListener('resize', onResize)
    return () => {
      cancelled = true
      window.removeEventListener('resize', onResize)
      pile?.destroy()
    }
  }, [])

  // ---- search -------------------------------------------------------------
  const run = useCallback(async (raw: string) => {
    const ranker = rankerRef.current
    if (!ranker) return
    const q = raw.trim()
    const seq = ++seqRef.current
    if (!q) {
      setResult(null)
      setSelected(null)
      pileRef.current?.clear()
      return
    }
    setBusy(true)
    const res = await ranker.search(q)
    if (seq !== seqRef.current) return // a newer query already landed
    setResult(res)
    pileRef.current?.show(res.hits)
    setBusy(false)
  }, [])

  // Debounced as-you-type, immediate on Enter.
  useEffect(() => {
    const t = setTimeout(() => run(query), 260)
    return () => clearTimeout(t)
  }, [query, run])

  // Mirror the query into the address bar, replacing rather than pushing so the
  // back button still leaves the page instead of walking every keystroke.
  useEffect(() => {
    const url = new URL(window.location.href)
    if (query.trim()) url.searchParams.set('q', query.trim())
    else url.searchParams.delete('q')
    if (url.toString() !== window.location.href) window.history.replaceState(null, '', url)
  }, [query])

  // Back/forward and pasted links.
  useEffect(() => {
    const onPop = () => setQuery(new URLSearchParams(window.location.search).get('q') ?? '')
    window.addEventListener('popstate', onPop)
    return () => window.removeEventListener('popstate', onPop)
  }, [])

  // Re-run once embeddings land so the first query upgrades itself.
  useEffect(() => {
    if (semanticReady && query.trim()) run(query)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [semanticReady])

  // ---- device tilt --------------------------------------------------------
  // Macs have no accelerometer: the Sudden Motion Sensor existed to park
  // spinning hard drives and left with them. But feature detection cannot see
  // that — on a secure origin, macOS Chrome *defines* DeviceOrientationEvent
  // and simply never fires it. So the only honest test is to subscribe and see
  // whether anything arrives. This button used to light up and do nothing.
  const toggleTilt = useCallback(async () => {
    if (tilt) {
      setTilt(false)
      pileRef.current?.setGravity(0, 1)
      return
    }
    const DOE = window.DeviceOrientationEvent as unknown as { requestPermission?: () => Promise<string> } | undefined
    if (DOE?.requestPermission) {
      const ok = await DOE.requestPermission().catch(() => 'denied')
      if (ok !== 'granted') {
        setNote('Motion access denied.')
        setTimeout(() => setNote(null), 4000)
        return
      }
    }
    if (!('DeviceOrientationEvent' in window)) {
      setNote('No motion sensor here — try Lean, or open this on a phone.')
      setTimeout(() => setNote(null), 4500)
      return
    }

    // Listen briefly. Silence means there is no sensor behind the API.
    const heard = await new Promise<boolean>((resolve) => {
      let done = false
      const onEvent = (e: DeviceOrientationEvent) => {
        if (done) return
        // A sensorless platform can still emit one all-null event.
        if (e.beta == null && e.gamma == null) return
        done = true
        cleanup()
        resolve(true)
      }
      const timer = setTimeout(() => {
        if (done) return
        done = true
        cleanup()
        resolve(false)
      }, 1200)
      const cleanup = () => {
        clearTimeout(timer)
        window.removeEventListener('deviceorientation', onEvent)
      }
      window.addEventListener('deviceorientation', onEvent)
    })

    if (!heard) {
      setNote('No motion sensor here — try Lean, or open this on a phone.')
      setTimeout(() => setNote(null), 4500)
      return
    }
    setTilt(true)
  }, [tilt])

  // ---- lean: the pointer becomes the horizon -------------------------------
  useEffect(() => {
    if (!lean) {
      pileRef.current?.setGravity(0, 1)
      return
    }
    const onMove = (e: PointerEvent) => {
      const tx = clamp((e.clientX / window.innerWidth) * 2 - 1, -1, 1)
      const ty = clamp((e.clientY / window.innerHeight) * 2 - 1, -1, 1)
      // Keep the pull roughly constant in magnitude so the heap slides rather
      // than floating when you reach the edge.
      pileRef.current?.setGravity(tx * 0.95, Math.max(0.25, 1 - Math.abs(tx) * 0.45 + ty * 0.25))
    }
    window.addEventListener('pointermove', onMove)
    return () => {
      window.removeEventListener('pointermove', onMove)
      pileRef.current?.setGravity(0, 1)
    }
  }, [lean])

  // ---- trackpad swipe: a shove that rights itself --------------------------
  useEffect(() => {
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      pileRef.current?.nudgeGravity(e.deltaX * 0.004, e.deltaY * 0.002)
    }
    window.addEventListener('wheel', onWheel, { passive: false })
    return () => window.removeEventListener('wheel', onWheel)
  }, [])

  useEffect(() => {
    if (!tilt) return
    const onOrient = (e: DeviceOrientationEvent) => {
      const gamma = (e.gamma ?? 0) / 45 // left/right
      const beta = (e.beta ?? 45) / 45 // front/back
      pileRef.current?.setGravity(clamp(gamma, -1, 1), clamp(beta, -1, 1.4))
    }
    window.addEventListener('deviceorientation', onOrient)
    return () => {
      window.removeEventListener('deviceorientation', onOrient)
      pileRef.current?.setGravity(0, 1)
    }
  }, [tilt])

  // Built once from the corpus; the showcase entries stay pinned at the front and
  // everything else is shuffled so a reload offers a different slice.
  const suggestions = useMemo(
    () => (ds ? shuffleTail(buildSuggestions(ds.companies), PINNED_SUGGESTIONS) : []),
    [ds],
  )

  const hitById = useMemo(() => new Map(result?.hits.map((h) => [h.company.id, h]) ?? []), [result])
  const chips = result ? describeFilters(result.parsed) : []
  const showcase: Hit[] = result?.hits ?? []

  return (
    <div className="app">
      <canvas ref={canvasRef} className="stage" />

      <header className="topbar">
        <div className="brand">
          <span className="brand-dot" />
          <span className="brand-name">Logo Pile</span>
          <span className="brand-sub">
            {ds ? `${ds.companies.length.toLocaleString()} IT · SaaS companies` : 'loading…'}
          </span>
        </div>

        <SearchBar
          value={query}
          onChange={setQuery}
          onSubmit={() => run(query)}
          busy={busy}
          chips={chips}
          count={result ? result.hits.length : null}
          suggestions={suggestions}
        />

        <div className="tools">
          {ds && <FilterPanel companies={ds.companies} query={query} onChange={setQuery} />}
          <button
            className={'tool' + (sorting ? ' is-on' : '')}
            onClick={() => { const next = !sorting; setSorting(next); pileRef.current?.setSorting(next) }}
            title="Separate the pile into zones by what each company does"
          >
            Sort
          </button>
          <button className="tool" onClick={() => pileRef.current?.kick(1)} title="Shake the pile">Shake</button>
          <button
            className={'tool' + (lean ? ' is-on' : '')}
            onClick={() => setLean((l) => !l)}
            title="The pile leans toward your cursor"
          >
            Lean
          </button>
          <button
            className={'tool' + (tilt ? ' is-on' : '')}
            onClick={toggleTilt}
            title="Tilt your phone or tablet to shake the pile"
          >
            Tilt
          </button>
        </div>
      </header>

      {result && result.hits.length === 0 && (
        <div className="empty">
          <strong>No matches.</strong>
          <span>
            {result.parsed.targetName && !result.target
              ? `"${result.parsed.targetName}" isn't in the dataset yet — add it to data/seed/ and re-run npm run data.`
              : 'Every company failed at least one filter. Try loosening a threshold.'}
          </span>
        </div>
      )}

      {result && result.target && (
        <div className="targetnote">
          Ranking against <strong>{result.target.name}</strong> — {result.target.categories.slice(0, 3).join(' · ')}
        </div>
      )}

      {showcase.length > 0 && (
        <div className="rail">
          {showcase.map((h, i) => (
            <button
              key={h.company.id}
              className={'rail-row' + (selected?.id === h.company.id ? ' is-sel' : '')}
              onClick={() => { setSelected(h.company); pileRef.current?.focus(h.company.id) }}
            >
              <span className="rail-rank">{i + 1}</span>
              <span className="rail-name">{h.company.name}</span>
              <span className="rail-bar"><i style={{ width: `${h.confidence}%` }} /></span>
              <span className="rail-conf">{h.confidence}%</span>
            </button>
          ))}
        </div>
      )}

      {selected && (
        <DetailCard
          company={selected}
          hit={hitById.get(selected.id)}
          onClose={() => setSelected(null)}
          onCompetitors={(c) => { setSelected(null); setQuery(`competitors of ${c.name}`) }}
        />
      )}

      {note && <div className="note">{note}</div>}

      {hovered && !selected && (
        <div className="tooltip">
          <strong>{hovered.name}</strong>
          <span>{hovered.categories.slice(0, 2).join(' · ')}</span>
        </div>
      )}

      <footer className="statusbar">
        <span className={'dot' + (semanticReady ? ' ok' : '')} />
        {semanticReady ? 'semantic + lexical + filters' : 'lexical + filters · loading embeddings'}
        {result?.layaUsed && <span className="badge">Laya calibrated</span>}
        {layaEnabled() && !result?.layaUsed && <span className="badge dim">Laya configured</span>}
        {result && result.excludedForMissingData > 0 && (
          <span className="muted">{result.excludedForMissingData} excluded — no data for a filtered field</span>
        )}
      </footer>
    </div>
  )
}

function clamp(v: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, v))
}

/**
 * Roughly one body per 2,800 px² of viewport — the density that looks like a
 * heap without becoming the whole page. Fixed at load; a resize re-lays the
 * walls but does not add or remove bodies.
 */
function bodyBudget(): number {
  const area = window.innerWidth * window.innerHeight
  return Math.round(clamp(area / 2800, 90, 500))
}
