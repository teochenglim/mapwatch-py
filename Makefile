.PHONY: build up down restart logs dev install seed-data \
        tilemap-build tilemap-up tilemap-down tilemap-download

# ── Local dev (uvicorn with hot-reload) ──────────────────────────────────────
dev:
	uvicorn main:app --reload --host 0.0.0.0 --port 8000

install:
	uv pip install -r pyproject.toml

# ── Docker (full stack: app + tilemap-server) ─────────────────────────────────
build:
	docker compose build

up:
	docker compose up -d

down:
	docker compose down

restart: down up

logs:
	docker compose logs -f

# ── Seed GeoJSON data into the named volume ───────────────────────────────────
# Run once after `make up` to copy local data files into the container volume.
seed-data:
	@for f in data/*.geojson; do \
	  echo "  copying $$f"; \
	  docker compose cp $$f app:/app/data/; \
	done

# ── Tilemap-server (standalone) ───────────────────────────────────────────────
tilemap-build:
	docker compose -f tilemap-server/docker-compose.yml build

tilemap-up:
	docker compose -f tilemap-server/docker-compose.yml up -d

tilemap-down:
	docker compose -f tilemap-server/docker-compose.yml down

# Pre-download Singapore tiles into tilemap-server/tiles/
# Usage: make tilemap-download ZOOM_MIN=10 ZOOM_MAX=15 LAYERS=dark,streets
ZOOM_MIN ?= 10
ZOOM_MAX ?= 15
LAYERS   ?= dark,streets
tilemap-download:
	sh tilemap-server/download-sg-tiles.sh \
	  --zoom-min $(ZOOM_MIN) --zoom-max $(ZOOM_MAX) \
	  --layers $(LAYERS) \
	  --out tilemap-server/tiles
