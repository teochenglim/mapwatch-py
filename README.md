# SG Bus Stop Selector

A self-contained Python web app for visualising and selecting Singapore bus stops on an interactive map.

Built with **FastAPI** (backend) + **Leaflet.js** (frontend). No database, no build step, no API keys required.

---

## Features

- Dark-themed map centred on Singapore (CartoDB basemap)
- Toggle bus stop layer on/off (lazy-loaded)
- **Click** a stop to select it — highlighted in cyan with details in the sidebar
- **Shift+click** to add more stops to the selection (multi-select)
- **Shift+click** a selected stop again to deselect it
- Click a stop in the sidebar panel to fly the map to it
- Remove individual stops with the × button, or wipe the selection with **Clear**
- Bus stop data cached locally after the first download (no repeated network calls)

---

## Requirements

- Python 3.9+
- Internet access for the first data download

---

## Quick Start

```bash
# 1. Clone / copy this folder into your project
cd export/

# 2. (Recommended) create a virtual environment
python -m venv .venv
source .venv/bin/activate       # Windows: .venv\Scripts\activate

# 3. Install dependencies
pip install -r requirements.txt

# 4. Start the server
uvicorn main:app --reload

# 5. Open in browser
open http://localhost:8000
```

---

## Downloading the Map Data

Bus stop data comes from [busrouter.sg](https://data.busrouter.sg) — free, no API key needed.

**Option A — via the browser UI**

Click the **Download Data** button in the top toolbar. The ~5 MB GeoJSON file is fetched and saved to `data/sg-bus-stops.geojson`. Then click **Bus Stops** to display the layer.

**Option B — via the API**

```bash
curl -X POST http://localhost:8000/api/download
# {"ok": true, "count": 5118}
```

**Option C — manually**

```bash
mkdir -p data
curl -o data/sg-bus-stops.geojson https://data.busrouter.sg/v1/stops.min.geojson
```

After downloading, the file is served from disk on every subsequent request — no internet needed.

---

## Project Structure

```
export/
├── main.py              # FastAPI app (3 routes)
├── requirements.txt     # fastapi, uvicorn, httpx
├── README.md            # this file
├── static/
│   └── index.html       # full Leaflet UI (self-contained, no build)
└── data/                # auto-created; holds cached GeoJSON
    └── sg-bus-stops.geojson   # created after first download
```

---

## API Reference

| Method | Path | Description |
|--------|------|-------------|
| `GET`  | `/` | Serves the Leaflet UI |
| `POST` | `/api/download` | Downloads bus stops from busrouter.sg → `data/sg-bus-stops.geojson` |
| `GET`  | `/api/geojson/sg-bus-stops` | Returns cached GeoJSON (404 if not downloaded yet) |

Interactive docs: [http://localhost:8000/docs](http://localhost:8000/docs)

---

## Porting to Another Python Project

This folder is fully self-contained. To embed it in an existing FastAPI app:

```python
# In your existing app.py
from fastapi.staticfiles import StaticFiles
from pathlib import Path

# Mount the static files
app.mount("/busstop/static", StaticFiles(directory="export/static"), name="busstop-static")

# Include the routes
from export.main import app as busstop_app
app.mount("/busstop", busstop_app)
```

Or simply copy `main.py` and `static/` into your project and adjust the `BASE` path at the top of `main.py`.

---

## Data Source

- **Bus stops**: [https://data.busrouter.sg/v1/stops.min.geojson](https://data.busrouter.sg/v1/stops.min.geojson)
- Maintained by the community at [busrouter.sg](https://busrouter.sg)
- Updated periodically; re-run the download to refresh

---

## Extending

| Want to add | What to do |
|-------------|------------|
| Bus routes layer | Download `https://data.busrouter.sg/v1/routes.min.geojson`, add a `/api/geojson/sg-bus-routes` endpoint, add a `L.geoJSON` polyline layer in `index.html` |
| Export selected stops | Add a button that calls `JSON.stringify([...selected.keys()])` and downloads it as a `.json` file |
| Persist selection | POST the selected stop codes to a new `/api/selection` endpoint and store in a file or DB |
| Different basemap | Swap the `L.tileLayer` URL in `index.html` — see [Leaflet providers](https://leaflet-extras.github.io/leaflet-providers/preview/) |
| MRT / cycling layers | Use the data.gov.sg dataset IDs from the mapwatcher project and add equivalent download + serve endpoints |
