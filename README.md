<p align="center"><img src="brand/icon-192.png" width="96" alt="MyBrain logo"></p>

# MyBrain

**Your code, as a living map.** MyBrain reads a project folder and draws it as
a brain:

- **Neurons**: every file, function, class and concept.
- **Synapses**: every "calls / imports / uses / references" between them.
- **Lobes**: groups of neurons that belong together (each has its own colour).
- **Core neurons**: the most connected ones, the heart of the project.

Each map gives you three files in a `mybrain-out/` folder:

| File | What it is |
|---|---|
| `graph.html` | The interactive network: drag, zoom, search, tap a neuron |
| `GRAPH_REPORT.md` | The **Brain Scan**: a short written summary |
| `graph.json` | The raw map data |

It's **free**. Code maps are built on the computer itself, with no AI and no API
key. Docs, PDFs and images are optional, and only go to a free
[Ollama](https://ollama.com) running on your own PC.

MyBrain is based on the open-source project Graphify (Apache-2.0). See
[NOTICE](NOTICE) for what was changed.

---

## Use it in Claude Code (phone or desktop)

Type in any session:

```
/mybrain                         map this project
/mybrain https://github.com/you/repo   map another repo
/mybrain query "how does login work?"
/mybrain path "LoginPage" "Database"
/mybrain explain "SoundEngine"
```

### One-time setup for cloud sessions (phone and claude.ai/code)

1. Open a session, tap the **environment name** in the title bar, then **Edit**.
2. Paste this into **Setup script** and save:

   ```bash
   uv tool install --force "git+https://github.com/Vicevinnybeats/MyBrain" && mybrain install
   ```

3. Every new session now has `/mybrain` ready.

### Desktop (your own computer)

Install [uv](https://docs.astral.sh/uv/) once, then run the same line in a
terminal:

```bash
uv tool install --force "git+https://github.com/Vicevinnybeats/MyBrain" && mybrain install
```

### Without Claude (terminal)

```bash
mybrain update .            # build or refresh the map of this folder (free)
mybrain query "question"
mybrain path "A" "B"
mybrain explain "X"
```

Tip: to keep libraries you didn't write (for example `third_party/`) out of
the map, list them in a `.mybrainignore` file. It works like `.gitignore`.

---

## Docs, PDFs and images (optional)

Only with Ollama on your own PC. Install it, run `ollama pull qwen2.5-coder:7b`, then:

```
/mybrain . --docs
```

If Ollama isn't running, MyBrain skips docs and still maps the code. It never
uses a paid AI on its own.

---

## For the curious: how MyBrain stays in sync with Graphify

See [sync/README.md](sync/README.md).
