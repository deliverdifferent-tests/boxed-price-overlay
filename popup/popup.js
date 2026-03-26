// Popup script for Boxed Price Overlay

document.addEventListener('DOMContentLoaded', async () => {
  const toggle = document.getElementById('enabled-toggle');
  const statusEl = document.getElementById('status');
  const scannerToggle = document.getElementById('scanner-toggle');
  const gemSettings = document.getElementById('gem-settings');
  const gemAmountInput = document.getElementById('gem-amount');
  const usdAmountInput = document.getElementById('usd-amount');
  const gemRateDisplay = document.getElementById('gem-rate-display');

  // Load saved state
  try {
    const data = await chrome.storage.local.get([
      'bpo_enabled', 'bpo_scanner_enabled', 'bpo_gem_rate',
      'bpo_gem_amount', 'bpo_usd_amount'
    ]);
    
    // Extension toggle
    const enabled = data.bpo_enabled !== false;
    toggle.checked = enabled;
    statusEl.textContent = enabled ? 'Active' : 'Paused';
    statusEl.style.color = enabled ? '#4ade80' : '#fbbf24';
    
    // Scanner toggle
    const scannerOn = data.bpo_scanner_enabled === true;
    scannerToggle.checked = scannerOn;
    gemSettings.style.display = scannerOn ? '' : 'none';
    
    // Gem rate
    if (data.bpo_gem_amount) gemAmountInput.value = data.bpo_gem_amount;
    if (data.bpo_usd_amount) usdAmountInput.value = data.bpo_usd_amount;
    updateRateDisplay();
  } catch (e) {}

  // Extension toggle handler
  toggle.addEventListener('change', async () => {
    const enabled = toggle.checked;
    await chrome.storage.local.set({ bpo_enabled: enabled });
    statusEl.textContent = enabled ? 'Active' : 'Paused';
    statusEl.style.color = enabled ? '#4ade80' : '#fbbf24';
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab) {
      try { await chrome.tabs.sendMessage(tab.id, { type: 'SET_ENABLED', enabled }); } catch (e) {}
    }
  });

  // Scanner toggle handler
  scannerToggle.addEventListener('change', async () => {
    const on = scannerToggle.checked;
    await chrome.storage.local.set({ bpo_scanner_enabled: on });
    gemSettings.style.display = on ? '' : 'none';
  });

  // Gem rate inputs
  function updateRateDisplay() {
    const gems = parseFloat(gemAmountInput.value) || 2500;
    const usd = parseFloat(usdAmountInput.value) || 20;
    const rate = usd / gems;
    gemRateDisplay.textContent = `1 gem = $${rate.toFixed(4)}`;
    return rate;
  }

  async function saveGemRate() {
    const gems = parseFloat(gemAmountInput.value) || 2500;
    const usd = parseFloat(usdAmountInput.value) || 20;
    const rate = usd / gems;
    await chrome.storage.local.set({
      bpo_gem_rate: rate,
      bpo_gem_amount: gems,
      bpo_usd_amount: usd
    });
    updateRateDisplay();
  }

  gemAmountInput.addEventListener('change', saveGemRate);
  usdAmountInput.addEventListener('change', saveGemRate);
  gemAmountInput.addEventListener('input', updateRateDisplay);
  usdAmountInput.addEventListener('input', updateRateDisplay);

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
      try { await chrome.tabs.sendMessage(tab.id, { type: 'RESCAN' }); } catch (e) {}
      window.close();
    }
  });

  // Clear cache button
  document.getElementById('clear-cache-btn').addEventListener('click', async () => {
    const data = await chrome.storage.local.get([
      'bpo_enabled', 'bpo_scanner_enabled', 'bpo_gem_rate',
      'bpo_gem_amount', 'bpo_usd_amount'
    ]);
    await chrome.runtime.sendMessage({ type: 'CLEAR_CACHE' });
    // Restore settings
    await chrome.storage.local.set(data);
    document.getElementById('cached-count').textContent = '0';
  });
});
