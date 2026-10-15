#!/usr/bin/env python3
"""Turn a checkout of Graphify (Apache-2.0) into MyBrain.

Usage:
    python3 sync/rebrand.py /path/to/graphify-checkout

What it does, in order:
  1. Deletes the MyBrain copies of the upstream folders (mybrain/, tests/, tools/).
  2. Copies the upstream code, tests and tooling in, renaming every file,
     folder and word "graphify" -> "mybrain" (and Graphify -> MyBrain).
  3. Applies the MyBrain patches listed in PATCHES below (no cloud ads,
     no outside CDN scripts, MyBrain banner, MyBrain package metadata).
  4. Copies sync/overrides/* over the result (our own skill, etc.) and
     sync/vendor/* into the package (bundled JavaScript).
  5. Fails loudly if any upstream branding or cloud link is left over.

LICENSE and LICENSE-MIT are copied verbatim. NOTICE is upstream's NOTICE
plus our own attribution block (sync/NOTICE.mybrain).
"""
from __future__ import annotations

import re
import shutil
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
SYNC = REPO / "sync"

# Upstream paths we take (relative to the Graphify checkout).
TAKE = ["graphify", "tests", "tools", "pyproject.toml", "ARCHITECTURE.md"]
# Upstream files we drop (they only test things MyBrain removed).
DROP = ["tests/test_cloud_cta.py"]
# Files that are copied byte-for-byte (license texts).
VERBATIM = ["LICENSE", "LICENSE-MIT"]
# Folders inside the repo that this script owns and rebuilds from scratch.
OWNED = ["mybrain", "tests", "tools"]

TEXT_SUFFIXES = None  # every file is tried as UTF-8 text; binaries are copied as-is


# ---------------------------------------------------------------- patches ---
# Each patch is (upstream relative path, old text, new text). They are applied
# to the UPSTREAM text, before the rename, so they read like Graphify's code.
# If upstream changes and a patch no longer matches, the script stops and says
# which one - that is the signal to look at the new upstream code.

_MYBRAIN_LOGO = '''_BANNER_LOGO = """\\
 ███╗   ███╗██╗   ██╗██████╗ ██████╗  █████╗ ██╗███╗   ██╗
 ████╗ ████║╚██╗ ██╔╝██╔══██╗██╔══██╗██╔══██╗██║████╗  ██║
 ██╔████╔██║ ╚████╔╝ ██████╔╝██████╔╝███████║██║██╔██╗ ██║
 ██║╚██╔╝██║  ╚██╔╝  ██╔══██╗██╔══██╗██╔══██║██║██║╚██╗██║
 ██║ ╚═╝ ██║   ██║   ██████╔╝██║  ██║██║  ██║██║██║ ╚████║
 ╚═╝     ╚═╝   ╚═╝   ╚═════╝ ╚═╝  ╚═╝╚═╝  ╚═╝╚═╝╚═╝  ╚═══╝
 your code, as a living map"""'''

