# Adding a New Tile Basemap (Theme)

The theme pipeline — UI button, URL, attribution — is driven by a single entry in **[config/tiles.yml](config/tiles.yml)**. No JS or HTML changes needed for the frontend.

The tile server infrastructure (download script, Docker image, CI, K8s) still requires manual steps.

---

## The One Frontend File to Edit: `config/tiles.yml`

Add a new entry to the `themes:` list:

```yaml
- id: newtheme            # lowercase; used in tile URL path and button id
  label: New Theme        # text on the toolbar button
  default: false          # true = active on page load (only one should be true)
  attribution: '&copy; <a href="https://example.com/">Provider</a>'
  source_url: "https://example.com/{z}/{x}/{y}.png"
  # proxy_url: "https://example.com/{z}/{y}/{x}"  # only if coord order is z/y/x (e.g. Esri)
```

That's it for the frontend. The JS reads this config from `/api/config` on load, builds the theme button, wires up `setTheme()`, and handles the attribution control swap.

> **`source_url` vs `proxy_url`:** Use `source_url` for standard `{z}/{x}/{y}` URLs. Use `proxy_url` (and omit `source_url`) for providers like Esri that use `{z}/{y}/{x}` coordinate order — the backend proxy uses `proxy_url.format(z=z, x=x, y=y)` directly.

---

## Step 1: Check Tile Provider Terms of Service

Before adding a new source:
- **Attribution required?** — OSM and CartoDB require attribution. The `attribution` field is displayed in the map's bottom-right when this theme is active.
- **Caching/offline use allowed?** — Some providers (e.g. Mapbox) prohibit pre-downloading tiles. CartoDB and OSM allow it.
- **API key required?** — The tile proxy in `main.py` doesn't support auth headers. If a key is needed in the URL, embed it in `source_url` (but don't commit to git — use an env var substitution in `config/tiles.yml` if needed).
- **Rate limits?** — The download script defaults to `--parallel 4` for CartoDB. For OSM (which asks ≤2 req/s), use `--parallel 1`.

---

## Step 2: Register the Tile Source — `config/tiles.yml`

Add the entry as shown above. The backend (`main.py`) reads this file at startup and auto-registers the tile in the `/tiles/{layer}/...` proxy and `/api/config` response.

No `main.py` edits needed.

---

## Step 3: Frontend Theme (Button + Attribution)

**Automatic.** `_buildThemesFromConfig()` in [static/mapwatch.js](static/mapwatch.js) reads `tiles_config` from `/api/config` and:
- Creates a `<button class="tb-btn" id="btn-{id}">` for each theme
- Populates `THEMES[id]` with the tile URL and attribution
- Activates the entry marked `default: true`
- `setTheme()` uses `addAttribution()` / `removeAttribution()` to swap attribution text correctly on switch

No `mapwatch.js` edits needed.
No `index.html` edits needed.

---

## Step 4: Create the Tile Server Directory

Copy an existing one as a template:

```bash
cp -r tilemap-server-dark tilemap-server-newtheme
```

Edit **`tilemap-server-newtheme/download-sg-tiles.sh`** — add your new layer to the `tile_url()` case statement:

```sh
tile_url() {
  layer=$1; z=$2; x=$3; y=$4
  case "$layer" in
    dark)      echo "https://a.basemaps.cartocdn.com/dark_all/${z}/${x}/${y}.png" ;;
    light)     echo "https://a.basemaps.cartocdn.com/light_all/${z}/${x}/${y}.png" ;;
    streets)   echo "https://tile.openstreetmap.org/${z}/${x}/${y}.png" ;;
    satellite) echo "https://server.arcgisonline.com/.../tile/${z}/${y}/${x}" ;;
    newtheme)  echo "https://example.com/${z}/${x}/${y}.png" ;;  # ← add
    *) echo "" ;;
  esac
}
```

Also update the default `LAYERS` variable at the top of the script:
```sh
LAYERS="newtheme"   # only download your layer from this server
```

---

## Step 5: Estimate Tile Count Before Downloading

Singapore bounding box at various zoom levels — approximate tile counts **per layer**:

| Zoom | Tiles | Approx size (PNG) |
|------|-------|--------------------|
| z10  | ~4    | < 1 MB             |
| z13  | ~64   | ~5 MB              |
| z15  | ~256  | ~25 MB             |
| z17  | ~1 024 | ~100 MB           |
| z18  | ~4 096 | ~400 MB           |
| z19  | ~16 384 | ~1.6 GB          |

z10–z18 together is roughly **400–600 MB** per layer. z19 adds ~1.6 GB. Check disk and image push limits before choosing `ZOOM_MAX`.

