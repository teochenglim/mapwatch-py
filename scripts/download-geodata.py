#!/usr/bin/env python3
"""Download all Singapore GeoJSON layers and save to --out directory.

Usage (matches Go version):
  python scripts/download-geodata.py --out /data
  python scripts/download-geodata.py --out ./data division mrt roads cycling busstops

Layers (all downloaded by default):
  division   — NPC police division boundaries (data.gov.sg)
  roads      — national road network (data.gov.sg)
  cycling    — cycling paths (data.gov.sg)
  mrt        — MRT/LRT rail lines (data.gov.sg)
  busstops   — bus stops (busrouter.sg)
"""
import argparse
import asyncio
import sys
from pathlib import Path

import httpx

# ── Data sources ──────────────────────────────────────────────────────────────

DIRECT_SOURCES = {
    "busstops": (
        "sg-bus-stops.geojson",
        "https://data.busrouter.sg/v1/stops.min.geojson",
    ),
}

DATAGOV_DATASETS = {
    "division": ("sg-npc-boundary.geojson", "d_89b44df21fccc4f51390eaff16aa1fe8"),
    "roads":    ("sg-roads.geojson",        "d_10480c0b59e65663dfae1028ff4aa8bb"),
    "cycling":  ("sg-cycling.geojson",      "d_8f468b25193f64be8a16fa7d8f60f553"),
    "mrt":      ("sg-mrt.geojson",          "d_222bfc84eb86c7c11994d02f8939da8d"),
}

ALL_LAYERS = list(DIRECT_SOURCES) + list(DATAGOV_DATASETS)

HEADERS = {"User-Agent": "mapwatch-py/2.0"}

# ── Download helpers ──────────────────────────────────────────────────────────

async def _fetch(client: httpx.AsyncClient, url: str) -> bytes:
    r = await client.get(url, headers=HEADERS, follow_redirects=True)
    r.raise_for_status()
    return r.content


async def _fetch_datagov(client: httpx.AsyncClient, dataset_id: str) -> bytes:
    poll = (
        f"https://api-open.data.gov.sg/v1/public/api/datasets"
        f"/{dataset_id}/poll-download"
    )
    r = await client.get(poll, headers=HEADERS)
    r.raise_for_status()
    download_url = r.json()["data"]["url"]
    return await _fetch(client, download_url)


async def download_layer(
    client: httpx.AsyncClient, layer: str, out_dir: Path
) -> None:
    if layer in DIRECT_SOURCES:
        filename, url = DIRECT_SOURCES[layer]
        print(f"  {layer}: {url}")
        data = await _fetch(client, url)
    elif layer in DATAGOV_DATASETS:
        filename, dataset_id = DATAGOV_DATASETS[layer]
        print(f"  {layer}: data.gov.sg/{dataset_id}")
        data = await _fetch_datagov(client, dataset_id)
    else:
        print(f"  {layer}: unknown layer, skipping", file=sys.stderr)
        return

    dest = out_dir / filename
    dest.write_bytes(data)
    print(f"  {layer}: saved {dest} ({len(data):,} bytes)")


async def main(layers: list[str], out_dir: Path) -> None:
    out_dir.mkdir(parents=True, exist_ok=True)
    print(f"Downloading {len(layers)} layer(s) to {out_dir} …")

    async with httpx.AsyncClient(timeout=60) as client:
        for layer in layers:
            try:
                await download_layer(client, layer, out_dir)
            except Exception as exc:
                print(f"  {layer}: FAILED — {exc}", file=sys.stderr)
                sys.exit(1)

    print("Done.")


# ── CLI ───────────────────────────────────────────────────────────────────────

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument(
        "layers",
        nargs="*",
        default=ALL_LAYERS,
        metavar="LAYER",
        help=f"Layers to download (default: all). Choices: {', '.join(ALL_LAYERS)}",
    )
    parser.add_argument(
        "--out", "-o",
        default="./data",
        metavar="DIR",
        help="Output directory (default: ./data)",
    )
    args = parser.parse_args()
    asyncio.run(main(args.layers, Path(args.out)))
