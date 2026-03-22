# Adding a New GeoJSON Overlay Layer

The entire layer pipeline — UI button, toggle logic, selection, download, API — is driven by a single entry in **[config/layers.yml](config/layers.yml)**. No JS or HTML changes needed.

---

## The One File to Edit: `config/layers.yml`

Add a new entry to the `layers:` list:

```yaml
- id: yourLayer           # camelCase; must be unique
  label: Your Layer       # text shown on the toolbar button
  enabled: false          # true = auto-load on page start; false = manual toggle
  file: sg-your-layer     # filename saved under /data/ (without .geojson)
  source:
    type: datagov         # or: direct
    dataset_id: d_YOUR_DATASET_ID   # for datagov — from data.gov.sg URL
    # url: "https://..."  # for direct — any public GeoJSON URL
  style:
    type: polygon         # polygon | line | line_conditional | point
    color: "#a855f7"
    weight: 2
    opacity: 0.8
    fill_color: "#a855f7" # polygon only
    fill_opacity: 0.1     # polygon only
    # dash_array: "6,4"   # line only
    # radius: 4           # point only
  tooltip:
    name_props: [NAME, name]       # try these properties for the main title
    # title_prefix: "Bus "         # prepend to name (e.g. for bus routes)
    sub_props: [SUBNAME]           # subtitle row (optional)
    detail_props:                  # extra rows (optional)
      - label: Code
        prop: CODE
  select:
    restore_style:                 # style restored after selection highlight clears
      color: "#a855f7"
      opacity: 0.8
      fillOpacity: 0.1
    # exclude_contains:            # skip features where a prop contains a value
    #   props: [DIVISION]
    #   value: "Sect"
```

That's it. The frontend builds the button, wires up the toggle, styles the layer, handles tooltips, and restores selection styles — all from this config entry.

---

## What Each Field Controls

| Field | Controls |
|-------|---------|
| `id` | Key used internally; also forms the button id (`btn-layer-{id.toLowerCase()}`) |
| `label` | Toolbar button text |
| `enabled` | If `true`, layer is fetched and shown automatically on page load |
| `file` | GeoJSON filename in `/data/`; also used in `/api/geojson/{file}` endpoint |
| `source.type: datagov` | Backend fetches via data.gov.sg poll-download API using `dataset_id` |
| `source.type: direct` | Backend fetches directly from `url` |
| `style.type: polygon` | Filled polygon with stroke |
| `style.type: line` | Stroke only (roads, MRT, cycling) |
| `style.type: line_conditional` | Weight 3 for `motorway/trunk`, 2 otherwise |
| `style.type: point` | `L.circleMarker` (bus stops) |
| `tooltip.name_props` | Properties tried in order for the tooltip title |
| `tooltip.detail_props` | Extra label/value rows in the tooltip |
| `select.restore_style` | Exact style dict passed to Leaflet's `setStyle()` after selection clears |
| `select.exclude_contains` | Skip features where any listed prop contains the given substring |

---

## Direction 1 — Frontend UI Button

**Automatic.** `_buildLayersFromConfig()` in [static/mapwatch.js](static/mapwatch.js) creates a `<button class="tb-btn">` for every entry in `layers_config` and appends it to `#tb-layers`. Nothing to add to `index.html`.

If `enabled: true`, the button is clicked programmatically on load to trigger the first fetch.

---

## Direction 2 — Toggle On/Off Logic

**Automatic.** `_buildLayerOptions(cfg)` builds the Leaflet `geoJSON` options from `style` and `tooltip`. `_toggleLayer()` is generic and handles lazy-fetch, show/hide, and the `active` class.

If a layer's GeoJSON file is missing (first run, not yet downloaded), `_toggleLayer` hides the button on 404 with a `console.warn` hint. The button reappears after download.

---

## Direction 3 — Selectable (Drag-to-Select)

**Automatic.** Any layer that is currently visible participates in drag-to-select — no registration needed. The restore style comes from `select.restore_style`; the tooltip/label in the result panel comes from `tooltip.name_props` and `label`.

> If your layer has features you want to **exclude** from selection (e.g. boundary sea sectors), use `select.exclude_contains`:
> ```yaml
> exclude_contains:
>   props: [DIVISION]
>   value: "Sect"
> ```

---

## Direction 4 — Download

**Automatic.** `scripts/download-geodata.py` reads `config/layers.yml` directly — no changes needed there. The backend's `/api/geojson/{file}` endpoint also auto-fetches on first request (triggers data.gov.sg poll or direct URL download).

To pre-download all layers manually:

```bash
python scripts/download-geodata.py          # all layers
python scripts/download-geodata.py yourlayer  # just yours
```

---

## Sensible Checks Before Going Live

```bash
# 1. Validate YAML parses correctly
python -c "import yaml; yaml.safe_load(open('config/layers.yml'))"

# 2. Check the API returns your layer
curl http://localhost:8000/api/config | python3 -m json.tool | grep -A2 '"id": "yourLayer"'

# 3. Try fetching the GeoJSON (triggers download if not cached)
curl -I http://localhost:8000/api/geojson/sg-your-layer

# 4. Check the button appears in the browser toolbar
# 5. Toggle the layer on and off — tooltip on hover
# 6. Enable drag-select — confirm your layer's features appear in the panel
# 7. If enabled: true — reload the page; layer should appear without clicking
```

---

## Checklist

| # | What | Where |
|---|------|-------|
| 1 | Add entry to `layers:` list | `config/layers.yml` |
| 2 | Set `source.type` + `dataset_id` or `url` | same entry |
| 3 | Set `style.type` + colour params | same entry |
| 4 | Set `tooltip.name_props` (and optionally `sub_props`, `detail_props`) | same entry |
| 5 | Set `select.restore_style` to match your style | same entry |
| 6 | Set `enabled: true` if it should auto-load | same entry |
| ✗ | ~~Edit `static/mapwatch.js`~~ | not needed |
| ✗ | ~~Edit `static/index.html`~~ | not needed |
| ✗ | ~~Edit `main.py`~~ | not needed |
| ✗ | ~~Edit `scripts/download-geodata.py`~~ | not needed |
