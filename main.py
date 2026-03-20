"""mapwatch-py — Singapore map viewer with offline tile proxy and GeoJSON layers.

Path-prefix / Traefik design
────────────────────────────
Traefik uses stripPrefix middleware so the app always sees requests starting
at '/'.  Two env vars configure what the *browser* uses to build URLs:

  ROOT_PATH       The path prefix Traefik exposes mapwatch-py under.
                  e.g. /department/mapwatch-py
                  Default: "" (root, for local dev)

  TILE_SERVER_URL The public base URL for the tile server.
                  e.g. /department/tile-server
                  Default: "" → uses the built-in tile proxy at
                  {ROOT_PATH}/tiles/{layer}/{z}/{x}/{y}.png

Both values are injected into index.html as window.MW_BASE / window.MW_TILE_BASE
so the frontend JS can build correct absolute URLs regardless of where the app
is mounted.
"""
import json
import os
from contextlib import asynccontextmanager
from pathlib import Path

import httpx
from fastapi import FastAPI, HTTPException, Request, WebSocket, WebSocketDisconnect
from fastapi.responses import HTMLResponse, JSONResponse, Response, FileResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates

BASE     = Path(__file__).parent
DATA_DIR = BASE / "data"
LIB_DIR  = BASE / "static" / "lib"
DATA_DIR.mkdir(exist_ok=True)
LIB_DIR.mkdir(exist_ok=True)

# ── Runtime configuration ─────────────────────────────────────────────────────

ROOT_PATH       = os.getenv("ROOT_PATH", "").rstrip("/")
TILE_SERVER_URL = os.getenv("TILE_SERVER_URL", "").rstrip("/")

# ── External data sources ─────────────────────────────────────────────────────

GEOJSON_SOURCES = {
    "sg-bus-stops":  "https://data.busrouter.sg/v1/stops.min.geojson",
    "sg-bus-routes": "https://data.busrouter.sg/v1/routes.min.geojson",
}

DATAGOV_DATASETS = {
    "sg-cycling":      "d_8f468b25193f64be8a16fa7d8f60f553",
    "sg-mrt":          "d_222bfc84eb86c7c11994d02f8939da8d",
    "sg-npc-boundary": "d_89b44df21fccc4f51390eaff16aa1fe8",
    "sg-roads":        "d_10480c0b59e65663dfae1028ff4aa8bb",
}

TILE_SOURCES = {
    "dark":      "https://a.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png",
    "light":     "https://a.basemaps.cartocdn.com/light_all/{z}/{x}/{y}.png",
    "streets":   "https://tile.openstreetmap.org/{z}/{x}/{y}.png",
    "satellite": None,  # Esri — y/x swap handled separately
}

LEAFLET_VER  = "1.9.4"
LEAFLET_BASE = f"https://unpkg.com/leaflet@{LEAFLET_VER}/dist"
CLUSTER_VER  = "1.5.3"
CLUSTER_BASE = f"https://unpkg.com/leaflet.markercluster@{CLUSTER_VER}/dist"

templates = Jinja2Templates(directory=str(BASE / "static"))


async def _fetch(client: httpx.AsyncClient, url: str) -> bytes:
    r = await client.get(url, headers={"User-Agent": "mapwatch-py/2.0"}, follow_redirects=True)
    r.raise_for_status()
    return r.content


@asynccontextmanager
async def lifespan(_app: FastAPI):
    """On startup: ensure Leaflet + MarkerCluster assets and bus-stop data are cached."""
    async with httpx.AsyncClient(timeout=30) as client:
        for fname in ("leaflet.js", "leaflet.css"):
            dst = LIB_DIR / fname
            if not dst.exists():
                try:
                    dst.write_bytes(await _fetch(client, f"{LEAFLET_BASE}/{fname}"))
                except Exception:
                    pass

        for fname, url in [
            ("leaflet.markercluster.js", f"{CLUSTER_BASE}/leaflet.markercluster.js"),
            ("MarkerCluster.css",         f"{CLUSTER_BASE}/MarkerCluster.css"),
            ("MarkerCluster.Default.css", f"{CLUSTER_BASE}/MarkerCluster.Default.css"),
        ]:
            dst = LIB_DIR / fname
            if not dst.exists():
                try:
                    dst.write_bytes(await _fetch(client, url))
                except Exception:
                    pass

        for key, url in GEOJSON_SOURCES.items():
            dst = DATA_DIR / f"{key}.geojson"
            if not dst.exists():
                try:
                    dst.write_bytes(await _fetch(client, url))
                except Exception:
                    pass
    yield


app = FastAPI(title="mapwatch-py", lifespan=lifespan)

# Static assets mounted at /static.  Traefik stripPrefix exposes this at
# {ROOT_PATH}/static/ but the pod always sees /static/.
app.mount("/static", StaticFiles(directory=BASE / "static"), name="static")


