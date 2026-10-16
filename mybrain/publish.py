"""mybrain-publish: send a map to the MyBrain web app (MyBrain addition).

The web app is a static site built from a private "maps" GitHub repository
(default: <you>/mybrain-maps). Publishing a map means writing two files into
that repository and pushing:

    maps/<name>/map.json    compact map for the app (columnar, no ids)
    maps/<name>/report.md   the Brain Scan (GRAPH_REPORT.md)

Usage:
    mybrain-publish [PATH] [--name NAME] [--maps-dir DIR] [--source OWNER/REPO] [--commit SHA] [--no-push]

PATH defaults to "." and must contain mybrain-out/graph.json.

Where the maps repository comes from, in order:
    --maps-dir DIR          an existing checkout (used as-is)
    $MYBRAIN_MAPS_DIR       same, from the environment
    $MYBRAIN_MAPS_REPO      "owner/repo" to clone (default Vicevinnybeats/mybrain-maps)
                            into ~/.mybrain/maps-repo; $MYBRAIN_MAPS_TOKEN, when set,
                            is used to authenticate (GitHub Actions).
$MYBRAIN_APP_URL, when set, is used to print the link to the published map.
"""
from __future__ import annotations

import json
import os
import re
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

FORMAT_VERSION = 1
DEFAULT_MAPS_REPO = "Vicevinnybeats/mybrain-maps"


def slugify(name: str) -> str:
    s = re.sub(r"[^a-z0-9._-]+", "-", name.strip().lower()).strip("-.")
    return s or "map"


def _git(args: list[str], cwd: Path, check: bool = True) -> str:
    out = subprocess.run(["git", *args], cwd=cwd, capture_output=True, text=True)
    if check and out.returncode != 0:
        raise RuntimeError(f"git {' '.join(args)} failed: {out.stderr.strip()}")
    return out.stdout.strip()


def default_name(target: Path) -> str:
    """The repo name from the git remote, else the folder name."""
    try:
        url = _git(["remote", "get-url", "origin"], target)
        m = re.search(r"([^/:]+?)(?:\.git)?/?$", url)
        if m:
            return slugify(m.group(1))
    except Exception:
        pass
    return slugify(target.resolve().name)


