#!/usr/bin/env python3
"""Download all Singapore GeoJSON layers defined in config/layers.yml.

Usage:
  python scripts/download-geodata.py --out /data
  python scripts/download-geodata.py --out ./data division mrt roads cycling busstops

Layer IDs come from the 'id' field in config/layers.yml.
Omit layer arguments to download all layers.
"""
import argparse
import asyncio
import sys
from pathlib import Path

import httpx
import yaml

# ── Load layer config ──────────────────────────────────────────────────────────

_CONFIG_PATH = Path(__file__).parent.parent / "config" / "layers.yml"

def _load_config() -> list[dict]:
    with open(_CONFIG_PATH) as f:
        return yaml.safe_load(f)["layers"]

LAYERS = _load_config()
ALL_LAYER_IDS = [layer["id"] for layer in LAYERS]

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
    client: httpx.AsyncClient, layer: dict, out_dir: Path
) -> None:
    layer_id = layer["id"]
    filename  = layer["file"] + ".geojson"
    source    = layer["source"]

    dest = out_dir / filename
    if dest.exists():
        print(f"  {layer_id}: already exists, skipping")
        return

    if source["type"] == "direct":
        url = source["url"]
        print(f"  {layer_id}: {url}")
        data = await _fetch(client, url)

    elif source["type"] == "datagov":
        dataset_id = source["dataset_id"]
        print(f"  {layer_id}: data.gov.sg/{dataset_id}")
        data = await _fetch_datagov(client, dataset_id)

    else:
        print(f"  {layer_id}: unknown source type '{source['type']}', skipping", file=sys.stderr)
        return

    dest.write_bytes(data)
    print(f"  {layer_id}: saved {dest} ({len(data):,} bytes)")


async def main(layer_ids: list[str], out_dir: Path) -> None:
    out_dir.mkdir(parents=True, exist_ok=True)

    # Build lookup: id → layer config
    layer_map = {layer["id"]: layer for layer in LAYERS}

    # Validate requested IDs
    unknown = [lid for lid in layer_ids if lid not in layer_map]
    if unknown:
        print(f"Unknown layer(s): {', '.join(unknown)}", file=sys.stderr)
        print(f"Available: {', '.join(ALL_LAYER_IDS)}", file=sys.stderr)
        sys.exit(1)

    print(f"Downloading {len(layer_ids)} layer(s) to {out_dir} …")

    async with httpx.AsyncClient(timeout=60) as client:
        for layer_id in layer_ids:
            try:
                await download_layer(client, layer_map[layer_id], out_dir)
            except Exception as exc:
                print(f"  {layer_id}: FAILED — {exc}", file=sys.stderr)
                sys.exit(1)

    print("Done.")


# ── CLI ───────────────────────────────────────────────────────────────────────

if __name__ == "__main__":
    parser = argparse.ArgumentParser(
        description=__doc__,
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument(
        "layers",
        nargs="*",
        default=ALL_LAYER_IDS,
        metavar="LAYER_ID",
        help=f"Layer IDs to download (default: all). Choices: {', '.join(ALL_LAYER_IDS)}",
    )
    parser.add_argument(
        "--out", "-o",
        default="./data",
        metavar="DIR",
        help="Output directory (default: ./data)",
    )
    args = parser.parse_args()
    asyncio.run(main(args.layers, Path(args.out)))
