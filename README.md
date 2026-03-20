# mapwatch-py

Singapore interactive map viewer — ported from [mapwatcher](https://github.com/teochenglim/mapwatcher) (Go) to **Python / FastAPI**.

Built for air-gapped Kubernetes environments where an offline tile cache and path-based Traefik routing are required.

---

## Features

| Feature | Detail |
|---|---|
| **4 tile layers** | Dark (CartoDB), Light (CartoDB), Streets (OSM), Satellite (Esri) |
| **6 GeoJSON overlays** | NPC Divisions, Roads, Cycling, MRT, Bus Stops, Bus Routes |
| **Drag-to-select** | Rectangle select across all visible layers |
| **Offline tiles** | Built-in CDN proxy with disk cache — or point at `tilemap-server` |
| **Real-time events** | WebSocket `/ws` stub ready for marker.add / update / remove |
| **Path-based routing** | `ROOT_PATH` env var for Traefik `stripPrefix` on K8s |
| **Two Docker images** | `mapwatch-py` (app) + `tilemap-server` (nginx tile cache) |

---

## Quick Start

### Local dev (uvicorn)

```bash
uv pip install -r pyproject.toml   # or: pip install fastapi httpx uvicorn jinja2
uvicorn main:app --reload
open http://localhost:8000
```

### Docker Compose (full stack)

```bash
docker compose up --build -d

# Seed GeoJSON data into the container volume (run once)
make seed-data
```

App → http://localhost:8000
Tile server → http://localhost:8001

---

## GeoJSON Data Layers

Layers are lazy-loaded on first toggle. Files are fetched automatically from public APIs on first request and cached to `data/`.

| Layer | File | Source |
|---|---|---|
| Divisions | `sg-npc-boundary.geojson` | data.gov.sg (SPF NPC Boundary) |
| Roads | `sg-roads.geojson` | data.gov.sg (SLA National Map Line) |
| Cycling | `sg-cycling.geojson` | data.gov.sg (LTA Cycling Path) |
| MRT | `sg-mrt.geojson` | data.gov.sg (URA Master Plan 2019) |
| Bus Stops | `sg-bus-stops.geojson` | busrouter.sg |
| Bus Routes | `sg-bus-routes.geojson` | busrouter.sg |

To pre-seed specific files (faster first load):

```bash
# Copy from a local mapwatcher clone
cp ../mapwatcher/data/sg-npc-boundary.geojson data/
cp ../mapwatcher/data/sg-bus-routes.geojson   data/

# Then seed into the running container
make seed-data
```

---

## Offline Tile Cache (`tilemap-server`)

`tilemap-server` is a standalone nginx image with Singapore tiles **baked in at build time** by GitHub Actions. No internet access is required at runtime — designed for air-gapped K8s.

### How it works

```
git push origin main
    │
    └─▶ GitHub Actions (has internet)
            │
            ├─ downloads SG tiles  (zoom 10–15, dark + streets)
            │   └─ cached between runs — only re-downloads on cache miss
            │
            └─ docker build (COPY tiles/ /tiles/)
                    │
                    └─▶ ghcr.io/teochenglim/mapwatch-py/tilemap-server:latest
                              (nginx + ~80–150 MB of PNG tiles, no volume needed)
```

### Adjust tile coverage

Edit the env vars at the top of `.github/workflows/docker.yml`:

```yaml
TILE_ZOOM_MIN: '10'
TILE_ZOOM_MAX: '15'          # z15 = street level detail, ~20 000 tiles per layer
TILE_LAYERS:   'dark,streets'  # dark | light | streets | satellite
```

### Force a tile refresh

Tiles are cached in GitHub Actions between runs. To re-download (e.g. OSM data updated):

```
Actions → Build and push Docker images → Run workflow → tile_cache_bust: 2
```

### Local tile download (connected machine)

```bash
sh tilemap-server/download-sg-tiles.sh \
  --zoom-min 10 --zoom-max 15 \
  --layers dark,streets \
  --out tilemap-server/tiles

# Then rebuild the image locally
docker compose build tilemap-server
```

---

## Path-based Routing (Traefik / K8s)

Traefik uses `stripPrefix` middleware — the pod always sees requests from `/`.
Two env vars tell the **browser** where to find resources:

| Env var | Local dev | K8s |
|---|---|---|
| `ROOT_PATH` | `""` | `/department/mapwatch-py` |
| `TILE_SERVER_URL` | `""` (built-in proxy) | `/department/tile-server` |

Example K8s `Deployment` env:

```yaml
env:
  - name: ROOT_PATH
    value: /department/mapwatch-py
  - name: TILE_SERVER_URL
    value: /department/tile-server
```

Example Traefik `IngressRoute`:

```yaml
# mapwatch-py app
- match: PathPrefix(`/department/mapwatch-py`)
  middlewares: [strip-mapwatch]
  services: [{name: mapwatch-py, port: 8000}]

# tilemap-server
- match: PathPrefix(`/department/tile-server`)
  middlewares: [strip-tilemap]
  services: [{name: tilemap-server, port: 80}]
```

```yaml
# Middlewares
apiVersion: traefik.io/v1alpha1
kind: Middleware
metadata: {name: strip-mapwatch}
spec:
  stripPrefix:
    prefixes: [/department/mapwatch-py]
---
apiVersion: traefik.io/v1alpha1
kind: Middleware
metadata: {name: strip-tilemap}
spec:
  stripPrefix:
    prefixes: [/department/tile-server]
```

---

## WebSocket (Real-time Events)

The `/ws` endpoint accepts connections (status dot turns green) but does nothing yet.

To push events, call `broadcast()` from anywhere in the app:

```python
# In main.py — _ws_clients set is already maintained
await broadcast({
    "type":   "marker.add",
    "marker": {"id": "alert-1", "lat": 1.3521, "lng": 103.8198,
               "severity": "warning", "alertname": "HighCPU"}
})
```

Supported message types (consumed by `mapwatch.js`):

```
marker.add    — place a new severity dot on the map
marker.update — move or re-colour an existing dot
marker.remove — remove a dot  {"type":"marker.remove","id":"..."}
```

---

## CI/CD — GitHub Actions

On every push to `main` (or version tag `v*.*.*`), two Docker images are built and pushed to GitHub Container Registry:

| Image | Tag |
|---|---|
| `ghcr.io/teochenglim/mapwatch-py` | `latest`, `main`, `v1.2.3` |
| `ghcr.io/teochenglim/mapwatch-py/tilemap-server` | `latest`, `main`, `v1.2.3` |

No secrets needed beyond the automatic `GITHUB_TOKEN` (already in the workflow).

```bash
git add .
git commit -m "feat: ..."
git push origin main
# → GitHub Actions builds and pushes both images automatically
```

Pull the images:

```bash
docker pull ghcr.io/teochenglim/mapwatch-py:latest
docker pull ghcr.io/teochenglim/mapwatch-py/tilemap-server:latest
```

---

## Project Structure

```
mapwatch-py/
├── main.py                     # FastAPI app — tiles, GeoJSON, config, WebSocket
├── Dockerfile                  # app image
├── docker-compose.yml          # full stack (app + tilemap-server)
├── Makefile                    # build / up / seed-data / tilemap-download
├── pyproject.toml
│
├── static/
│   ├── index.html              # Jinja2 template — injects MW_BASE, MW_TILE_BASE
│   ├── mapwatch.js             # Leaflet UI — ported from mapwatcher (Go)
│   ├── effects/
│   │   ├── blink.js
│   │   ├── heatmap.js
│   │   └── geohash-grid.js
│   ├── modules/
│   │   ├── sound.js
│   │   ├── leaderboard.js
│   │   └── stats.js
│   └── lib/                    # Leaflet + MarkerCluster (downloaded at startup)
│
├── data/                       # GeoJSON cache + tile disk cache
│   ├── sg-bus-stops.geojson
│   ├── sg-npc-boundary.geojson
│   └── tiles/{layer}/{z}/{x}/{y}.png
│
├── tilemap-server/
│   ├── Dockerfile              # nginx:alpine tile server
│   ├── nginx.conf
│   ├── download-sg-tiles.sh    # pre-download SG tiles for offline use
│   └── docker-compose.yml      # standalone tilemap-server
│
└── .github/
    └── workflows/
        └── docker.yml          # build + push both images on push to main
```

---

## API Reference

| Method | Path | Description |
|---|---|---|
| `GET` | `/` | Leaflet map UI |
| `GET` | `/api/config` | Available layers + feature flags |
| `GET` | `/api/geojson/{name}` | GeoJSON layer (auto-downloads on first request) |
| `GET` | `/tiles/{layer}/{z}/{x}/{y}.png` | Tile proxy with disk cache |
| `WS`  | `/ws` | WebSocket — real-time marker events |

Interactive API docs: http://localhost:8000/docs

---

## Data Sources

| Data | Source |
|---|---|
| Bus stops / routes | [busrouter.sg](https://data.busrouter.sg) |
| NPC divisions, roads, cycling, MRT | [data.gov.sg](https://data.gov.sg) |
| Dark / Light tiles | [CartoDB](https://carto.com/basemaps/) |
| Streets tiles | [OpenStreetMap](https://www.openstreetmap.org/copyright) |
| Satellite tiles | [Esri World Imagery](https://www.esri.com/) |
