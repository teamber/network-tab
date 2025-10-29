# Teamber Réseau — Panneau DevTools (Firefox/Chrome)

Panneau DevTools qui clone l’onglet Réseau et ajoute des actions de copie modernes (avec ou sans token). Pensé pour un usage quotidien en debug: filtre, tri, menu contextuel, copie formatée, et détails complets.

## Installation (Chrome, permanent)
Chrome ne supporte plus Manifest V2 pour les extensions grand public. Le projet inclut un manifeste MV3 séparé pour Chrome.

1) Téléchargez `teamber-reseau-chrome.zip` à partir des releases et dézippez le.
2) Ouvrez `chrome://extensions`, activez « Mode développeur ».
3) Cliquez « Charger l'extension non empaquetée » (Load unpacked).
4) Sélectionnez le dossier `teamber-reseau-chrome`.

Remarque: `devtools_page` est supporté en MV3. Les permissions demandées sont minimales ("clipboardWrite"). Le code du panneau est compatible Chrome/Firefox grâce à la détection `browser`/`chrome`.

## Installtion (Firefox, permanent)
1. Assurez‑vous d’avoir `zip` disponible dans votre shell.
2. Exécutez:
    - macOS/Linux: `bash build-firefox.sh`
3. Le fichier est généré: `dist/firefox/teamber-reseau.xpi`
4. Installer:
    - via `about:debugging` → « Load Temporary Add‑on » → choisissez ce `.xpi` ou le `manifest.json` de `dist/firefox`.

Ce script zipe directement les fichiers (manifest.json, *.html, *.js, icônes) sans encapsuler un dossier supplémentaire — c’est requis par Firefox.

## Installation (Firefox, temporaire)
1. Ouvrez `about:debugging#/runtime/this-firefox` dans Firefox.
2. Cliquez « Load Temporary Add-on » et sélectionnez le fichier `manifest.json` de ce dossier (Manifest V2).
3. Ouvrez les DevTools (F12) puis l’onglet « Teamber Réseau ».

Note: Manifest V2, add-on temporaire non persisté au redémarrage (il faudra le recharger au prochain lancement de Firefox).

## Utilisation rapide
- Regénérez des requêtes (recharger la page) pour alimenter la liste.
- La liste (en haut) affiche 4 colonnes: ETAT | METHODE | FICHIER | Taille. Seule « FICHIER » s’adapte à la largeur, avec ellipsis.
- Tri: cliquer les en-têtes pour trier (asc/desc). Les erreurs (≥400) restent toujours en bas; le tri s’applique à l’intérieur des groupes.
- Filtre: champ en haut à gauche (url ou méthode). Bouton Clear pour vider la liste.
- Sélection: cliquez une ligne pour voir les détails (en bas). Les hauteurs sont redimensionnables via la barre entre les sections.
- Menu contextuel: clic droit sur une ligne → « Copier » ou « Copier avec token ».
- Boutons d’action: en haut de la section détails, boutons « 📋 Copier », « 🔐 Copier avec token », « 📦 Copier payload », « 🧾 Copier réponse ».
- Historique: vidé automatiquement à chaque rafraîchissement/navigation de l’onglet inspecté.
- Auto‑scroll: la liste défile automatiquement vers le bas pour afficher la dernière requête.

## Format de copie
Exemple exact (sortie copiée):

```
✨ Teamber • Copied at 2025-10-16 09:12:34
────────────────────────────────────────────
🔗 URL    : https://www.foo.fr
🚀 METHOD : POST    •    STATUS : 200    •    DURATION : 123 ms
────────────────────────────────────────────
🔑 TOKEN: <le_token_ici>   # (uniquement avec « Copier avec token »)
────────────────────────────────────────────
📦 PAYLOAD:
{ ...request body... }

🧾 RESPONSE:
{ ...response body (tronque si volumineux)... }
```

- Extraction de token best‑effort depuis les headers (priorité) : Authorization (Bearer <token> → on garde seulement <token>), X-Access-Token, Token, X-Auth-Token.
- Les corps volumineux sont tronqués (MAX_BODY_CHARS=4000) pour préserver la fluidité; mention de troncature ajoutée dans la copie « complète ».
- La récupération du body de réponse utilise `entry.raw.getContent()` à la demande (Promise ou callback), avec timeout best‑effort.
- Le bouton « 🧾 Copier réponse » copie la réponse entière (non tronquée), avec un délai d’attente plus long.

