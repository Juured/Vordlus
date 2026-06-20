# vordlus scrape service (Python + Crawl4AI)

A small headless scrape service for Estonian real-estate listings
([kv.ee](https://kv.ee), [city24.ee](https://city24.ee),
[kinnisvara24.ee](https://kinnisvara24.ee)). Runs in Coolify on a VPS
IP, which has a much better reputation than Vercel's edge IPs for
getting past Cloudflare's anti-bot layer.

The vordlus Next.js app calls this service to get the first listing
photo (and a normalized `NormalizedListing` schema with title, address,
price, area, rooms, photos) for a kv.ee / city24.ee / kinnisvara24.ee
URL.

## Architecture

```
HTTP request
   │
   ▼
/scrape  ──►  registry.get_adapter(url)  ──►  KvEeAdapter  |  City24Adapter  |  Kinnisvara24Adapter
                                                          │
                                                          ▼
                                              AsyncWebCrawler (Crawl4AI)
                                                          │
                                                          ▼
                                              LLMExtractionStrategy
                                              (OpenAI gpt-4o-mini)
                                                          │
                                                          ▼
                                              NormalizedListing
```

Adapters are pluggable: adding a new portal is one new class in
`adapters/` + one line in `adapters/__init__.py`. The LLM extraction
schema is shared (`schema.NormalizedListing`), so all adapters emit
the same shape.

## API

### `GET /health`

```json
{ "ok": true, "cacheSize": 3, "llmReady": true, "version": "0.2.0" }
```

### `GET /sources`

```json
["kv.ee", "city24.ee", "kinnisvara24.ee"]
```

### `POST /scrape`

Body:

```json
{ "url": "https://www.kv.ee/3995056", "source": "kv.ee" }
```

`source` is optional — auto-detected from the URL host. Response:

```json
{
  "listing": {
    "source": "kv.ee",
    "source_id": "3995056",
    "url": "https://www.kv.ee/3995056",
    "title": "3-toaline korter, 56 m²",
    "address": "Tartu mnt 47, Nõmme, Tallinn",
    "price": 215000.0,
    "area_m2": 56.0,
    "rooms": 3,
    "photos": ["https://img-bb.kv.ee/.../foo.jpg", "..."],
    "description": "Heas seisukorras 3-toaline korter Nõmmel...",
    "agent_name": "Uus Maa Kinnisvara",
    "agent_phone": "+372 5555 1234",
    "fetched_at": "2026-06-20T10:30:00+00:00"
  },
  "blocked": false,
  "cached": false,
  "elapsed_ms": 4321
}
```

When the page is blocked by Cloudflare (challenge page detected):

```json
{ "listing": null, "blocked": true, "cached": false, "elapsed_ms": 1234 }
```

Errors:

- `400 { "detail": "invalid url" }` — non-HTTP(S) URL.
- `400 { "detail": "unsupported source" }` — host is not a known portal.
- `502 { "listing": null, "error": "..." }` — Chromium failed.
- `503 { "listing": null, "error": "LLM API key not configured" }` — no `OPENAI_API_KEY` / `ANTHROPIC_API_KEY`.
- `504 { "listing": null, "error": "scrape timeout" }` — exceeded `SCRAPE_TIMEOUT_MS`.

## Environment variables

| Var | Default | Notes |
|---|---|---|
| `PORT` | `3000` | HTTP listen port. |
| `SCRAPE_TIMEOUT_MS` | `30000` | Total per-request budget. |
| `CACHE_TTL_SECONDS` | `3600` | In-memory LRU TTL (1h). |
| `CACHE_MAX` | `100` | LRU size. |
| `OPENAI_API_KEY` | _(none)_ | Required for LLM extraction. Without it `/scrape` returns 503. `/health` and `/sources` still work. |
| `ANTHROPIC_API_KEY` | _(none)_ | Optional. Used if `OPENAI_API_KEY` is not set. |
| `LLM_PROVIDER` | `openai` | `openai` or `anthropic`. |
| `LLM_MODEL` | `gpt-4o-mini` (OpenAI) / `claude-3-5-sonnet-latest` (Anthropic) | Override the model. |
| `LOG_LEVEL` | `INFO` | Python logging level. |

## Local development

```bash
cd scrape
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
playwright install chromium
export OPENAI_API_KEY=sk-...
uvicorn server:app --reload --port 3000
# in another shell
curl -fsS http://localhost:3000/health
curl -fsS http://localhost:3000/sources
curl -fsS -X POST http://localhost:3000/scrape \
  -H 'content-type: application/json' \
  -d '{"url":"https://www.kv.ee/3995056"}'
```

> Local Cloudflare success depends on your residential IP. From a VPS
> (the deployment target), it almost always works. From a home
> connection, kv.ee often returns the challenge page.

## Coolify deployment

1. In Coolify, create a new **Private Service** (with Dockerfile).
2. Point the Git source at the vordlus repo, set **Dockerfile path**
   to `scrape/Dockerfile`.
3. **Port** = `3000`. **Healthcheck path** = `/health`.
4. **Environment**: set `OPENAI_API_KEY=sk-...` (required for real
   extraction). Image builds in ~3-5 min (Craw4lAI + Chromium).
5. In the vordlus app's environment, set:
   ```
   SCRAPE_SERVICE_URL=http://<scrape-service-name>:3000
   ```
   where `<scrape-service-name>` is the Coolify internal DNS name of
   this service.

## Why not just run this on Vercel?

Vercel's edge IPs are heavily flagged by Cloudflare. Even a perfectly
innocent Chromium from a Vercel function gets the challenge page for
kv.ee. A typical Hetzner / OVH / DO VPS IP is shared by fewer
Cloudflare-targeted users and is far more likely to pass.

## License

MIT. Listing photos are © their respective owners; this service only
extracts URLs, not image bytes.

## Enrichment layer (v0.3+)

The scrape service persists every /scrape to a local SQLite database
and exposes two new endpoints the vordlus `/api/enrich` orchestrator
calls. SQLite is in the stdlib — no native build deps.

### `POST /scrape/listing`

Full record from a single listing URL. Persists to SQLite
(`DB_PATH`, default `/data/vordlus.db`).

Body: `{ "url": "https://www.kv.ee/3995056" }`

Response (200):
```json
{
  "id": "kv.ee:3995056",
  "source": "kv.ee",
  "source_id": "3995056",
  "url": "https://www.kv.ee/3995056",
  "address_norm": "viljandi-mnt-47-tallinn",
  "address_display": "Viljandi mnt 47, Tallinn",
  "first_seen_at": 1715000000000,
  "days_on_market": 42,
  "price_history": [
    { "date": 1715000000000, "price": 449000 },
    { "date": 1717800000000, "price": 420000 }
  ],
  "current": {
    "price_eur": 420000, "area_m2": 199, "rooms": 5,
    "energy_class": "D", "build_year": 1970,
    "photo_count": 12, "description_len": 1450,
    "has_floor_plan": true, "photo_url": "https://..."
  },
  "blocked": false
}
```

- Persists a `listings` row keyed by `source:source_id`. `first_seen_at`
  is preserved across re-scrapes.
- Appends to `price_history` only if the price changed since the
  last observation.
- **Falls back to SQLite** when `OPENAI_API_KEY` is missing (returns
  `{"error": "no llm key", "cached": true, ...}` with whatever was
  previously scraped). This lets the panel boot in the LLM-key
  bootstrap window.

### `POST /scrape/search`

Listings matching a normalized address, plus aggregate stats.

Body:
```json
{
  "address": "Viljandi mnt 47, Tallinn",
  "type": "sale",
  "areaMin": 100, "areaMax": 300,
  "roomsMin": 3, "roomsMax": 6
}
```

Response (200):
```json
{
  "address_norm": "viljandi-mnt-47-tallinn",
  "type": "sale",
  "total_count": 12,
  "by_portal": { "kv.ee": 8, "city24.ee": 4 },
  "listings": [
    {
      "id": "kv.ee:3995056",
      "url": "https://www.kv.ee/3995056",
      "portal": "kv.ee",
      "price_eur": 420000, "area_m2": 199, "rooms": 5,
      "price_per_m2": 2110,
      "first_seen_at": 1715000000000,
      "days_on_market": 42,
      "address_display": "Viljandi mnt 47, Tallinn",
      "photo_url": "https://...",
      "energy_class": "D"
    }
  ],
  "stats": {
    "median_price_eur": 400000,
    "median_price_per_m2": 2110,
    "p25_price_per_m2": 1750,
    "p75_price_per_m2": 2400
  },
  "cached": false
}
```

Query strategy: SQLite exact-match on `address_norm` first, then
LIKE-fallback on the first 2 address tokens. Filters: `areaMin`/
`areaMax` (m²), `roomsMin`/`roomsMax`.

## Persistence

SQLite via the stdlib `sqlite3` module. Two tables:

```sql
CREATE TABLE listings (
  id TEXT PRIMARY KEY,         -- "{source}:{source_id}" e.g. "kv.ee:3995056"
  source TEXT, source_id TEXT, url TEXT UNIQUE,
  address_norm TEXT, address_display TEXT,
  first_seen_at INTEGER, last_seen_at INTEGER,
  last_price_eur INTEGER, area_m2 REAL, rooms INTEGER,
  energy_class TEXT, build_year INTEGER,
  photo_count INTEGER, description_len INTEGER, has_floor_plan INTEGER,
  photo_url TEXT
);
CREATE TABLE price_history (
  listing_id TEXT, observed_at INTEGER, price_eur INTEGER,
  PRIMARY KEY (listing_id, observed_at)
);
```

**Important:** mount `DB_PATH` (default `/data/vordlus.db`) as a
Coolify volume so the database persists across container restarts.

## Env vars

- `PORT` — default 3000
- `SCRAPE_TIMEOUT_MS` — default 30000
- `CACHE_TTL_SECONDS` — default 3600 (1h)
- `CACHE_MAX` — default 100
- `DB_PATH` — default `/data/vordlus.db` (mount as Coolify volume)
- `OPENAI_API_KEY` — required for /scrape LLM extraction. Without
  it, /scrape/listing and /scrape/search still work from SQLite cache.
- `ANTHROPIC_API_KEY` — optional alternative
- `LLM_PROVIDER` — "openai" (default) or "anthropic"
- `LLM_MODEL` — override the model name

## Tests

```bash
cd scrape
python -m pip install --break-system-packages pytest pydantic
python -m pytest __tests__/db_test.py -v
```

6/6 tests pass: schema creation, upsert, first_seen_at preservation,
price_history dedup, address normalization.
