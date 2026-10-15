#!/bin/sh
# Builds the MyBrain web app with the maps in this repository.
# Uses the latest MyBrain app code from the public MyBrain repository.
set -e
rm -rf .mybrain dist
git clone --depth 1 "${MYBRAIN_REPO:-https://github.com/Vicevinnybeats/MyBrain}" .mybrain
python3 .mybrain/webapp/build.py --maps . --out dist
cp .mybrain/webapp/worker.js worker.js