## Limitations
- Impossible de modifier le menu contextuel natif de Firefox DevTools: le menu affiché est un overlay DOM propre au panneau.
- `getContent()` peut échouer ou être lent selon la ressource (binaire, CORS, timings). Fallback: "<unable to read response>" ou contenu HAR si disponible.
- Les réponses binaires ou très grandes peuvent être lourdes à copier; l’aperçu UI reste tronqué pour préserver la fluidité.
- Add-on temporaire (Manifest V2) à recharger à chaque redémarrage de Firefox.

## Dépannage
- Archive « corrompue » (Firefox): avez‑vous zippé le contenu (fichiers) et non le dossier parent ? Le `manifest.json` doit se trouver à la racine du zip.
- Archive « corrompue » (Chrome): utilisez `dist/chrome` (MV3). Si vous empaquetez la racine (MV2), Chrome refusera.
- Rien n’apparaît ? Ouvrez d’abord l’onglet « Teamber Réseau », puis rechargez la page inspectée.
- La copie échoue ? Le panneau peut refuser `navigator.clipboard` selon contexte; un fallback via `execCommand('copy')` est utilisé.
- Pas de body de réponse ? Voir section limitations `getContent()`; attendez la fin de la requête, réessayez.

## Tests rapides
1) POST JSON avec Authorization Bearer
- Effectuer un POST avec `Authorization: Bearer abc.def.ghi`.
- Clic droit ou bouton → « Copier avec token » → le champ `🔑 TOKEN: abc.def.ghi` (sans "Bearer").

2) GET fichier statique
- GET d’un `.css`/`.png`. Entrées sans taille sont filtrées; seules celles avec taille > 0 s’affichent. La colonne FICHIER reste en une ligne, ellipsis si trop long.

3) Réponse volumineuse
- Endpoint renvoyant un gros JSON (> 4000 car.). L’aperçu est tronqué dans l’UI; le bouton « 🧾 Copier réponse » copie l’intégralité.

## Vie privée
- Aucune donnée n’est envoyée en dehors de votre navigateur. Les informations sont utilisées uniquement dans le panneau ouvert.

---

``## Erreurs d'installation fréquentes et solutions

### Chrome — « CRX_REQUIRED_PROOF_MISSING »
Cette erreur survient quand on essaie d’installer un fichier `.crx` qui ne provient pas du Chrome Web Store. Depuis plusieurs années, Chrome bloque l’installation hors‑store des CRX pour des raisons de sécurité.

Solutions:
- En développement: utilisez « Charger l’extension non empaquetée » (Load unpacked) et pointez sur le dossier `dist/chrome`. C’est la méthode recommandée.
- Pour distribuer en interne (entreprise): déployez via stratégie (policy) d’entreprise et hébergez le CRX+update.xml, ou publiez sur le Chrome Web Store. Le simple glisser‑déposer d’un `.crx` n’est plus autorisé.
- Option avancée: utilisez le bouton « Pack extension » de `chrome://extensions` pour générer votre CRX, mais son installation restera bloquée hors policy/Store.

### Firefox — « Le module complémentaire semble corrompu »
Cette erreur apparaît généralement quand:
- Le zip n’a pas la bonne structure (le `manifest.json` n’est pas à la racine de l’archive), ou
- L’XPI est non signé et vous tentez une installation permanente.

Solutions:
- Utilisation temporaire (recommandée pour le dev): ouvrez `about:debugging#/runtime/this-firefox` → « Load Temporary Add‑on » → choisissez `manifest.json` (ou `dist/firefox/teamber-reseau.xpi`).
- Si vous voulez installer de façon persistante: il faut signer l’extension via addons.mozilla.org (AMO) ou utiliser Firefox Developer Edition en désactivant la signature (`xpinstall.signatures.required=false`).
- Assurez‑vous que l’XPI est construit en zippant directement les fichiers (manifest, *.html, *.js, icônes) à la racine, sans dossier parent. Utilisez `bash build-firefox.sh` pour générer un XPI conforme.
``
