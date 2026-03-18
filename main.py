"""mapwatch-py — Singapore bus stop selector."""
import json
from contextlib import asynccontextmanager
from pathlib import Path

import httpx
from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse, JSONResponse, Response
from fastapi.staticfiles import StaticFiles

BASE     = Path(__file__).parent
DATA_DIR = BASE / "data"
LIB_DIR  = BASE / "static" / "lib"
DATA_DIR.mkdir(exist_ok=True)
LIB_DIR.mkdir(exist_ok=True)

BUS_STOPS_URL  = "https://data.busrouter.sg/v1/stops.min.geojson"
BUS_STOPS_FILE = DATA_DIR / "sg-bus-stops.geojson"

LEAFLET_VER  = "1.9.4"
LEAFLET_BASE = f"https://unpkg.com/leaflet@{LEAFLET_VER}/dist"

TILE_SOURCES = {
    "dark":      "https://a.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png",
    "satellite": None,  # Esri — handled separately (y/x swap)
    "streets":   "https://tile.openstreetmap.org/{z}/{x}/{y}.png",
}


async def _fetch(client: httpx.AsyncClient, url: str) -> bytes:
    r = await client.get(url, headers={"User-Agent": "mapwatch-py/1.0"})
    r.raise_for_status()
    return r.content


@asynccontextmanager
async def lifespan(_app: FastAPI):
    """On startup: ensure Leaflet assets and bus stops data are cached locally."""
    async with httpx.AsyncClient(timeout=30) as client:
        # Leaflet JS + CSS
        for fname in ("leaflet.js", "leaflet.css"):
            dst = LIB_DIR / fname
            if not dst.exists():
                try:
                    dst.write_bytes(await _fetch(client, f"{LEAFLET_BASE}/{fname}"))
                except Exception:
                    pass

        # Bus stops GeoJSON
        if not BUS_STOPS_FILE.exists():
            try:
                BUS_STOPS_FILE.write_bytes(await _fetch(client, BUS_STOPS_URL))
            except Exception:
                pass
    yield


app = FastAPI(title="mapwatch-py", lifespan=lifespan)
app.mount("/static", StaticFiles(directory=BASE / "static"), name="static")


@app.get("/", include_in_schema=False)
def index():
    return FileResponse(BASE / "static" / "index.html")


@app.get("/api/geojson/sg-bus-stops")
def geojson():
    if not BUS_STOPS_FILE.exists():
        raise HTTPException(404, "Bus stops not available — server may still be starting up")
    return JSONResponse(json.loads(BUS_STOPS_FILE.read_text()))


@app.get("/tiles/{layer}/{z}/{x}/{y}.png")
async def proxy_tile(layer: str, z: int, x: int, y: int):
    """Proxy and disk-cache map tiles for offline use."""
    if layer not in TILE_SOURCES:
        raise HTTPException(400, f"Unknown layer: {layer}")

    tile_path = DATA_DIR / "tiles" / layer / str(z) / str(x) / f"{y}.png"
    if tile_path.exists():
        return FileResponse(tile_path, media_type="image/png")

    if layer == "satellite":
        url = (
            "https://server.arcgisonline.com/ArcGIS/rest/services"
            f"/World_Imagery/MapServer/tile/{z}/{y}/{x}"
        )
    else:
        url = TILE_SOURCES[layer].format(z=z, x=x, y=y)

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
