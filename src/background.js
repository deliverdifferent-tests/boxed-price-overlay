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
  try {
    const response = await fetch(url, {
      method: 'GET',
      credentials: 'omit',
      headers: {
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        'Cache-Control': 'no-cache',
        'Pragma': 'no-cache',
      }
    });
    
    if (!response.ok) {
      return { ok: false, status: response.status, body: '' };
    }
    
    const body = await response.text();
    return { ok: true, status: response.status, body };
  } catch (err) {
    return { ok: false, error: err.message, body: '' };
  }
}

// Log extension load
console.log('[BoxedOverlay] Background service worker loaded');
