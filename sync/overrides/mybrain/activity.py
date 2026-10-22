"""mybrain-activity: tell the MyBrain app what Claude is doing (MyBrain addition).

Claude Code runs this as a hook (installed by `mybrain install`). It sends one
small event per file Claude reads, searches or changes, plus the session's
token count when Claude finishes a reply, to the app's /api/activity. The app
shows them live: the Brain Monitor's activity feed and beams in the 3D brain.

What is sent: the repository name, the session id (shortened), the kind of
action (read / write / search / run), the file path inside the repository and
token totals. Never file contents, never commands, never search patterns.

It never slows Claude down or gets in its way: the hook returns at once, the
network call happens in a detached process with a short timeout, and every
error is swallowed. Turn it off with MYBRAIN_ACTIVITY=off.

    mybrain-activity            (as a hook: reads the hook's JSON on stdin)
    mybrain-activity --test     send one test event and print the answer

App address, in order: $MYBRAIN_APP_URL, ~/.mybrain/app-url, the default below.
"""
from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import sys
import urllib.request
from pathlib import Path

DEFAULT_APP_URL = "https://mybrain.vicevinnybeats.workers.dev"
HOOK_MATCHER = "Read|Edit|Write|MultiEdit|NotebookEdit|Grep|Glob|Bash"
KINDS = {
    "Read": "read", "NotebookRead": "read",
    "Edit": "write", "Write": "write", "MultiEdit": "write", "NotebookEdit": "write",
    "Grep": "search", "Glob": "search",
    "Bash": "run",
}


def app_url() -> str:
    url = os.environ.get("MYBRAIN_APP_URL", "").strip()
    if not url:
        try:
            url = (Path.home() / ".mybrain" / "app-url").read_text(encoding="utf-8").strip()
        except OSError:
            url = ""
    return (url or DEFAULT_APP_URL).rstrip("/")


def _git(cwd: str, *args: str) -> str:
    try:
        r = subprocess.run(["git", "-C", cwd, *args], capture_output=True, text=True, timeout=2)
        return r.stdout.strip() if r.returncode == 0 else ""
    except (OSError, subprocess.SubprocessError):
        return ""


def repo_of(cwd: str) -> tuple[str, str]:
    """(owner/name or folder name, repository root) for a working directory."""
    root = _git(cwd, "rev-parse", "--show-toplevel") or cwd
    remote = _git(root, "config", "--get", "remote.origin.url")
    m = re.search(r"github\.com[:/]+([\w.-]+/[\w.-]+?)(?:\.git)?/?$", remote) or \
        re.search(r"/git/([\w.-]+/[\w.-]+?)(?:\.git)?/?$", remote)
    name = m.group(1) if m else Path(root).name
    return name[:100], root


def tokens_of(transcript: str) -> dict:
    """Token totals of a session, summed from its transcript (JSON lines)."""
    tot = {"input": 0, "output": 0, "cache": 0}
    seen = set()
    try:
        with open(transcript, encoding="utf-8") as fh:
            for line in fh:
                try:
                    e = json.loads(line)
                except ValueError:
                    continue
                msg = e.get("message") if isinstance(e, dict) else None
                if not isinstance(msg, dict) or msg.get("role") != "assistant":
                    continue
                mid = msg.get("id")
                if mid in seen:          # one reply is logged once per content block
                    continue
                seen.add(mid)
                u = msg.get("usage") or {}
                tot["input"] += int(u.get("input_tokens") or 0)
                tot["output"] += int(u.get("output_tokens") or 0)
                tot["cache"] += int(u.get("cache_read_input_tokens") or 0) + int(u.get("cache_creation_input_tokens") or 0)
    except OSError:
        pass
    return tot


