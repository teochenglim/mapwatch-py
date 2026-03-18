FROM python:3.11-slim

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends curl \
    && rm -rf /var/lib/apt/lists/*

RUN pip install --no-cache-dir uv
COPY pyproject.toml uv.lock* ./
RUN uv pip install --system --no-cache \
    "fastapi>=0.135.1" \
    "httpx>=0.27.0" \
    "uvicorn[standard]>=0.42.0"

COPY . .

# Download Leaflet assets only if not already present in build context
RUN mkdir -p static/lib \
    && ([ -f static/lib/leaflet.js ]  || curl -fsSL "https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"  -o static/lib/leaflet.js) \
    && ([ -f static/lib/leaflet.css ] || curl -fsSL "https://unpkg.com/leaflet@1.9.4/dist/leaflet.css" -o static/lib/leaflet.css)

# Download bus stops GeoJSON only if not already present in build context
RUN mkdir -p data \
    && ([ -f data/sg-bus-stops.geojson ] || curl -fsSL "https://data.busrouter.sg/v1/stops.min.geojson" -o data/sg-bus-stops.geojson)

EXPOSE 8000

CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000"]
