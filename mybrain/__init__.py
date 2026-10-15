"""mybrain - extract · build · cluster · analyze · report."""


def __getattr__(name):
    # Lazy imports so `mybrain install` works before heavy deps are in place.
    _map = {
        "extract": ("mybrain.extract", "extract"),
        "collect_files": ("mybrain.extract", "collect_files"),
        "build_from_json": ("mybrain.build", "build_from_json"),
        "cluster": ("mybrain.cluster", "cluster"),
        "score_all": ("mybrain.cluster", "score_all"),
        "cohesion_score": ("mybrain.cluster", "cohesion_score"),
        "god_nodes": ("mybrain.analyze", "god_nodes"),
        "surprising_connections": ("mybrain.analyze", "surprising_connections"),
        "suggest_questions": ("mybrain.analyze", "suggest_questions"),
        "generate": ("mybrain.report", "generate"),
        "to_json": ("mybrain.export", "to_json"),
        "to_html": ("mybrain.export", "to_html"),
        "to_svg": ("mybrain.export", "to_svg"),
        "to_canvas": ("mybrain.export", "to_canvas"),
        "to_wiki": ("mybrain.wiki", "to_wiki"),
        "reflect": ("mybrain.reflect", "reflect"),
        "save_query_result": ("mybrain.ingest", "save_query_result"),
    }
    if name in _map:
        import importlib
        mod_name, attr = _map[name]
        mod = importlib.import_module(mod_name)
        return getattr(mod, attr)
    raise AttributeError(f"module 'mybrain' has no attribute {name!r}")
