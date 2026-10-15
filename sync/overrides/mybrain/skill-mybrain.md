---
name: mybrain
description: "MyBrain: map a codebase into a knowledge graph (neurons = files/functions/classes, synapses = calls/imports/uses, lobes = clusters) and answer questions from it. Use for /mybrain, for questions about a codebase's architecture or how parts connect, and whenever mybrain-out/graph.json exists. Free: code maps are built locally with no AI and no API key."
---

# /mybrain

MyBrain turns a folder of code into a living map: a **Brain Scan** report
(`mybrain-out/GRAPH_REPORT.md`), the data file (`mybrain-out/graph.json`) and an
interactive network view (`mybrain-out/graph.html`).

Words: **neuron** = a file, function, class or concept · **synapse** = a
connection (calls / imports / uses / references) · **lobe** = a cluster of
neurons that belong together · **core neurons** = the most connected ones.

## Usage

```
/mybrain                         # map the current folder (code only, free, no AI)
/mybrain <path>                  # map another folder
/mybrain https://github.com/o/r  # clone a GitHub repo and map it
/mybrain <path> --docs           # also read docs/PDF/images with a LOCAL Ollama (skipped if none)
/mybrain query "<question>"      # answer a question from the map
/mybrain path "A" "B"            # shortest chain of synapses from A to B
/mybrain explain "X"             # plain-language explanation of one neuron
/mybrain publish                 # send this map to the MyBrain web app (see below)
/mybrain add-ci                  # make this repo's map update itself on every push
```

## Rules

- Never use a paid AI API or ask for an API key. Code maps need no AI at all.
- Docs/PDF/images are optional and only ever go to a local Ollama. If Ollama is
  not reachable, say "docs skipped (no local Ollama)" and continue with code.
- The user may be on a phone: keep replies short, plain language, no walls of text.

## What to do

If invoked with `--help` or `-h` only, print the Usage block above and stop.

### Step 1 - make sure MyBrain is installed

```bash
command -v mybrain >/dev/null 2>&1 || uv tool install "git+https://github.com/Vicevinnybeats/MyBrain" \
  || pip install --user "git+https://github.com/Vicevinnybeats/MyBrain"
mybrain --version
```

### Step 2 - pick the job

- `query`, `path`, `explain` → go to **Questions** below.
- `publish` → go to **Publish** below.
- `add-ci` → go to **Add the workflow** below.
- A plain question about the code (not a command) and `mybrain-out/graph.json`
  already exists → go straight to **Questions** with `mybrain query "<question>"`.
- Otherwise → **Build a map**. No path means `.`.

### Build a map

1. GitHub URL: `TARGET=$(mybrain clone <url> | tail -1)` (add `--branch B` if
   given), otherwise `TARGET=<path or .>`.
2. Build the code map (free, local):
   ```bash
   mybrain update "$TARGET"
   ```
   If it says nothing was built (no previous map yet / no code found), run
   `mybrain extract "$TARGET" --code-only && mybrain cluster-only "$TARGET"`.
3. Only with `--docs`:
   ```bash
   if curl -sf "${OLLAMA_HOST:-http://localhost:11434}/api/tags" >/dev/null; then
     mybrain extract "$TARGET" --backend ollama && mybrain cluster-only "$TARGET"
   else
     echo "docs skipped (no local Ollama)"
   fi
   ```
4. Read `$TARGET/mybrain-out/GRAPH_REPORT.md` and reply in at most ~10 lines:
   - counts: neurons · synapses · lobes
   - the 3-5 core neurons and what they seem to do
   - one or two surprising connections, if any
   - where the files are: `mybrain-out/graph.html` (open in a browser),
     `GRAPH_REPORT.md`, `graph.json`
   - suggest `/mybrain publish` to see it in the MyBrain app on the phone.
5. If the target is a git repo, mention `mybrain-out/` can go in `.gitignore`.

### Questions

Run the matching command from the folder that has `mybrain-out/` (or pass
`--graph <path>/mybrain-out/graph.json`):

```bash
mybrain query "<question>"         # add --dfs to follow one path deeply
mybrain path "<A>" "<B>"
mybrain explain "<X>"
```

If a name is ambiguous, the candidates are listed: retry with
`"<file path>::<Name>"` (e.g. `"src/engine.h::SoundEngine"`) for the likely
one, or ask. No match → try a shorter or different name. `path` says "No
directed path found" → retry with `--undirected`. Answer in plain language
using only what the command returned; name the files involved.

### Publish

Sends the map to the user's MyBrain web app. The app is built from the
user's private `mybrain-maps` GitHub repository, so publishing = pushing the
map there. Build the map first if `mybrain-out/graph.json` is missing.

```bash
mybrain-publish "$TARGET"          # optional: --name <short-name>
```

- In a cloud session, git can only push to repositories attached to the
  session. If the push is refused, attach `Vicevinnybeats/mybrain-maps` with
  push access (the add_repo tool) and run it again.
- Success prints "pushed - the app updates in about a minute". Tell the user
  to open their MyBrain app and pull down to refresh.
- `mybrain-publish` missing → update MyBrain:
  `uv tool install --force "git+https://github.com/Vicevinnybeats/MyBrain"`.

### Add the workflow

Makes the current repository publish a fresh map on every push to main/master.

```bash
mkdir -p .github/workflows
curl -fsSL https://raw.githubusercontent.com/Vicevinnybeats/MyBrain/HEAD/ci/mybrain.yml \
  -o .github/workflows/mybrain.yml
```

Commit and push it (on the branch the user works on). Then tell the user the
one thing they must do themselves, once per repository:
"In GitHub open this repo → Settings → Secrets and variables → Actions →
New repository secret. Name: `MYBRAIN_MAPS_TOKEN`, value: your MyBrain maps
token." Never ask for the token in chat.
