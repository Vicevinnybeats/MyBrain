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

## The MyBrain app (phone and desktop)

The app is a website that lists all your maps. Tap one to open it as a living
network: pinch to zoom, drag with one finger, tap a neuron for its synapses
and **Explain**, search from the top bar, filter **Lobes**, and read the
**Brain Scan**. To move a neuron on a phone, touch and hold it, then drag.

- **Phone:** open the app link in Safari or Chrome, then use **Share → Add to
  Home Screen** (iPhone) or **⋮ → Install app** (Android).
- **Desktop:** Chrome or Edge show an **Install** icon in the address bar.
- It works offline for maps you've already opened.

### One-time hosting setup (free, about 10 minutes)

The app runs on Cloudflare (free) and reads your maps from a **private** GitHub
repository called `mybrain-maps`. Only you can open it: Cloudflare emails you a
login code.

1. **Create the maps repo.** github.com/new, name `mybrain-maps`, choose
   **Private**, tick **Add a README file**, then **Create**. Ask Claude in a
   MyBrain session to "set up mybrain-maps", and it adds the starter files.
2. **Connect Cloudflare.** dash.cloudflare.com → **Workers & Pages** →
   **Create application** → **Import a repository** → connect GitHub and pick
   `mybrain-maps`. Set **Build command** to `sh build.sh` and leave
   **Deploy command** as `npx wrangler deploy`. Then **Deploy**.
3. **Lock it to you.** Open the new `mybrain` Worker → **Access** tab →
   **Protect this Worker behind Access** → **All traffic** → allow your
   **email address** → **Apply Access**.
4. Open the link Cloudflare shows (`https://mybrain.<you>.workers.dev`), enter
   your email, then type the code you receive. Done!

You never paste passwords or tokens into a chat: all of this happens on the
Cloudflare and GitHub websites.

### Send a map to the app

In Claude Code: `/mybrain publish`. In a terminal: `mybrain-publish .`

---

## Part 3: maps that update themselves

Add the MyBrain workflow to any repository and its map refreshes on every
push (free, code only).

**Add it:** in a Claude Code session on that repo, type `/mybrain add-ci`.
Or, from the repo folder on your computer, run this one line:

```bash
mkdir -p .github/workflows && curl -fsSL https://raw.githubusercontent.com/Vicevinnybeats/MyBrain/HEAD/ci/mybrain.yml -o .github/workflows/mybrain.yml
```

Then commit and push.

**Give it permission (once per repo):** the workflow needs a token that can
write to `mybrain-maps`.

1. Make the token once: github.com → **Settings** → **Developer settings** →
   **Personal access tokens** → **Fine-grained tokens** → **Generate new token**.
   Name it `MyBrain maps`, choose **Only select repositories** → `mybrain-maps`,
   and under **Permissions** set **Contents** to **Read and write**. Copy the
   token into your password manager.
2. In each repo: **Settings** → **Secrets and variables** → **Actions** →
   **New repository secret**. Name it `MYBRAIN_MAPS_TOKEN` and paste the token.

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