PATCHES: list[tuple[str, str, str]] = [
    # 1. No "Graphify Cloud" nudge after a build.
    (
        "graphify/cli.py",
        '    print()\n'
        '    print("  Graphify Cloud: faster indexing, fewer tokens, cross-repo search,")\n'
        '    print("  and PR review, with your whole SDLC mapped and always current.")\n'
        '    print("  Connect a repo at https://app.graphify.com")\n',
        '    return  # MyBrain: no hosted-platform nudge\n',
    ),
    # 2. No "try the hosted platform" lines after install / in help.
    (
        "graphify/install.py",
        '    print("Prefer a hosted version? Try the graphify platform free for 14 days:")\n'
        '    print("https://app.graphify.com")\n',
        '',
    ),
    (
        "graphify/__main__.py",
        '        print("Prefer a hosted version? Try the graphify platform free for 14 days:")\n'
        '        print("https://app.graphify.com")\n',
        '',
    ),
    # 3. graph.html: bundle vis-network inline instead of loading it from unpkg.
    (
        "graphify/exporters/html.py",
        '<script src="https://unpkg.com/vis-network@9.1.6/standalone/umd/vis-network.min.js"\n'
        '        integrity="sha384-Ux6phic9PEHJ38YtrijhkzyJ8yQlH8i/+buBR8s3mAZOJrP1gwyvAcIYl3GWtpX1"\n'
        '        crossorigin="anonymous"></script>\n',
        '<script>{_bundled_js("vis-network.min.js")}</script>\n',
    ),
    (
        "graphify/exporters/html.py",
        '    def _js_safe(obj) -> str:\n',
        '    from graphify.vendor import bundled_js as _bundled_js\n\n'
        '    def _js_safe(obj) -> str:\n',
    ),
    # 4. Tree view: bundle d3 instead of loading it from d3js.org.
    (
        "graphify/tree_html.py",
        '  <script src="https://d3js.org/d3.v7.min.js"></script>\n',
        '  <script>{d3_js}</script>\n',
    ),
    (
        "graphify/tree_html.py",
        '        data_json=data_json,\n    )\n',
        '        data_json=data_json,\n        d3_js=_bundled_js("d3.v7.min.js"),\n    )\n',
    ),
    (
        "graphify/tree_html.py",
        'from pathlib import Path\n',
        'from pathlib import Path\n\nfrom graphify.vendor import bundled_js as _bundled_js\n',
    ),
    # 4b. Call-flow page: bundle mermaid instead of loading it from jsdelivr.
    (
        "graphify/callflow_html.py",
        '<script src="https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.min.js"></script>\n',
        '<script>{_bundled_js("mermaid.min.js")}</script>\n',
    ),
    (
        "graphify/callflow_html.py",
        'from pathlib import Path\n',
        'from pathlib import Path\n\nfrom graphify.vendor import bundled_js as _bundled_js\n',
    ),
    # 5. MyBrain banner instead of the Graphify logo.
    (
        "graphify/install.py",
        "__REGEX__" + r'(?s)_BANNER_LOGO = """\\\n.*?"""',
        _MYBRAIN_LOGO,
    ),
    # 6. Docs links that point at Graphify's website.
    (
        "**/*.md",
        "__REGEX__" + r'\s*\(see https://docs\.graphify\.com[^)]*\)',
        '',
    ),
    # 7. Package metadata.
    (
        "pyproject.toml",
        "__REGEX__" + r'description = "[^"]*"',
        'description = "MyBrain - turn any folder of code into a knowledge graph you can explore '
        'on your phone and desktop (Apache-2.0 fork; see NOTICE)"',
    ),
    (
        "pyproject.toml",
        "__REGEX__" + r'\[project\.urls\]\n(?:[^\n]+\n)*\n',
        '[project.urls]\nRepository = "https://github.com/vicevinnybeats/mybrain"\n\n',
    ),
    (
        "pyproject.toml",
        'graphify = ["skill.md",',
        'graphify = ["vendor/*.js", "skill.md",',
    ),
    (
        "pyproject.toml",
        'packages = ["graphify", "graphify.extractors", "graphify.exporters"]',
        'packages = ["graphify", "graphify.extractors", "graphify.exporters", "graphify.vendor"]',
    ),
]

# Applied to every text file BEFORE the generic rename (order matters).
PRE_RENAME = [
    ("Graphify-Labs/graphify", "vicevinnybeats/mybrain"),
    ("graphifyy", "mybrain"),
]
RENAME = [
    ("GRAPHIFY", "MYBRAIN"),
    ("Graphify", "MyBrain"),
    ("graphify", "mybrain"),
]


def rename_text(s: str) -> str:
    for a, b in PRE_RENAME + RENAME:
        s = s.replace(a, b)
    return s


def rename_path(p: str) -> str:
    for a, b in RENAME:
        p = p.replace(a, b)
    return p


