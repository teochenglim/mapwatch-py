.PHONY: build up down restart logs dev install seed-data \
        up-offline down-offline restart-offline logs-offline \
        tilemap-build tilemap-up tilemap-down tilemap-download

# ── Local dev (uvicorn with hot-reload, online CDN tiles) ────────────────────
dev:
	TILE_MODE=online uvicorn main:app --reload --host 0.0.0.0 --port 8000

install:
	uv pip install -r pyproject.toml

# ── Online mode (single app container, CDN tiles) ─────────────────────────────
# Tiles fetched on demand from CDN and cached locally. No tilemap containers.
build:
	docker compose build

up:
	docker compose up -d

down:
	docker compose down

restart: down up

logs:
	docker compose logs -f

# ── Offline mode (app + nginx tilemap containers, local tiles) ────────────────
# Requires tiles pre-downloaded into tilemap-server-*/tiles/ first.
# Run `make tilemap-download` before first use.
build-offline:
	docker compose -f docker-compose.offline.yml build

up-offline:
	docker compose -f docker-compose.offline.yml up -d

down-offline:
	docker compose -f docker-compose.offline.yml down

restart-offline: down-offline up-offline

logs-offline:
	docker compose -f docker-compose.offline.yml logs -f

# ── Seed GeoJSON data into the running app container ─────────────────────────
seed-data:
	@for f in data/*.geojson; do \
	  echo "  copying $$f"; \
	  docker compose cp $$f app:/app/data/; \
	done

# ── Pre-download Singapore tiles into tilemap-server-*/tiles/ ─────────────────
# Run this before `make up-offline`.
# Usage examples:
#   make tilemap-download                              # dark only, z10-z19
#   make tilemap-download ZOOM_MIN=10 ZOOM_MAX=15      # lower zoom for quick test
#   make tilemap-download LAYERS=dark,light,streets    # all layers
ZOOM_MIN ?= 10
ZOOM_MAX ?= 19
LAYERS   ?= dark
tilemap-download:
	@for layer in $(shell echo "$(LAYERS)" | tr ',' ' '); do \
	  echo "==> Downloading $$layer tiles z$(ZOOM_MIN)–z$(ZOOM_MAX)"; \
	  sh tilemap-server-$$layer/download-sg-tiles.sh \
	    --zoom-min $(ZOOM_MIN) --zoom-max $(ZOOM_MAX) \
	    --layers $$layer \
	    --out tilemap-server-$$layer/tiles; \
	done
