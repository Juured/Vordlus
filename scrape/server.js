// vordlus scrape service
// ======================
// Headless scrape service for Estonian real-estate listings (kv.ee, city24.ee,
// kinnisvara24.ee). Runs on a VPS IP to bypass Cloudflare gating that hits
// Vercel edge IPs.
//
// POST /scrape        body: { url }       → { photoUrl, title, address, blocked }
// GET  /health                          → 200 "ok"
//
// Env vars:
//   PORT                default 3000
//   SCRAPE_TIMEOUT_MS   default 30000 — total per-request budget
//   CACHE_TTL_MS        default 3600000 (1h)
//   CACHE_MAX           default 100
//   HEADLESS            default "true" — set "false" for local debugging only

const express = require("express");
const { chromium } = require("playwright");
const { LruTtl } = require("./cache");
const {
  extractFirstPhoto,
  extractTitle,
  looksLikeBlocked,
} = require("./extract");

const PORT = parseInt(process.env.PORT || "3000", 10);
const SCRAPE_TIMEOUT_MS = parseInt(process.env.SCRAPE_TIMEOUT_MS || "30000", 10);
const CACHE_TTL_MS = parseInt(process.env.CACHE_TTL_MS || "3600000", 10);
const CACHE_MAX = parseInt(process.env.CACHE_MAX || "100", 10);
const HEADLESS = (process.env.HEADLESS || "true").toLowerCase() !== "false";

const cache = new LruTtl({ max: CACHE_MAX, ttlMs: CACHE_TTL_MS });

let browserPromise = null;

async function getBrowser() {
  if (browserPromise) return browserPromise;
  browserPromise = chromium.launch({
    headless: HEADLESS,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      // Make us look like a normal Chrome a bit more. Playwright already
      // patches navigator.webdriver, but a few extra flags don't hurt.
      "--disable-blink-features=AutomationControlled",
    ],
  });
  return browserPromise;
}

async function scrapeOnce(url) {
  const browser = await getBrowser();
  const context = await browser.newContext({
    userAgent:
      "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) " +
      "Chrome/131.0.0.0 Safari/537.36",
    locale: "et-EE",
    timezoneId: "Europe/Tallinn",
    viewport: { width: 1280, height: 800 },
    extraHTTPHeaders: {
      "Accept-Language": "et-EE,et;q=0.9,en;q=0.7",
    },
  });
  const page = await context.newPage();

  try {
    const response = await page.goto(url, {
      waitUntil: "domcontentloaded",
      timeout: SCRAPE_TIMEOUT_MS,
    });
    // Try to wait for the page to settle. Don't fail if it never does —
    // we still want the HTML we have.
    try {
      await page.waitForLoadState("networkidle", { timeout: Math.max(2000, Math.floor(SCRAPE_TIMEOUT_MS / 3)) });
    } catch {
      /* swallow — networkidle may never fire on ad-heavy pages */
    }

    const status = response ? response.status() : 0;
    const html = await page.content();

    if (looksLikeBlocked(html) || status === 403 || status === 503) {
      return { blocked: true, photoUrl: null, title: null, address: null, status };
    }

    const photoUrl = extractFirstPhoto(html, url);
    const title = extractTitle(html);

    return { blocked: false, photoUrl, title, address: title, status };
  } finally {
    await page.close().catch(() => {});
    await context.close().catch(() => {});
  }
}

function validateUrl(url) {
  try {
    const u = new URL(url);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    return u;
  } catch {
    return null;
  }
}

const app = express();
app.use(express.json({ limit: "32kb" }));

app.get("/health", (_req, res) => {
  res.json({ ok: true, cacheSize: cache.size(), browserReady: !!browserPromise });
});

app.post("/scrape", async (req, res) => {
  const t0 = Date.now();
  const url = (req.body && req.body.url) || "";
  const parsed = validateUrl(url);
  if (!parsed) {
    return res.status(400).json({ error: "invalid url", url });
  }

  const cacheKey = parsed.toString();
  const cached = cache.get(cacheKey);
  if (cached) {
    return res.json({ ...cached, cached: true, elapsedMs: Date.now() - t0 });
  }

  try {
    const result = await scrapeOnce(cacheKey);
    const out = {
      photoUrl: result.photoUrl,
      title: result.title,
      address: result.address,
      blocked: result.blocked,
    };
    // Cache everything except pure "blocked" responses — those can recover
    // and we want to re-try. Cache miss + null photo (a real miss) is fine to
    // cache so we don't hammer kv.ee with a known-broken URL.
    if (!result.blocked) {
      cache.set(cacheKey, out);
    }
    return res.json({ ...out, cached: false, elapsedMs: Date.now() - t0, status: result.status });
  } catch (e) {
    return res.status(502).json({
      error: (e && e.message) || "scrape failed",
      url,
      elapsedMs: Date.now() - t0,
    });
  }
});

const server = app.listen(PORT, "0.0.0.0", () => {
  console.log(`[scrape] listening on :${PORT}`);
  // Warm up the browser in the background so the first /scrape is fast.
  getBrowser().then(() => console.log("[scrape] browser ready")).catch((e) => {
    console.error("[scrape] failed to launch browser:", e && e.message);
  });
});

async function shutdown(signal) {
  console.log(`[scrape] received ${signal}, shutting down`);
  server.close(() => process.exit(0));
  try {
    if (browserPromise) {
      const b = await browserPromise;
      await b.close();
    }
  } catch {
    /* ignore */
  }
  setTimeout(() => process.exit(1), 5000).unref();
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
