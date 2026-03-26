/**
 * Background service worker for Boxed Price Overlay.
 * Handles fetch requests from the content script to avoid CORS issues.
 */

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'FETCH_URL') {
    fetchUrl(message.url)
      .then(result => sendResponse(result))
      .catch(err => sendResponse({ ok: false, error: err.message }));
    return true; // Keep the message channel open for async response
  }
  
  if (message.type === 'CLEAR_CACHE') {
    chrome.storage.local.clear().then(() => {
      sendResponse({ ok: true });
    });
    return true;
  }

  if (message.type === 'GET_STATS') {
    chrome.storage.local.get(null).then(data => {
      const keys = Object.keys(data).filter(k => k.startsWith('bpo_'));
      sendResponse({ 
        ok: true, 
        cached: keys.length,
        totalKeys: Object.keys(data).length
      });
    });
    return true;
  }
});

async function fetchUrl(url) {
  // First try: normal fetch
  try {
    const response = await fetch(url, {
      method: 'GET',
      credentials: 'omit',
      headers: {
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
      }
    });
    
    if (response.ok) {
      const body = await response.text();
      return { ok: true, status: response.status, body };
    }
    
    // If 403, try the tab-based approach
    if (response.status === 403) {
      console.log('[BoxedOverlay] 403 from fetch, trying tab approach for:', url);
      return await fetchViaTab(url);
    }
    
    return { ok: false, status: response.status, body: '' };
  } catch (err) {
    console.log('[BoxedOverlay] Fetch error, trying tab approach:', err.message);
    return await fetchViaTab(url);
  }
}

/**
 * Fetch a URL by opening it in a hidden tab, reading the content, then closing.
 * This gets around 403 blocks because it's a real browser navigation.
 */
async function fetchViaTab(url) {
  return new Promise((resolve) => {
    // Timeout after 15 seconds
    const timeout = setTimeout(() => {
      resolve({ ok: false, error: 'Tab fetch timeout', body: '' });
    }, 15000);
    
    chrome.tabs.create({ url, active: false }, (tab) => {
      if (!tab || !tab.id) {
        clearTimeout(timeout);
        resolve({ ok: false, error: 'Failed to create tab', body: '' });
        return;
      }
      
      const tabId = tab.id;
      
      function onComplete(tabIdChanged, changeInfo) {
        if (tabIdChanged !== tabId || changeInfo.status !== 'complete') return;
        
        chrome.tabs.onUpdated.removeListener(onComplete);
        
        // Execute script to read the page HTML
        chrome.scripting.executeScript({
          target: { tabId },
          func: () => document.documentElement.outerHTML
        }, (results) => {
          clearTimeout(timeout);
          chrome.tabs.remove(tabId);
          
          if (results && results[0] && results[0].result) {
            resolve({ ok: true, status: 200, body: results[0].result });
          } else {
            resolve({ ok: false, error: 'Could not read tab content', body: '' });
          }
        });
      }
      
      chrome.tabs.onUpdated.addListener(onComplete);
    });
  });
}

// Log extension load
console.log('[BoxedOverlay] Background service worker loaded');
