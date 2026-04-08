FROM python:3.11-slim

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends curl \
    && rm -rf /var/lib/apt/lists/*

RUN pip install --no-cache-dir uv

# Python deps — cached unless pyproject.toml / uv.lock change
COPY pyproject.toml uv.lock* ./
RUN uv pip install --system --no-cache \
    "fastapi>=0.135.1" \
    "httpx>=0.28.1" \
    "uvicorn[standard]>=0.42.0" \
    "jinja2>=3.1.0"

# Pre-cache Leaflet + MarkerCluster — this layer is cached independently of
# app code, so rebuilding main.py / static/ won't re-download these.
RUN mkdir -p static/lib \
    && curl -fsSL "https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"                            -o static/lib/leaflet.js \
    && curl -fsSL "https://unpkg.com/leaflet@1.9.4/dist/leaflet.css"                           -o static/lib/leaflet.css \
    && curl -fsSL "https://unpkg.com/leaflet.markercluster@1.5.3/dist/leaflet.markercluster.js" -o static/lib/leaflet.markercluster.js \
    && curl -fsSL "https://unpkg.com/leaflet.markercluster@1.5.3/dist/MarkerCluster.css"        -o static/lib/MarkerCluster.css \
    && curl -fsSL "https://unpkg.com/leaflet.markercluster@1.5.3/dist/MarkerCluster.Default.css" -o static/lib/MarkerCluster.Default.css

# GeoJSON data — cached unless scripts/ or config/ change.
# download-geodata.py skips files that already exist (see skip-if-exists logic).
# If ./data/*.geojson exist in the build context (COPY . . below), they win;
# the download step runs first to populate missing ones only.
COPY scripts/ scripts/
COPY config/ config/
RUN mkdir -p data && python scripts/download-geodata.py --out data

# App code — COPY . . comes last so changes to main.py / static/ / templates/
# only invalidate this layer, not the Leaflet or geodata layers above.
COPY . .

EXPOSE 8000

# ROOT_PATH and TILE_SERVER_URL are injected at runtime (K8s env / docker-compose)
ENV ROOT_PATH=""
ENV TILE_SERVER_URL=""

CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000"]
