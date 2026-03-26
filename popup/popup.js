// Popup script for Boxed Price Overlay

document.addEventListener('DOMContentLoaded', async () => {
  const toggle = document.getElementById('enabled-toggle');
  const statusEl = document.getElementById('status');

  // Load saved state
  try {
    const data = await chrome.storage.local.get('bpo_enabled');
    const enabled = data.bpo_enabled !== false; // default true
    toggle.checked = enabled;
    statusEl.textContent = enabled ? 'Active' : 'Paused';
    statusEl.style.color = enabled ? '#4ade80' : '#fbbf24';
  } catch (e) {}

  // Toggle handler
  toggle.addEventListener('change', async () => {
    const enabled = toggle.checked;
    await chrome.storage.local.set({ bpo_enabled: enabled });
    statusEl.textContent = enabled ? 'Active' : 'Paused';
    statusEl.style.color = enabled ? '#4ade80' : '#fbbf24';

    // Tell content script
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab) {
      try {
        await chrome.tabs.sendMessage(tab.id, { type: 'SET_ENABLED', enabled });
      } catch (e) {}
    }
  });

  // Get stats
  try {
    const response = await chrome.runtime.sendMessage({ type: 'GET_STATS' });
    if (response && response.ok) {
      document.getElementById('cached-count').textContent = response.cached;
    }
  } catch (e) {
    statusEl.textContent = 'Inactive';
    statusEl.style.color = '#ef4444';
  }

  // Rescan button
  document.getElementById('rescan-btn').addEventListener('click', async () => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab) {
      try {
        await chrome.tabs.sendMessage(tab.id, { type: 'RESCAN' });
      } catch (e) {}
      window.close();
    }
  });

  // Clear cache button
  document.getElementById('clear-cache-btn').addEventListener('click', async () => {
    // Preserve the enabled setting
    const data = await chrome.storage.local.get('bpo_enabled');
    await chrome.runtime.sendMessage({ type: 'CLEAR_CACHE' });
    await chrome.storage.local.set({ bpo_enabled: data.bpo_enabled !== false });
    document.getElementById('cached-count').textContent = '0';
  });
});
