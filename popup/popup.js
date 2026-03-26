// Popup script for Boxed Price Overlay

document.addEventListener('DOMContentLoaded', async () => {
  // Get stats
  try {
    const response = await chrome.runtime.sendMessage({ type: 'GET_STATS' });
    if (response && response.ok) {
      document.getElementById('cached-count').textContent = response.cached;
    }
  } catch (e) {
    document.getElementById('status').textContent = 'Inactive';
    document.getElementById('status').style.color = '#ef4444';
  }

  // Rescan button
  document.getElementById('rescan-btn').addEventListener('click', async () => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab) {
      await chrome.tabs.sendMessage(tab.id, { type: 'RESCAN' });
      window.close();
    }
  });

  // Clear cache button
  document.getElementById('clear-cache-btn').addEventListener('click', async () => {
    await chrome.runtime.sendMessage({ type: 'CLEAR_CACHE' });
    document.getElementById('cached-count').textContent = '0';
  });
});
