# syntax=docker/dockerfile:1.6
#
# vordlus scrape service — Python + Crawl4AI.
#
# Multi-stage build:
#   - builder: install Crawl4AI + Playwright deps into a venv we copy
#     into the runtime image.
#   - runtime: slim python:3.12-slim with the venv + chromium + its
#     native libs. No compiler toolchain, no apt cache.
#
# Crawl4AI bundles Playwright + patchright, but we still need Chromium
# and the native libs it links against. `playwright install --with-deps
# chromium` handles both.

# ── builder ────────────────────────────────────────────────────────
FROM python:3.12-slim AS builder

ENV PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PYTHONDONTWRITEBYTECODE=1

WORKDIR /build

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        build-essential \
        gcc \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt ./
RUN python -m venv /opt/venv \
    && /opt/venv/bin/pip install --upgrade pip \
    && /opt/venv/bin/pip install -r requirements.txt


# ── runtime ────────────────────────────────────────────────────────
FROM python:3.12-slim AS runtime

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PORT=3000 \
    SCRAPE_TIMEOUT_MS=30000 \
    CACHE_TTL_SECONDS=3600 \
    CACHE_MAX=100 \
    PATH="/opt/venv/bin:$PATH"

# Native libs Chromium needs. The list matches `playwright install
# --with-deps chromium` on Debian bookworm.
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        ca-certificates \
        fonts-liberation \
        libasound2 \
        libatk-bridge2.0-0 \
        libatk1.0-0 \
        libc6 \
        libcairo2 \
        libcups2 \
        libdbus-1-3 \
        libexpat1 \
        libfontconfig1 \
        libgbm1 \
        libgcc-s1 \
        libglib2.0-0 \
        libgtk-3-0 \
        libnspr4 \
        libnss3 \
        libpango-1.0-0 \
        libpangocairo-1.0-0 \
        libstdc++6 \
        libx11-6 \
        libx11-xcb1 \
        libxcb1 \
        libxcomposite1 \
        libxcursor1 \
        libxdamage1 \
        libxext6 \
        libxfixes3 \
        libxi6 \
        libxrandr2 \
        libxrender1 \
        libxss1 \
        libxtst6 \
        wget \
        xdg-utils \
    && rm -rf /var/lib/apt/lists/*

# Non-root for Coolify.
RUN groupadd --system --gid 1001 vordlus \
    && useradd --system --uid 1001 --gid vordlus vordlus

# Bring in the venv from the builder.
COPY --from=builder /opt/venv /opt/venv

WORKDIR /app
COPY --chown=vordlus:vordlus . /app

USER vordlus

# Crawl4AI downloads Chromium on first run. Pre-install at image build
# time so the first /scrape call is fast. Uses ~170MB of image size.
RUN python -m playwright install chromium

EXPOSE 3000

CMD ["python", "-m", "uvicorn", "server:app", "--host", "0.0.0.0", "--port", "3000"]
