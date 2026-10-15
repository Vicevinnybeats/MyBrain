#!/usr/bin/env python3
"""Generate MyBrain's neural-brain logo (brand/logo.svg and brand/icon.svg).

A side-view brain drawn as a network: neurons (dots) on the outline and
inside, joined by synapses (lines) to their nearest neighbours - the same
picture MyBrain draws of your code. Deterministic: same output every run.
"""
import math
from pathlib import Path

HERE = Path(__file__).resolve().parent

# Brain silhouette (side view, facing left), in a 0..100 box.
OUTLINE = [
    (14, 56), (12, 44), (16, 32), (24, 22), (35, 15), (48, 12), (61, 13),
    (73, 17), (83, 25), (89, 36), (90, 48), (86, 58), (78, 64), (70, 70),
    (60, 72), (50, 70), (40, 72), (30, 69), (21, 64),
]
CEREBELLUM = [(70, 70), (78, 76), (74, 83), (64, 82)]
STEM = [(60, 72), (58, 82), (56, 92)]
INNER = [
    (26, 38), (34, 28), (46, 24), (58, 25), (70, 30), (78, 42), (72, 54),
    (60, 58), (48, 58), (36, 58), (28, 50), (40, 44), (52, 40), (64, 44),
    (46, 34), (56, 50),
]
# Highlighted "core neurons" (the hubs) - indexes into INNER.
HUBS = {11, 12, 15}


def _pts():
    seen, out = set(), []
    for p in OUTLINE + CEREBELLUM + STEM + INNER:
        if p not in seen:
            seen.add(p)
            out.append(p)
    return out


def _edges(pts, k=3, maxd=17.5):
    es = set()
    for i, a in enumerate(pts):
        near = sorted(
            (math.dist(a, b), j) for j, b in enumerate(pts) if j != i
        )[:k]
        for d, j in near:
            if d <= maxd:
                es.add((min(i, j), max(i, j)))
    return sorted(es)


def _svg(size, pad, bg):
    pts = _pts()
    # Fit the drawing's bounding box into the padded square, centred.
    xs, ys = [p[0] for p in pts], [p[1] for p in pts]
    w, h = max(xs) - min(xs), max(ys) - min(ys)
    s = (size - 2 * pad) / max(w, h)
    ox = (size - w * s) / 2 - min(xs) * s
    oy = (size - h * s) / 2 - min(ys) * s
    X = lambda p: round(ox + p[0] * s, 1)
    Y = lambda p: round(oy + p[1] * s, 1)
    hubs = {INNER[i] for i in HUBS}
    parts = [
        f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {size} {size}" '
        f'width="{size}" height="{size}">',
        "<defs>",
        f'<linearGradient id="g" gradientUnits="userSpaceOnUse" x1="{size*0.15:.0f}" y1="{size*0.15:.0f}" x2="{size*0.85:.0f}" y2="{size*0.85:.0f}">'
        '<stop offset="0" stop-color="#c084fc"/><stop offset="1" stop-color="#22d3ee"/>'
        "</linearGradient>",
        '<radialGradient id="glow"><stop offset="0" stop-color="#f0abfc" stop-opacity=".9"/>'
        '<stop offset="1" stop-color="#f0abfc" stop-opacity="0"/></radialGradient>',
        "</defs>",
    ]
    if bg:
        r = size * 0.22
        parts.append(f'<rect width="{size}" height="{size}" rx="{r}" fill="#0b1020"/>')
    sw = max(1.5, size / 80)
    parts.append(f'<g stroke="url(#g)" stroke-width="{sw:.1f}" stroke-linecap="round" opacity=".85">')
    for i, j in _edges(pts):
        a, b = pts[i], pts[j]
        parts.append(f'<line x1="{X(a)}" y1="{Y(a)}" x2="{X(b)}" y2="{Y(b)}"/>')
    parts.append("</g>")
    for p in hubs:
        parts.append(f'<circle cx="{X(p)}" cy="{Y(p)}" r="{size/9:.1f}" fill="url(#glow)"/>')
    parts.append('<g fill="url(#g)">')
    for p in pts:
        r = size / 30 if p in hubs else size / 52
        fill = ' fill="#ffffff"' if p in hubs else ""
        parts.append(f'<circle cx="{X(p)}" cy="{Y(p)}" r="{r:.1f}"{fill}/>')
    parts.append("</g></svg>")
    return "\n".join(parts) + "\n"


if __name__ == "__main__":
    (HERE / "logo.svg").write_text(_svg(512, 8, bg=False))
    (HERE / "icon.svg").write_text(_svg(512, 56, bg=True))
    (HERE / "icon-maskable.svg").write_text(_svg(512, 100, bg=True))
    print("wrote logo.svg, icon.svg, icon-maskable.svg")
