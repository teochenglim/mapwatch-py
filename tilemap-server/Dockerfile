# ── tilemap-server ────────────────────────────────────────────────────────────
# Offline nginx tile server for Singapore.
#
# Tiles are pre-downloaded by the CI pipeline (or manually via
# download-sg-tiles.sh) and baked into the image at build time.
# No internet access is required at runtime — suitable for air-gapped K8s.
#
# Tile directory layout (built by download-sg-tiles.sh):
#   tiles/{layer}/{z}/{x}/{y}.png
#   layer: dark | light | streets | satellite
# ─────────────────────────────────────────────────────────────────────────────

FROM nginx:1.27-alpine

RUN apk add --no-cache curl

COPY nginx.conf /etc/nginx/nginx.conf

# Copy pre-downloaded tiles (populated by CI before docker build).
# The tiles/ directory always exists in the repo (contains .gitkeep),
# so this COPY never fails even on a clean checkout with no tiles.
COPY tiles/ /tiles/

# Keep the download script in the image for manual re-seeding if needed
COPY download-sg-tiles.sh /usr/local/bin/download-sg-tiles.sh
RUN chmod +x /usr/local/bin/download-sg-tiles.sh

EXPOSE 80

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
    CMD curl -sf http://localhost/healthz || exit 1

CMD ["nginx", "-g", "daemon off;"]
