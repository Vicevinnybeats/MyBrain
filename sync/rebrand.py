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
DROP = [
    "tests/test_cloud_cta.py",  # tests the hosted-platform nudge MyBrain removed
]
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
        '<script data-vendor="vis-network@9.1.6/standalone/umd/vis-network.min.js"\n'
        '        data-integrity="sha384-Ux6phic9PEHJ38YtrijhkzyJ8yQlH8i/+buBR8s3mAZOJrP1gwyvAcIYl3GWtpX1">'
        '{_bundled_js("vis-network.min.js")}</script>\n',
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
        '  <script data-vendor="d3@7.9.0">{d3_js}</script>\n',
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
        '<script data-vendor="mermaid@11.12.0">{_bundled_js("mermaid.min.js")}</script>\n',
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
        '[project.urls]\nRepository = "https://github.com/Vicevinnybeats/MyBrain"\n\n',
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
    # 8. Free by default: never pick a paid AI (or the Claude CLI) on its own.
    #    Only a local Ollama is auto-detected; anything else needs --backend.
    (
        "graphify/llm.py",
        '    for backend in ("gemini", "kimi", "claude", "openai", "deepseek"):\n'
        '        if _get_backend_api_key(backend):\n'
        '            return backend\n',
        '    # MyBrain: free by default - auto-detect only a local Ollama. Paid\n'
        '    # backends are used only when picked explicitly with --backend, or when\n'
        '    # GRAPHIFY_ALLOW_PAID_AUTODETECT=1 restores upstream auto-detection.\n'
        '    if os.environ.get("GRAPHIFY_ALLOW_PAID_AUTODETECT", _PAID_AUTODETECT_DEFAULT).strip() != "1":\n'
        '        ollama_url = _resolve_ollama_base_url("")\n'
        '        if ollama_url:\n'
        '            _validate_ollama_base_url(ollama_url)\n'
        '            return "ollama"\n'
        '        return None\n'
        '    for backend in ("gemini", "kimi", "claude", "openai", "deepseek"):\n'
        '        if _get_backend_api_key(backend):\n'
        '            return backend\n',
    ),
    (
        "graphify/llm.py",
        '    if not backend and _claude_cli_available():\n',
        '    if (not backend and os.environ.get("GRAPHIFY_ALLOW_PAID_AUTODETECT", _PAID_AUTODETECT_DEFAULT).strip() == "1"\n'
        '            and _claude_cli_available()):\n',
    ),
    (
        "graphify/cli.py",
        '            print("Code graph updated. For doc/paper/image changes run /graphify --update in your AI assistant.")\n'
        '            if not (\n',
        '            print("Code map updated (free, no AI). For docs/PDF/images: /graphify --docs (needs local Ollama).")\n'
        '            if False and not (  # MyBrain: no paid-AI tips\n',
    ),
    # 9. Brain words in the report (GRAPH_REPORT.md = the "Brain Scan").
    ("graphify/report.py", 'f"# Graph Report - {', 'f"# Brain Scan - {'),
    ("graphify/report.py", '"## Community Hubs (Navigation)"', '"## Lobes (Navigation)"'),
    ("graphify/report.py", '"## God Nodes (most connected - your core abstractions)"',
     '"## Core Neurons (most connected - your core abstractions)"'),
    ("graphify/report.py", '- {node[\'degree\']} edges")', '- {node[\'degree\']} synapses")'),
    ("graphify/report.py",
     'f"- {G.number_of_nodes()} nodes · {G.number_of_edges()} edges · {len(communities)} communities"',
     'f"- {G.number_of_nodes()} neurons · {G.number_of_edges()} synapses · {len(communities)} lobes"'),
    ("graphify/report.py", 'f"## Communities ({len(communities)} total,', 'f"## Lobes ({len(communities)} total,'),
    ("graphify/report.py", 'f"### Community {cid} - \\"{label}\\"",', 'f"### Lobe {cid} - \\"{label}\\"",'),
    ("graphify/report.py", 'f"Nodes ({len(real_nodes)}): {', 'f"Neurons ({len(real_nodes)}): {'),
    ("graphify/callflow_html.py", 'stripped.startswith("## God Nodes")',
     'stripped.startswith(("## God Nodes", "## Core Neurons"))'),
    # 10. Brain words in graph.html.
    ("graphify/exporters/html.py", '<title>graphify - {title}</title>', '<title>MyBrain - {title}</title>'),
    ("graphify/exporters/html.py", 'placeholder="Search nodes..."', 'placeholder="Search neurons..."'),
    ("graphify/exporters/html.py", '<h3>Node Info</h3>', '<h3>Neuron</h3>'),
    ("graphify/exporters/html.py", 'Click a node to inspect it', 'Tap a neuron to see its synapses'),
    ("graphify/exporters/html.py", '<h3>Communities</h3>', '<h3>Lobes</h3>'),
    ("graphify/exporters/html.py", '<div class="field">Community: ${{', '<div class="field">Lobe: ${{'),
    ("graphify/exporters/html.py", '<div class="field">Degree: ${{', '<div class="field">Synapses: ${{'),
    ("graphify/exporters/html.py", 'Neighbors (${{neighborIds.length}})', 'Connected neurons (${{neighborIds.length}})'),
    ("graphify/exporters/html.py",
     'stats = f"{G.number_of_nodes()} nodes &middot; {G.number_of_edges()} edges &middot; {len(communities)} communities"',
     'stats = f"{G.number_of_nodes()} neurons &middot; {G.number_of_edges()} synapses &middot; {len(communities)} lobes"'),
    # 11. Tests: follow MyBrain's words and free-by-default policy.
    ("tests/conftest.py",
     '    for key in backend_detection_env_vars():\n        monkeypatch.delenv(key, raising=False)\n',
     '    for key in backend_detection_env_vars():\n        monkeypatch.delenv(key, raising=False)\n'
     '    # MyBrain is free by default (only Ollama is auto-detected); upstream\n'
     '    # tests exercise the paid auto-detection, so opt back in for them.\n'
     '    # tests/test_mybrain_free_default.py covers the MyBrain default.\n'
     '    import graphify.llm as _llm\n'
     '    monkeypatch.setattr(_llm, "_PAID_AUTODETECT_DEFAULT", "1")\n'),
    ("tests/test_report.py", 'assert "# Graph Report" in report', 'assert "# Brain Scan" in report'),
    ("tests/test_report.py", 'assert "## God Nodes" in report', 'assert "## Core Neurons" in report'),
    ("tests/test_report.py", 'assert "## Communities" in report', 'assert "## Lobes (" in report'),
    ("tests/test_report.py", 'assert "## Community Hubs (Navigation)" in report', 'assert "## Lobes (Navigation)" in report'),
    ("tests/test_report_gap_thresholds.py", 'r"## Communities \\((\\d+) total', 'r"## Lobes \\((\\d+) total'),
    ("tests/test_report_gap_thresholds.py", 'r"### Community ', 'r"### Lobe '),
    ("tests/test_report_gap_thresholds.py", 'assert "Nodes (3):" in text', 'assert "Neurons (3):" in text'),
    ("tests/test_pipeline.py", 'assert "God Nodes" in report', 'assert "Core Neurons" in report'),
    ("tests/test_export.py", 'assert title.startswith("graphify - ")\n    label = title[len("graphify - "):]',
     'assert title.startswith("MyBrain - ")\n    label = title[len("MyBrain - "):]'),
    ("tests/test_export.py", 'assert "https://unpkg.com/vis-network/standalone" not in content',
     'assert "https://unpkg.com/" not in content  # MyBrain bundles it inline'),
    ("tests/test_export.py", "<div class=\"field\">Community: Core</div>", "<div class=\"field\">Lobe: Core</div>"),
    ("tests/test_export.py", "<div class=\"field\">Community: Core Systems</div>", "<div class=\"field\">Lobe: Core Systems</div>"),
    ("tests/test_export.py", "<div class=\"field\">Degree: 1</div>", "<div class=\"field\">Synapses: 1</div>"),
    ("tests/test_callflow_html.py", '    assert "Transformer" not in html\n',
     '    assert "Transformer" not in __import__("re").sub(r"(?s)<script data-vendor.*?</script>", "", html)\n'),
    ("tests/test_install_strings.py",
     "def test_how_it_works_clarifies_code_only_semantic_extraction():\n",
     "@__import__(\"pytest\").mark.skip(reason=\"MyBrain does not ship the upstream docs/ folder\")\n"
     "def test_how_it_works_clarifies_code_only_semantic_extraction():\n"),
    ("tests/test_pipeline.py", '    assert "Communities" in report\n', '    assert "Lobes" in report\n'),
    ("tests/test_export.py", "    assert 'crossorigin=\"anonymous\"' in content\n",
     "    # MyBrain inlines the script, so there is no cross-origin request to protect.\n"),
    ("graphify/llm.py", '    "OLLAMA_BASE_URL", "OLLAMA_HOST",\n',
     '    "OLLAMA_BASE_URL", "OLLAMA_HOST",\n    "GRAPHIFY_ALLOW_PAID_AUTODETECT",\n'),
    ("graphify/llm.py", "def detect_backend() -> str | None:\n",
     "# MyBrain: \"0\" = free by default. Tests flip this to \"1\" to exercise upstream's\n"
     "# paid auto-detection without touching the environment.\n"
     "_PAID_AUTODETECT_DEFAULT = \"0\"\n\n\n"
     "def detect_backend() -> str | None:\n"),
    # 12. Claude Code gets the MyBrain skill (sync/overrides/mybrain/skill-mybrain.md);
    #     upstream's skill.md stays in the package untouched.
    ("graphify/install.py",
     '    "claude": {\n        "skill_file": "skill.md",\n',
     '    "claude": {\n        "skill_file": "skill-mybrain.md",\n'),
    ("pyproject.toml", 'graphify = ["vendor/*.js", "skill.md",', 'graphify = ["vendor/*.js", "skill-mybrain.md", "skill.md",'),
    ("tests/test_community_labels_skill.py",
     '    paths = sorted(REPO_ROOT.glob("graphify/skill*.md"))\n',
     '    paths = sorted(p for p in REPO_ROOT.glob("graphify/skill*.md")\n'
     '                   if p.name != "skill-graphify.md")  # MyBrain\'s own skill has no Step 5\n'),
    ("tests/test_install_references.py",
     "def test_claude_install_ships_lean_core_and_references(tmp_path):\n",
     "@__import__(\"pytest\").mark.skip(reason=\"MyBrain installs its own short skill for Claude Code\")\n"
     "def test_claude_install_ships_lean_core_and_references(tmp_path):\n"),
    # 13. mybrain-publish: send a map to the web app (sync/overrides/mybrain/publish.py).
    ("pyproject.toml", 'graphify-mcp = "graphify.serve:_main"\n',
     'graphify-mcp = "graphify.serve:_main"\ngraphify-publish = "graphify.publish:main"\n'),
    # 14. Use the brain automatically: the global CLAUDE.md block written by
    #     `install` also tells Claude to build/query the map on its own.
    ("graphify/install.py",
     '        "When the user types `/graphify`, use the installed graphify skill "\n        "or instructions before doing anything else.\\n"\n    )\n',
     '        "When the user types `/graphify`, use the installed graphify skill "\n        "or instructions before doing anything else.\\n"\n        "Use it automatically (free, local, no AI) to save tokens:\\n"\n        "- Before exploring a codebase to answer how it works, where something lives or what calls what: if `graphify-out/graph.json` is missing in the repo root, run `graphify update .` once (seconds to ~2 min), then ask the map first with `graphify query \\"<question>\\"`, `graphify path \\"A\\" \\"B\\"` or `graphify explain \\"X\\"`; read raw files only where the map points.\\n"\n        "- Skip it for tiny tasks (one known file, a typo, a config value).\\n"\n        "- After larger code changes, run `graphify update .` again.\\n"\n        "- Keep graphify-out/ out of commits: add it to .git/info/exclude.\\n"\n    )\n'),
    # 15. A global install also guards Grep/Read in every Claude Code session
    #     (silent unless the repo has a map), like a per-project hook install.
    ("graphify/install.py",
     '    if platform == "opencode":\n        _install_opencode_plugin(project_dir if project else Path("."))\n',
     '    if platform == "claude" and not project:\n'
     '        _install_claude_hook(Path.home(), project=False)\n'
     '        print("  ~/.claude/settings.json  ->  map-first hints before Grep/Read (any repo with a map)")\n\n'
     '    if platform == "opencode":\n        _install_opencode_plugin(project_dir if project else Path("."))\n'),
]

# Applied to every text file BEFORE the generic rename (order matters).
PRE_RENAME = [
    ("Graphify-Labs/graphify", "Vicevinnybeats/MyBrain"),
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
    check_vendor()
    check_clean()
    print("Rebrand complete.")


VENDOR_SHA384 = {
    # Same hash upstream pins with SRI for the unpkg copy.
    "vis-network.min.js": "Ux6phic9PEHJ38YtrijhkzyJ8yQlH8i/+buBR8s3mAZOJrP1gwyvAcIYl3GWtpX1",
}


def check_vendor() -> None:
    import base64
    import hashlib
    for name, want in VENDOR_SHA384.items():
        got = base64.b64encode(hashlib.sha384((SYNC / "vendor" / name).read_bytes()).digest()).decode()
        if got != want:
            sys.exit(f"sync/vendor/{name} does not match its pinned sha384")


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
