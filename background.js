// background.js
// Capture toutes les requêtes réseau et les stocke pour le panel DevTools

(function() {
  'use strict';
  
  const b = (typeof browser !== 'undefined') ? browser : (typeof chrome !== 'undefined' ? chrome : null);
  if (!b) {
    console.error('[Teamber Background] API indisponible.');
    return;
  }
  
  const STORAGE_KEY = 'teamber.network.requests';
  const MAX_REQUESTS = 200;
  const IS_CHROME = typeof chrome !== 'undefined' && !browser;
  
  // Structure pour stocker les requêtes par tabId
  const requestsMap = new Map(); // tabId -> Array of requests
  const pendingRequests = new Map(); // requestId -> request data
  
  // Récupérer les requêtes stockées au démarrage
  async function loadRequests() {
    try {
      const result = await (b.storage.local.get ? b.storage.local.get(STORAGE_KEY) :
        new Promise(resolve => b.storage.local.get([STORAGE_KEY], resolve)));
      const data = result[STORAGE_KEY] || {};
      for (const [tabId, requests] of Object.entries(data)) {
        requestsMap.set(parseInt(tabId), requests);
      }
    } catch (e) {
      console.warn('[Teamber Background] Erreur chargement storage:', e);
    }
  }
  
  // Sauvegarder les requêtes
  async function saveRequests() {
    try {
      const data = {};
      for (const [tabId, requests] of requestsMap.entries()) {
        data[tabId] = requests;
      }
      await (b.storage.local.set ? b.storage.local.set({ [STORAGE_KEY]: data }) :
        new Promise(resolve => b.storage.local.set({ [STORAGE_KEY]: data }, resolve)));
    } catch (e) {
      console.warn('[Teamber Background] Erreur sauvegarde storage:', e);
    }
  }
  
  // Ajouter une requête
  function addRequest(tabId, requestData) {
    if (!requestsMap.has(tabId)) {
      requestsMap.set(tabId, []);
    }
    const requests = requestsMap.get(tabId);
    requests.push(requestData);
    
    // Limiter le nombre de requêtes
    if (requests.length > MAX_REQUESTS) {
      requests.shift();
    }
    
    saveRequests();
  }
  
  // Nettoyer les requêtes d'un onglet
  function clearTab(tabId) {
    requestsMap.delete(tabId);
    saveRequests();
  }
  
  // Écouter les requêtes
  if (b.webRequest) {
    // Configuration des extraSpecs selon le navigateur
    const beforeRequestExtraSpecs = ['requestBody'];
    const sendHeadersExtraSpecs = ['requestHeaders'];
    
    // Chrome nécessite 'extraHeaders' pour obtenir tous les headers
    if (IS_CHROME) {
      try {
        sendHeadersExtraSpecs.push('extraHeaders');
      } catch (e) {
        console.warn('[Teamber Background] extraHeaders non disponible');
      }
    }
    
    // onBeforeRequest - capture URL, méthode, body
    b.webRequest.onBeforeRequest.addListener(
      (details) => {
        if (details.tabId < 0) return; // Ignorer les requêtes background
        
        const requestData = {
          requestId: details.requestId,
          tabId: details.tabId,
          url: details.url,
          method: details.method,
          timeStamp: details.timeStamp,
          type: details.type,
          requestBody: details.requestBody,
          frameId: details.frameId
        };
        
        // Sur Chrome, requestBody peut être undefined pour les POST
        if (IS_CHROME && details.method === 'POST') {
          if (!details.requestBody) {
            console.log('[Teamber Background] POST sans body capturé:', details.url);
          } else {
            console.log('[Teamber Background] POST avec body:', details.url);
          }
        }
        
        pendingRequests.set(details.requestId, requestData);
      },
      { urls: ['<all_urls>'] },
      beforeRequestExtraSpecs
    );
    
    // onSendHeaders - capture request headers
    b.webRequest.onSendHeaders.addListener(
      (details) => {
        const pending = pendingRequests.get(details.requestId);
        if (pending) {
          pending.requestHeaders = details.requestHeaders;
        }
      },
      { urls: ['<all_urls>'] },
      sendHeadersExtraSpecs
    );
    
    // onHeadersReceived - capture response headers et status
    b.webRequest.onHeadersReceived.addListener(
      (details) => {
        const pending = pendingRequests.get(details.requestId);
        if (pending) {
          pending.statusCode = details.statusCode;
          pending.statusLine = details.statusLine;
          pending.responseHeaders = details.responseHeaders;
        }
      },
      { urls: ['<all_urls>'] },
      ['responseHeaders']
    );
    
    // onCompleted - requête terminée avec succès
    b.webRequest.onCompleted.addListener(
      (details) => {
        const pending = pendingRequests.get(details.requestId);
        if (pending) {
          pending.endTime = details.timeStamp;
          pending.fromCache = details.fromCache;
          pending.ip = details.ip;
          
          // Construire un objet HAR-like
          const harEntry = buildHAREntry(pending);
          addRequest(details.tabId, harEntry);
          
          pendingRequests.delete(details.requestId);
        }
      },
      { urls: ['<all_urls>'] }
    );
    
    // onErrorOccurred - requête en erreur
    b.webRequest.onErrorOccurred.addListener(
      (details) => {
        const pending = pendingRequests.get(details.requestId);
        if (pending) {
          pending.error = details.error;
          pending.endTime = details.timeStamp;
          
          const harEntry = buildHAREntry(pending);
          addRequest(details.tabId, harEntry);
          
          pendingRequests.delete(details.requestId);
        }
      },
      { urls: ['<all_urls>'] }
    );
  }
  
  // Construire une entrée HAR à partir des données collectées
  function buildHAREntry(data) {
    const startTime = new Date(data.timeStamp);
    const duration = data.endTime ? (data.endTime - data.timeStamp) : 0;
    
    // Construire request headers
    const requestHeaders = (data.requestHeaders || []).map(h => ({
      name: h.name,
      value: h.value
    }));
    
    // Construire response headers
    const responseHeaders = (data.responseHeaders || []).map(h => ({
      name: h.name,
      value: h.value
    }));
    
    // Extraire la taille depuis Content-Length
    let contentSize = 0;
    if (data.responseHeaders) {
      const contentLengthHeader = data.responseHeaders.find(h =>
        h.name.toLowerCase() === 'content-length'
      );
      if (contentLengthHeader) {
        contentSize = parseInt(contentLengthHeader.value, 10) || 0;
      }
    }
    
    // Extraire le body si disponible
    let postDataText = null;
    let requestBodySize = 0;
    if (data.requestBody) {
      if (data.requestBody.raw) {
        try {
          const decoder = new TextDecoder('utf-8');
          const parts = data.requestBody.raw.map(part => {
            if (part.bytes) {
              const decoded = decoder.decode(new Uint8Array(part.bytes));
              requestBodySize += part.bytes.byteLength || 0;
              return decoded;
            }
            return '';
          });
          postDataText = parts.join('');
        } catch (e) {
          console.warn('[Teamber Background] Erreur décodage body:', e);
        }
      } else if (data.requestBody.formData) {
        postDataText = JSON.stringify(data.requestBody.formData);
        requestBodySize = postDataText.length;
      }
    } else if (IS_CHROME && data.method === 'POST') {
      // Sur Chrome, si c'est un POST sans body capturé, on l'indique
      postDataText = '<body not captured by webRequest API - use HAR>';
    }
    
    // Extraire Content-Type du body si possible
    let mimeType = 'application/json';
    if (data.requestHeaders) {
      const contentTypeHeader = data.requestHeaders.find(h =>
        h.name.toLowerCase() === 'content-type'
      );
      if (contentTypeHeader) {
        mimeType = contentTypeHeader.value.split(';')[0].trim();
      }
    }
    
    return {
      startedDateTime: startTime.toISOString(),
      time: duration,
      request: {
        method: data.method,
        url: data.url,
        httpVersion: 'HTTP/1.1',
        headers: requestHeaders,
        queryString: [],
        cookies: [],
        headersSize: -1,
        bodySize: requestBodySize,
        postData: postDataText ? {
          mimeType: mimeType,
          text: postDataText
        } : undefined
      },
      response: {
        status: data.statusCode || 0,
        statusText: data.statusLine || '',
        httpVersion: 'HTTP/1.1',
        headers: responseHeaders,
        cookies: [],
        content: {
          size: contentSize,
          mimeType: '',
          text: '' // Le body de réponse n'est pas disponible via webRequest
        },
        redirectURL: '',
        headersSize: -1,
        bodySize: contentSize,
        _transferSize: contentSize
      },
      cache: {},
      timings: {
        blocked: -1,
        dns: -1,
        connect: -1,
        send: 0,
        wait: duration,
        receive: 0,
        ssl: -1
      },
      serverIPAddress: data.ip || '',
      connection: '',
      _initiator: { type: data.type }
    };
  }
  
  // Écouter les messages du panel
  b.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === 'getRequests') {
      const tabId = message.tabId;
      const requests = requestsMap.get(tabId) || [];
      console.log('[Teamber Background] Envoi de', requests.length, 'requêtes pour tabId', tabId);
      sendResponse({ requests });
      return true;
    }
    
    if (message.type === 'clearRequests') {
      const tabId = message.tabId;
      clearTab(tabId);
      sendResponse({ success: true });
      return true;
    }
  });
  
  // Nettoyer quand un onglet est fermé
  b.tabs.onRemoved.addListener((tabId) => {
    clearTab(tabId);
  });
  
  // Charger les requêtes au démarrage
  loadRequests();
  
  console.log('[Teamber Background] Background script démarré (Chrome:', IS_CHROME, ')');
})();
