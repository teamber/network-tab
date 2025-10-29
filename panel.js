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

  // Détermine si la requête est de type XHR/fetch (à exclure de l'affichage des "vrais" appels)
  function isXhrOrFetch(raw) {
    try {
      const t = (raw && raw.cause && raw.cause.type)
        || (raw && raw.initiator && raw.initiator.type)
        || (raw && raw._initiator && raw._initiator.type)
        || '';
      const type = String(t || '').toLowerCase();
      return type === 'xhr' || type === 'xmlhttprequest' || type === 'fetch';
    } catch {
      return false;
    }
  }

  // Renvoie true si la chaîne est un JSON non vide parsable ({ ... } ou [ ... ])
  function hasParsableJson(str) {
    try {
      const t = String(str == null ? '' : str).trim();
      if (!t) return false;
      const first = t[0];
      if (first !== '{' && first !== '[') return false;
      JSON.parse(t);
      return true;
    } catch { return false; }
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
    $toast.style.background = ok ? '#3fb950' : '#f85149';
    $toast.style.color = '#0d1117';
    setTimeout(() => { $toast.style.display = 'none'; }, 2000);
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
    // Filtrer: supprimer les XHR/fetch pour n'afficher que les "vrais" appels (documents/ressources)
    base = base.filter(e => !isXhrOrFetch(e.raw));

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
    return `<div class="section-header details-header">
      <div class="copy-options">
        <div class="checkbox-wrapper">
          <input type="checkbox" id="chkToken" ${disabled ? 'disabled' : ''}>
          <label for="chkToken">Token</label>
        </div>
        <div class="checkbox-wrapper">
          <input type="checkbox" id="chkPayload" ${disabled ? 'disabled' : ''} checked>
          <label for="chkPayload">Payload</label>
        </div>
        <div class="checkbox-wrapper">
          <input type="checkbox" id="chkResponse" ${disabled ? 'disabled' : ''} checked>
          <label for="chkResponse">Réponse</label>
        </div>
        <button id="btnCopyCustom" class="copy-btn" ${dis}>Copier</button>
      </div>
    </div>`;
  }

  function renderDetails() {
    const e = state.entries.find(x => x.id === state.selectedId);
    if (!e) {
      $details.innerHTML = detailsHeaderHtml(true) + '<div class=\"muted\" style=\"padding:12px 14px\">Sélectionnez une requête pour voir les détails…</div>';
      return;
    }

    // Préparer headers pour affichage
    const reqHeaders = e.request && e.request.headers || [];
    const resHeaders = e.response && e.response.headers || [];

    const reqKv = (reqHeaders||[]).map(h => `<div>${escapeHtml(h.name || '')}</div><div class=\"code\">${escapeHtml(h.value || '')}</div>`).join('');
    const resKv = (resHeaders||[]).map(h => `<div>${escapeHtml(h.name || '')}</div><div class=\"code\">${escapeHtml(h.value || '')}</div>`).join('');

    // Préparer contenu Payload/Response (préttifié JSON + surlignage), sans appel getContent() automatique
    let payloadRaw = '';
    try {
      const pd = e.request && e.request.postData;
      payloadRaw = (pd && (pd.text || (pd.params && JSON.stringify(pd.params)))) || '';
    } catch (_) {}
    const hasPayloadJson = hasParsableJson(payloadRaw);
    const payloadPretty = hasPayloadJson ? prettyMaybeJson(payloadRaw) : '';
    const payloadHtml = hasPayloadJson ? highlightJson(safeTruncate(payloadPretty || '', MAX_BODY_CHARS)) : '<div class="muted">(aucun JSON)</div>';

    const respRaw = (e.response && e.response.content && e.response.content.text);
    const hasRespJson = hasParsableJson(respRaw);
    const responsePretty = hasRespJson ? prettyMaybeJson(respRaw) : '';
    const responseHtml = hasRespJson ? highlightJson(safeTruncate(responsePretty || '', MAX_BODY_CHARS)) : '<div class="muted">(aucun JSON)</div>';

    // Extraire juste le pathname de l'URL
    let pathname = '';
    try {
      const urlObj = new URL(e.url);
      pathname = urlObj.pathname + urlObj.search;
    } catch {
      pathname = e.url || '';
    }

    const statusClass = (code) => {
      if (code >= 200 && code < 300) return 'ok';
      if (code >= 300 && code < 400) return 'warn';
      if (code >= 400) return 'err';
      return '';
    };

    $details.innerHTML = `
      ${detailsHeaderHtml(false)}
      <div class=\"details-content\">
        <div class=\"request-summary\">
          <span class=\"request-summary-url\">${escapeHtml(pathname)}</span>
          <span class=\"request-summary-method\">${escapeHtml(e.method || '')}</span>
          <span class=\"request-summary-status ${statusClass(e.status)}\">${escapeHtml(String(e.status || ''))}</span>
          <span class=\"request-summary-duration\">${escapeHtml(fmtTime(e.durationMs || 0))}</span>
        </div>

        <div class=\"section\">
          <div class=\"section-title-wrapper\">
            <h3>Payload</h3>
            <button class=\"section-copy-btn\" id=\"btnCopyPayloadInline\" ${hasPayloadJson ? '' : 'disabled'}>📋 Copier</button>
          </div>
          <pre class=\"code json\">${payloadHtml}</pre>
        </div>

        <div class=\"section\">
          <div class=\"section-title-wrapper\">
            <h3>Response</h3>
            <button class=\"section-copy-btn\" id=\"btnCopyResponseInline\" ${hasRespJson ? '' : 'disabled'}>📋 Copier</button>
          </div>
          <pre id=\"respPre\" class=\"code json\">${responseHtml}</pre>
        </div>

        <div class=\"section\">
          <div class=\"section-title-wrapper\">
            <h3>Headers (Request)</h3>
          </div>
          <div class=\"code\">
            ${reqKv ? `<div class=\"kv\">${reqKv}</div>` : '<div class=\"muted\">(aucun)</div>'}
          </div>
        </div>

        <div class=\"section\">
          <div class=\"section-title-wrapper\">
            <h3>Headers (Response)</h3>
          </div>
          <div class=\"code\">
            ${resKv ? `<div class=\"kv\">${resKv}</div>` : '<div class=\"muted\">(aucun)</div>'}
          </div>
        </div>
      </div>
    `;

    // Lazy load de la réponse pour l'aperçu dans la section détails
    (async () => {
      try {
        const currentId = e.id;
        const target = document.getElementById('respPre');
        const btnInline = document.getElementById('btnCopyResponseInline');
        if (!target) return;
        const got = await ensureResponseBody(e, { timeoutMs: 3000 });
        if (state.selectedId !== currentId) return; // la sélection a changé entre-temps
        if (got && typeof got.text === 'string') {
          let text = got.text;
          if (hasParsableJson(text)) {
            try { text = JSON.stringify(JSON.parse(String(text).trim()), null, 2); } catch {}
            target.innerHTML = highlightJson(safeTruncate(text || '', MAX_BODY_CHARS));
            if (btnInline) btnInline.disabled = false;
          } else {
            target.innerHTML = '<div class="muted">(aucun JSON)</div>';
            if (btnInline) btnInline.disabled = true;
          }
        }
      } catch (err) {
        // silencieux; l'aperçu initial restera basé sur HAR si disponible
      }
    })();
  }

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g,'&amp;')
      .replace(/</g,'&lt;')
      .replace(/>/g,'&gt;')
      .replace(/"/g,'&quot;')
      .replace(/'/g,'&#039;');
  }

  function prettyMaybeJson(text) {
    try {
      if (!text) return '';
      const t = String(text).trim();
      if (!t) return '';
      if (t.startsWith('{') || t.startsWith('[')) {
        return JSON.stringify(JSON.parse(t), null, 2);
      }
      return t;
    } catch { return String(text); }
  }

  // Minimal JSON highlighter: escapes HTML then wraps tokens with span classes
  function highlightJson(input) {
    try {
      const jsonStr = typeof input === 'string' ? input : JSON.stringify(input, null, 2);
      const esc = escapeHtml(jsonStr);
      return esc
        // Keys
        .replace(/(&quot;)([^\n\r\t\f\v\"]*?)(&quot;\s*:)/g, (_m, p1, key, p3) => `<span class="json-string">&quot;</span><span class="json-key">${key}</span><span class="json-string">&quot;</span><span class="json-key">:</span>`)
        // Strings (values)
        .replace(/&quot;([^\n\r\t\f\v\"]*?)&quot;/g, '<span class="json-string">&quot;$1&quot;</span>')
        // Numbers
        .replace(/\b(-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)\b/g, '<span class="json-number">$1</span>')
        // Booleans
        .replace(/\b(true|false)\b/g, '<span class="json-boolean">$1</span>')
        // Null
        .replace(/\bnull\b/g, '<span class="json-null">null</span>');
    } catch (e) {
      return escapeHtml(String(input||''));
    }
  }

  async function ensureResponseBody(entry, opts) {
    // Best-effort: ne pas récupérer à l'avance. Lors de la copie, tenter getContent().
    // Gère les implémentations basées callback (Chrome) et Promise (Firefox).
    const raw = entry.raw;
    const timeoutMs = (opts && typeof opts.timeoutMs === 'number') ? opts.timeoutMs : GET_CONTENT_TIMEOUT_MS;
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
        result = await withTimeout(ret, timeoutMs);
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

    result = await withTimeout(cbPromise, timeoutMs);
    if (result && (result.text || result.text === '')) return result;

    return { text: null, encoding: null, error: 'timeout-or-error' };
  }

  async function buildCopiedText(entry, opts = {}) {
    // opts peut contenir: includeToken, includePayload, includeResponse
    const includeToken = opts.includeToken !== undefined ? opts.includeToken : false;
    const wantPayload = opts.includePayload !== undefined ? opts.includePayload : true;
    const wantResponse = opts.includeResponse !== undefined ? opts.includeResponse : true;

    // Assurer payload brut
    let payloadRaw = '';
    try {
      const pd = entry.request && entry.request.postData;
      payloadRaw = (pd && (pd.text || (pd.params && JSON.stringify(pd.params)))) || '';
    } catch {}

    // Préparer payload JSON si parsable et demandé
    let payloadJson = '';
    if (wantPayload && hasParsableJson(payloadRaw)) {
      try { payloadJson = JSON.stringify(JSON.parse(String(payloadRaw).trim()), null, 2); } catch {}
      payloadJson = safeTruncate(payloadJson, MAX_BODY_CHARS);
    }

    // Assurer response body via getContent si demandé
    let responseRaw = '';
    if (wantResponse) {
      try {
        const got = await ensureResponseBody(entry);
        if (got && typeof got.text === 'string') {
          responseRaw = got.text;
        } else if (got && got.timeout) {
          responseRaw = '';// considérer comme vide pour la copie globale
        } else {
          // fallback si déjà présent dans HAR
          const harText = entry.response && entry.response.content && entry.response.content.text;
          responseRaw = (harText != null) ? harText : '';
        }
      } catch (e) {
        responseRaw = '';
      }
    }

    // Préparer réponse JSON si parsable et demandé
    let responseJson = '';
    if (wantResponse && hasParsableJson(responseRaw)) {
      try { responseJson = JSON.stringify(JSON.parse(String(responseRaw).trim()), null, 2); } catch {}
      responseJson = safeTruncate(responseJson || '', MAX_BODY_CHARS);
    }

    // Token seulement si demandé
    let tokenLine = '';
    if (includeToken) {
      const headersMap = headersArrayToMap(entry.request && entry.request.headers || []);
      const token = extractToken(headersMap);
      tokenLine = `\n🔑 TOKEN: ${token ? token : '— Aucun —'}`;
    }

    const ts = nowTimestamp();
    const status = entry.status || 0;
    const duration = fmtTime(entry.durationMs || 0);
    const method = entry.method || '';
    const url = entry.url || '';

    // Construction du texte: format cohérent avec titre + saut de ligne + données
    const parts = [];
    const isError = (Number(status) >= 400);

    // En-tête SUCCÈS/ERREUR
    parts.push(isError ? `⚠️ 🔴 **ERREUR**` : `✅ 🟢 **SUCCÈS**`);
    parts.push('');

    // URL
    parts.push('🔗 URL:');
    parts.push(url);
    parts.push('');

    // MÉTHODE
    parts.push('🚀 MÉTHODE:');
    parts.push(method);
    parts.push('');

    // STATUT
    parts.push('🧭 STATUT:');
    parts.push(String(status));
    parts.push('');

    // DURÉE
    parts.push('⏱ DURÉE:');
    parts.push(duration);

    // TOKEN si demandé
    if (includeToken) {
      parts.push('');
      parts.push('🔑 TOKEN:');
      const token = tokenLine ? tokenLine.replace(/^\n🔑 TOKEN: /, '') : '— Aucun —';
      parts.push(token);
    }

    const hasPayload = !!payloadJson;
    const hasResponse = !!responseJson;

    // PAYLOAD si disponible
    if (hasPayload) {
      parts.push('');
      parts.push('📦 PAYLOAD:');
      parts.push('```');
      parts.push(payloadJson);
      parts.push('```');
    }

    // RESPONSE si disponible
    if (hasResponse) {
      parts.push('');
      parts.push('🧾 RESPONSE:');
      parts.push('```');
      parts.push(responseJson);
      parts.push('```');
    }

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

  async function handleCopyCustom() {
    const entry = state.entries.find(x => x.id === state.selectedId);
    if (!entry) return;

    try {
      // Lire l'état des checkboxes
      const chkToken = document.getElementById('chkToken');
      const chkPayload = document.getElementById('chkPayload');
      const chkResponse = document.getElementById('chkResponse');

      const opts = {
        includeToken: chkToken ? chkToken.checked : false,
        includePayload: chkPayload ? chkPayload.checked : true,
        includeResponse: chkResponse ? chkResponse.checked : true
      };

      const text = await buildCopiedText(entry, opts);
      const ok = await copyTextToClipboard(text);
      if (ok) showToast('Teamber — Copié ✓', true);
      else showToast('Échec de la copie', false);
    } catch (e) {
      console.error('[Teamber Réseau] Erreur copie:', e);
      showToast('Échec de la copie', false);
    }
  }

  async function handleCopy(withToken) {
    const entry = state.entries.find(x => x.id === state.selectedId);
    if (!entry) return;

    try {
      const text = await buildCopiedText(entry, {
        includeToken: withToken,
        includePayload: true,
        includeResponse: true
      });
      const ok = await copyTextToClipboard(text);
      if (ok) showToast(withToken ? 'Teamber — Copié avec token ✓' : 'Teamber — Copié ✓', true);
      else showToast('Échec de la copie', false);
    } catch (e) {
      console.error('[Teamber Réseau] Erreur copie:', e);
      showToast('Échec de la copie', false);
    }
  }

  // Copie uniquement du payload
  function extractPayload(entry) {
    try {
      const pd = entry.request && entry.request.postData;
      let payload = (pd && (pd.text || (pd.params && JSON.stringify(pd.params)))) || '';
      // Beautifier JSON si possible
      try {
        const t = payload && String(payload).trim();
        if (t && (t.startsWith('{') || t.startsWith('['))) {
          payload = JSON.stringify(JSON.parse(t), null, 2);
        }
      } catch {}
      return safeTruncate(payload, MAX_BODY_CHARS);
    } catch {
      return '';
    }
  }

  async function extractResponse(entry, opts = {}) {
    const { truncate = true, timeoutMs } = opts;
    try {
      const got = await ensureResponseBody(entry, { timeoutMs });
      let text = '';
      if (got && typeof got.text === 'string') {
        text = got.text;
      } else if (got && got.timeout) {
        text = '<unable to read response: timeout>';
      } else {
        const harText = entry.response && entry.response.content && entry.response.content.text;
        text = (harText != null) ? harText : '<unable to read response>';
      }
      try {
        const t = text && String(text).trim();
        if (t && (t.startsWith('{') || t.startsWith('['))) {
          text = JSON.stringify(JSON.parse(t), null, 2);
        }
      } catch {}
      return truncate ? safeTruncate(text || '', MAX_BODY_CHARS) : (text || '');
    } catch {
      return '<unable to read response>';
    }
  }

  async function handleCopyPayload() {
    const entry = state.entries.find(x => x.id === state.selectedId);
    if (!entry) return;
    try {
      const text = extractPayload(entry);
      const ok = await copyTextToClipboard(text);
      if (ok) showToast('Teamber — Payload copié ✓', true);
      else showToast('Échec de la copie', false);
    } catch (e) {
      console.error('[Teamber Réseau] Erreur copie payload:', e);
      showToast('Échec de la copie', false);
    }
  }

  async function handleCopyNoResponse() {
      const entry = state.entries.find(x => x.id === state.selectedId);
      if (!entry) return;
      try {
        const text = await buildCopiedText(entry, {
          includeToken: false,
          includePayload: true,
          includeResponse: false
        });
        const ok = await copyTextToClipboard(text);
        if (ok) showToast('Teamber — Copié (sans réponse) ✓', true);
        else showToast('Échec de la copie', false);
      } catch (e) {
        console.error('[Teamber Réseau] Erreur copie (sans réponse):', e);
        showToast('Échec de la copie', false);
      }
    }

    async function handleCopyResponse() {
    const entry = state.entries.find(x => x.id === state.selectedId);
    if (!entry) return;
    try {
      // Pour la copie de la réponse, ne pas tronquer et autoriser un délai plus long
      const text = await extractResponse(entry, { truncate: false, timeoutMs: 15000 });
      const ok = await copyTextToClipboard(text);
      if (ok) showToast('Teamber — Réponse copiée ✓', true);
      else showToast('Échec de la copie', false);
    } catch (e) {
      console.error('[Teamber Réseau] Erreur copie réponse:', e);
      showToast('Échec de la copie', false);
    }
  }

  // Événements UI
  $filter.addEventListener('input', (e) => setFilter(e.target.value));
  $clearBtn.addEventListener('click', () => { state.entries = []; clearSelection(); renderRows(); });

  // Boutons dans l'en-tête DETAILS (event delegation)
  $details.addEventListener('click', (e) => {
    // Gérer le bouton principal de copie avec checkboxes
    const copyBtn = e.target.closest('#btnCopyCustom');
    if (copyBtn && !copyBtn.disabled) {
      handleCopyCustom();
      return;
    }

    // Gérer les boutons inline de copie pour Payload et Response
    const btnPayloadInline = e.target.closest('#btnCopyPayloadInline');
    if (btnPayloadInline && !btnPayloadInline.disabled) {
      handleCopyPayload();
      return;
    }

    const btnResponseInline = e.target.closest('#btnCopyResponseInline');
    if (btnResponseInline && !btnResponseInline.disabled) {
      handleCopyResponse();
      return;
    }

    // Gérer les anciens boutons d'action (pour les sous-sections si besoin)
    const btn = e.target.closest('button[data-action]');
    if (!btn) return;
    if (btn.disabled) return;
    const action = btn.dataset.action;
    if (action === 'copy') handleCopy(false);
    if (action === 'copy-token') handleCopy(true);
    if (action === 'copy-payload') handleCopyPayload();
    if (action === 'copy-no-response') handleCopyNoResponse();
    if (action === 'copy-response') handleCopyResponse();
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

  // Charger les requêtes existantes au démarrage
  async function loadExistingRequests() {
    try {
      if (b.devtools.network && typeof b.devtools.network.getHAR === 'function') {
        const har = await new Promise((resolve, reject) => {
          b.devtools.network.getHAR((harLog) => {
            if (harLog) resolve(harLog);
            else reject(new Error('No HAR data'));
          });
        });

        if (har && har.entries && Array.isArray(har.entries)) {
          console.log('[Teamber Réseau] Chargement de', har.entries.length, 'requêtes existantes');
          for (const entry of har.entries) {
            try {
              addEntryFromRaw(entry);
            } catch (e) {
              console.warn('[Teamber Réseau] Erreur lors du chargement d\'une entrée HAR:', e);
            }
          }
        }
      }
    } catch (e) {
      console.warn('[Teamber Réseau] Impossible de charger les requêtes existantes:', e);
    }
  }

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

  // Charger les requêtes existantes au démarrage
  loadExistingRequests();

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
