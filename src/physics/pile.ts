import Matter from 'matter-js'
import type { Company, Hit, Zone } from '../types'
import { getLogo, getSprite, SPRITE_PAD } from './logos'

/**
 * The pile.
 *
 * Every company is a rounded body in a Matter world, resting in a heap at the
 * bottom. On a search, matched bodies leave the simulation's collision graph
 * and get flown to a results grid by a critically-damped spring we integrate
 * ourselves — physics for the pile, deterministic easing for the answer. Mixing
 * the two is what makes results readable instead of a jostling mess.
 */

const { Engine, Bodies, Composite, Body, Mouse, MouseConstraint, Query, Common } = Matter

type Mode = 'pile' | 'flying'

interface Tile {
  company: Company
  body: Matter.Body
  size: number
  mode: Mode
  /** Spring target while flying. */
  tx: number
  ty: number
  /** Own velocity for the spring integrator (Matter's is bypassed). */
  vx: number
  vy: number
  targetSize: number
  renderSize: number
  confidence: number
  rank: number
  /** 0 → in pile, 1 → fully flown. Drives label/badge fade. */
  lift: number
  /** Spawned for a search rather than part of the resting heap; removed on release. */
  transient?: boolean
}

export interface PileOptions {
  onSelect: (c: Company) => void
  onHover: (c: Company | null) => void
  /**
   * How many bodies live in the heap. The dataset can be far larger than this —
   * Matter.js handles a few hundred colliding bodies comfortably and thousands
   * not at all. The pile shows the most prominent slice; anything else is still
   * fully searchable and gets spawned on demand when it matches.
   */
  maxBodies?: number
}

const WALL = 400
const DEFAULT_MAX_BODIES = 500
/** Width the results rail occupies on the right; the grid stays clear of it. */
const RAIL_INSET = 278
const RAIL_MIN_WIDTH = 900

export class Pile {
  private engine = Engine.create()
  private tiles: Tile[] = []
  private byId = new Map<string, Tile>()
  private ctx: CanvasRenderingContext2D
  private raf = 0
  private w = 0
  private h = 0
  private dpr = 1
  private walls: Matter.Body[] = []
  private mouseConstraint: Matter.MouseConstraint | null = null
  private pointerDownAt: { x: number; y: number; t: number } | null = null
  private hovered: string | null = null
  private resultTop = 120
  private resultBottom = 0
  /**
   * How far the heap is drawn below its simulated position. Results need
   * headroom, and the honest way to get it is to move the pile out of the way
   * rather than draw the grid on top of it. Physics never sees this — it is a
   * render-space offset, applied to hit-testing too so clicks stay accurate.
   */
  private pileOffset = 0
  private pileOffsetTarget = 0
  /** Sort mode: pull the heap sideways into one vertical band per zone. */
  private sorting = false
  private zones: Zone[] = []
  /** zone id -> { x centre, half-width } in canvas pixels, recomputed on resize. */
  private bands = new Map<string, { x: number; w: number; label: string }>()
  private destroyed = false

  /** Everything searchable, including companies with no body in the heap. */
  private catalogue = new Map<string, Company>()

  constructor(private canvas: HTMLCanvasElement, companies: Company[], private opts: PileOptions) {
    const ctx = canvas.getContext('2d', { alpha: true })
    if (!ctx) throw new Error('2d canvas unavailable')
    this.ctx = ctx

    this.engine.gravity.y = 1
    this.engine.positionIterations = 6
    this.engine.velocityIterations = 4

    this.resize()
    this.buildWalls()
    this.buildTiles(companies)
    this.attachInput()

    const step = () => {
      if (this.destroyed) return
      this.tick()
      this.draw()
      this.raf = requestAnimationFrame(step)
    }
    this.raf = requestAnimationFrame(step)
  }

  // ---------------------------------------------------------------- setup ---

  /** Valuation, falling back to revenue — same ordering the ranker uses. */
  private static weight(c: Company): number {
    return c.valuationUsd ?? (c.revenueUsd != null ? c.revenueUsd * 4 : 0)
  }

