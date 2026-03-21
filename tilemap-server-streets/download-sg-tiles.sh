#!/usr/bin/env sh
# download-sg-tiles.sh — pre-download Singapore map tiles for offline use.
#
# Usage:
#   ./download-sg-tiles.sh [--zoom-min N] [--zoom-max N] [--layers LAYERS] [--out DIR]
#
# Defaults:
#   --zoom-min 10
#   --zoom-max 15
#   --layers   dark,light,streets   (satellite excluded by default — large)
#   --out      ./tiles
#
# Singapore bounding box:
#   lat: 1.159 – 1.482
#   lng: 103.605 – 104.088
#
# Tile sources:
#   dark     : CartoDB dark_all
#   light    : CartoDB light_all
#   streets  : OpenStreetMap
#   satellite: Esri World Imagery (y/x swapped URL)
#
# NOTE: Respect rate limits — a small delay is added between requests.

set -eu

ZOOM_MIN=10
ZOOM_MAX=18
LAYERS="dark,light,streets"
OUT_DIR="./tiles"

# ── Argument parsing ──────────────────────────────────────────────────────────
while [ $# -gt 0 ]; do
  case "$1" in
    --zoom-min) ZOOM_MIN="$2"; shift 2 ;;
    --zoom-max) ZOOM_MAX="$2"; shift 2 ;;
    --layers)   LAYERS="$2";   shift 2 ;;
    --out)      OUT_DIR="$2";  shift 2 ;;
    *) echo "Unknown option: $1" >&2; exit 1 ;;
  esac
done

# ── Tile URL builders ─────────────────────────────────────────────────────────
tile_url() {
  layer=$1; z=$2; x=$3; y=$4
  case "$layer" in
    dark)      echo "https://a.basemaps.cartocdn.com/dark_all/${z}/${x}/${y}.png" ;;
    light)     echo "https://a.basemaps.cartocdn.com/light_all/${z}/${x}/${y}.png" ;;
    streets)   echo "https://tile.openstreetmap.org/${z}/${x}/${y}.png" ;;
    satellite) echo "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/${z}/${y}/${x}" ;;
    *) echo "" ;;
  esac
}

# ── Lat/lng → tile coordinate conversion (Web Mercator / Slippy Map) ─────────
# Requires python3
lat_lng_to_tile() {
  lat=$1; lng=$2; z=$3
  python3 -c "
import math
lat, lng, z = $lat, $lng, $z
n = 2**z
x = int((lng + 180) / 360 * n)
lat_r = math.radians(lat)
y = int((1 - math.log(math.tan(lat_r) + 1/math.cos(lat_r)) / math.pi) / 2 * n)
print(x, y)
"
}

# Singapore bounding box
SG_LAT_MIN=1.159
SG_LAT_MAX=1.482
SG_LNG_MIN=103.605
SG_LNG_MAX=104.088

echo "==> Downloading Singapore tiles"
echo "    Zoom range : ${ZOOM_MIN}–${ZOOM_MAX}"
echo "    Layers     : ${LAYERS}"
echo "    Output dir : ${OUT_DIR}"
echo ""

TOTAL=0
SKIPPED=0

for LAYER in $(echo "$LAYERS" | tr ',' ' '); do
  for Z in $(seq "$ZOOM_MIN" "$ZOOM_MAX"); do
    # Compute tile range covering Singapore at zoom Z
    BOUNDS_MIN=$(lat_lng_to_tile "$SG_LAT_MAX" "$SG_LNG_MIN" "$Z")
    BOUNDS_MAX=$(lat_lng_to_tile "$SG_LAT_MIN" "$SG_LNG_MAX" "$Z")

    X_MIN=$(echo "$BOUNDS_MIN" | awk '{print $1}')
    Y_MIN=$(echo "$BOUNDS_MIN" | awk '{print $2}')
    X_MAX=$(echo "$BOUNDS_MAX" | awk '{print $1}')
    Y_MAX=$(echo "$BOUNDS_MAX" | awk '{print $2}')

    for X in $(seq "$X_MIN" "$X_MAX"); do
      for Y in $(seq "$Y_MIN" "$Y_MAX"); do
        DEST="${OUT_DIR}/${LAYER}/${Z}/${X}/${Y}.png"
        if [ -f "$DEST" ]; then
          SKIPPED=$((SKIPPED + 1))
          continue
        fi

        URL=$(tile_url "$LAYER" "$Z" "$X" "$Y")
        [ -z "$URL" ] && continue

        mkdir -p "$(dirname "$DEST")"
        RETRY=0
        SUCCESS=0
        while [ $RETRY -lt 3 ]; do
          if curl -sf --max-time 15 \
              -H "User-Agent: mapwatch-py-tilefetcher/1.0" \
              -o "$DEST" "$URL"; then
            TOTAL=$((TOTAL + 1))
            SUCCESS=1
            break
          fi
          RETRY=$((RETRY + 1))
          sleep $((RETRY * 2))
        done
        if [ $SUCCESS -eq 0 ]; then
          echo "  WARN: failed ${LAYER}/${Z}/${X}/${Y} (gave up after 3 attempts)" >&2
          rm -f "$DEST"
        fi

        # Brief pause to avoid hammering tile CDNs
        sleep 0.05
      done
    done
    echo "  z=${Z} layer=${LAYER} done"
  done
done

echo ""
echo "==> Done. Downloaded: ${TOTAL}  Skipped (cached): ${SKIPPED}"
