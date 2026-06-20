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