  private buildTiles(companies: Company[]) {
    for (const c of companies) this.catalogue.set(c.id, c)
    const max = this.opts.maxBodies ?? DEFAULT_MAX_BODIES
    if (companies.length > max) {
      companies = [...companies].sort((a, b) => Pile.weight(b) - Pile.weight(a)).slice(0, max)
    }

    // Bigger companies get bigger tiles. Valuation is the most widely populated
    // "how much does this logo matter" signal we have.
    const sizeFor = (c: Company) => {
      const v = c.valuationUsd ?? c.revenueUsd ?? 1e8
      return Math.round(Math.max(30, Math.min(74, 26 + 7.5 * Math.log10(v / 1e7))))
    }

    companies.forEach((c, i) => {
      const size = sizeFor(c)
      const body = Bodies.rectangle(
        Common.random(size, this.w - size),
        -Common.random(100, 2600) - i * 2,
        size,
        size,
        {
          chamfer: { radius: size * 0.26 },
          restitution: 0.18,
          friction: 0.42,
          frictionAir: 0.012,
          density: 0.0016,
          label: c.id,
        },
      )
      Body.setAngle(body, Common.random(-0.5, 0.5))
      const tile: Tile = {
        company: c, body, size, mode: 'pile', tx: 0, ty: 0, vx: 0, vy: 0,
        targetSize: size, renderSize: size, confidence: 0, rank: 0, lift: 0,
      }
      this.tiles.push(tile)
      this.byId.set(c.id, tile)
      getLogo(c)
    })
    Composite.add(this.engine.world, this.tiles.map((t) => t.body))
  }

  private buildWalls() {
    Composite.remove(this.engine.world, this.walls)
    const opts = { isStatic: true, restitution: 0, friction: 0.6 }
    this.walls = [
      Bodies.rectangle(this.w / 2, this.h + WALL / 2 - 2, this.w * 3, WALL, opts),
      Bodies.rectangle(-WALL / 2 + 1, this.h / 2, WALL, this.h * 6, opts),
      Bodies.rectangle(this.w + WALL / 2 - 1, this.h / 2, WALL, this.h * 6, opts),
    ]
    Composite.add(this.engine.world, this.walls)
  }

  private attachInput() {
    const mouse = Mouse.create(this.canvas)
    // Matter's default wheel/touch handlers hijack page scroll; drop them.
    mouse.element.removeEventListener('wheel', (mouse as unknown as { mousewheel: EventListener }).mousewheel)
    this.mouseConstraint = MouseConstraint.create(this.engine, {
      mouse,
      constraint: { stiffness: 0.12, damping: 0.1, render: { visible: false } },
    })
    Composite.add(this.engine.world, this.mouseConstraint)

    this.canvas.addEventListener('pointerdown', (e) => {
      this.pointerDownAt = { x: e.clientX, y: e.clientY, t: performance.now() }
    })
    this.canvas.addEventListener('pointerup', (e) => {
      const d = this.pointerDownAt
      this.pointerDownAt = null
      if (!d) return
      const moved = Math.hypot(e.clientX - d.x, e.clientY - d.y)
      if (moved > 6 || performance.now() - d.t > 500) return
      const hit = this.tileAt(e)
      if (hit) this.opts.onSelect(hit.company)
    })
    this.canvas.addEventListener('pointermove', (e) => {
      const hit = this.tileAt(e)
      const id = hit?.company.id ?? null
      if (id !== this.hovered) {
        this.hovered = id
        this.canvas.style.cursor = id ? 'pointer' : 'grab'
        this.opts.onHover(hit?.company ?? null)
      }
    })
    this.canvas.addEventListener('pointerleave', () => {
      this.hovered = null
      this.opts.onHover(null)
    })
  }

  private tileAt(e: PointerEvent): Tile | null {
    const rect = this.canvas.getBoundingClientRect()
    const x = e.clientX - rect.left
    const y = e.clientY - rect.top
    // Flying tiles are drawn where they are simulated; pile tiles are drawn
    // `pileOffset` lower, so the pointer has to be lifted back by that much
    // before testing against their bodies.
    const flying = this.tiles.filter((t) => t.lift > 0.01)
    const hitFlying = Query.point(flying.map((t) => t.body), { x, y })
    if (hitFlying.length) {
      const best = hitFlying.sort((a, b) => (this.byId.get(b.label)?.lift ?? 0) - (this.byId.get(a.label)?.lift ?? 0))[0]
      return this.byId.get(best.label) ?? null
    }
    const rest = this.tiles.filter((t) => t.lift <= 0.01)
    const hitPile = Query.point(rest.map((t) => t.body), { x, y: y - this.pileOffset })
    return hitPile.length ? this.byId.get(hitPile[0].label) ?? null : null
  }

  // ----------------------------------------------------------------- api ----

