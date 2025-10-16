# Teamber Réseau — Panneau DevTools (Firefox)

Panneau DevTools qui clone l’onglet Réseau et ajoute des actions de copie modernes (avec ou sans token). Pensé pour un usage quotidien en debug: filtre, tri, menu contextuel, copie formatée, et détails complets.

## Installation (Firefox, temporaire)
1. Ouvrez `about:debugging#/runtime/this-firefox` dans Firefox.
2. Cliquez « Load Temporary Add-on » et sélectionnez le fichier `manifest.json` de ce dossier (Manifest V2).
3. Ouvrez les DevTools (F12) puis l’onglet « Teamber Réseau ».

Note: Manifest V2, add-on temporaire non persisté au redémarrage (il faudra le recharger au prochain lancement de Firefox).

## Installation (Chrome)
Chrome ne supporte plus Manifest V2 pour les extensions grand public. Si vous chargez ce projet tel quel, vous verrez l’erreur « Impossible d'installer l'extension, car elle utilise une version de fichier manifeste non compatible ». Pour Chrome, utilisez le manifest MV3 fourni.

Deux options:
- Développement (recommandé):
  1) Ouvrez `chrome://extensions`, activez « Mode développeur ».
  2) Cliquez « Charger l'extension non empaquetée » (Load unpacked).
  3) Sélectionnez le dossier du projet après avoir renommé/copier `manifest.chrome.json` → `manifest.json` (ou remplacez temporairement le fichier `manifest.json`).

- Empaquetage CRX:
  1) Dupliquez `manifest.chrome.json` en `manifest.json` dans un dossier de build (ou renommez directement dans une copie du projet).
  2) Zipez le dossier et empaquetez via `chrome://extensions` → « Pack extension ».

Remarque: `devtools_page` est supporté en MV3. Les permissions demandées sont minimales ("devtools", "clipboardWrite"). Le code du panneau est compatible Chrome/Firefox grâce à la détection `browser`/`chrome`. 

## Utilisation rapide
- Regénérez des requêtes (recharger la page) pour alimenter la liste.
- La liste (en haut) affiche 4 colonnes: ETAT | METHODE | FICHIER | Taille. Seule « FICHIER » s’adapte à la largeur, avec ellipsis.
- Tri: cliquer les en-têtes pour trier (asc/desc). Les erreurs (≥400) restent toujours en bas; le tri s’applique à l’intérieur des groupes.
- Filtre: champ en haut à gauche (url ou méthode). Bouton Clear pour vider la liste.
- Sélection: cliquez une ligne pour voir les détails (en bas). Les hauteurs sont redimensionnables via la barre entre les sections.
- Menu contextuel: clic droit sur une ligne → « Copier » ou « Copier avec token ».
- Boutons d’action: en haut de la section détails, boutons « 📋 Copier » et « 🔐 Copier avec token » (équivalent au menu).
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
- Les corps volumineux sont tronqués (MAX_BODY_CHARS=4000) pour préserver la fluidité; mention de troncature ajoutée.
- La récupération du body de réponse utilise `entry.raw.getContent()` à la demande (Promise ou callback), avec timeout best‑effort.

## Limitations
- Impossible de modifier le menu contextuel natif de Firefox DevTools: le menu affiché est un overlay DOM propre au panneau.
- `getContent()` peut échouer ou être lent selon la ressource (binaire, CORS, timings). Fallback: "<unable to read response>" ou contenu HAR si disponible.
- Les réponses binaires ou très grandes sont présentées tronquées/vides dans la copie.
- Add-on temporaire (Manifest V2) à recharger à chaque redémarrage du navigateur.

## Dépannage
- Rien n’apparaît ? Ouvrez d’abord l’onglet « Teamber Réseau », puis rechargez la page inspectée.
- La copie échoue ? Le panneau peut refuser `navigator.clipboard` selon contexte; un fallback via `execCommand('copy')` est utilisé.
- Pas de body de réponse ? Voir section limitations `getContent()`; essayez d’attendre que la requête soit complète puis relancer la copie.

## Tests rapides
1) POST JSON avec Authorization Bearer
- Effectuer un POST avec `Authorization: Bearer abc.def.ghi`.
- Clic droit ou bouton → « Copier avec token » → le champ `🔑 TOKEN: abc.def.ghi` (sans "Bearer").

2) GET fichier statique
- GET d’un `.css`/`.png`. Entrées sans taille sont filtrées; seules celles avec taille > 0 s’affichent. La colonne FICHIER reste en une ligne, ellipsis si trop long.

3) Réponse volumineuse
- Endpoint renvoyant un gros JSON (> 4000 car.). Le texte copié est tronqué proprement avec mention de la longueur totale.

## Vie privée
- Aucune donnée n’est envoyée en dehors de votre navigateur. Les informations sont utilisées uniquement dans le panneau ouvert.
