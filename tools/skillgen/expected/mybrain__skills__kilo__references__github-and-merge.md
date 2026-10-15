# mybrain reference: GitHub clone and cross-repo merge

Load this when the user passed one or more `https://github.com/...` URLs, or named several local subfolders to merge into one graph.

### Step 0 - Clone GitHub repo(s) (only if a GitHub URL was given)

**Single repo:**
```bash
LOCAL_PATH=$(mybrain clone <github-url> [--branch <branch>])
# Use LOCAL_PATH as the target for all subsequent steps
```

**Multiple repos (cross-repo graph):**
```bash
# Clone each repo, run the full pipeline on each, then merge
mybrain clone <url1>   # → ~/.mybrain/repos/<owner1>/<repo1>
mybrain clone <url2>   # → ~/.mybrain/repos/<owner2>/<repo2>
# Run /mybrain on each local path to produce their graph.json files
# Then merge:
mybrain merge-graphs \
  ~/.mybrain/repos/<owner1>/<repo1>/mybrain-out/graph.json \
  ~/.mybrain/repos/<owner2>/<repo2>/mybrain-out/graph.json \
  --out mybrain-out/cross-repo-graph.json
```

MyBrain clones into `~/.mybrain/repos/<owner>/<repo>` and reuses existing clones on repeat runs. Each node in the merged graph carries a `repo` attribute so you can filter by origin.

**Multiple local subfolders (monorepo or multi-service layout):**

The skill pipeline writes all intermediate and final outputs to `mybrain-out/` in the current working directory. Running the skill on each subfolder separately will clobber the same output dir. Instead, use the CLI directly for each subfolder — it places `mybrain-out/` *inside* the scanned path:

```bash
mybrain extract ./core/     # → ./core/mybrain-out/graph.json
mybrain extract ./service/  # → ./service/mybrain-out/graph.json
mybrain extract ./platform/ # → ./platform/mybrain-out/graph.json
# Add --backend gemini|kimi|openai|deepseek|claude-cli depending on which API key you have set

# Then merge at the project root:
mybrain merge-graphs \
  ./core/mybrain-out/graph.json \
  ./service/mybrain-out/graph.json \
  ./platform/mybrain-out/graph.json \
  --out mybrain-out/graph.json
```

Once `mybrain-out/graph.json` exists, the fast path above takes over: any codebase question runs `mybrain query` directly on the merged graph — no re-extraction, no size gate.