  resize() {
    const rect = this.canvas.getBoundingClientRect()
    this.dpr = Math.min(2, window.devicePixelRatio || 1)
    this.w = Math.max(320, rect.width)
    this.h = Math.max(320, rect.height)
    this.canvas.width = Math.round(this.w * this.dpr)
    this.canvas.height = Math.round(this.h * this.dpr)
    this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0)
    if (this.walls.length) this.buildWalls()
    this.layoutBands()
  }

  /**
   * Spawn a body for a company that matched but isn't in the heap. It enters
   * from just below the floor so it reads as rising out of the pile.
   */
  private spawn(c: Company): Tile {
    const size = Math.round(Math.max(30, Math.min(74, 26 + 7.5 * Math.log10(Math.max(1e7, Pile.weight(c)) / 1e7))))
    const body = Bodies.rectangle(Common.random(size, this.w - size), this.h + size, size, size, {
      chamfer: { radius: size * 0.26 },
      restitution: 0.18,
      friction: 0.42,
      frictionAir: 0.012,
      density: 0.0016,
      label: c.id,
    })
    const tile: Tile = {
      company: c, body, size, mode: 'pile', tx: 0, ty: 0, vx: 0, vy: 0,
      targetSize: size, renderSize: size, confidence: 0, rank: 0, lift: 0,
      transient: true,
    }
    this.tiles.push(tile)
    this.byId.set(c.id, tile)
    Composite.add(this.engine.world, body)
    getLogo(c)
    return tile
  }

  /** Fly the matched logos up into a ranked grid; drop everything else back. */
  show(hits: Hit[]) {
    // Only fly what fits above the heap; the rail lists every match regardless.
    const layout = hits.length ? this.layout(hits.length) : null
    // Matching is not enough — a company that matched but sits past the grid
    // capacity must also come down, or it keeps flying at the slot it was
    // given by the *previous* query and overlaps whatever now owns that slot.
    const flying = new Set(layout ? hits.slice(0, layout.capacity).map((h) => h.company.id) : [])

    for (const t of this.tiles) {
      if (t.mode === 'flying' && !flying.has(t.company.id)) this.release(t)
    }

    if (!layout) {
      this.pileOffsetTarget = 0
      return
    }

    hits.slice(0, layout.capacity).forEach((hit, i) => {
      const slot = layout.slots[i]
      if (!slot) return
      const t = this.byId.get(hit.company.id) ?? this.spawn(hit.company)
      t.mode = 'flying'
      t.tx = slot.x
      t.ty = slot.y
      t.targetSize = layout.size * (0.86 + 0.28 * (hit.confidence / 100))
      t.confidence = hit.confidence
      t.rank = i + 1
      t.body.collisionFilter.mask = 0 // leave the collision graph entirely
      Body.setStatic(t.body, false)
      t.vx = t.body.velocity.x * 60
      t.vy = t.body.velocity.y * 60
    })
    this.resultTop = layout.top
    this.resultBottom = layout.bottom
  }

  clear() {
    for (const t of this.tiles) if (t.mode === 'flying') this.release(t)
    this.pileOffsetTarget = 0
  }

  setZones(zones: Zone[]) {
    this.zones = zones
    this.layoutBands()
  }

  /**
   * Toggle the sort. Bodies get pulled toward their zone's band by a horizontal
   * spring while gravity keeps doing the stacking, so the heap reorganises
   * itself rather than being teleported into place.
   */
  setSorting(on: boolean) {
    this.sorting = on
    this.layoutBands()
    for (const t of this.tiles) {
      // Extra drag while sorting, or the bands oscillate instead of settling.
      t.body.frictionAir = on ? 0.05 : 0.012
      if (on) Body.applyForce(t.body, t.body.position, { x: 0, y: -0.02 * t.body.mass })
    }
  }

  get isSorting(): boolean {
    return this.sorting
  }

  /**
   * Band widths follow each zone's total tile AREA, not its head count. Tiles are
   * sized by valuation, so a zone of twenty giants covers far more ground than
   * twenty startups — splitting by count alone left the big-logo bands heaped
   * into a hump that reached the search box.
   */
  private layoutBands() {
    this.bands.clear()
    if (!this.zones.length) return
    const area = new Map<string, number>()
    for (const t of this.tiles) {
      if (t.transient) continue
      area.set(t.company.cluster, (area.get(t.company.cluster) ?? 0) + t.size * t.size)
    }
    const present = this.zones.filter((z) => (area.get(z.id) ?? 0) > 0)
    const total = present.reduce((a, z) => a + (area.get(z.id) ?? 0), 0) || 1
    let x = 0
    for (const z of present) {
      const w = (this.w * (area.get(z.id) ?? 0)) / total
      this.bands.set(z.id, { x: x + w / 2, w, label: z.label })
      x += w
    }
  }

  /** Shove the pile — used by the shake button and device tilt. */
  kick(strength = 1) {
    for (const t of this.tiles) {
      if (t.mode === 'flying') continue
      Body.applyForce(t.body, t.body.position, {
        x: Common.random(-0.06, 0.06) * strength * t.body.mass,
        y: Common.random(-0.16, -0.05) * strength * t.body.mass,
      })
    }
  }

  setGravity(x: number, y: number) {
    this.engine.gravity.x = x
    this.engine.gravity.y = y
  }

  focus(id: string) {
    const t = this.byId.get(id)
    if (t) Body.applyForce(t.body, t.body.position, { x: 0, y: -0.09 * t.body.mass })
  }

  destroy() {
    this.destroyed = true
    cancelAnimationFrame(this.raf)
    Composite.clear(this.engine.world, false)
    Engine.clear(this.engine)
  }

  // -------------------------------------------------------------- internals -

  private release(t: Tile) {
    if (t.transient) {
      // Never part of the heap — sink it back out of view instead of adding a
      // body the pile was deliberately sized to exclude.
      Composite.remove(this.engine.world, t.body)
      this.tiles.splice(this.tiles.indexOf(t), 1)
      this.byId.delete(t.company.id)
      return
    }
    t.mode = 'pile'
    t.targetSize = t.size
    t.confidence = 0
    t.body.collisionFilter.mask = 0xffffffff
    Body.setVelocity(t.body, { x: Common.random(-2, 2), y: Common.random(0, 2) })
    Body.setAngularVelocity(t.body, Common.random(-0.06, 0.06))
  }

  private layout(n: number) {
    const pad = 22
    const inset = this.w >= RAIL_MIN_WIDTH ? RAIL_INSET : 0
    const usableW = this.w - pad * 2 - inset
    const maxCols = Math.max(2, Math.min(8, Math.floor(usableW / 110)))
    const cols = Math.min(n, Math.max(2, Math.min(maxCols, Math.ceil(Math.sqrt(n * 1.9)))))
    const cell = Math.min(128, usableW / cols)
    const size = Math.min(76, cell * 0.62)
    const rowH = cell * 0.96
    // Clear the search box, filter chips and the "ranking against X" note.
    const top = Math.max(196, this.h * 0.19)

    // Ask for up to three rows, then sink the heap by however much is missing.
    // Capped so the pile always stays partly on screen — it is the point of the
    // page, not a backdrop to be shoved off the bottom.
    const wantRows = Math.min(3, Math.ceil(n / cols))
    const needed = top + rowH * wantRows + 28
    const rawTop = this.pileTop()
    this.pileOffsetTarget = Math.max(0, Math.min(this.h * 0.34, needed - rawTop))

    const maxRows = Math.max(1, Math.floor((rawTop + this.pileOffsetTarget - 28 - top) / rowH))
    const rows = Math.min(Math.ceil(n / cols), maxRows)
    const capacity = Math.min(n, rows * cols)
    const slots: Array<{ x: number; y: number }> = []
    for (let i = 0; i < capacity; i++) {
      const r = Math.floor(i / cols)
      const c = i % cols
      const inRow = Math.min(cols, n - r * cols)
      const rowW = inRow * cell
      const left = pad + (usableW - rowW) / 2
      slots.push({ x: left + cell * c + cell / 2, y: top + rowH * r + rowH / 2 })
    }
    return { slots, size, capacity, top: top - 10, bottom: top + rowH * rows }
  }

  /** Y of the highest resting body, i.e. the top of the heap. */
  private pileTop(): number {
    let top = this.h
    for (const t of this.tiles) {
      if (t.mode === 'flying' || t.transient) continue
      const y = t.body.position.y - t.size / 2
      if (y < top) top = y
    }
    return top
  }

  private tick() {
    const dt = 1000 / 60

    if (this.sorting) {
      for (const t of this.tiles) {
        if (t.mode === 'flying') continue
        const band = this.bands.get(t.company.cluster)
        if (!band) continue
        // Containment, not centring. Pulling every body toward the middle of its
        // band stacks them into a skyscraper that runs off the top of the screen;
        // only nudging the ones that have strayed outside lets each zone spread
        // across its full width and stay about as tall as the others.
        const half = Math.max(24, band.w / 2 - t.size * 0.55)
        const dx = t.body.position.x - band.x
        if (Math.abs(dx) <= half) continue
        const overshoot = Math.abs(dx) - half
        const force = Math.sign(dx) * -Math.min(0.012, overshoot * 0.0006) * t.body.mass
        Body.applyForce(t.body, t.body.position, { x: force, y: 0 })
      }
    }

    Engine.update(this.engine, dt)

    // Critically-damped spring for flying tiles, integrated outside Matter so
    // gravity and neighbours can't perturb the result grid.
    const k = 0.055
    const damp = 0.76
    for (const t of this.tiles) {
      if (t.mode === 'flying') {
        const p = t.body.position
        t.vx = (t.vx + (t.tx - p.x) * k) * damp
        t.vy = (t.vy + (t.ty - p.y) * k) * damp
        Body.setPosition(t.body, { x: p.x + t.vx, y: p.y + t.vy })
        Body.setVelocity(t.body, { x: 0, y: 0 })
        Body.setAngle(t.body, t.body.angle * 0.86)
        Body.setAngularVelocity(t.body, 0)
        t.lift = Math.min(1, t.lift + 0.06)
      } else if (t.lift > 0) {
        t.lift = Math.max(0, t.lift - 0.08)
      }
      t.renderSize += (t.targetSize - t.renderSize) * 0.12
    }

    this.pileOffset += (this.pileOffsetTarget - this.pileOffset) * 0.09
  }

  // ------------------------------------------------------------- rendering --

  private draw() {
    const { ctx } = this
    ctx.clearRect(0, 0, this.w, this.h)

    const flying = this.tiles.filter((t) => t.lift > 0.01).sort((a, b) => a.rank - b.rank)

    // The heap, pushed down out of the results' way.
    ctx.save()
    ctx.translate(0, this.pileOffset)
    if (this.sorting) this.drawBands(ctx)
    for (const t of this.tiles) if (t.lift <= 0.01) this.drawTile(ctx, t)
    ctx.restore()

    // Hold back the pile visually while an answer is on screen: 500 bright logos
    // are a lot of competition for fourteen that matter.
    if (flying.length) {
      const dim = Math.min(1, this.pileOffset / Math.max(1, this.pileOffsetTarget || 1))
      const g = ctx.createLinearGradient(0, this.resultTop - 40, 0, this.h)
      g.addColorStop(0, `rgba(8,9,13,${0.62 * dim})`)
      g.addColorStop(0.45, `rgba(8,9,13,${0.5 * dim})`)
      g.addColorStop(1, `rgba(8,9,13,${0.34 * dim})`)
      ctx.fillStyle = g
      ctx.fillRect(0, this.resultTop - 40, this.w, this.h - this.resultTop + 40)
      this.drawResultBackdrop(ctx)
    }

    for (const t of flying) this.drawTile(ctx, t)

    // Screen space, so a full band can't push its label out of view.
    if (this.sorting) this.drawBandLabels(ctx)
  }

  /** Band tints, drawn under the heap. */
  private drawBands(ctx: CanvasRenderingContext2D) {
    let i = 0
    for (const [, band] of this.bands) {
      ctx.fillStyle = i % 2 ? 'rgba(129,140,248,0.055)' : 'rgba(129,140,248,0.015)'
      ctx.fillRect(band.x - band.w / 2, 0, band.w, this.h)
      i++
    }
  }

  /**
   * Zone labels along the bottom edge, in screen space. They used to sit above
   * the tallest body in each band, which put them behind the search box on a
   * full band and off-screen entirely on a very full one.
   */
  private drawBandLabels(ctx: CanvasRenderingContext2D) {
    const y = this.h - 34
    ctx.save()
    ctx.font = '600 10px Inter, system-ui, sans-serif'
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    for (const [, band] of this.bands) {
      const tw = ctx.measureText(band.label).width
      if (tw + 16 > band.w) continue
      roundRect(ctx, band.x - tw / 2 - 8, y - 9, tw + 16, 18, 9)
      ctx.fillStyle = 'rgba(13,15,23,0.94)'
      ctx.fill()
      ctx.strokeStyle = 'rgba(129,140,248,0.38)'
      ctx.lineWidth = 1
      ctx.stroke()
      ctx.fillStyle = 'rgba(205,209,255,0.96)'
      ctx.fillText(band.label, band.x, y + 0.5)
    }
    ctx.restore()
  }

  private drawResultBackdrop(ctx: CanvasRenderingContext2D) {
    const g = ctx.createLinearGradient(0, this.resultTop - 60, 0, this.resultBottom + 40)
    g.addColorStop(0, 'rgba(99,102,241,0.00)')
    g.addColorStop(0.5, 'rgba(99,102,241,0.07)')
    g.addColorStop(1, 'rgba(99,102,241,0.00)')
    ctx.fillStyle = g
    ctx.fillRect(0, this.resultTop - 60, this.w, this.resultBottom - this.resultTop + 100)
  }

  private drawTile(ctx: CanvasRenderingContext2D, t: Tile) {
    const { x, y } = t.body.position
    if (y > this.h + 120 || y < -200) return
    const s = t.renderSize
    const isHover = this.hovered === t.company.id

    ctx.save()
    ctx.translate(x, y)
    ctx.rotate(t.body.angle)

    // The lift glow is the one shadow we still pay for, and only the handful of
    // flying tiles ever have it.
    if (t.lift > 0.02) {
      ctx.shadowColor = `rgba(99,102,241,${0.5 * t.lift})`
      ctx.shadowBlur = 26 * t.lift
    }

    const sprite = getSprite(t.company, this.dpr)
    if (sprite) {
      // The sprite includes its baked shadow in a padded margin, so it draws
      // slightly larger than the plate itself.
      const full = s / (1 - SPRITE_PAD * 2)
      ctx.drawImage(sprite, -full / 2, -full / 2, full, full)
    }
    ctx.shadowBlur = 0

    if (isHover) {
      roundRect(ctx, -s / 2, -s / 2, s, s, s * 0.26)
      ctx.fillStyle = 'rgba(255,255,255,0.22)'
      ctx.fill()
    }

    // rank + confidence + name, faded in as the tile lifts
    if (t.lift > 0.05) {
      const a = t.lift
      ctx.rotate(-t.body.angle)

      ctx.font = '600 11px Inter, system-ui, sans-serif'
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      const label = t.company.name.length > 18 ? t.company.name.slice(0, 17) + '…' : t.company.name
      const ty = s / 2 + 16
      const conf = `${t.confidence}%`

      // One solid plate behind the name and the score. Text drawn straight onto
      // the pile is unreadable the moment a bright logo sits behind it.
      const nameW = ctx.measureText(label).width
      ctx.font = '700 10px "JetBrains Mono", ui-monospace, monospace'
      const confW = ctx.measureText(conf).width
      const plateW = Math.max(nameW, 58) + confW + 26
      const plateH = 22
      roundRect(ctx, -plateW / 2, ty - plateH / 2, plateW, plateH, 11)
      ctx.fillStyle = `rgba(13,15,23,${0.9 * a})`
      ctx.fill()
      ctx.strokeStyle = `rgba(129,140,248,${0.28 * a})`
      ctx.lineWidth = 1
      ctx.stroke()

      ctx.font = '600 11px Inter, system-ui, sans-serif'
      ctx.textAlign = 'left'
      ctx.fillStyle = `rgba(233,236,245,${a})`
      ctx.fillText(label, -plateW / 2 + 10, ty)

      ctx.font = '700 10px "JetBrains Mono", ui-monospace, monospace'
      ctx.textAlign = 'right'
      ctx.fillStyle = `rgba(160,170,255,${a})`
      ctx.fillText(conf, plateW / 2 - 10, ty + 0.5)
      ctx.textAlign = 'center'

      ctx.beginPath()
      ctx.arc(-s / 2 + 1, -s / 2 + 1, 9, 0, Math.PI * 2)
      ctx.fillStyle = `rgba(17,18,28,${0.92 * a})`
      ctx.fill()
      ctx.strokeStyle = `rgba(129,140,248,${0.65 * a})`
      ctx.stroke()
      ctx.fillStyle = `rgba(226,229,245,${a})`
      ctx.font = '700 9px "JetBrains Mono", ui-monospace, monospace'
      ctx.fillText(String(t.rank), -s / 2 + 1, -s / 2 + 2)
    }

    ctx.restore()
  }
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath()
  ctx.moveTo(x + r, y)
  ctx.arcTo(x + w, y, x + w, y + h, r)
  ctx.arcTo(x + w, y + h, x, y + h, r)
  ctx.arcTo(x, y + h, x, y, r)
  ctx.arcTo(x, y, x + w, y, r)
  ctx.closePath()
}
