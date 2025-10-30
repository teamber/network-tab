// background-chrome.js
// Service Worker pour Chrome MV3
// (webRequest n'est pas disponible en MV3, on utilise HAR polling côté panel)

(function() {
  'use strict';
  
  const STORAGE_KEY = 'teamber.network.requests';
  const MAX_REQUESTS = 200;
  
  // Structure pour stocker les requêtes par tabId
  const requestsMap = new Map(); // tabId -> Array of requests
  
  // Récupérer les requêtes stockées au démarrage
  async function loadRequests() {
    try {
      const result = await chrome.storage.local.get(STORAGE_KEY);
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
      await chrome.storage.local.set({ [STORAGE_KEY]: data });
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
  
  // Écouter les messages du panel
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
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
  chrome.tabs.onRemoved.addListener((tabId) => {
    clearTab(tabId);
  });
  
  // Charger les requêtes au démarrage
  loadRequests();
  
  console.log('[Teamber Background] Background script (MV3) démarré');
})();
