#!/usr/bin/env python3
"""Refresh every map whose GitHub repository has new commits (MyBrain).

Run by .github/workflows/refresh-maps.yml every hour. For each
maps/<name>/map.json that remembers its "source" repository, it asks GitHub
for that repository's latest commit (git ls-remote: cheap, no clone). Only a
repository that changed since its map was built is cloned, mapped (free, no
AI) and published again. Private repositories need the MYBRAIN_READ_TOKEN
secret on this repository; public ones work without it.
"""
from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent
TOKEN = os.environ.get("MYBRAIN_READ_TOKEN", "")


def url(repo: str) -> str:
    return (f"https://x-access-token:{TOKEN}@github.com/{repo}.git" if TOKEN
            else f"https://github.com/{repo}.git")


def clean(text: str) -> str:
    return text.replace(TOKEN, "***") if TOKEN else text


def latest_commit(repo: str) -> str | None:
    r = subprocess.run(["git", "ls-remote", url(repo), "HEAD"], capture_output=True, text=True)
    if r.returncode != 0 or not r.stdout.strip():
        print(f"  {repo}: cannot read it ({clean(r.stderr.strip())[:200]})")
        return None
    return r.stdout.split()[0]


def main() -> int:
    changed = []
    for mj in sorted((ROOT / "maps").glob("*/map.json")):
        data = json.loads(mj.read_text(encoding="utf-8"))
        repo = data.get("source")
        if not repo:
            continue
        head = latest_commit(repo)
        if head is None:
            continue
        if head == data.get("commit"):
            print(f"  {repo}: up to date")
        else:
            print(f"  {repo}: new commits -> remap")
            changed.append((mj.parent.name, repo))
    failures = 0
    for name, repo in changed:
        work = ROOT / ".work" / name
        shutil.rmtree(work, ignore_errors=True)
        work.parent.mkdir(exist_ok=True)
        r = subprocess.run(["git", "clone", "--depth", "1", url(repo), str(work)],
                           capture_output=True, text=True)
        if r.returncode != 0:
            print(f"  {repo}: clone failed: {clean(r.stderr.strip())[:300]}")
            failures += 1
            continue
        steps = [["mybrain", "update", "."],
                 ["mybrain-publish", ".", "--name", name, "--source", repo,
                  "--maps-dir", str(ROOT)]]
        for cmd in steps:
            if subprocess.run(cmd, cwd=work).returncode != 0:
                print(f"  {repo}: {cmd[0]} failed")
                failures += 1
                break
        shutil.rmtree(work, ignore_errors=True)
    print(f"{len(changed)} map(s) refreshed, {failures} failed")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
