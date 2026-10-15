"""Bundled third-party JavaScript (MyBrain addition).

MyBrain pages never load scripts from an outside CDN; the libraries ship
inside the package and are inlined into each generated HTML page. Licenses
for these files are in sync/vendor/licenses/ in the MyBrain repository.
"""
from __future__ import annotations

from functools import lru_cache
from pathlib import Path

_HERE = Path(__file__).resolve().parent


@lru_cache(maxsize=None)
def bundled_js(name: str) -> str:
    """Return a vendored script's source, safe to place inside <script>...</script>."""
    src = (_HERE / name).read_text(encoding="utf-8")
    # Keep the HTML tokenizer from ending or re-entering the script element early.
    return src.replace("</script", "<\\/script").replace("<!--", "<\\!--")
