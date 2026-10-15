```bash
if [ ! -f mybrain-out/.mybrain_python ]; then
    MYBRAIN_BIN=$(which mybrain 2>/dev/null)
    if [ -n "$MYBRAIN_BIN" ]; then
        PYTHON=$(head -1 "$MYBRAIN_BIN" | tr -d '#!')
        case "$PYTHON" in *[!a-zA-Z0-9/_.@-]*) PYTHON="python3" ;; esac
    else
        PYTHON="python3"
    fi
    mkdir -p mybrain-out
    "$PYTHON" -c "import sys; open('mybrain-out/.mybrain_python', 'w', encoding='utf-8').write(sys.executable)"
fi
```
