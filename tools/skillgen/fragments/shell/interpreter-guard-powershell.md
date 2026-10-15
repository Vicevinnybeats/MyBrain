```powershell
if (-not (Test-Path mybrain-out\.mybrain_python)) {
    $MYBRAIN_PYTHON = $null
    $mybrainCmd = Get-Command mybrain -ErrorAction SilentlyContinue
    if ($mybrainCmd) {
        # The interpreter that owns the mybrain entry point sits next to it
        # (<env>\Scripts\python.exe for uv tool, pipx, and venv installs).
        $py = Join-Path (Split-Path $mybrainCmd.Source) "python.exe"
        if (Test-Path $py) { $MYBRAIN_PYTHON = $py }
    }
    if (-not $MYBRAIN_PYTHON) { $MYBRAIN_PYTHON = "python" }
    New-Item -ItemType Directory -Force -Path mybrain-out | Out-Null
    & $MYBRAIN_PYTHON -c "import sys; open('mybrain-out/.mybrain_python', 'w', encoding='utf-8').write(sys.executable)"
}
```
