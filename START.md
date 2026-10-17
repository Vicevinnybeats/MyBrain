# Start a session with MyBrain

Claude: do these steps now, in order, then tell me in one short line that
MyBrain is ready (or what failed).

1. If the `mybrain` command is missing, install it (free, no keys):
   `uv tool install --force "git+https://github.com/Vicevinnybeats/MyBrain" && mybrain install`
   (if `uv` is missing too: `curl -LsSf https://astral.sh/uv/install.sh | sh` first).
2. Read my personal context and follow it for the whole session:
   https://raw.githubusercontent.com/Vicevinnybeats/MyBrain/HEAD/CONTEXT.md
3. In the repository of this session: if `mybrain-out/graph.json` is missing,
   build the map with `mybrain update .` (local, free).
4. For the rest of the session, before exploring code, ask the map first
   (`mybrain query "..."`, `mybrain path "A" "B"`, `mybrain explain "X"`) and
   read only the files it points to.
