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
  const STORAGE_KEY_COPY_OPTIONS = 'teamber.copy.options';
  const STORAGE_KEY_PRIMARY_COLOR = 'teamber.primary.color';
  const DEFAULT_PRIMARY_COLOR = '#58a6ff';

  // Etat
  const state = {
    entries: [],   // { id, url, method, status, timeString, durationMs, request, response, raw }
    selectedId: null,
    filter: '',
    sort: { key: null, dir: 'asc' }, // key in ['status','method','file','size','url']
    activeTab: 'headers' // Onglet actif dans les détails
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

  // Filtre les ressources statiques (CSS, JS, images, fonts, etc.)
  function isStaticResource(url, type) {
    try {
      const urlLower = String(url || '').toLowerCase();
      const typeLower = String(type || '').toLowerCase();

      // Filtrer par extension
      const staticExtensions = ['.css', '.js', '.jpg', '.jpeg', '.png', '.gif', '.svg', '.ico',
                                '.woff', '.woff2', '.ttf', '.eot', '.otf', '.map'];
      if (staticExtensions.some(ext => urlLower.endsWith(ext))) {
        return true;
      }

      // Filtrer par type de ressource
      const staticTypes = ['stylesheet', 'script', 'image', 'font', 'media'];
      if (staticTypes.includes(typeLower)) {
        return true;
      }

      return false;
    } catch {
      return false;
    }
  }

  // Sauvegarder les options de copie
  function saveCopyOptions(token, payload, response) {
    try {
      localStorage.setItem(STORAGE_KEY_COPY_OPTIONS, JSON.stringify({
        token: token,
        payload: payload,
        response: response
      }));
    } catch (e) {
      console.warn('[Teamber Réseau] Erreur sauvegarde copy options:', e);
    }
  }

  // Charger les options de copie
  function loadCopyOptions() {
    try {
      const data = localStorage.getItem(STORAGE_KEY_COPY_OPTIONS);
      if (data) {
        return JSON.parse(data);
      }
    } catch (e) {
      console.warn('[Teamber Réseau] Erreur chargement copy options:', e);
    }
    return { token: false, payload: true, response: true };
  }

  // Sauvegarder la couleur primaire
  function savePrimaryColor(color) {
    try {
      localStorage.setItem(STORAGE_KEY_PRIMARY_COLOR, color);
      applyPrimaryColor(color);
    } catch (e) {
      console.warn('[Teamber Réseau] Erreur sauvegarde couleur primaire:', e);
    }
  }

  // Charger la couleur primaire
  function loadPrimaryColor() {
    try {
      const color = localStorage.getItem(STORAGE_KEY_PRIMARY_COLOR);
      return color || DEFAULT_PRIMARY_COLOR;
    } catch (e) {
      console.warn('[Teamber Réseau] Erreur chargement couleur primaire:', e);
      return DEFAULT_PRIMARY_COLOR;
    }
  }

  // Appliquer la couleur primaire
  function applyPrimaryColor(color) {
    try {
      document.documentElement.style.setProperty('--accent', color);
      // Calculer une version plus foncée pour le hover
      const rgb = parseInt(color.slice(1), 16);
      const r = Math.max(0, ((rgb >> 16) & 0xff) - 20);
      const g = Math.max(0, ((rgb >> 8) & 0xff) - 20);
      const bl = Math.max(0, (rgb & 0xff) - 20);
      const hoverColor = `#${((1 << 24) + (r << 16) + (g << 8) + bl).toString(16).slice(1)}`;
      document.documentElement.style.setProperty('--accent-hover', hoverColor);
    } catch (e) {
      console.warn('[Teamber Réseau] Erreur application couleur:', e);
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
  async function clearHistory(reason) {
    try {
      state.entries = [];
      clearSelection();
      renderRows();

      // Effacer aussi les requêtes dans le background
      try {
        const tabId = b.devtools.inspectedWindow.tabId;
        await b.runtime.sendMessage({
          type: 'clearRequests',
          tabId: tabId
        });
      } catch (e) {
        console.warn('[Teamber Réseau] Erreur lors du clear background:', e);
      }

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

    // Filtrer les ressources statiques (CSS, JS, images, fonts, etc.)
    base = base.filter(e => {
      const type = (e.raw && e.raw._initiator && e.raw._initiator.type) ||
                   (e.raw && e.raw.type) || '';
      return !isStaticResource(e.url, type);
    });

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

  function buildTabsActionsHtml(disabled) {
    const dis = disabled ? 'disabled' : '';
    const options = loadCopyOptions();
    const primaryColor = loadPrimaryColor();
    return `
      <button id="btnCopyCustom" class="tabs-action-btn" ${dis}>Copier</button>
      <div class="tabs-settings-wrapper">
        <button id="copySettingsBtn" class="tabs-settings-btn" title="Options de copie" ${dis}>
          <svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
            <path d="M12 15.5A3.5 3.5 0 0 1 8.5 12 3.5 3.5 0 0 1 12 8.5a3.5 3.5 0 0 1 3.5 3.5 3.5 3.5 0 0 1-3.5 3.5m7.43-2.53c.04-.32.07-.64.07-.97 0-.33-.03-.66-.07-1l2.11-1.63c.19-.15.24-.42.12-.64l-2-3.46c-.12-.22-.39-.31-.61-.22l-2.49 1c-.52-.39-1.06-.73-1.69-.98l-.37-2.65A.506.506 0 0 0 14 2h-4c-.25 0-.46.18-.5.42l-.37 2.65c-.63.25-1.17.59-1.69.98l-2.49-1c-.22-.09-.49 0-.61.22l-2 3.46c-.13.22-.07.49.12.64L4.57 11c-.04.34-.07.67-.07 1 0 .33.03.65.07.97l-2.11 1.66c-.19.15-.25.42-.12.64l2 3.46c.12.22.39.3.61.22l2.49-1.01c.52.4 1.06.74 1.69.99l.37 2.65c.04.24.25.42.5.42h4c.25 0 .46-.18.5-.42l.37-2.65c.63-.26 1.17-.59 1.69-.99l2.49 1.01c.22.08.49 0 .61-.22l2-3.46c.12-.22.07-.49-.12-.64l-2.11-1.66z"/>
          </svg>
        </button>
        <div id="copySettingsDropdown" class="settings-dropdown">
          <div class="settings-option">
            <input type="checkbox" id="chkToken" ${disabled ? 'disabled' : ''} ${options.token ? 'checked' : ''}>
            <label for="chkToken">Token</label>
          </div>
          <div class="settings-option">
            <input type="checkbox" id="chkPayload" ${disabled ? 'disabled' : ''} ${options.payload ? 'checked' : ''}>
            <label for="chkPayload">Payload</label>
          </div>
          <div class="settings-option">
            <input type="checkbox" id="chkResponse" ${disabled ? 'disabled' : ''} ${options.response ? 'checked' : ''}>
            <label for="chkResponse">Réponse</label>
          </div>
          <div class="settings-divider"></div>
          <div class="color-picker-wrapper">
            <span class="color-picker-label">Couleur primaire</span>
            <input type="color" id="primaryColorPicker" class="color-picker-input" value="${primaryColor}" ${disabled ? 'disabled' : ''}>
          </div>
        </div>
      </div>
    `;
  }

  function renderDetails() {
    const e = state.entries.find(x => x.id === state.selectedId);
    if (!e) {
      $details.innerHTML = `
        <div class="tabs-container">
          <div class="tabs-nav">
            <div class="tabs-nav-scroll">
            </div>
            <div class="tabs-nav-actions">
              ${buildTabsActionsHtml(true)}
            </div>
          </div>
          <div style="padding:16px; color: var(--muted);">Sélectionnez une requête pour voir les détails…</div>
        </div>
      `;
      return;
    }

    // Extraire toutes les données nécessaires
    const reqHeaders = e.request && e.request.headers || [];
    const resHeaders = e.response && e.response.headers || [];
    const reqCookies = e.request && e.request.cookies || [];
    const resCookies = e.response && e.response.cookies || [];

    let payloadRaw = '';
    try {
      const pd = e.request && e.request.postData;
      payloadRaw = (pd && (pd.text || (pd.params && JSON.stringify(pd.params)))) || '';
    } catch (_) {}

    const respRaw = (e.response && e.response.content && e.response.content.text);
    const timings = (e.raw && e.raw.timings) || {};
    const initiator = getInitiator(e.raw);

    // Construire les onglets
    const headersTabHtml = buildHeadersTab(reqHeaders, resHeaders);
    const cookiesTabHtml = buildCookiesTab(reqCookies, resCookies);
    const requestTabHtml = buildRequestTab(e, payloadRaw);
    const responseTabHtml = buildResponseTab(e, respRaw);
    const timingsTabHtml = buildTimingsTab(timings, e.durationMs);
    const traceTabHtml = buildTraceTab(initiator);

    const tabs = [
      { id: 'headers', label: 'En-têtes', content: headersTabHtml },
      { id: 'request', label: 'Requête', content: requestTabHtml },
      { id: 'response', label: 'Réponse', content: responseTabHtml },
      { id: 'cookies', label: 'Cookies', content: cookiesTabHtml },
      { id: 'timings', label: 'Délais', content: timingsTabHtml },
      { id: 'trace', label: 'Trace', content: traceTabHtml }
    ];

    const tabsNavHtml = tabs.map(tab =>
      `<button class="tab-button ${state.activeTab === tab.id ? 'active' : ''}" data-tab="${tab.id}">${escapeHtml(tab.label)}</button>`
    ).join('');

    const tabsContentHtml = tabs.map(tab =>
      `<div class="tab-content ${state.activeTab === tab.id ? 'active' : ''}" data-tab="${tab.id}">${tab.content}</div>`
    ).join('');

    $details.innerHTML = `
      <div class="tabs-container">
        <div class="tabs-nav">
          <div class="tabs-nav-scroll">
            ${tabsNavHtml}
          </div>
          <div class="tabs-nav-actions">
            ${buildTabsActionsHtml(false)}
          </div>
        </div>
        ${tabsContentHtml}
      </div>
    `;

    // Ajouter les event listeners pour les onglets
    const tabButtons = $details.querySelectorAll('.tab-button');
    tabButtons.forEach(btn => {
      btn.addEventListener('click', () => {
        const tabId = btn.dataset.tab;
        state.activeTab = tabId;

        // Update active states
        $details.querySelectorAll('.tab-button').forEach(b => b.classList.remove('active'));
        $details.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
        btn.classList.add('active');
        $details.querySelector(`.tab-content[data-tab="${tabId}"]`).classList.add('active');

        // Lazy load si nécessaire
        if (tabId === 'response') {
          loadResponseBody(e);
        }
      });
    });

    // Event listeners pour les sections collapsables
    const collapsableTitles = $details.querySelectorAll('.collapsable-section-title');
    collapsableTitles.forEach(title => {
      title.addEventListener('click', () => {
        const targetId = title.dataset.collapse;
        const content = document.getElementById(targetId);
        if (content) {
          title.classList.toggle('collapsed');
          content.classList.toggle('collapsed');
        }
      });
    });

    // Event listeners pour les boutons copier dans les onglets
    const btnCopyRequestBody = document.getElementById('btnCopyRequestBody');
    if (btnCopyRequestBody) {
      btnCopyRequestBody.addEventListener('click', () => {
        try {
          const text = payloadRaw || '';
          if (text) {
            navigator.clipboard.writeText(text);
            showToast('Corps de requête copié', true);
          }
        } catch (err) {
          showToast('Erreur lors de la copie', false);
        }
      });
    }

    const btnCopyResponseBody = document.getElementById('btnCopyResponseBody');
    if (btnCopyResponseBody) {
      btnCopyResponseBody.addEventListener('click', async () => {
        try {
          let text = respRaw || '';
          if (!text) {
            const got = await ensureResponseBody(e, { timeoutMs: 3000 });
            if (got && got.text) {
              text = got.text;
            }
          }
          if (text) {
            navigator.clipboard.writeText(text);
            showToast('Corps de réponse copié', true);
          } else {
            showToast('Aucune donnée à copier', false);
          }
        } catch (err) {
          showToast('Erreur lors de la copie', false);
        }
      });
    }

    // Event listener pour le bouton settings de copie
    const copySettingsBtn = document.getElementById('copySettingsBtn');
    const copySettingsDropdown = document.getElementById('copySettingsDropdown');
    if (copySettingsBtn && copySettingsDropdown) {
      copySettingsBtn.addEventListener('click', (ev) => {
        ev.stopPropagation();
        copySettingsDropdown.classList.toggle('active');
      });

      // Fermer le dropdown quand on clique en dehors
      const closeDropdownHandler = (ev) => {
        if (!copySettingsBtn.contains(ev.target) && !copySettingsDropdown.contains(ev.target)) {
          copySettingsDropdown.classList.remove('active');
        }
      };
      document.addEventListener('click', closeDropdownHandler);

      // Event listeners pour les checkboxes
      const chkToken = document.getElementById('chkToken');
      const chkPayload = document.getElementById('chkPayload');
      const chkResponse = document.getElementById('chkResponse');

      const saveOptions = () => {
        saveCopyOptions(
          chkToken ? chkToken.checked : false,
          chkPayload ? chkPayload.checked : false,
          chkResponse ? chkResponse.checked : false
        );
      };

      if (chkToken) chkToken.addEventListener('change', saveOptions);
      if (chkPayload) chkPayload.addEventListener('change', saveOptions);
      if (chkResponse) chkResponse.addEventListener('change', saveOptions);

      // Event listener pour le color picker
      const colorPicker = document.getElementById('primaryColorPicker');
      if (colorPicker) {
        colorPicker.addEventListener('input', (ev) => {
          savePrimaryColor(ev.target.value);
        });
      }
    }

    // Event listeners pour les boutons copier dans les headers
    const headerCopyBtns = $details.querySelectorAll('.header-copy-btn');
    headerCopyBtns.forEach(btn => {
      btn.addEventListener('click', () => {
        const value = btn.dataset.copyValue;
        if (value) {
          try {
            navigator.clipboard.writeText(value);
            showToast('Token copié', true);
          } catch (err) {
            showToast('Erreur lors de la copie', false);
          }
        }
      });
    });

    // Lazy load de la réponse si onglet Response
    if (state.activeTab === 'response') {
      loadResponseBody(e);
    }
  }

  function buildHeadersTab(reqHeaders, resHeaders) {
    const reqRows = reqHeaders.map(h => {
      const isAuth = (h.name || '').toLowerCase() === 'authorization';
      const nameRow = `<tr><td class="header-name" colspan="2">${escapeHtml(h.name || '')}</td></tr>`;
      const valueRow = isAuth
        ? `<tr><td class="header-value-with-btn">
             <span>${escapeHtml(h.value || '')}</span>
             <button class="header-copy-btn" data-copy-value="${escapeHtml(h.value || '')}" title="Copier le token">📋</button>
           </td></tr>`
        : `<tr><td class="header-value" colspan="2">${escapeHtml(h.value || '')}</td></tr>`;
      return nameRow + valueRow;
    }).join('');

    const resRows = resHeaders.map(h =>
      `<tr><td class="header-name" colspan="2">${escapeHtml(h.name || '')}</td></tr>
       <tr><td class="header-value" colspan="2">${escapeHtml(h.value || '')}</td></tr>`
    ).join('');

    return `
      <div class="collapsable-section">
        <div class="collapsable-section-title" data-collapse="req-headers">En-têtes de requête</div>
        <div class="collapsable-content" id="req-headers">
          ${reqRows ? `<table class="info-table"><tbody>${reqRows}</tbody></table>` : '<div class="muted">Aucun en-tête</div>'}
        </div>
      </div>
      <div class="collapsable-section">
        <div class="collapsable-section-title" data-collapse="res-headers">En-têtes de réponse</div>
        <div class="collapsable-content" id="res-headers">
          ${resRows ? `<table class="info-table"><tbody>${resRows}</tbody></table>` : '<div class="muted">Aucun en-tête</div>'}
        </div>
      </div>
    `;
  }

  function buildCookiesTab(reqCookies, resCookies) {
    const reqRows = reqCookies.map(c =>
      `<tr><td>${escapeHtml(c.name || '')}</td><td>${escapeHtml(c.value || '')}</td></tr>`
    ).join('');
    const resRows = resCookies.map(c =>
      `<tr><td>${escapeHtml(c.name || '')}</td><td>${escapeHtml(c.value || '')}</td></tr>`
    ).join('');

    return `
      <div class="info-section">
        <div class="info-section-title">Cookies de requête</div>
        ${reqRows ? `<table class="info-table"><tbody>${reqRows}</tbody></table>` : '<div class="muted">Aucun cookie</div>'}
      </div>
      <div class="info-section">
        <div class="info-section-title">Cookies de réponse</div>
        ${resRows ? `<table class="info-table"><tbody>${resRows}</tbody></table>` : '<div class="muted">Aucun cookie</div>'}
      </div>
    `;
  }

  function buildRequestTab(e, payloadRaw) {
    const hasPayloadJson = hasParsableJson(payloadRaw);
    const payloadPretty = hasPayloadJson ? prettyMaybeJson(payloadRaw) : payloadRaw;
    const payloadHtml = hasPayloadJson ? highlightJson(safeTruncate(payloadPretty || '', MAX_BODY_CHARS)) :
                        (payloadRaw ? `<div>${escapeHtml(payloadRaw)}</div>` : '<div class="muted">Aucune donnée</div>');

    return `
      <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 16px;">
        <div class="info-section-title" style="margin-bottom: 0;">Corps de la requête</div>
        <button class="section-copy-btn" id="btnCopyRequestBody" ${payloadRaw ? '' : 'disabled'}>📋 Copier</button>
      </div>
      <pre id="requestBodyPre" class="code json">${payloadHtml}</pre>
    `;
  }

  function buildResponseTab(e, respRaw) {
    const hasRespJson = hasParsableJson(respRaw);
    const responsePretty = hasRespJson ? prettyMaybeJson(respRaw) : respRaw;
    const responseHtml = hasRespJson ? highlightJson(safeTruncate(responsePretty || '', MAX_BODY_CHARS)) :
                         (respRaw ? `<div>${escapeHtml(respRaw)}</div>` : '<div class="muted">Chargement...</div>');

    return `
      <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 16px;">
        <div class="info-section-title" style="margin-bottom: 0;">Corps de la réponse</div>
        <button class="section-copy-btn" id="btnCopyResponseBody">📋 Copier</button>
      </div>
      <pre id="respPre" class="code json">${responseHtml}</pre>
    `;
  }

  function buildTimingsTab(timings, totalDuration) {
    const timingRows = [
      { label: 'Bloqué', value: timings.blocked },
      { label: 'DNS', value: timings.dns },
      { label: 'Connexion', value: timings.connect },
      { label: 'SSL', value: timings.ssl },
      { label: 'Envoi', value: timings.send },
      { label: 'Attente', value: timings.wait },
      { label: 'Réception', value: timings.receive },
      { label: 'Total', value: totalDuration }
    ].map(({ label, value }) => {
      const val = (value !== undefined && value >= 0) ? `${Math.round(value)} ms` : '—';
      return `<tr><td>${label}</td><td>${val}</td></tr>`;
    }).join('');

    return `
      <div class="info-section">
        <table class="info-table">
          <tbody>${timingRows}</tbody>
        </table>
      </div>
    `;
  }

  function buildTraceTab(initiator) {
    return `
      <div class="info-section">
        <table class="info-table">
          <tbody>
            <tr><td>Initiateur</td><td>${escapeHtml(String(initiator || '—'))}</td></tr>
          </tbody>
        </table>
      </div>
    `;
  }

  async function loadResponseBody(e) {
    try {
      const currentId = e.id;
      const target = document.getElementById('respPre');
      if (!target) return;
      const got = await ensureResponseBody(e, { timeoutMs: 3000 });
      if (state.selectedId !== currentId) return;
      if (got && typeof got.text === 'string') {
        let text = got.text;
        if (hasParsableJson(text)) {
          try { text = JSON.stringify(JSON.parse(String(text).trim()), null, 2); } catch {}
          target.innerHTML = highlightJson(safeTruncate(text || '', MAX_BODY_CHARS));
        } else if (text.trim()) {
          // Afficher le contenu brut s'il existe
          target.innerHTML = `<div>${escapeHtml(text)}</div>`;
        } else {
          target.innerHTML = '<div class="muted">Aucune donnée</div>';
        }
      } else {
        target.innerHTML = '<div class="muted">Aucune donnée</div>';
      }
    } catch (err) {
      const target = document.getElementById('respPre');
      if (target) {
        target.innerHTML = '<div class="muted">Erreur lors du chargement</div>';
      }
    }
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

    // Construction du texte: n'inclure Payload/Response que si JSON non vide
    const parts = [];
    const isError = (Number(status) >= 400);
    parts.push(isError ? `⚠️ 🔴 **ERREUR**` : `✅ 🟢 **SUCCÈS**`);
    parts.push('────────────────────────────────────────────');
    parts.push(`🔗 URL       : ${url}`);
    parts.push(`🚀 MÉTHODE   : ${method}    •    🧭 STATUT : ${status}    •    ⏱ DURÉE : ${duration}`);
    if (includeToken) {
      parts.push('────────────────────────────────────────────');
      parts.push(`${tokenLine ? tokenLine.replace(/^\n/, '') : '— Aucun —'}`);
    }

    const hasPayload = !!payloadJson;
    const hasResponse = !!responseJson;

    if (hasPayload || hasResponse) {
      parts.push('────────────────────────────────────────────');
      if (hasPayload) {
        parts.push('📦 PAYLOAD:');
        parts.push('```');
        parts.push(payloadJson);
        parts.push('```');
      }
      if (hasResponse) {
        if (hasPayload) parts.push('');
        parts.push('🧾 RESPONSE:');
        parts.push('```');
        parts.push(responseJson);
        parts.push('```');
      }
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
  $clearBtn.addEventListener('click', () => clearHistory('manuel'));

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

  // Resizer (entre URL et DETAILS) - responsive: vertical ou horizontal
  (function initResizer(){
    if (!$split || !$rowResizer) return;
    const STORAGE_KEY_ROWS = 'teamber.split.ratio.rows';
    const STORAGE_KEY_COLS = 'teamber.split.ratio.cols';
    let drag = null;

    function isWideLayout() {
      return window.innerWidth >= 768;
    }

    function applyByRatio(ratio) {
      const rect = $split.getBoundingClientRect();
      if (!rect) return;
      const wide = isWideLayout();

      if (wide) {
        // Mode horizontal (colonnes)
        if (rect.width <= 0) return;
        const minLeft = 200;
        const minRight = 300;
        const leftPx = Math.max(minLeft, Math.min(rect.width - minRight, Math.round(rect.width * ratio)));
        $split.style.gridTemplateColumns = `${leftPx}px 6px 1fr`;
        $split.style.gridTemplateRows = '1fr';
      } else {
        // Mode vertical (lignes)
        if (rect.height <= 0) return;
        const minTop = 80;
        const minBottom = 120;
        const topPx = Math.max(minTop, Math.min(rect.height - minBottom, Math.round(rect.height * ratio)));
        $split.style.gridTemplateRows = `${topPx}px 6px 1fr`;
        $split.style.gridTemplateColumns = '1fr';
      }
    }

    function restore() {
      const wide = isWideLayout();
      const key = wide ? STORAGE_KEY_COLS : STORAGE_KEY_ROWS;
      const defaultRatio = wide ? 0.56 : 0.56;
      const r = parseFloat(localStorage.getItem(key) || String(defaultRatio));
      if (isFinite(r) && r > 0 && r < 1) applyByRatio(r);
    }

    $rowResizer.addEventListener('mousedown', (ev) => {
      ev.preventDefault();
      const rect = $split.getBoundingClientRect();
      const listRect = $split.children[0].getBoundingClientRect();
      const wide = isWideLayout();
      drag = {
        startX: ev.clientX,
        startY: ev.clientY,
        rectW: rect.width,
        rectH: rect.height,
        listStartWidth: listRect.width,
        listStartHeight: listRect.height,
        isWide: wide
      };
      document.body.style.userSelect = 'none';
    });

    window.addEventListener('mousemove', (ev) => {
      if (!drag) return;

      if (drag.isWide) {
        // Mode horizontal
        const dx = ev.clientX - drag.startX;
        const leftPx = Math.max(200, Math.min(drag.rectW - 300, drag.listStartWidth + dx));
        $split.style.gridTemplateColumns = `${leftPx}px 6px 1fr`;
        const ratio = leftPx / drag.rectW;
        try { localStorage.setItem(STORAGE_KEY_COLS, String(ratio)); } catch {}
      } else {
        // Mode vertical
        const dy = ev.clientY - drag.startY;
        const topPx = Math.max(80, Math.min(drag.rectH - 120, drag.listStartHeight + dy));
        $split.style.gridTemplateRows = `${topPx}px 6px 1fr`;
        const ratio = topPx / drag.rectH;
        try { localStorage.setItem(STORAGE_KEY_ROWS, String(ratio)); } catch {}
      }
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

  // Charger les requêtes depuis le background script
  async function loadRequestsFromBackground() {
    try {
      const tabId = b.devtools.inspectedWindow.tabId;
      const response = await b.runtime.sendMessage({
        type: 'getRequests',
        tabId: tabId
      });

      if (response && response.requests && Array.isArray(response.requests)) {
        console.log('[Teamber Réseau] Chargement de', response.requests.length, 'requêtes depuis background');
        for (const entry of response.requests) {
          try {
            addEntryFromRaw(entry);
          } catch (e) {
            console.warn('[Teamber Réseau] Erreur lors du chargement d\'une entrée:', e);
          }
        }
      }
    } catch (e) {
      console.warn('[Teamber Réseau] Impossible de charger depuis background:', e);
    }
  }

  // Charger les requêtes existantes au démarrage (fallback pour compatibilité)
  async function loadExistingRequests() {
    // D'abord essayer de charger depuis le background
    await loadRequestsFromBackground();

    // Ensuite charger depuis HAR (pour les requêtes capturées par DevTools)
    try {
      if (b.devtools.network && typeof b.devtools.network.getHAR === 'function') {
        const har = await new Promise((resolve, reject) => {
          b.devtools.network.getHAR((harLog) => {
            if (harLog) resolve(harLog);
            else reject(new Error('No HAR data'));
          });
        });

        if (har && har.entries && Array.isArray(har.entries)) {
          console.log('[Teamber Réseau] Chargement de', har.entries.length, 'requêtes depuis HAR');
          for (const entry of har.entries) {
            try {
              // Éviter les doublons en vérifiant l'URL et le timestamp
              const exists = state.entries.some(e =>
                e.url === entry.request.url &&
                Math.abs(e.durationMs - (entry.time || 0)) < 10
              );
              if (!exists) {
                addEntryFromRaw(entry);
              }
            } catch (e) {
              console.warn('[Teamber Réseau] Erreur lors du chargement d\'une entrée HAR:', e);
            }
          }
        }
      }
    } catch (e) {
      console.warn('[Teamber Réseau] Impossible de charger les requêtes HAR:', e);
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
  applyPrimaryColor(loadPrimaryColor()); // Appliquer la couleur primaire sauvegardée
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
