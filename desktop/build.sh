#!/bin/sh
# Rebuild MyBrain.exe (Windows launcher) from Linux/macOS with Go installed.
# Icon resource: rsrc_windows_amd64.syso (made from brand/icon-512.png with
#   convert ../brand/icon-512.png -define icon:auto-resize=256,128,64,48,32,16 mybrain.ico
#   go run github.com/akavel/rsrc@v0.10.2 -ico mybrain.ico -arch amd64 -o rsrc_windows_amd64.syso)
set -e
cd "$(dirname "$0")"
GOOS=windows GOARCH=amd64 CGO_ENABLED=0 go build -trimpath -ldflags "-s -w -H=windowsgui" -o MyBrain.exe .
