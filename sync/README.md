# Updating MyBrain from a newer Graphify

MyBrain's engine (`mybrain/`, `tests/`, `tools/`) is generated from Graphify's
open-source code by `sync/rebrand.py`. Don't edit those folders by hand: put
changes in `sync/rebrand.py` (as a patch) or in `sync/overrides/`, so they
survive the next update.

## The update, step by step (or ask Claude: "update MyBrain from Graphify")

```bash
git clone --depth 1 https://github.com/Graphify-Labs/graphify /tmp/graphify
python3 sync/rebrand.py /tmp/graphify       # copy, rename, patch, check
uv pip install -e ".[sql,pascal,terraform,ocaml,commonlisp,robot,vbnet,r,solidity]" pytest hypothesis
python -m pytest tests -q                   # run the tests
```

- **"PATCH DID NOT MATCH"** means Graphify changed code that MyBrain patches.
  Look at the new code and update that patch in `sync/rebrand.py`.
- **"leftover upstream references"** means new Graphify branding or cloud
  links appeared. Add a patch that removes them.
- Commit when the tests look like before (see below).

## What lives where

| Path | What it is |
|---|---|
| `sync/rebrand.py` | The copy, rename and patch script, and the list of every MyBrain change |
| `sync/overrides/` | MyBrain's own files, copied on top (the `/mybrain` skill, extra tests) |
| `sync/vendor/` | Bundled JavaScript (vis-network, d3, mermaid) and its licenses |
| `sync/NOTICE.mybrain` | Added to the end of `NOTICE` |
| `brand/` | Logo and app icons (`python3 brand/make_logo.py` redraws them) |

## Known test results

Last sync: Graphify commit `10130e79` (2026-10-14), version 0.9.91.
About 7,780 tests pass. These also fail on the original Graphify in a cloud
sandbox, so they are not MyBrain problems:

- `test_security.py` (7): need internet DNS.
- `test_skillgen.py` (11) and `test_languages.py::test_markdown_nested_frontmatter_survives` (1):
  already failing in Graphify itself.
