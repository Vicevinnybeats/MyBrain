---
trigger: always_on
description: Consult the mybrain knowledge graph at mybrain-out/ for codebase and architecture questions.
---

## mybrain

This project has a mybrain knowledge graph at mybrain-out/.

Rules:
- For codebase or architecture questions, when `mybrain-out/graph.json` exists, first run `mybrain query "<question>"` (CLI) or `query_graph` (MCP). Use `mybrain path "<A>" "<B>"` / `shortest_path` for relationships and `mybrain explain "<concept>"` / `get_node` for focused concepts. These return a scoped subgraph, usually much smaller than `GRAPH_REPORT.md` or raw grep output.
- If mybrain-out/wiki/index.md exists, navigate it instead of reading raw files
- Read mybrain-out/GRAPH_REPORT.md only for broad architecture review or when query/path/explain do not surface enough context
- After modifying code files in this session, run `mybrain update .` to keep the graph current (AST-only, no API cost)
