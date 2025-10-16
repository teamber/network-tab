#!/usr/bin/env bash
set -euo pipefail
# Build XPI for Firefox (Manifest V2)
# Output: dist/firefox/teamber-reseau.xpi

ROOT_DIR="$(cd "$(dirname "$0")" && pwd)"
DIST_DIR="$ROOT_DIR/dist/firefox"

rm -rf "$DIST_DIR"
mkdir -p "$DIST_DIR"

# Files to include
cp -f "$ROOT_DIR/manifest.json" "$DIST_DIR/manifest.json"
cp -f "$ROOT_DIR/devtools.html" "$DIST_DIR/"
cp -f "$ROOT_DIR/devtools.js" "$DIST_DIR/"
cp -f "$ROOT_DIR/panel.html" "$DIST_DIR/"
cp -f "$ROOT_DIR/panel.js" "$DIST_DIR/"
cp -f "$ROOT_DIR/icon48.png" "$DIST_DIR/"

# Create XPI (zip of files, not of the parent folder)
(
  cd "$DIST_DIR"
  zip -qr "teamber-reseau.xpi" manifest.json devtools.html devtools.js panel.html panel.js icon48.png
)

echo "Firefox XPI built at: $DIST_DIR/teamber-reseau.xpi"