# ── Index ─────────────────────────────────────────────────────────────────────

@app.get("/", include_in_schema=False)
def index(request: Request) -> HTMLResponse:
    """Render index.html, injecting base-path config for the frontend."""
    tile_base = TILE_SERVER_URL if TILE_SERVER_URL else f"{ROOT_PATH}/tiles"
    return templates.TemplateResponse("index.html", {
        "request":      request,
        "mw_base":      ROOT_PATH,
        "mw_tile_base": tile_base,
    })


# ── /ws — WebSocket stub (real-time events placeholder) ──────────────────────
# Accepts connections so the frontend status dot turns green and retries stop.
# TODO: wire to an event bus (e.g. Redis pub/sub, AlertManager webhook) to push
#       marker.add / marker.update / marker.remove messages to connected clients.

_ws_clients: set[WebSocket] = set()


@app.websocket("/ws")
async def websocket_endpoint(ws: WebSocket) -> None:
    await ws.accept()
    _ws_clients.add(ws)
    try:
        while True:
            await ws.receive_text()   # keep connection alive; ignore client messages
    except WebSocketDisconnect:
        pass
    finally:
        _ws_clients.discard(ws)


# ── /api/config ───────────────────────────────────────────────────────────────

@app.get("/api/config")
def api_config() -> JSONResponse:
    all_names = list(GEOJSON_SOURCES) + list(DATAGOV_DATASETS)
    available = {
        _layer_key(name): (DATA_DIR / f"{name}.geojson").exists()
        for name in all_names
    }
    return JSONResponse({
        "availableLayers": available,
        "modules":         {},
        "locations":       [],
        "heatmapRegions":  [],
    })


def _layer_key(filename: str) -> str:
    return {
        "sg-npc-boundary": "division",
        "sg-roads":        "roads",
        "sg-cycling":      "cycling",
        "sg-mrt":          "mrt",
        "sg-bus-stops":    "busStops",
        "sg-bus-routes":   "busRoutes",
    }.get(filename, filename)


# ── /api/geojson/{filename} ───────────────────────────────────────────────────

@app.get("/api/geojson/{filename}")
async def geojson(filename: str) -> JSONResponse:
    valid = set(GEOJSON_SOURCES) | set(DATAGOV_DATASETS)
    if filename not in valid:
        raise HTTPException(400, f"Unknown layer: {filename}")

    path = DATA_DIR / f"{filename}.geojson"
    if path.exists():
        return JSONResponse(json.loads(path.read_text()))

    try:
        if filename in GEOJSON_SOURCES:
            async with httpx.AsyncClient(timeout=60) as client:
                path.write_bytes(await _fetch(client, GEOJSON_SOURCES[filename]))
        else:
            await _fetch_datagov(DATAGOV_DATASETS[filename], path)
        return JSONResponse(json.loads(path.read_text()))
    except Exception as exc:
        raise HTTPException(404, f"{filename} not available: {exc}") from exc


async def _fetch_datagov(dataset_id: str, dest: Path) -> None:
    poll = f"https://api-open.data.gov.sg/v1/public/api/datasets/{dataset_id}/poll-download"
    async with httpx.AsyncClient(timeout=60, follow_redirects=True) as client:
        r = await client.get(poll, headers={"User-Agent": "mapwatch-py/2.0"})
        r.raise_for_status()
        download_url = r.json()["data"]["url"]
        dest.write_bytes(await _fetch(client, download_url))


# ── /tiles/{layer}/{z}/{x}/{y}.png — built-in CDN proxy + disk cache ─────────

@app.get("/tiles/{layer}/{z}/{x}/{y}.png")
async def proxy_tile(layer: str, z: int, x: int, y: int) -> Response:
    if layer not in TILE_SOURCES:
        raise HTTPException(400, f"Unknown tile layer: {layer}")

    tile_path = DATA_DIR / "tiles" / layer / str(z) / str(x) / f"{y}.png"
    if tile_path.exists():
        return FileResponse(tile_path, media_type="image/png")

    url = (
        f"https://server.arcgisonline.com/ArcGIS/rest/services"
        f"/World_Imagery/MapServer/tile/{z}/{y}/{x}"
        if layer == "satellite"
        else TILE_SOURCES[layer].format(z=z, x=x, y=y)
    )

    try:
        async with httpx.AsyncClient(timeout=10) as client:
            content = await _fetch(client, url)
    except httpx.HTTPStatusError as exc:
        raise HTTPException(502, f"upstream tile {exc.response.status_code}") from exc
    except httpx.RequestError as exc:
        raise HTTPException(502, f"tile fetch failed: {exc}") from exc

    tile_path.parent.mkdir(parents=True, exist_ok=True)
    tile_path.write_bytes(content)
    return Response(content, media_type="image/png")
