.PHONY: build up down restart logs dev install seed-data \
        pull-offline up-offline down-offline restart-offline logs-offline

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

# ── Offline mode (app + proxy build; tilemap images pulled from GHCR) ─────────
# Tiles are baked into GHCR images — no local download needed.
# Prerequisites: docker login ghcr.io
build-offline:
	docker compose -f docker-compose.offline.yml build

pull-offline:
	docker compose -f docker-compose.offline.yml pull

up-offline: pull-offline
	docker compose -f docker-compose.offline.yml up -d --remove-orphans

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

