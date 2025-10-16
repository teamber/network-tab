#!/usr/bin/env bash
set -euo pipefail
# Prepare a Chrome MV3 bundle (unpacked) and a ZIP for packaging
# Output: dist/chrome/ (folder) and dist/chrome.zip

ROOT_DIR="$(cd "$(dirname "$0")" && pwd)"
DIST_DIR="$ROOT_DIR/dist/chrome"

rm -rf "$DIST_DIR"
mkdir -p "$DIST_DIR"

# Use MV3 manifest for Chrome
cp -f "$ROOT_DIR/manifest.chrome.json" "$DIST_DIR/manifest.json"
cp -f "$ROOT_DIR/devtools.html" "$DIST_DIR/"
cp -f "$ROOT_DIR/devtools.js" "$DIST_DIR/"
cp -f "$ROOT_DIR/panel.html" "$DIST_DIR/"
cp -f "$ROOT_DIR/panel.js" "$DIST_DIR/"
cp -f "$ROOT_DIR/icon48.png" "$DIST_DIR/"

# Create a zip archive suitable for Load unpacked (after unzip) or Pack extension
(
  cd "$DIST_DIR/.."
  rm -f chrome.zip
  zip -qr chrome.zip chrome
)

echo "Chrome bundle prepared at: $DIST_DIR"
echo "Chrome ZIP created at: $DIST_DIR/../chrome.zip"

echo "To create a CRX, open chrome://extensions and use 'Pack extension' with: $DIST_DIR"
