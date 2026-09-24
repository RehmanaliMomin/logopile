import Matter from 'matter-js'
import type { Company, Hit } from '../types'
import { getLogo } from './logos'

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
}

export interface PileOptions {
  onSelect: (c: Company) => void
  onHover: (c: Company | null) => void
}

const WALL = 400
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
  private destroyed = false

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

  private buildTiles(companies: Company[]) {
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
    const p = { x: e.clientX - rect.left, y: e.clientY - rect.top }
    // Flying tiles sit on top, so test them first.
    const order = [...this.tiles].sort((a, b) => b.lift - a.lift)
    const found = Query.point(order.map((t) => t.body), p)
    if (!found.length) return null
    const top = found.sort((a, b) => (this.byId.get(b.label)?.lift ?? 0) - (this.byId.get(a.label)?.lift ?? 0))[0]
    return this.byId.get(top.label) ?? null
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
  }

  /** Fly the matched logos up into a ranked grid; drop everything else back. */
  show(hits: Hit[]) {
    const matched = new Set(hits.map((h) => h.company.id))

    for (const t of this.tiles) {
      if (matched.has(t.company.id)) continue
      if (t.mode === 'flying') this.release(t)
    }

    if (!hits.length) return

    // Only fly what fits above the heap. On a short viewport the tail would
    // otherwise land inside the pile and become unreadable; those hits stay in
    // the rail, which lists every match regardless.
    const layout = this.layout(hits.length)
    hits.slice(0, layout.capacity).forEach((hit, i) => {
      const t = this.byId.get(hit.company.id)
      if (!t) return
      const slot = layout.slots[i]
      if (!slot) return
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
    // Leave the bottom third to the pile itself.
    const maxRows = Math.max(1, Math.floor((this.h * 0.72 - top) / rowH))
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

  private tick() {
    const dt = 1000 / 60
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
  }

  // ------------------------------------------------------------- rendering --

  private draw() {
    const { ctx } = this
    ctx.clearRect(0, 0, this.w, this.h)

    const flying = this.tiles.filter((t) => t.lift > 0.01).sort((a, b) => a.rank - b.rank)
    if (flying.length) this.drawResultBackdrop(ctx)

    for (const t of this.tiles) if (t.lift <= 0.01) this.drawTile(ctx, t)
    for (const t of flying) this.drawTile(ctx, t)
  }

  private drawResultBackdrop(ctx: CanvasRenderingContext2D) {
    const g = ctx.createLinearGradient(0, this.resultTop - 60, 0, this.resultBottom + 40)
    g.addColorStop(0, 'rgba(99,102,241,0.00)')
    g.addColorStop(0.5, 'rgba(99,102,241,0.055)')
    g.addColorStop(1, 'rgba(99,102,241,0.00)')
    ctx.fillStyle = g
    ctx.fillRect(0, this.resultTop - 60, this.w, this.resultBottom - this.resultTop + 100)
  }

  private drawTile(ctx: CanvasRenderingContext2D, t: Tile) {
    const { x, y } = t.body.position
    if (y > this.h + 120 || y < -200) return
    const s = t.renderSize
    const r = s * 0.26
    const isHover = this.hovered === t.company.id

    ctx.save()
    ctx.translate(x, y)
    ctx.rotate(t.body.angle)

    // lift shadow + selection glow
    if (t.lift > 0.02) {
      ctx.shadowColor = `rgba(99,102,241,${0.5 * t.lift})`
      ctx.shadowBlur = 26 * t.lift
    } else {
      ctx.shadowColor = 'rgba(0,0,0,0.45)'
      ctx.shadowBlur = 8
      ctx.shadowOffsetY = 3
    }

    roundRect(ctx, -s / 2, -s / 2, s, s, r)
    ctx.fillStyle = isHover ? '#ffffff' : '#f7f8fb'
    ctx.fill()
    ctx.shadowBlur = 0
    ctx.shadowOffsetY = 0

    const asset = getLogo(t.company)
    const inner = s * 0.66
    if (asset.state === 'ready' && asset.image) {
      const img = asset.image
      const scale = Math.min(inner / img.naturalWidth, inner / img.naturalHeight)
      const w = img.naturalWidth * scale
      const h = img.naturalHeight * scale
      try { ctx.drawImage(img, -w / 2, -h / 2, w, h) } catch { /* tainted/decoding */ }
    } else {
      ctx.fillStyle = `hsl(${asset.monogram.hue} 68% 46%)`
      roundRect(ctx, -inner / 2, -inner / 2, inner, inner, inner * 0.28)
      ctx.fill()
      ctx.fillStyle = '#fff'
      ctx.font = `700 ${Math.round(inner * 0.44)}px Inter, system-ui, sans-serif`
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      ctx.fillText(asset.monogram.text, 0, 1)
    }

    // rank + confidence + name, faded in as the tile lifts
    if (t.lift > 0.05) {
      const a = t.lift
      ctx.rotate(-t.body.angle)

      ctx.font = '600 11px Inter, system-ui, sans-serif'
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      const label = t.company.name.length > 18 ? t.company.name.slice(0, 17) + '…' : t.company.name
      const ty = s / 2 + 15
      ctx.fillStyle = `rgba(233,236,245,${a})`
      ctx.fillText(label, 0, ty)

      const conf = `${t.confidence}%`
      ctx.font = '700 10px "JetBrains Mono", ui-monospace, monospace'
      const cw = ctx.measureText(conf).width + 12
      const cy = ty + 15
      roundRect(ctx, -cw / 2, cy - 8, cw, 16, 8)
      ctx.fillStyle = `rgba(99,102,241,${0.22 * a})`
      ctx.fill()
      ctx.strokeStyle = `rgba(129,140,248,${0.5 * a})`
      ctx.lineWidth = 1
      ctx.stroke()
      ctx.fillStyle = `rgba(196,201,255,${a})`
      ctx.fillText(conf, 0, cy + 1)

      // rank pip
      ctx.beginPath()
      ctx.arc(-s / 2 + 2, -s / 2 + 2, 9, 0, Math.PI * 2)
      ctx.fillStyle = `rgba(17,18,28,${0.92 * a})`
      ctx.fill()
      ctx.strokeStyle = `rgba(129,140,248,${0.65 * a})`
      ctx.stroke()
      ctx.fillStyle = `rgba(226,229,245,${a})`
      ctx.font = '700 9px "JetBrains Mono", ui-monospace, monospace'
      ctx.fillText(String(t.rank), -s / 2 + 2, -s / 2 + 3)
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
