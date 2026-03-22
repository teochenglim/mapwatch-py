#!/usr/bin/env sh
# download-sg-tiles.sh — pre-download Singapore map tiles for offline use.
#
# Usage:
#   ./download-sg-tiles.sh [--zoom-min N] [--zoom-max N] [--layers LAYERS]
#                          [--out DIR] [--x-part N/M] [--parallel N]
#
# Defaults:
#   --zoom-min 10
#   --zoom-max 19
#   --layers   dark,light,streets   (satellite excluded by default — large)
#   --out      ./tiles
#   --x-part   1/1   (no split — download all x tiles for this zoom range)
#   --parallel 1     (sequential; set to 4 for CartoDB, keep 1 for OSM)
#
# --x-part N/M splits the SG x-tile range for each zoom into M equal buckets
# and downloads only bucket N. Use this to parallelise high-zoom downloads
# across multiple CI jobs (one job per part). Applied to ALL zoom levels in
# the range, so use together with --zoom-min == --zoom-max for a single zoom.
#
#   Example (z19 split across 6 CI jobs):
#     Job 1: --zoom-min 19 --zoom-max 19 --x-part 1/6
#     Job 2: --zoom-min 19 --zoom-max 19 --x-part 2/6
#     ...
#
# Singapore bounding box:
#   lat: 1.159 – 1.482
#   lng: 103.605 – 104.088
#
# Tile sources:
#   dark     : CartoDB dark_all
#   light    : CartoDB light_all
#   streets  : OpenStreetMap  (keep --parallel 1, rate-limit sensitive)
#   satellite: Esri World Imagery (y/x swapped URL)
#
# NOTE: Respect provider rate limits.
#   CartoDB: no stated limit; 2–4 parallel is safe.
#   OSM: ~2 req/s recommended; keep --parallel 1 with default 0.05s delay.

set -eu

ZOOM_MIN=10
ZOOM_MAX=19
LAYERS="dark,light,streets"
OUT_DIR="./tiles"
X_PART_N=1   # which bucket (1-based)
X_PART_D=1   # total buckets (1 = no split)
PARALLEL=1   # concurrent downloads

# ── Argument parsing ──────────────────────────────────────────────────────────
while [ $# -gt 0 ]; do
  case "$1" in
    --zoom-min) ZOOM_MIN="$2"; shift 2 ;;
    --zoom-max) ZOOM_MAX="$2"; shift 2 ;;
    --layers)   LAYERS="$2";   shift 2 ;;
    --out)      OUT_DIR="$2";  shift 2 ;;
    --parallel) PARALLEL="$2"; shift 2 ;;
    --x-part)
      X_PART_N="$(echo "$2" | cut -d/ -f1)"
      X_PART_D="$(echo "$2" | cut -d/ -f2)"
      shift 2 ;;
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

# ── Single-tile download with retry ──────────────────────────────────────────
_dl_tile() {
  url="$1"; dest="$2"
  mkdir -p "$(dirname "$dest")"
  retry=0
  while [ $retry -lt 3 ]; do
    if curl -sf --max-time 15 \
        -H "User-Agent: mapwatch-py-tilefetcher/1.0" \
        -o "$dest" "$url"; then
      return 0
    fi
    retry=$((retry + 1))
    sleep $((retry * 2))
  done
  rm -f "$dest"
  return 1
}

# ── Singapore bounding box ────────────────────────────────────────────────────
SG_LAT_MIN=1.159
SG_LAT_MAX=1.482
SG_LNG_MIN=103.605
SG_LNG_MAX=104.088

echo "==> Downloading Singapore tiles"
echo "    Zoom range : ${ZOOM_MIN}–${ZOOM_MAX}"
echo "    Layers     : ${LAYERS}"
echo "    x-part     : ${X_PART_N}/${X_PART_D}"
echo "    Parallel   : ${PARALLEL}"
echo "    Output dir : ${OUT_DIR}"
echo ""

TOTAL=0
SKIPPED=0
FAILED=0
ACTIVE_JOBS=0

for LAYER in $(echo "$LAYERS" | tr ',' ' '); do
  for Z in $(seq "$ZOOM_MIN" "$ZOOM_MAX"); do

    # Compute full tile range covering Singapore at zoom Z
    BOUNDS_MIN=$(lat_lng_to_tile "$SG_LAT_MAX" "$SG_LNG_MIN" "$Z")
    BOUNDS_MAX=$(lat_lng_to_tile "$SG_LAT_MIN" "$SG_LNG_MAX" "$Z")

    X_FULL_MIN=$(echo "$BOUNDS_MIN" | awk '{print $1}')
    Y_MIN=$(echo "$BOUNDS_MIN" | awk '{print $2}')
    X_FULL_MAX=$(echo "$BOUNDS_MAX" | awk '{print $1}')
    Y_MAX=$(echo "$BOUNDS_MAX" | awk '{print $2}')

    # Apply x-part split: divide the x range into X_PART_D buckets, take bucket X_PART_N
    if [ "$X_PART_D" -gt 1 ]; then
      FULL_W=$((X_FULL_MAX - X_FULL_MIN + 1))
      # Ceiling division so every tile is covered across all parts
      PART_W=$(( (FULL_W + X_PART_D - 1) / X_PART_D ))
      X_MIN=$(( X_FULL_MIN + (X_PART_N - 1) * PART_W ))
      X_MAX=$(( X_MIN + PART_W - 1 ))
      # Clamp to actual range (last bucket may be smaller)
      [ "$X_MAX" -gt "$X_FULL_MAX" ] && X_MAX="$X_FULL_MAX"
    else
      X_MIN="$X_FULL_MIN"
      X_MAX="$X_FULL_MAX"
    fi

    for X in $(seq "$X_MIN" "$X_MAX"); do
      for Y in $(seq "$Y_MIN" "$Y_MAX"); do
        DEST="${OUT_DIR}/${LAYER}/${Z}/${X}/${Y}.png"

        if [ -f "$DEST" ]; then
          SKIPPED=$((SKIPPED + 1))
          continue
        fi

        URL=$(tile_url "$LAYER" "$Z" "$X" "$Y")
        [ -z "$URL" ] && continue

        if [ "$PARALLEL" -le 1 ]; then
          # Sequential with polite delay
          if _dl_tile "$URL" "$DEST"; then
            TOTAL=$((TOTAL + 1))
          else
            echo "  WARN: failed ${LAYER}/${Z}/${X}/${Y} (gave up after 3 attempts)" >&2
            FAILED=$((FAILED + 1))
          fi
          sleep 0.05

        else
          # Parallel: fire-and-forget up to PARALLEL concurrent jobs
          _dl_tile "$URL" "$DEST" &
          ACTIVE_JOBS=$((ACTIVE_JOBS + 1))

          # When the pool is full, drain all current jobs before refilling.
          # Simple and portable; avoids bash-specific wait -n.
          if [ "$ACTIVE_JOBS" -ge "$PARALLEL" ]; then
            wait
            ACTIVE_JOBS=0
          fi
          TOTAL=$((TOTAL + 1))   # count optimistically; failures logged by _dl_tile
        fi
      done
    done

    echo "  z=${Z} layer=${LAYER} x=${X_MIN}..${X_MAX} done"
  done
done

# Drain any remaining background jobs
wait

echo ""
echo "==> Done."
echo "    Downloaded : ${TOTAL}"
echo "    Skipped    : ${SKIPPED} (already cached)"
echo "    Failed     : ${FAILED}"
