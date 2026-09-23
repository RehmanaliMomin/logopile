# Logo Pile — IT & SaaS

A physics pile of 279 IT/SaaS company logos. Type a natural-language query and the
matching logos fly out of the heap into a ranked grid with confidence scores.

```bash
npm install
npm run data      # build dataset + embeddings (first run downloads ~25MB model)
npm run dev       # http://localhost:5188
```

Everything runs client-side. No API keys, no server, no paid services.

---

## How it works

```
query
  ↓  parse.ts        regex filters + competitor intent, stripped out of the text
  ↓  hard filters    revenue / valuation / employees / founded / funding / region / stage
  ↓  signals         semantic · lexical · category overlap · competitor graph · prominence
  ↓  blend           weights shift when the query names a target company
  ↓  confidence      55% relative to the best hit + 45% absolute
  ↓  [Laya]          optional calibrated rerank of the top 30
  ↓  pile.show()     matched bodies leave the collision graph, spring into a grid
```

### The five signals

| signal | what it is | weight (plain) | weight (competitor query) |
|---|---|---|---|
| semantic | cosine of MiniLM embeddings, query vs. product description | 0.54 | 0.28 |
| lexical | BM25 over the same text | 0.25 | 0.07 |
| category | Jaccard-ish overlap of category tags | 0.14 | 0.25 |
| competitor | 1.0 direct graph edge, 0.55 shared-competitor (second hop) | — | 0.32 |
| prominence | log-scaled valuation, 0..1 | 0.07 | 0.08 |

`prominence` is a deliberate tiebreak, not a ranking signal: when two companies are
equally good answers, the one people have heard of sits higher.

### Competitor logic

`competitors of X` / `alternatives to X` / `X competitors` / `similar to X`:

1. Resolve X by exact name → id → domain → prefix → substring.
2. Exclude X from its own results.
3. Use **X's own precomputed vector** as the query vector rather than re-embedding
   its description — it is the exact point in space we want neighbours of.
4. Score direct graph edges at 1.0 and second-hop (companies fought over by X's
   own competitors) at 0.55. Blend with category overlap and semantic distance.

The graph is symmetrised at build time: if A lists B, B gets A. So you only ever
write each edge once, in whichever direction you happened to think of it.

### Physics

Matter.js runs the heap. Matched tiles do **not** stay in the simulation — they
get `collisionFilter.mask = 0` and are moved by a critically-damped spring we
integrate ourselves. Physics for the pile, deterministic easing for the answer;
mixing the two is what keeps results readable instead of a jostling mess.

Tiles are sized by `log10(valuation)`, so the pile has visual hierarchy at rest.

### Graceful missing data

A numeric filter excludes rows whose field is `null` — but the count is reported in
the status bar (`24 excluded — no data for a filtered field`) rather than silently
dropped. Estimated figures carry an `est` tag on the detail card.

---

## Project structure

```
data/seed/*.json           hand-curated slices — add files, they're merged in order
scripts/build-dataset.mjs  merge, validate, symmetrise the graph, derive fields
scripts/build-embeddings.mjs  MiniLM → public/embeddings.bin (Float32, L2-normalised)
scripts/ingest-edgar.mjs   pull real revenue from SEC EDGAR for tickered companies
scripts/smoke.mjs          Node harness: run the ranker over example queries
public/companies.json      generated — do not edit
public/embeddings.bin      generated — gitignored
src/search/parse.ts        NL → filters + target + leftover semantic text
src/search/bm25.ts         tiny in-memory BM25
src/search/embed.ts        query-side embedding (transformers.js from CDN, lazy)
src/search/rank.ts         the blend
src/search/laya.ts         optional calibrated reranker
src/physics/pile.ts        Matter world, spring layout, canvas rendering
src/physics/logos.ts       logo fallback chain
src/ui/                    App, SearchBar, DetailCard
```

---

## Data schema

```jsonc
{
  "id": "whatfix",                    // stable slug, used for competitor edges
  "name": "Whatfix",
  "domain": "whatfix.com",            // drives the logo URL
  "description": "…",                 // 1–2 sentences; this is what gets embedded
  "categories": ["digital adoption platform", "in-app guidance", "saas"],
  "hqCity": "San Jose",
  "hqCountry": "United States",
  "region": "North America",          // North America | Europe | Asia | Asia Pacific | Middle East
  "founded": 2014,
  "employees": 1100,
  "stage": "series-e",                // public | private | bootstrapped | acquired | seed | series-a…g | late-stage
  "ticker": null,                     // set it and EDGAR can fill real revenue
  "revenueUsd": 100000000,
  "revenueEstimated": true,           // shows an "est" tag in the UI
  "valuationUsd": 600000000,
  "valuationEstimated": true,
  "fundingTotalUsd": 265000000,
  "competitors": ["walkme", "pendo"]  // write each edge once; build symmetrises
}
```

Derived at build time (never hand-written): `isUnicorn`, `logo`, `logoFallback`,
`searchText`.

Any field may be `null` except `id`, `name`, `domain`, `description`, `categories`.

---

## Adding companies