Use `make tilemap-download` for a one-off local download:

```bash
make tilemap-download LAYERS=newtheme ZOOM_MIN=10 ZOOM_MAX=18
```

---

## Step 6: Add the CI Build Jobs — `.github/workflows/docker.yml`

The CI uses a matrix strategy to parallelise downloads across zoom bands and x-range splits. Add your layer to the existing `download-tiles` matrix and a new `build-tilemap-newtheme` job.

### 6a. Add to the download matrix

In the `download-tiles` matrix job, the `layer` dimension lists all tile layers. Add `newtheme`:

```yaml
strategy:
  matrix:
    layer: [dark, light, streets, newtheme]   # ← add newtheme
    band: [low, z18-p1, z18-p2, z19-p1, ...]
```

Set the appropriate `--parallel` flag for your provider (4 for CartoDB-style, 1 for OSM):

```yaml
- name: Download tiles
  run: |
    sh tilemap-server-${{ matrix.layer }}/download-sg-tiles.sh \
      --zoom-min $ZOOM_MIN --zoom-max $ZOOM_MAX \
      --layers ${{ matrix.layer }} \
      --x-part $X_PART \
      --parallel 4   # adjust for provider rate limits
```

### 6b. Add a build job

```yaml
build-tilemap-newtheme:
  needs: download-tiles
  runs-on: ubuntu-latest
  steps:
    - uses: actions/checkout@v4
    - uses: actions/download-artifact@v4
      with:
        pattern: tiles-newtheme-*
        path: tilemap-server-newtheme/tiles
        merge-multiple: true
    - name: Build & push image
      uses: docker/build-push-action@v5
      with:
        context: tilemap-server-newtheme
        push: true
        tags: ghcr.io/${{ github.repository_owner }}/mapwatch-py/tilemap-server-newtheme:${{ env.IMAGE_TAG }}
```

---

## Step 7: Add the Kubernetes Deployment — `k8s/tilemap.yml`

Copy one of the existing blocks and create a `tilemap-newtheme` equivalent. Things to update:

- `metadata.name`: `tilemap-newtheme`
- `matchLabels.app` / `template.labels.app`: `tilemap-newtheme`
- init container image: `ghcr.io/.../tilemap-server-newtheme:v1`
- `Service.metadata.name`: `tilemap-newtheme`

The `configMapName` stays as `tilemap-nginx` (shared — no change needed).

---

## Step 8: Add the Ingress Route — `k8s/ingress.yml`

```yaml
- path: /department/tilemap-server/newtheme
  pathType: Prefix
  backend:
    service:
      name: tilemap-newtheme
      port:
        number: 80
```

---

## Step 9: Add to Offline Docker Compose — `docker-compose.offline.yml`

```yaml
tilemap-newtheme:
  image: nginx:1.27-alpine
  volumes:
    - ./tilemap-server-newtheme/tiles:/tiles:ro
    - ./tilemap-nginx-local.conf:/etc/nginx/conf.d/default.conf:ro
```

---

## Sanity Checks Before Deploying

```bash
# 1. Validate YAML parses correctly
python -c "import yaml; yaml.safe_load(open('config/tiles.yml'))"

# 2. Check the API returns your theme
curl http://localhost:8000/api/config | python3 -m json.tool | grep -A5 '"id": "newtheme"'

# 3. Spot-check a tile fetched via the proxy (online mode)
curl -I "http://localhost:8000/tiles/newtheme/12/3235/2030.png"

# 4. Verify tiles downloaded correctly
ls tilemap-server-newtheme/tiles/newtheme/12/

# 5. In browser: click New Theme button
#    - button highlights, others go inactive
#    - attribution at bottom-right updates to your provider's text
#    - map tiles change
```

---

## Files Touched Summary

| File | What to change |
|------|---------------|
| `config/tiles.yml` | Add theme entry (id, label, attribution, source_url) |
| `tilemap-server-newtheme/` | Copy from existing; add `tile_url()` case + update default `LAYERS` |
| `.github/workflows/docker.yml` | Add to download matrix + add `build-tilemap-newtheme` job |
| `k8s/tilemap.yml` | Add Deployment + Service (reuse `tilemap-nginx` ConfigMap) |
| `k8s/ingress.yml` | Add Ingress/IngressRoute rule |
| `docker-compose.offline.yml` | Add service for offline local dev |
| ✗ ~~`main.py`~~ | not needed |
| ✗ ~~`static/mapwatch.js`~~ | not needed |
| ✗ ~~`static/index.html`~~ | not needed |
