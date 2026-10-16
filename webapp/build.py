#!/usr/bin/env python3
"""Build the MyBrain web app into a folder ready for static hosting.

    python3 webapp/build.py --maps <folder with maps/> --out dist

The maps folder is a checkout of your private maps repository: it contains
maps/<name>/map.json (+ report.md), written by `mybrain-publish`.
This script copies the app, the icons and the maps into --out and writes
maps/index.json (the list the home screen shows). Standard library only, so it
runs on Cloudflare Pages / Vercel build machines as-is.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import shutil
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO = HERE.parent
APP_FILES = ["index.html", "app.css", "app.js", "graph.js", "layout-worker.js",
             "manifest.webmanifest", "sw.js"]
ICONS = ["icon.svg", "icon-192.png", "icon-512.png", "icon-maskable-192.png",
         "icon-maskable-512.png", "apple-touch-icon.png"]

HEADERS = """/*
  X-Content-Type-Options: nosniff
  Referrer-Policy: no-referrer
  X-Frame-Options: DENY
  Content-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; worker-src 'self'; manifest-src 'self'; frame-ancestors 'none'; base-uri 'self'
  X-Robots-Tag: noindex, nofollow

/maps/*
  Cache-Control: no-cache

/sw.js
  Cache-Control: no-cache

/index.html
  Cache-Control: no-cache
"""


def build(maps_root: Path | None, out: Path) -> dict:
    if out.exists():
        shutil.rmtree(out)
    (out / "icons").mkdir(parents=True)
    (out / "vendor").mkdir()
    for f in APP_FILES:
        shutil.copy2(HERE / f, out / f)
    for f in (HERE / "vendor").iterdir():
        shutil.copy2(f, out / "vendor" / f.name)
    for f in ICONS:
        shutil.copy2(REPO / "brand" / f, out / "icons" / f)

    maps_out = out / "maps"
    maps_out.mkdir()
    entries = []
    src = (maps_root / "maps") if maps_root and (maps_root / "maps").is_dir() else maps_root
    if src and src.is_dir():
        for d in sorted(p for p in src.iterdir() if p.is_dir()):
            mj = d / "map.json"
            if not mj.exists():
                continue
            data = json.loads(mj.read_text(encoding="utf-8"))
            entries.append({
                "name": d.name,
                "stats": data.get("stats", {}),
                "published": data.get("published"),
                "commit": data.get("commit"),
                "source": data.get("source"),
            })
            shutil.copytree(d, maps_out / d.name)
    index = {"maps": entries}
    (maps_out / "index.json").write_text(json.dumps(index, indent=1), encoding="utf-8")

    # Version stamp: changes whenever the app or any map changes, so the
    # service worker refreshes its cached copy of the app.
    h = hashlib.sha256()
    for f in sorted(out.rglob("*")):
        if f.is_file() and f.name != "sw.js":
            h.update(f.relative_to(out).as_posix().encode())
            h.update(f.read_bytes())
    version = h.hexdigest()[:10]
    sw = (out / "sw.js").read_text(encoding="utf-8").replace("__BUILD__", version)
    (out / "sw.js").write_text(sw, encoding="utf-8")
    (out / "version.txt").write_text(f"MyBrain app {version}\n", encoding="utf-8")
    (out / "_headers").write_text(HEADERS, encoding="utf-8")
    (out / "robots.txt").write_text("User-agent: *\nDisallow: /\n", encoding="utf-8")
    return {"maps": len(entries), "version": version}


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--maps", type=Path, default=None, help="folder that contains maps/<name>/map.json")
    ap.add_argument("--out", type=Path, default=Path("dist"))
    a = ap.parse_args()
    info = build(a.maps.resolve() if a.maps else None, a.out.resolve())
    print(f"MyBrain app built: {info['maps']} map(s), version {info['version']} -> {a.out}")


if __name__ == "__main__":
    main()
