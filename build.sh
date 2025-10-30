
#!/bin/bash

set -e

echo "🔨 Compilation Teamber Réseau..."
echo ""

# Créer le dossier dist s'il n'existe pas
mkdir -p dist

# ============================================================================
# CHROME (Manifest V3)
# ============================================================================
echo "📦 Compilation pour Chrome (Manifest V3)..."

CHROME_DIST="dist/chrome"
rm -rf "$CHROME_DIST"
mkdir -p "$CHROME_DIST"

# Copier tous les fichiers
cp manifest.chrome.json "$CHROME_DIST/manifest.json"
cp devtools.html "$CHROME_DIST/"
cp devtools.js "$CHROME_DIST/"
cp panel.html "$CHROME_DIST/"
cp panel.js "$CHROME_DIST/"
cp background-chrome.js "$CHROME_DIST/background.js"
cp icon48.png "$CHROME_DIST/"

echo "✅ Chrome compilé dans: $CHROME_DIST (Manifest V3)"
echo ""

# ============================================================================
# FIREFOX (Manifest V2)
# ============================================================================
echo "📦 Compilation pour Firefox (Manifest V2)..."

FIREFOX_DIST="dist/firefox"
rm -rf "$FIREFOX_DIST"
mkdir -p "$FIREFOX_DIST"

# Copier tous les fichiers
cp manifest.json "$FIREFOX_DIST/"
cp devtools.html "$FIREFOX_DIST/"
cp devtools.js "$FIREFOX_DIST/"
cp panel.html "$FIREFOX_DIST/"
cp panel.js "$FIREFOX_DIST/"
cp background.js "$FIREFOX_DIST/"
cp icon48.png "$FIREFOX_DIST/"

# Créer l'XPI (zip) pour Firefox
if command -v zip &> /dev/null; then
  cd "$FIREFOX_DIST"
  zip -r teamber-reseau.xpi manifest.json devtools.html devtools.js panel.html panel.js background.js icon48.png > /dev/null 2>&1
  cd - > /dev/null
  echo "✅ Firefox compilé dans: $FIREFOX_DIST (Manifest V2)"
  echo "   XPI généré: $FIREFOX_DIST/teamber-reseau.xpi"
else
  echo "⚠️  zip non trouvé - XPI non généré"
  echo "✅ Firefox compilé dans: $FIREFOX_DIST (fichiers sources)"
fi

echo ""
echo "🎉 Compilation terminée !"
echo ""
echo "📋 Prochaines étapes:"
echo ""
echo "📍 CHROME (Manifest V3):"
echo "   1. Allez sur chrome://extensions"
echo "   2. Activez 'Mode développeur'"
echo "   3. Cliquez 'Charger l'extension non empaquetée'"
echo "   4. Sélectionnez: $CHROME_DIST"
echo ""
echo "📍 FIREFOX (Manifest V2):"
echo "   1. Allez sur about:debugging#/runtime/this-firefox"
echo "   2. Cliquez 'Load Temporary Add-on'"
if command -v zip &> /dev/null; then
  echo "   3. Sélectionnez: $FIREFOX_DIST/teamber-reseau.xpi"
else
  echo "   3. Sélectionnez: $FIREFOX_DIST/manifest.json"
fi
echo ""
echo "💡 Après rechargement, fermez et rouvrez les DevTools (F12) !"
echo ""
