// devtools.js
// Crée le panneau DevTools "Teamber Réseau"
(function() {
  try {
    // Firefox supporte l'API browser.*; Chrome/compatibilité: window.browser peut ne pas exister.
    const b = (typeof browser !== 'undefined') ? browser : (typeof chrome !== 'undefined' ? chrome : null);
    if (!b || !b.devtools || !b.devtools.panels) {
      console.error('[Teamber Réseau] API devtools.panels indisponible.');
      return;
    }

    b.devtools.panels.create(
      'Teamber Réseau',
      'icon48.png',
      'panel.html'
    ).then && b.devtools.panels.create(
      'Teamber Réseau',
      'icon48.png',
      'panel.html'
    ); // Firefox renvoie une Promise, Chrome un Panel. Cet appel double est toléré par Firefox, ignoré sinon.

  } catch (e) {
    console.error('[Teamber Réseau] Erreur création du panneau:', e);
  }
})();