def compact_map(graph: dict, name: str) -> dict:
    """graph.json (node-link) -> the web app's compact columnar format."""
    nodes = graph.get("nodes", [])
    links = graph.get("links", graph.get("edges", []))
    index = {n["id"]: i for i, n in enumerate(nodes)}

    files: list[str] = []
    file_idx: dict[str, int] = {}
    kinds: list[str] = []
    kind_idx: dict[str, int] = {}
    lobe_names: dict[int, str] = {}
    lobe_size: dict[int, int] = {}

    col = {"label": [], "lobe": [], "file": [], "loc": [], "kind": [], "deg": []}
    for n in nodes:
        f = n.get("source_file") or ""
        if f not in file_idx:
            file_idx[f] = len(files)
            files.append(f)
        k = n.get("file_type") or ""
        if k not in kind_idx:
            kind_idx[k] = len(kinds)
            kinds.append(k)
        c = n.get("community")
        c = int(c) if isinstance(c, (int, float)) or (isinstance(c, str) and c.isdigit()) else -1
        if c >= 0 and c not in lobe_names:
            lobe_names[c] = str(n.get("community_name") or f"Lobe {c}")
        lobe_size[c] = lobe_size.get(c, 0) + 1
        col["label"].append(str(n.get("label") or n["id"]))
        col["lobe"].append(c)
        col["file"].append(file_idx[f])
        col["loc"].append(str(n.get("source_location") or ""))
        col["kind"].append(kind_idx[k])
        col["deg"].append(0)

    rels: list[str] = []
    rel_idx: dict[str, int] = {}
    edges: list[int] = []
    seen = set()
    for e in links:
        s = index.get(e.get("_src", e.get("source")))
        t = index.get(e.get("_tgt", e.get("target")))
        if s is None or t is None or s == t:
            continue
        r = str(e.get("relation") or "related")
        key = (s, t, r)
        if key in seen:
            continue
        seen.add(key)
        if r not in rel_idx:
            rel_idx[r] = len(rels)
            rels.append(r)
        edges += [s, t, rel_idx[r]]
        col["deg"][s] += 1
        col["deg"][t] += 1

    # Placeholder names ("Community 12") read better as "Lobe 12" in the app.
    lobes = []
    for c in sorted(lobe_names, key=lambda c: -lobe_size.get(c, 0)):
        nm = lobe_names[c]
        if re.fullmatch(r"Community \d+", nm):
            nm = f"Lobe {c}"
        lobes.append([c, nm, lobe_size.get(c, 0)])

    meta = graph.get("graph", {}) or {}
    return {
        "format": FORMAT_VERSION,
        "name": name,
        "published": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "commit": graph.get("built_at_commit") or meta.get("built_at_commit"),
        "stats": {"neurons": len(nodes), "synapses": len(edges) // 3, "lobes": len(lobes)},
        "lobes": lobes,
        "files": files,
        "kinds": kinds,
        "rels": rels,
        "nodes": col,
        "edges": edges,
    }


def _maps_checkout(maps_dir: str | None) -> tuple[Path, bool]:
    """Return (checkout path, is_git_managed_by_us)."""
    explicit = maps_dir or os.environ.get("MYBRAIN_MAPS_DIR")
    if explicit:
        return Path(explicit).expanduser().resolve(), False
    repo = os.environ.get("MYBRAIN_MAPS_REPO", DEFAULT_MAPS_REPO)
    token = os.environ.get("MYBRAIN_MAPS_TOKEN", "")
    if "://" in repo or repo.startswith(("/", ".", "git@")):
        url = repo                                   # a full URL or a local path
    else:
        url = (f"https://x-access-token:{token}@github.com/{repo}.git" if token
               else f"https://github.com/{repo}.git")
    dest = Path.home() / ".mybrain" / "maps-repo"
    if (dest / ".git").exists():
        _git(["remote", "set-url", "origin", url], dest)
        _git(["fetch", "--depth", "1", "origin"], dest)
        branch = _git(["rev-parse", "--abbrev-ref", "origin/HEAD"], dest, check=False) or "origin/main"
        _git(["reset", "--hard", branch], dest)
    else:
        dest.parent.mkdir(parents=True, exist_ok=True)
        res = subprocess.run(["git", "clone", "--depth", "1", url, str(dest)],
                             capture_output=True, text=True)
        if res.returncode != 0:
            msg = res.stderr.replace(token, "***") if token else res.stderr
            raise RuntimeError(f"could not clone {repo}: {msg.strip()}")
    return dest, True


def publish(target: Path, name: str, maps_dir: str | None, push: bool,
            source: str | None = None, commit: str | None = None) -> Path:
    graph_path = target / "mybrain-out" / "graph.json"
    if not graph_path.exists():
        raise FileNotFoundError(f"{graph_path} not found - build the map first (mybrain update {target})")
    graph = json.loads(graph_path.read_text(encoding="utf-8"))
    data = compact_map(graph, name)
    if source:
        # "owner/repo": lets the maps repository refresh this map on its own.
        data["source"] = source
    if commit:
        data["commit"] = commit

    checkout, managed = _maps_checkout(maps_dir)
    out = checkout / "maps" / name
    out.mkdir(parents=True, exist_ok=True)
    (out / "map.json").write_text(json.dumps(data, separators=(",", ":")), encoding="utf-8")
    report = target / "mybrain-out" / "GRAPH_REPORT.md"
    if report.exists():
        (out / "report.md").write_text(report.read_text(encoding="utf-8"), encoding="utf-8")

    st = data["stats"]
    print(f"[mybrain publish] {name}: {st['neurons']} neurons, {st['synapses']} synapses, "
          f"{st['lobes']} lobes -> {out}")

    if push and (managed or (checkout / ".git").exists()):
        _git(["add", "maps/" + name], checkout)
        if _git(["status", "--porcelain", "maps/" + name], checkout):
            env_name = _git(["config", "user.name"], checkout, check=False)
            if not env_name:
                _git(["config", "user.name", "MyBrain"], checkout)
                _git(["config", "user.email", "mybrain@users.noreply.github.com"], checkout)
            _git(["commit", "-q", "-m", f"Update map: {name}"], checkout)
            for attempt in range(4):
                res = subprocess.run(["git", "push", "-q", "origin", "HEAD"], cwd=checkout,
                                     capture_output=True, text=True)
                if res.returncode == 0:
                    break
                # Someone else published at the same time: rebase onto theirs and retry.
                _git(["pull", "-q", "--rebase", "origin", _git(["rev-parse", "--abbrev-ref", "HEAD"], checkout)],
                     checkout, check=False)
            else:
                raise RuntimeError("git push to the maps repository failed")
            print("[mybrain publish] pushed - the app updates in about a minute")
        else:
            print("[mybrain publish] map unchanged - nothing to push")

    app = os.environ.get("MYBRAIN_APP_URL", "").rstrip("/")
    if app:
        print(f"[mybrain publish] open: {app}/#/map/{name}")
    return out


def main(argv: list[str] | None = None) -> int:
    args = list(sys.argv[1:] if argv is None else argv)
    if any(a in ("-h", "--help") for a in args):
        print(__doc__)
        return 0
    name = maps_dir = source = commit = None
    push = True
    rest = []
    i = 0
    while i < len(args):
        a = args[i]
        if a == "--name" and i + 1 < len(args):
            name = args[i + 1]; i += 2
        elif a == "--maps-dir" and i + 1 < len(args):
            maps_dir = args[i + 1]; i += 2
        elif a == "--source" and i + 1 < len(args):
            source = args[i + 1]; i += 2
        elif a == "--commit" and i + 1 < len(args):
            commit = args[i + 1]; i += 2
        elif a == "--no-push":
            push = False; i += 1
        else:
            rest.append(a); i += 1
    target = Path(rest[0] if rest else ".").resolve()
    try:
        publish(target, slugify(name) if name else default_name(target), maps_dir, push, source, commit)
    except Exception as exc:  # plain message for the phone, no traceback
        print(f"[mybrain publish] error: {exc}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
