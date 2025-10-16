// panel.js
// Panneau DevTools « Teamber Réseau »
// - Clone visuellement l'onglet Réseau de Firefox (liste + détails)
// - Ajoute un menu contextuel avec deux options de copie
// - getContent() best-effort uniquement à la demande lors de la copie

(function() {
  'use strict';

  const b = (typeof browser !== 'undefined') ? browser : (typeof chrome !== 'undefined' ? chrome : null);
  if (!b || !b.devtools) {
    console.error('[Teamber Réseau] API devtools indisponible.');
    return;
  }

  // Constantes de configuration
  const MAX_ROWS = 200;                 // Limite de la liste
  const MAX_BODY_CHARS = 4000;          // Troncature des bodies
  const GET_CONTENT_TIMEOUT_MS = 2000;  // Timeout best-effort pour getContent()

  // Etat
  const state = {
    entries: [],   // { id, url, method, status, timeString, durationMs, request, response, raw }
    selectedId: null,
    filter: '',
    sort: { key: null, dir: 'asc' } // key in ['status','method','file','size','url']
  };
  let idSeq = 1;

  // DOM refs
  const $rows = document.getElementById('rows');
  const $details = document.getElementById('details');
  const $filter = document.getElementById('filter');
  const $clearBtn = document.getElementById('clearBtn');
  const $ctxMenu = document.getElementById('ctxMenu');
  const $toast = document.getElementById('toast');
  const $thead = document.querySelector('thead');
  const $split = document.getElementById('split');
  const $rowResizer = document.getElementById('rowResizer');
  const $listSection = document.querySelector('.list-section');

  // Utils
  function cls(...names) { return names.filter(Boolean).join(' '); }

  function fmtTime(ms) { return `${Math.round(ms)} ms`; }

  function nowTimestamp() {
    try {
      const d = new Date();
      const y = d.getFullYear();
      const m = String(d.getMonth()+1).padStart(2,'0');
      const da = String(d.getDate()).padStart(2,'0');
      const h = String(d.getHours()).padStart(2,'0');
      const mi = String(d.getMinutes()).padStart(2,'0');
      const s = String(d.getSeconds()).padStart(2,'0');
      return `${y}-${m}-${da} ${h}:${mi}:${s}`;
    } catch { return new Date().toString(); }
  }

  function safeTruncate(str, maxLen) {
    if (str == null) return '';
    try {
      const s = String(str);
      if (s.length <= maxLen) return s;
      return s.slice(0, maxLen) + `\n\n… [tronqué, longueur totale: ${s.length} caractères]`;
    } catch (e) {
      console.warn('[Teamber Réseau] safeTruncate erreur:', e);
      return String(str).slice(0, maxLen);
    }
  }

  function headersArrayToMap(arr) {
    const map = Object.create(null);
    if (Array.isArray(arr)) {
      for (const h of arr) {
        if (!h || typeof h.name === 'undefined') continue;
        map[String(h.name).toLowerCase()] = h.value;
      }
    }
    return map;
  }

  function statusClass(code) {
    if (code >= 200 && code < 300) return 'ok';
    if (code >= 300 && code < 400) return 'warn';
    if (code >= 400) return 'err';
    return '';
  }

  function getFileFromUrl(url) {
    try {
      const u = new URL(url);
      const parts = u.pathname.split('/').filter(Boolean);
      const last = parts.length ? parts[parts.length - 1] : '';
      const q = u.search ? u.search.replace(/^\?/, '') : '';
      return last + (q ? ('?' + q) : '');
    } catch {
      // Fallback sans URL()
      const m = String(url||'').match(/\/([^\/?#]+)(\?[^#]*)?$/);
      if (!m) return String(url||'');
      const last = m[1] || '';
      const q = (m[2]||'').replace(/^\?/, '');
      return last + (q ? ('?' + q) : '');
    }
  }

  function formatSize(bytes) {
    const b = Number(bytes||0);
    if (!isFinite(b) || b <= 0) return '—';
    if (b < 1024) return b + ' B';
    const kb = b / 1024;
    if (kb < 1024) return kb.toFixed(kb < 10 ? 2 : 1) + ' KB';
    const mb = kb / 1024;
    return mb.toFixed(mb < 10 ? 2 : 1) + ' MB';
  }

  function getSizeFromResponse(resp) {
    if (!resp) return 0;
    const c = resp.content || {};
    return (typeof c.size === 'number' && c.size >= 0) ? c.size
      : (typeof resp.bodySize === 'number' ? resp.bodySize
      : (typeof resp._transferSize === 'number' ? resp._transferSize : 0));
  }

  function getInitiator(raw) {
    try {
      return (raw && (raw.cause && raw.cause.type)) || (raw && raw.initiator && raw.initiator.type) || (raw && raw._initiator && raw._initiator.type) || '—';
    } catch { return '—'; }
  }

  function extractToken(headersMap) {
    // Recherche dans Authorization, X-Access-Token, Token, X-Auth-Token
    const auth = headersMap['authorization'];
    const xAccess = headersMap['x-access-token'];
    const token = headersMap['token'];
    const xAuth = headersMap['x-auth-token'];

    let t = auth || xAccess || token || xAuth;
    if (!t) return null;

    // Authorization: Bearer <token> => ne garder que <token>
    if (auth) {
      const m = String(auth).match(/^Bearer\s+(.+)$/i);
      if (m) return m[1].trim();
    }
    return String(t).trim();
  }

  function showToast(text, ok=true) {
    $toast.textContent = text;
    $toast.style.display = 'block';
    $toast.style.background = ok ? '#1f2b1f' : '#2b1f1f';
    $toast.style.borderColor = ok ? '#315a31' : '#5a3131';
    setTimeout(() => { $toast.style.display = 'none'; }, 1800);
  }

  function closeCtxMenu() { $ctxMenu.style.display = 'none'; }

  function openCtxMenu(x, y) {
    // Positionner sans overflow écran
    const w = 240; const h = 90;
    const vw = window.innerWidth; const vh = window.innerHeight;
    const left = Math.min(x, vw - w - 8);
    const top = Math.min(y, vh - h - 8);
    $ctxMenu.style.left = left + 'px';
    $ctxMenu.style.top = top + 'px';
    $ctxMenu.style.display = 'block';
  }

  function clearSelection() {
    state.selectedId = null;
    renderRows();
    renderDetails();
  }

  // Efface l'historique (entrées) lors d'un rafraîchissement/navigation de la page
  function clearHistory(reason) {
    try {
      state.entries = [];
      clearSelection();
      renderRows();
      // Toast informatif (discret)
      if (reason) {
        showToast(`Historique effacé — ${reason}`, true);
      } else {
        showToast('Historique effacé', true);
      }
    } catch (e) {
      console.warn('[Teamber Réseau] clearHistory erreur:', e);
      // fallback minimal
      state.entries = [];
      state.selectedId = null;
      renderRows();
      renderDetails();
    }
  }

  function setFilter(val) {
    state.filter = String(val || '').trim().toLowerCase();
    renderRows();
  }

  function addEntryFromRaw(raw) {
    // Normaliser les champs depuis un HAR-like
    const req = raw && raw.request ? raw.request : raw._request || raw;
    const res = raw && raw.response ? raw.response : raw._response || {};

    const url = (req && (req.url || (req.headers && req.headers.Referer))) || '(inconnu)';
    const method = (req && req.method) || 'GET';
    const status = (res && (res.status || res.statusCode)) || 0;
    const timeMs = (typeof raw.time === 'number') ? raw.time : (raw._timings && raw._timings.time) || 0;
    const started = raw.startedDateTime ? new Date(raw.startedDateTime) : new Date();

    const entry = {
      id: idSeq++,
      url,
      method,
      status,
      timeString: started.toLocaleTimeString(),
      durationMs: Math.round(timeMs || 0),
      request: req || {},
      response: res || {},
      raw
    };

    state.entries.push(entry);
    if (state.entries.length > MAX_ROWS) state.entries.shift();
    renderRows();
  }

  function renderRows() {
    const f = state.filter;
    let base = !f ? state.entries.slice() : state.entries.filter(e => {
      return (e.url && e.url.toLowerCase().includes(f)) || (e.method && e.method.toLowerCase().includes(f));
    });
    // Afficher uniquement les entrées avec une taille définie (> 0)
    base = base.filter(e => getSizeFromResponse(e.response) > 0);

    // Partition: non-erreurs d'abord, erreurs (>=400) ensuite (toujours en bas)
    const nonErr = [];
    const errs = [];
    for (const e of base) {
      if ((e.status|0) >= 400) errs.push(e); else nonErr.push(e);
    }

    // Tri optionnel à l'intérieur de chaque groupe
    const hasSort = !!(state.sort && state.sort.key);
    function valByKey(e, key) {
      switch (key) {
        case 'status': return Number(e.status||0);
        case 'method': return String(e.method||'');
        case 'file': return String(getFileFromUrl(e.url||''));
        case 'size': return Number(getSizeFromResponse(e.response));
        case 'url': return String(e.url||'');
        default: return 0;
      }
    }
    function cmp(a, b) {
      if (!hasSort) return 0; // garder l'ordre d'insertion intra-groupe
      const dir = state.sort.dir === 'desc' ? -1 : 1;
      const va = valByKey(a, state.sort.key);
      const vb = valByKey(b, state.sort.key);
      if (typeof va === 'number' && typeof vb === 'number') return (va - vb) * dir;
      return String(va).localeCompare(String(vb)) * dir;
    }
    if (hasSort) {
      nonErr.sort(cmp);
      errs.sort(cmp);
    }

    const list = nonErr.concat(errs);

    $rows.innerHTML = '';
    for (const e of list) {
      const tr = document.createElement('tr');
      tr.dataset.id = String(e.id);
      tr.className = cls(e.id === state.selectedId && 'selected');

      const tdStatus = document.createElement('td');
      tdStatus.className = cls('col-status', statusClass(e.status|0));
      tdStatus.textContent = String(e.status || '');

      const tdMethod = document.createElement('td');
      tdMethod.className = 'col-method';
      tdMethod.textContent = e.method || '';

      const tdFile = document.createElement('td');
      tdFile.className = 'col-file';
      tdFile.textContent = getFileFromUrl(e.url || '');
      tdFile.title = e.url || '';

      const sizeBytes = getSizeFromResponse(e.response);
      const tdSize = document.createElement('td');
      tdSize.className = 'col-size';
      tdSize.textContent = formatSize(sizeBytes);

      tr.appendChild(tdStatus);
      tr.appendChild(tdMethod);
      tr.appendChild(tdFile);
      tr.appendChild(tdSize);

      tr.addEventListener('click', () => {
        state.selectedId = e.id;
        renderRows();
        renderDetails();
      });

      tr.addEventListener('contextmenu', (ev) => {
        ev.preventDefault();
        state.selectedId = e.id;
        renderRows();
        openCtxMenu(ev.clientX, ev.clientY);
      });

      $rows.appendChild(tr);
    }

    // Auto-scroll vers le bas pour la section liste (URL)
    if ($listSection) {
      $listSection.scrollTop = $listSection.scrollHeight;
    }
  }

  function detailsHeaderHtml(disabled) {
    const dis = disabled ? 'disabled' : '';
    return `<div class=\"section-header details-header\">\n      <div class=\"actions\">\n        <button id=\"btnCopy\" data-action=\"copy\" ${dis}>📋 Copier</button>\n        <button id=\"btnCopyToken\" data-action=\"copy-token\" ${dis}>🔐 Copier avec token</button>\n      </div>\n    </div>`;
  }

  function renderDetails() {
    const e = state.entries.find(x => x.id === state.selectedId);
    if (!e) {
      $details.innerHTML = detailsHeaderHtml(true) + '<div class=\"muted\" style=\"padding:8px\">Sélectionnez une requête pour voir les détails…</div>';
      return;
    }

    // Préparer headers pour affichage
    const reqHeaders = e.request && e.request.headers || [];
    const resHeaders = e.response && e.response.headers || [];

    const reqKv = (reqHeaders||[]).map(h => `<div>${escapeHtml(h.name || '')}</div><div class=\"code\">${escapeHtml(h.value || '')}</div>`).join('');
    const resKv = (resHeaders||[]).map(h => `<div>${escapeHtml(h.name || '')}</div><div class=\"code\">${escapeHtml(h.value || '')}</div>`).join('');

    // Corps requête (peut être volumineux, tronquer visuellement seulement)
    let payload = '';
    try {
      const pd = e.request && e.request.postData;
      const txt = pd && (pd.text || (pd.params && JSON.stringify(pd.params)));
      payload = safeTruncate(txt || '', MAX_BODY_CHARS);
    } catch (_) {}

    $details.innerHTML = `
      ${detailsHeaderHtml(false)}
      <div class=\"section\">
        <div class=\"detail-item\">
          <div class=\"detail-key\">URL</div>
          <pre class=\"code\">${escapeHtml(e.url || '')}</pre>
        </div>
        <div class=\"detail-item\">
          <div class=\"detail-key\">MÉTHODE</div>
          <pre class=\"code\">${escapeHtml(e.method || '')}</pre>
        </div>
        <div class=\"detail-item\">
          <div class=\"detail-key\">STATUT</div>
          <pre class=\"code\">${escapeHtml(String(e.status || ''))}</pre>
        </div>
        <div class=\"detail-item\">
          <div class=\"detail-key\">DURÉE</div>
          <pre class=\"code\">${escapeHtml(fmtTime(e.durationMs || 0))}</pre>
        </div>
        <div class=\"detail-item\">
          <div class=\"detail-key\">HEURE</div>
          <pre class=\"code\">${escapeHtml(e.timeString || '')}</pre>
        </div>
      </div>
      <div class=\"section\">
        <h3>Headers (Request)</h3>
        <div class=\"kv\">${reqKv || '<div class=\"muted\">(aucun)</div>'}</div>
      </div>
      <div class=\"section\">
        <h3>Headers (Response)</h3>
        <div class=\"kv\">${resKv || '<div class=\"muted\">(aucun)</div>'}</div>
      </div>
      <div class=\"section\">
        <h3>Payload</h3>
        <pre class=\"code\">${escapeHtml(payload || '')}</pre>
      </div>
    `;
  }

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g,'&amp;')
      .replace(/</g,'&lt;')
      .replace(/>/g,'&gt;')
      .replace(/"/g,'&quot;')
      .replace(/'/g,'&#039;');
  }

  async function ensureResponseBody(entry) {
    // Best-effort: ne pas récupérer à l'avance. Lors de la copie, tenter getContent().
    // Gère les implémentations basées callback (Chrome) et Promise (Firefox).
    const raw = entry.raw;
    if (!raw || typeof raw.getContent !== 'function') {
      return { text: null, encoding: null, error: 'no-getContent' };
    }

    function withTimeout(p, ms) {
      return new Promise((resolve) => {
        const t = setTimeout(() => resolve({ timeout: true }), ms);
        p.then(v => { clearTimeout(t); resolve(v); }, _ => { clearTimeout(t); resolve({ error: true }); });
      });
    }

    let result;
    try {
      // Tentative Promise
      const ret = raw.getContent();
      if (ret && typeof ret.then === 'function') {
        result = await withTimeout(ret, GET_CONTENT_TIMEOUT_MS);
        if (result && (result.content || result.text || typeof result === 'string')) {
          // Normaliser divers formats:
          if (typeof result === 'string') return { text: result, encoding: 'utf-8' };
          if (typeof result.text === 'string') return { text: result.text, encoding: result.encoding || 'utf-8' };
          if (typeof result.content === 'string') return { text: result.content, encoding: result.encoding || 'utf-8' };
        }
      }
    } catch (e) {
      // ignore, fallback callback
    }

    // Fallback callback-style
    const cbPromise = new Promise(resolve => {
      try {
        raw.getContent(function(body, encoding) {
          resolve({ text: body, encoding });
        });
      } catch (e) {
        resolve({ text: null, encoding: null, error: String(e) });
      }
    });

    result = await withTimeout(cbPromise, GET_CONTENT_TIMEOUT_MS);
    if (result && (result.text || result.text === '')) return result;

    return { text: null, encoding: null, error: 'timeout-or-error' };
  }

  async function buildCopiedText(entry, withToken) {
    // Assurer payload
    let payload = '';
    try {
      const pd = entry.request && entry.request.postData;
      payload = (pd && (pd.text || (pd.params && JSON.stringify(pd.params)))) || '';
    } catch {}

    payload = safeTruncate(payload, MAX_BODY_CHARS);

    // Assurer response body via getContent
    let responseText = '';
    try {
      const got = await ensureResponseBody(entry);
      if (got && typeof got.text === 'string') {
        responseText = got.text;
        // formatage JSON lisible si applicable
        try {
          if (responseText && responseText.trim().startsWith('{')) {
            responseText = JSON.stringify(JSON.parse(responseText), null, 2);
          }
        } catch {}
      } else if (got && got.timeout) {
        responseText = '<unable to read response: timeout>';
      } else {
        // fallback si déjà présent dans HAR
        const harText = entry.response && entry.response.content && entry.response.content.text;
        responseText = (harText != null) ? harText : '<unable to read response>';
      }
    } catch (e) {
      responseText = '<unable to read response>';
    }

    responseText = safeTruncate(responseText || '', MAX_BODY_CHARS);

    // Token seulement si demandé
    let tokenLine = '';
    if (withToken) {
      const headersMap = headersArrayToMap(entry.request && entry.request.headers || []);
      const token = extractToken(headersMap);
      tokenLine = `\n🔑 TOKEN: ${token ? token : '— Aucun —'}`;
    }

    const ts = nowTimestamp();
    const status = entry.status || 0;
    const duration = fmtTime(entry.durationMs || 0);
    const method = entry.method || '';
    const url = entry.url || '';

    // Construction du texte exactement comme demandé
    const parts = [];
    parts.push(`✨ Teamber • Copied at ${ts}`);
    parts.push('────────────────────────────────────────────');
    parts.push(`🔗 URL    : ${url}`);
    parts.push(`🚀 METHOD : ${method}    •    STATUS : ${status}    •    DURATION : ${duration}`);
    parts.push('────────────────────────────────────────────');
    if (withToken) {
      parts.push(`${tokenLine ? tokenLine.replace(/^\n/, '') : '— Aucun —'}`);
      parts.push('────────────────────────────────────────────');
    }
    parts.push('📦 PAYLOAD:');
    parts.push('```json');
    parts.push(payload || '');
    parts.push('```');
    parts.push('');
    parts.push('🧾 RESPONSE:');
    parts.push('```json');
    parts.push(responseText || '');
    parts.push('```');

    return parts.join('\n');
  }

  async function copyTextToClipboard(text) {
    // Clipboard moderne avec fallback
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(text);
        return true;
      }
    } catch (e) { /* fallback */ }

    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.focus();
      ta.select();
      const ok = document.execCommand('copy');
      document.body.removeChild(ta);
      return !!ok;
    } catch (e) {
      console.error('[Teamber Réseau] Clipboard fallback échec:', e);
      return false;
    }
  }

  async function handleCopy(withToken) {
    const entry = state.entries.find(x => x.id === state.selectedId);
    if (!entry) return;

    try {
      const text = await buildCopiedText(entry, withToken);
      const ok = await copyTextToClipboard(text);
      if (ok) showToast(withToken ? 'Teamber — Copié avec token ✓' : 'Teamber — Copié ✓', true);
      else showToast('Échec de la copie', false);
    } catch (e) {
      console.error('[Teamber Réseau] Erreur copie:', e);
      showToast('Échec de la copie', false);
    }
  }

  // Événements UI
  $filter.addEventListener('input', (e) => setFilter(e.target.value));
  $clearBtn.addEventListener('click', () => { state.entries = []; clearSelection(); renderRows(); });

  // Boutons dans l'en-tête DETAILS (event delegation)
  $details.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-action]');
    if (!btn) return;
    if (btn.disabled) return;
    const action = btn.dataset.action;
    if (action === 'copy') handleCopy(false);
    if (action === 'copy-token') handleCopy(true);
  });

  // Resizer vertical (entre URL et DETAILS)
  (function initRowResizer(){
    if (!$split || !$rowResizer) return;
    const STORAGE_KEY = 'teamber.split.ratio';
    let drag = null;
    function applyByRatio(ratio) {
      const rect = $split.getBoundingClientRect();
      if (!rect || rect.height <= 0) return;
      const minTop = 80; // px
      const minBottom = 120; // px (pour contenu details)
      const topPx = Math.max(minTop, Math.min(rect.height - minBottom, Math.round(rect.height * ratio)));
      $split.style.gridTemplateRows = `${topPx}px 6px 1fr`;
    }
    function restore() {
      const r = parseFloat(localStorage.getItem(STORAGE_KEY) || '0.56');
      if (isFinite(r) && r > 0 && r < 1) applyByRatio(r);
    }
    $rowResizer.addEventListener('mousedown', (ev) => {
      ev.preventDefault();
      const rect = $split.getBoundingClientRect();
      const topRect = $split.children[0].getBoundingClientRect();
      drag = { startY: ev.clientY, rectH: rect.height, topStart: topRect.height };
      document.body.style.userSelect = 'none';
    });
    window.addEventListener('mousemove', (ev) => {
      if (!drag) return;
      const dy = ev.clientY - drag.startY;
      const topPx = Math.max(80, Math.min(drag.rectH - 120, drag.topStart + dy));
      $split.style.gridTemplateRows = `${topPx}px 6px 1fr`;
      const ratio = topPx / drag.rectH;
      try { localStorage.setItem(STORAGE_KEY, String(ratio)); } catch {}
    });
    window.addEventListener('mouseup', () => {
      if (!drag) return;
      drag = null;
      document.body.style.userSelect = '';
    });
    window.addEventListener('resize', restore);
    // Initial
    restore();
  })();

  // Tri sur clic d'entêtes
  function toggleSort(key) {
    if (state.sort.key === key) {
      state.sort.dir = (state.sort.dir === 'asc') ? 'desc' : 'asc';
    } else {
      state.sort.key = key;
      state.sort.dir = 'asc';
    }
    renderRows();
  }
  if ($thead) {
    $thead.querySelectorAll('th.sortable').forEach(th => {
      th.addEventListener('click', () => toggleSort(th.dataset.col));
    });
  }

  document.addEventListener('click', (e) => {
    if (!$ctxMenu.contains(e.target)) closeCtxMenu();
  });
  document.addEventListener('contextmenu', (e) => {
    // clic droit dans un espace vide => fermer le menu
    if (!(e.target && (e.target.closest('tr')))) closeCtxMenu();
  });

  $ctxMenu.addEventListener('click', (e) => {
    const actionEl = e.target.closest('.ctx-item');
    if (!actionEl) return;
    const action = actionEl.dataset.action;
    closeCtxMenu();
    if (action === 'copy') handleCopy(false);
    if (action === 'copy-token') handleCopy(true);
  });

  // Écoute des requêtes réseau DevTools + nettoyage à la navigation/rafraîchissement
  try {
    // Nouvelles requêtes
    b.devtools.network.onRequestFinished.addListener((request) => {
      try {
        addEntryFromRaw(request); // On conserve l'objet raw pour getContent() plus tard
      } catch (e) {
        console.error('[Teamber Réseau] addEntryFromRaw error:', e);
      }
    });

    // Effacer l'historique quand la page est rechargée/naviguée
    if (b.devtools.network.onNavigated && typeof b.devtools.network.onNavigated.addListener === 'function') {
      b.devtools.network.onNavigated.addListener(() => clearHistory('rafraîchissement'));
    }
  } catch (e) {
    console.error('[Teamber Réseau] onRequestFinished/onNavigated indisponible:', e);
  }

  // Autre API de navigation (compat Chrome/Firefox): inspectedWindow.onNavigated
  try {
    if (b.devtools.inspectedWindow && b.devtools.inspectedWindow.onNavigated && typeof b.devtools.inspectedWindow.onNavigated.addListener === 'function') {
      b.devtools.inspectedWindow.onNavigated.addListener(() => clearHistory('rafraîchissement'));
    }
  } catch (e) {
    console.error('[Teamber Réseau] inspectedWindow.onNavigated indisponible:', e);
  }

  // Initial render
  renderRows();
  renderDetails();

  // Exposer quelques helpers pour debug dans la console du panneau
  window.__TeamberNetwork = {
    state,
    MAX_BODY_CHARS,
    safeTruncate,
    ensureResponseBody
  };

  /*
  README (limitations & installation rapides)
  - Cette extension fonctionne exclusivement en panneau DevTools (pas de menu global).
  - Le menu contextuel est un overlay DOM (impossible techniquement de modifier le menu natif de Firefox DevTools).
  - getContent() est best‑effort et n'est appelé qu'à la demande lors de la copie; il peut échouer ou être lent.
  - Les corps volumineux sont tronqués à MAX_BODY_CHARS pour éviter tout freeze de l'UI.
  - Add-on temporaire (manifest v2), à charger via about:debugging (This Firefox) → Load Temporary Add‑on → manifest.json.
  */

})();
