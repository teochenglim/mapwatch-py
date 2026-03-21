FROM python:3.11-slim

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends curl \
    && rm -rf /var/lib/apt/lists/*

RUN pip install --no-cache-dir uv

COPY pyproject.toml uv.lock* ./
RUN uv pip install --system --no-cache \
    "fastapi>=0.135.1" \
    "httpx>=0.28.1" \
    "uvicorn[standard]>=0.42.0" \
    "jinja2>=3.1.0"

COPY . .

# Pre-cache Leaflet + MarkerCluster assets so the first page load is instant
RUN mkdir -p static/lib \
    && ([ -f static/lib/leaflet.js ]                || curl -fsSL "https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"                          -o static/lib/leaflet.js) \
    && ([ -f static/lib/leaflet.css ]               || curl -fsSL "https://unpkg.com/leaflet@1.9.4/dist/leaflet.css"                         -o static/lib/leaflet.css) \
    && ([ -f static/lib/leaflet.markercluster.js ]  || curl -fsSL "https://unpkg.com/leaflet.markercluster@1.5.3/dist/leaflet.markercluster.js" -o static/lib/leaflet.markercluster.js) \
    && ([ -f static/lib/MarkerCluster.css ]         || curl -fsSL "https://unpkg.com/leaflet.markercluster@1.5.3/dist/MarkerCluster.css"      -o static/lib/MarkerCluster.css) \
    && ([ -f static/lib/MarkerCluster.Default.css ] || curl -fsSL "https://unpkg.com/leaflet.markercluster@1.5.3/dist/MarkerCluster.Default.css" -o static/lib/MarkerCluster.Default.css)

# Download all GeoJSON layers and bake into the image (mirrors Go version's download-sg CLI)
RUN python scripts/download-geodata.py --out data

EXPOSE 8000

# ROOT_PATH and TILE_SERVER_URL are injected at runtime (K8s env / docker-compose)
ENV ROOT_PATH=""
ENV TILE_SERVER_URL=""

CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000"]