def apply_patches(src: Path) -> None:
    for rel, old, new in PATCHES:
        targets = sorted(src.glob(rel)) if "*" in rel else [src / rel]
        hit = False
        for f in targets:
            text = f.read_text(encoding="utf-8")
            if old.startswith("__REGEX__"):
                text2, n = re.subn(old[len("__REGEX__"):], lambda _m: new, text)
            else:
                n = text.count(old)
                text2 = text.replace(old, new)
            if n:
                hit = True
                f.write_text(text2, encoding="utf-8")
        if not hit and "*" not in rel:
            sys.exit(f"PATCH DID NOT MATCH: {rel}: {old[:70]!r}\n"
                     "Upstream changed this code - update sync/rebrand.py.")


def main() -> None:
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    upstream = Path(sys.argv[1]).resolve()
    if not (upstream / "graphify" / "__init__.py").exists():
        sys.exit(f"{upstream} does not look like a Graphify checkout")

    # Work on a scratch copy so patches never touch the user's checkout.
    work = REPO / ".sync-work"
    shutil.rmtree(work, ignore_errors=True)
    work.mkdir()
    for name in TAKE + VERBATIM + ["NOTICE"]:
        s = upstream / name
        (shutil.copytree if s.is_dir() else shutil.copy2)(s, work / name)
    for rel in DROP:
        (work / rel).unlink()
    apply_patches(work)

    for name in OWNED:
        shutil.rmtree(REPO / name, ignore_errors=True)

    for f in sorted(work.rglob("*")):
        if f.is_dir() or "__pycache__" in f.parts:
            continue
        rel = f.relative_to(work).as_posix()
        if rel in VERBATIM or rel == "NOTICE":
            continue
        dst = REPO / rename_path(rel)
        dst.parent.mkdir(parents=True, exist_ok=True)
        data = f.read_bytes()
        try:
            text = data.decode("utf-8")
        except UnicodeDecodeError:
            dst.write_bytes(data)
            continue
        dst.write_bytes(rename_text(text).encode("utf-8"))
        shutil.copymode(f, dst)

    for name in VERBATIM:
        shutil.copy2(work / name, REPO / name)
    notice = (work / "NOTICE").read_text(encoding="utf-8").rstrip("\n")
    notice += "\n\n" + (SYNC / "NOTICE.mybrain").read_text(encoding="utf-8")
    (REPO / "NOTICE").write_text(notice, encoding="utf-8")

    # Our own files on top.
    overrides = SYNC / "overrides"
    for f in sorted(overrides.rglob("*")):
        if f.is_file():
            dst = REPO / f.relative_to(overrides)
            dst.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(f, dst)
    vendor_dst = REPO / "mybrain" / "vendor"
    vendor_dst.mkdir(parents=True, exist_ok=True)
    for f in sorted((SYNC / "vendor").glob("*.js")):
        shutil.copy2(f, vendor_dst / f.name)

    shutil.rmtree(work)
    check_clean()
    print("Rebrand complete.")


def check_clean() -> None:
    """Fail if upstream branding or cloud links survived."""
    bad = re.compile(r"graphify|app\.mybrain\.com|docs\.mybrain\.com|<script src=\"https?://", re.I)
    problems = []
    for name in OWNED + ["pyproject.toml"]:
        root = REPO / name
        files = [root] if root.is_file() else root.rglob("*")
        for f in files:
            if not f.is_file():
                continue
            if bad.search(f.relative_to(REPO).as_posix()):
                problems.append(f"name: {f}")
                continue
            try:
                text = f.read_text(encoding="utf-8")
            except UnicodeDecodeError:
                continue
            for i, line in enumerate(text.splitlines(), 1):
                if bad.search(line):
                    problems.append(f"{f.relative_to(REPO)}:{i}: {line.strip()[:100]}")
    if problems:
        print("\n".join(problems[:50]))
        sys.exit(f"{len(problems)} leftover upstream references - fix sync/rebrand.py")


if __name__ == "__main__":
    main()
