"""Per-language extractors, incrementally migrated out of mybrain/extract.py.

Dispatch still flows through mybrain.extract (the facade re-exports every
moved name), so importing from mybrain.extract keeps working unchanged.
LANGUAGE_EXTRACTORS is the registry seed; wiring dispatch through it is a
later, separate step. See MIGRATION.md for how to port another language.
"""
from __future__ import annotations

from pathlib import Path
from typing import Callable

from mybrain.extractors.apex import extract_apex
from mybrain.extractors.bash import extract_bash
from mybrain.extractors.blade import extract_blade
from mybrain.extractors.cobol import extract_cobol
from mybrain.extractors.commonlisp import extract_commonlisp
from mybrain.extractors.dart import extract_dart
from mybrain.extractors.dm import extract_dm, extract_dmf, extract_dmi, extract_dmm
from mybrain.extractors.elixir import extract_elixir
from mybrain.extractors.erlang import extract_erlang
from mybrain.extractors.fortran import extract_fortran
from mybrain.extractors.go import extract_go
from mybrain.extractors.json_config import extract_json
from mybrain.extractors.julia import extract_julia
from mybrain.extractors.markdown import extract_markdown
from mybrain.extractors.objc import extract_objc
from mybrain.extractors.pascal import extract_pascal
from mybrain.extractors.pascal_forms import extract_delphi_form, extract_lazarus_form
from mybrain.extractors.powershell import extract_powershell, extract_powershell_manifest
from mybrain.extractors.r import extract_r
from mybrain.extractors.razor import extract_razor
from mybrain.extractors.rust import extract_rust
from mybrain.extractors.sln import extract_sln
from mybrain.extractors.solidity import extract_solidity
from mybrain.extractors.sql import extract_sql
from mybrain.extractors.terraform import extract_terraform
from mybrain.extractors.verilog import extract_verilog
from mybrain.extractors.vbnet import extract_vbnet
from mybrain.extractors.zig import extract_zig

LANGUAGE_EXTRACTORS: dict[str, Callable[[Path], dict]] = {
    "apex": extract_apex,
    "bash": extract_bash,
    "blade": extract_blade,
    "cobol": extract_cobol,
    "commonlisp": extract_commonlisp,
    "dart": extract_dart,
    "delphi_form": extract_delphi_form,
    "dm": extract_dm,
    "dmf": extract_dmf,
    "dmi": extract_dmi,
    "dmm": extract_dmm,
    "elixir": extract_elixir,
    "erlang": extract_erlang,
    "fortran": extract_fortran,
    "go": extract_go,
    "json": extract_json,
    "julia": extract_julia,
    "lazarus_form": extract_lazarus_form,
    "markdown": extract_markdown,
    "objc": extract_objc,
    "pascal": extract_pascal,
    "powershell": extract_powershell,
    "powershell_manifest": extract_powershell_manifest,
    "r": extract_r,
    "razor": extract_razor,
    "rust": extract_rust,
    "sln": extract_sln,
    "solidity": extract_solidity,
    "sql": extract_sql,
    "terraform": extract_terraform,
    "verilog": extract_verilog,
    "vbnet": extract_vbnet,
    "zig": extract_zig,
}
