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
- **Windows:** download [`desktop/MyBrain.exe`](desktop/MyBrain.exe) and
  double-click it. It opens MyBrain in its own window (Edge or Chrome app
  mode). Right-click it → **Pin to taskbar**. Windows may say "unknown
  publisher" the first time: **More info → Run anyway**.
- **Desktop browser:** Chrome or Edge also show an **Install** icon in the
  address bar.
- It works offline for maps you've already opened.

**In a map:** the ⚡ button turns the firing-signal animation on or off. Tap
a neuron → **Path from here** → tap or search a second neuron to see the
shortest chain of synapses between them, like `mybrain path`.

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

### The + button (add a project from the app)

The **+** on the home screen maps any GitHub repo for you in 2–5 minutes.
It needs three one-time settings. All of them are made on the GitHub and
Cloudflare websites; never paste a token into a chat.

1. **Token for the + button.** github.com → Settings → Developer settings →
   Personal access tokens → **Fine-grained tokens** → Generate new token.
   Name it `MyBrain app`, then **Only select repositories** → `mybrain-maps`.
   Under Permissions → Repository permissions, set **Actions** to **Read and
   write**. Generate it and copy it.
2. **Give it to the app.** Cloudflare → Workers & Pages → `mybrain` →
   **Settings** → **Variables and Secrets** → **Add**. Type: **Secret**,
   name: `GITHUB_TOKEN`, value: the token. Save.
3. **Protect the + button.** Either turn on **Access** (see step 3 above), or
   add a second secret named `ADD_KEY` with a passphrase you make up. The
   app asks for it once per device.
4. **Optional, for private repos:** make a read-only token (Fine-grained,
   **All repositories**, **Contents: Read-only**) and add it in GitHub →
   `mybrain-maps` → Settings → Secrets and variables → Actions → New
   repository secret named `MYBRAIN_READ_TOKEN`. Public repos work without it.

### Send a map to the app

In Claude Code: `/mybrain publish`. In a terminal: `mybrain-publish .`

---

## Part 3: maps that update themselves

**Nothing to set up per repository.** Add a repo once with the **+** button
and it stays up to date by itself:

- Every hour, `mybrain-maps` asks GitHub for each remembered repo's latest
  commit (a quick check, no download).
- Only a repo with new commits is cloned, re-mapped (free, no AI) and
  republished. The app shows the new map a minute or two later.
- To refresh now: https://github.com/Vicevinnybeats/mybrain-maps/actions/workflows/refresh-maps.yml
  → **Run workflow**.
- **Private repos** need one read-only token, once, for all of them:
  `MYBRAIN_READ_TOKEN` (see the + button section). Public repos need nothing.
- To keep a folder out of a repo's map (for example `third_party/`), add a
  `.mybrainignore` file to that repo. It works like `.gitignore`.

**Optional: instant updates on every push.** If an hour is too slow for one
repo, add [`ci/mybrain.yml`](ci/mybrain.yml) to it as
`.github/workflows/mybrain.yml`, plus a `MYBRAIN_MAPS_TOKEN` secret (a
fine-grained token for `mybrain-maps` with **Contents: Read and write**).

---

## Does Claude use the brain automatically?

Yes, once the Setup script has run (it runs in every new cloud session).
`mybrain install` adds rules to Claude's global instructions: before
exploring a codebase, Claude builds the map if it's missing (`mybrain update .`,
free) and asks the map first (`query`, `path`, `explain`). It only reads the
files the map points to, which saves tokens. You don't have to type anything.
Type `/mybrain` when you want a summary or a fresh map on demand.

It also installs a small guard (like Graphify's): whenever Claude is about to
search or read files in a repo that has a map, it is reminded to ask the map
first and shown what the map already knows about that file or word. In a repo
without a map the guard stays silent.

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
