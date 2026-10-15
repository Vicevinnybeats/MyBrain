"""MyBrain policy: never pick a paid AI (or the Claude CLI) on its own."""
from mybrain import llm


def test_paid_keys_are_ignored_by_default(monkeypatch):
    monkeypatch.delenv("MYBRAIN_ALLOW_PAID_AUTODETECT", raising=False)
    monkeypatch.setattr(llm, "_PAID_AUTODETECT_DEFAULT", "0")
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-test")
    monkeypatch.setenv("GEMINI_API_KEY", "x")
    monkeypatch.setenv("OPENAI_API_KEY", "x")
    assert llm.detect_backend() is None


def test_local_ollama_is_the_only_auto_backend(monkeypatch):
    monkeypatch.delenv("MYBRAIN_ALLOW_PAID_AUTODETECT", raising=False)
    monkeypatch.setattr(llm, "_PAID_AUTODETECT_DEFAULT", "0")
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-test")
    monkeypatch.setenv("OLLAMA_BASE_URL", "http://localhost:11434/v1")
    assert llm.detect_backend() == "ollama"


def test_claude_cli_is_not_used_for_lobe_names(monkeypatch):
    monkeypatch.delenv("MYBRAIN_ALLOW_PAID_AUTODETECT", raising=False)
    monkeypatch.setattr(llm, "_PAID_AUTODETECT_DEFAULT", "0")
    monkeypatch.setattr(llm, "_claude_cli_available", lambda: True)

    def boom(*a, **k):
        raise AssertionError("an LLM was called")

    monkeypatch.setattr(llm, "label_communities", boom)
    import networkx as nx
    G = nx.Graph()
    G.add_edge("a", "b")
    labels, source = llm.generate_community_labels(G, {0: ["a", "b"]}, quiet=True)
    assert source == "placeholder"


def test_graph_html_has_no_outside_scripts(tmp_path):
    import networkx as nx
    from mybrain.cluster import cluster
    from mybrain.export import to_html
    G = nx.Graph()
    G.add_node("a", label="a", source_file="a.py", file_type="code")
    G.add_node("b", label="b", source_file="b.py", file_type="code")
    G.add_edge("a", "b", relation="calls", confidence="EXTRACTED")
    out = tmp_path / "graph.html"
    to_html(G, cluster(G), str(out))
    html = out.read_text(encoding="utf-8")
    assert '<script src="http' not in html
    assert "MyBrain - " in html