1. Drop a new `data/seed/06-whatever.json` (a JSON array) or extend an existing slice.
2. `npm run data` — merges, validates, symmetrises the graph, re-embeds.

The build prints every competitor edge pointing at an id that isn't in the dataset,
so the graph tells you what to add next. If the id exists under a different slug,
add it to `ALIAS` in `scripts/build-dataset.mjs` instead.

### Where to get more data, free

| source | what you get | how |
|---|---|---|
| **SEC EDGAR** `data.sec.gov/api/xbrl` | real annual revenue for every US-listed company, no key | `npm run ingest:edgar -- --write` (matches on `ticker`) |
| **SEC company_tickers.json** | the full list of US public companies + CIKs | seed `id`/`ticker`/`name` from it, then EDGAR for financials |
| **Wikipedia / Wikidata SPARQL** | founded year, HQ, employees, industry, for anything with an article | SPARQL endpoint, no key, generous limits |
| **CB Insights / Crunchbase unicorn lists** | valuation + funding for private unicorns | published as HTML tables, scrape once into a slice |
| **Companies House (UK), OpenCorporates** | EU/UK registered entities, filings | free tiers, good for the Europe coverage gap |
| **GitHub topic/org pages** | dev-tool coverage and open-source vendors | useful for finding companies you've missed, not for financials |

Add Brandfetch or Logo.dev for higher-res logos: `LOGO_CDN='https://cdn.brandfetch.io/{domain}/w/256/h/256?c=YOUR_KEY' npm run data`.

### Making the financial filters accurate

- **Public companies:** run the EDGAR ingest. It sets `revenueEstimated: false`.
  Never hand-type these — they go stale every quarter and EDGAR is free.
- **Private companies:** leave `revenueEstimated: true`. An estimate that is
  labelled is useful; one that pretends to be reported is not.
- **Valuation for public companies** is market cap, which moves daily — it's
  marked `valuationEstimated: true` on purpose. Wire a quotes API if you need it live.
- **Revenue vs ARR:** the schema has one field. For SaaS privates the figure is
  ARR; for public companies it's GAAP annual revenue. Split the field if that
  distinction matters to you.

### Making competitor search more accurate

The graph is the highest-leverage thing in the whole app — one correct edge beats a
lot of embedding tuning. In order of payoff:

1. **Add edges, especially for the categories you care about.** They're symmetrised,
   so each one is a single line.
2. **Make descriptions discriminative.** "Cloud software for business" embeds near
   everything. Name the product, the buyer and the mechanism.
3. **Keep categories tight.** They're a hard-ish signal at 0.25 weight on competitor
   queries; twelve loose tags per company dilutes it.
4. **Turn on Laya** (below) if you want the percentage to be a real probability.

---

## Laya (optional calibrated reranking)

The built-in confidence is a relevance ordering rescaled to 0–100. It is *not* a
probability. [Laya](https://github.com/NandhaKishorM/laya) — Apache-2.0, an open
alternative to TypeSafe's Jev — is a non-autoregressive decision engine whose `noul`
head returns a calibrated yes/no probability in ~33ms. Point the app at one and the
top 30 hits get reranked by `P(this company is a direct competitor of X)`, which is
exactly what the badge claims to show.

```bash
# run Laya however you prefer (see its README), then:
echo 'VITE_LAYA_URL=http://localhost:8000' >> .env.local
```

Off by default. Every failure mode — unset, down, slow, malformed response — falls
back to the local score with no error surfaced. The status bar reads
`Laya calibrated` only when a rerank actually landed.

---

## Swapping the embedding model

`src/search/embed.ts` exports `setEmbedder(fn)`. Anything returning L2-normalised
vectors works, as long as `scripts/build-embeddings.mjs` uses the same model and
dimension. `bge-small-en-v1.5` is the obvious upgrade (384-dim, same shape, better
retrieval); change `MODEL` in both places and re-run `npm run data`.

---

## Commands

| command | does |
|---|---|
| `npm run dev` | dev server on :5188 |
| `npm run build` | typecheck + production bundle |
| `npm run data` | rebuild `companies.json` **and** `embeddings.bin` |
| `npm run embed` | embeddings only |
| `npm run ingest:edgar` | dry-run SEC revenue diff (`-- --write` to apply) |
| `node scripts/smoke.mjs` | run the ranker over example queries in Node |
| `node scripts/smoke.mjs --semantic` | same, with embeddings on |

## Interaction

- `/` focuses search · `Esc` blurs
- Drag logos · click one for its detail card · **Shake** kicks the pile
- **Tilt** uses DeviceOrientation (iOS prompts for permission) so tilting the
  laptop or phone shakes the heap
- Results also list in the right rail, click to jump

## Known limits

- 279 companies. The ranking is only as good as the graph and the descriptions.
- Valuations for public companies are approximate market caps, not live quotes.
- `requestAnimationFrame` pauses in background tabs — the pile freezes and resumes,
  which is correct browser behaviour, not a bug.
- Image-based (logo similarity) search is not implemented. The hook for it is
  `setEmbedder` plus a CLIP image tower; the corpus blob format already supports it.
