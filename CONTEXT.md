# Personal context for Claude

Read at the start of every Claude Code session (see `~/.claude/CLAUDE.md`).
This file is public: it holds no secrets, keys or private details.

## Who I am

- GitHub: **Vicevinnybeats** (Vinny).
- Music producer: riddim and dubstep. I work in **FL Studio**, design at
  **140 BPM**, and play most notes at **D#3** (FL Studio's naming).
- I mostly work from my **phone** in the Claude app (cloud sessions), and
  sometimes on a Windows PC.

## How to work with me

- **Plain language.** Short, phone-friendly updates. Screenshots help.
- **Never claim something works without testing it**, and say what the
  test was. If something could not be tested, say so.
- **Commit and push after each working step.**
- **Never ask me to paste a secret, token or password into the chat.** Tell
  me where to paste it (GitHub or Cloudflare settings) and give the link.
- For settings I must change myself, give **step-by-step instructions with
  direct links**.
- Ask before running a project's code for the first time.
- Prefer free tools. No paid AI or API keys unless I ask.

## My projects

| Repository | What it is |
|---|---|
| GNARL | A VST3 synth for riddim and dubstep (a Vital fork), with a web and phone app |
| MyBrain | This repo: maps my code as a "brain" so Claude reads less and costs less (a Graphify fork) |
| mybrain-maps | Private: the maps and the MyBrain app's hosting (Cloudflare Worker) |
| Cardly, Flexuur, AirDex, CuePoint, Vinny-editor | Other projects, mapped in MyBrain |

## MyBrain

- Every mapped repo has a map. In a repo with one, **ask the map first**
  (`mybrain query`, `mybrain path`, `mybrain explain`) before reading files.
  If the map is missing, build it with `mybrain update .` (free, local).
- The app: https://mybrain.vicevinnybeats.workers.dev (add a repo with +,
  delete with the bin). Health check: `/api/health`.
- The app's GitHub token expires **22 July 2027**: regenerate it and paste
  it into Cloudflare → Secrets Store → `GITHUB_TOKEN`.