def event_from_hook(h: dict) -> dict | None:
    name = h.get("hook_event_name") or ""
    cwd = h.get("cwd") or os.getcwd()
    repo, root = repo_of(cwd)
    ev = {"session": str(h.get("session_id") or "")[:12] or "unknown", "repo": repo}
    if name == "PostToolUse":
        tool = h.get("tool_name") or ""
        kind = KINDS.get(tool)
        if not kind:
            return None
        ti = h.get("tool_input") or {}
        path = ti.get("file_path") or ti.get("notebook_path") or ti.get("path") or ""
        if path:
            try:
                p = Path(path)
                path = str(p.resolve().relative_to(Path(root).resolve())) if p.is_absolute() else path
            except (ValueError, OSError):
                path = Path(path).name
        ev.update(kind=kind, path=str(path)[:300])
        return ev
    if name in ("Stop", "SessionEnd"):
        t = tokens_of(h.get("transcript_path") or "")
        ev.update(kind="tokens", tokens=t)
        return ev
    if name == "SessionStart":
        ev.update(kind="start")
        return ev
    return None


def send(ev: dict, timeout: float = 4.0) -> tuple[int, str]:
    req = urllib.request.Request(app_url() + "/api/activity", data=json.dumps(ev).encode(),
                                 headers={"content-type": "application/json", "user-agent": "mybrain-activity"},
                                 method="POST")
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.status, r.read(300).decode("utf-8", "replace")


def main() -> None:
    if "--test" in sys.argv:
        repo, _ = repo_of(os.getcwd())
        ev = {"session": "test", "repo": repo, "kind": "read", "path": "README.md"}
        try:
            print(app_url(), *send(ev))
        except Exception as e:  # noqa: BLE001 - a test should say what failed
            print(app_url(), "failed:", e)
            sys.exit(1)
        return
    if os.environ.get("MYBRAIN_ACTIVITY", "").lower() in ("off", "0", "no", "false"):
        return
    try:
        h = json.loads(sys.stdin.read() or "{}")
        ev = event_from_hook(h)
    except Exception:  # noqa: BLE001 - a hook must never get in Claude's way
        return
    if not ev:
        return
    # send from a detached child so Claude never waits on the network
    try:
        if hasattr(os, "fork"):
            if os.fork() != 0:
                return
            os.setsid()
            if os.fork() != 0:
                os._exit(0)
            try:
                send(ev)
            except Exception:  # noqa: BLE001
                pass
            os._exit(0)
        else:
            send(ev, timeout=2.0)
    except Exception:  # noqa: BLE001
        pass


# ---------------------------------------------------------------- installing --
def _strip(entries: list) -> list:
    out = []
    for e in entries:
        hooks = [x for x in (e.get("hooks") or []) if "mybrain-activity" not in str(x.get("command", ""))]
        if hooks:
            out.append({**e, "hooks": hooks})
        elif not e.get("hooks"):
            out.append(e)
    return out


def install_activity_hook(settings_path: Path) -> bool:
    """Add the activity hooks to a Claude Code settings file (idempotent)."""
    cmd = shutil.which("mybrain-activity") or "mybrain-activity"
    try:
        settings = json.loads(settings_path.read_text(encoding="utf-8")) if settings_path.exists() else {}
    except ValueError:
        return False
    if not isinstance(settings, dict):
        return False
    hooks = settings.setdefault("hooks", {})
    if not isinstance(hooks, dict):
        return False
    hook = {"type": "command", "command": cmd, "timeout": 5}
    for event, matcher in (("PostToolUse", HOOK_MATCHER), ("Stop", None), ("SessionStart", None)):
        lst = hooks.get(event, [])
        if not isinstance(lst, list):
            return False
        lst = _strip(lst)
        entry = {"hooks": [hook]}
        if matcher:
            entry = {"matcher": matcher, **entry}
        lst.append(entry)
        hooks[event] = lst
    settings_path.parent.mkdir(parents=True, exist_ok=True)
    settings_path.write_text(json.dumps(settings, indent=2) + "\n", encoding="utf-8")
    return True


if __name__ == "__main__":
    main()
