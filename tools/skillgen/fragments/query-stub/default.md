When `mybrain-out/graph.json` already exists and the user asks a question about the corpus, answer from the graph rather than rebuilding it:

```bash
mybrain query "<question>"
```

Before traversal, expand the question against the graph's own vocabulary so a wording mismatch does not collapse the answer to noise. If the `mybrain query` CLI is unavailable, fall back to an inline NetworkX traversal of `mybrain-out/graph.json`. Answer using only what the graph output contains, and quote `source_location` when citing a specific fact. For that vocab-expansion step, the BFS/DFS traversal modes, the `--budget` cap, the NetworkX fallback, `save-result` feedback, and the `/mybrain path` and `/mybrain explain` flows, see `references/query.md`.
