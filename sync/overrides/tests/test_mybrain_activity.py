"""MyBrain: the live-activity hook (mybrain/activity.py)."""
import json
import subprocess

from mybrain import activity


def _repo(tmp_path):
    subprocess.run(["git", "init", "-q", str(tmp_path)], check=True)
    subprocess.run(["git", "-C", str(tmp_path), "remote", "add", "origin", "https://github.com/Someone/Thing.git"], check=True)
    (tmp_path / "src").mkdir()
    return tmp_path


def test_read_event_has_repo_relative_path_and_short_session(tmp_path):
    root = _repo(tmp_path)
    ev = activity.event_from_hook({
        "hook_event_name": "PostToolUse", "session_id": "abcdef1234567890xyz", "cwd": str(root / "src"),
        "tool_name": "Read", "tool_input": {"file_path": str(root / "src" / "a.py")},
    })
    assert ev == {"session": "abcdef123456", "repo": "Someone/Thing", "kind": "read", "path": "src/a.py"}


def test_edits_are_writes_and_commands_send_no_text(tmp_path):
    root = _repo(tmp_path)
    w = activity.event_from_hook({"hook_event_name": "PostToolUse", "session_id": "s", "cwd": str(root),
                                  "tool_name": "Edit", "tool_input": {"file_path": "src/a.py"}})
    assert w["kind"] == "write"
    run = activity.event_from_hook({"hook_event_name": "PostToolUse", "session_id": "s", "cwd": str(root),
                                    "tool_name": "Bash", "tool_input": {"command": "export SECRET=hunter2"}})
    assert run["kind"] == "run" and "hunter2" not in json.dumps(run)
    grep = activity.event_from_hook({"hook_event_name": "PostToolUse", "session_id": "s", "cwd": str(root),
                                     "tool_name": "Grep", "tool_input": {"pattern": "password=.*"}})
    assert grep["kind"] == "search" and "password" not in json.dumps(grep)
    assert activity.event_from_hook({"hook_event_name": "PostToolUse", "session_id": "s", "cwd": str(root),
                                     "tool_name": "WebFetch", "tool_input": {}}) is None


def test_tokens_are_summed_once_per_reply(tmp_path):
    t = tmp_path / "t.jsonl"
    u = {"input_tokens": 10, "output_tokens": 5, "cache_read_input_tokens": 100, "cache_creation_input_tokens": 1}
    lines = [
        {"message": {"role": "assistant", "id": "m1", "usage": u}},
        {"message": {"role": "assistant", "id": "m1", "usage": u}},   # same reply, second block
        {"message": {"role": "assistant", "id": "m2", "usage": u}},
        {"message": {"role": "user", "content": "hi"}},
    ]
    t.write_text("\n".join(json.dumps(x) for x in lines) + "\nnot json\n")
    assert activity.tokens_of(str(t)) == {"input": 20, "output": 10, "cache": 202}


def test_install_is_idempotent_and_keeps_other_hooks(tmp_path):
    s = tmp_path / "settings.json"
    s.write_text(json.dumps({"hooks": {"PostToolUse": [{"matcher": "Edit", "hooks": [{"type": "command", "command": "lint"}]}]},
                             "model": "x"}))
    assert activity.install_activity_hook(s)
    assert activity.install_activity_hook(s)
    d = json.loads(s.read_text())
    assert d["model"] == "x"
    post = d["hooks"]["PostToolUse"]
    assert [h["command"] for e in post for h in e["hooks"]].count("lint") == 1
    assert sum("mybrain-activity" in h["command"] for e in post for h in e["hooks"]) == 1
    assert len(d["hooks"]["Stop"]) == 1 and len(d["hooks"]["SessionStart"]) == 1


def test_off_switch_sends_nothing(monkeypatch, capsys):
    sent = []
    monkeypatch.setenv("MYBRAIN_ACTIVITY", "off")
    monkeypatch.setattr(activity, "send", lambda ev, timeout=4.0: sent.append(ev))
    monkeypatch.setattr("sys.stdin", __import__("io").StringIO('{"hook_event_name":"SessionStart","session_id":"s"}'))
    activity.main()
    assert sent == []
