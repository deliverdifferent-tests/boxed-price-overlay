/**
 * Content script for Boxed Price Overlay.
 * Runs on boxed.gg/marketplace pages.
 * 
 * Scans marketplace card tiles, parses titles, resolves prices,
 * and injects overlay UI into each card.
 */

// Import parser (loaded as separate script? No — MV3 content scripts are single-file.
// We inline the parser and resolver functions here, or bundle.
// For V1 simplicity: include parser.js and resolver.js in manifest content_scripts array.
// Actually MV3 supports multiple JS files in content_scripts — let's use that.)

const SCAN_DEBOUNCE_MS = 500;
const BATCH_SIZE = 5;
const BATCH_DELAY_MS = 1200;

let processedTiles = new WeakSet();
let scanTimeout = null;
let extensionEnabled = true;

// Load saved enabled state
chrome.storage.local.get('bpo_enabled', (data) => {
  extensionEnabled = data.bpo_enabled !== false;
});

/**
 * Find the marketplace grid container.
 */
function findMarketplaceGrid() {
  // Primary: class-based selector from Dane's inspection
  const grid = document.querySelector('.marketplace-grid');
  if (grid) return grid;
  
  // Fallback: look for scrollable grid containers
  const candidates = document.querySelectorAll('[class*="marketplace"], [class*="grid"]');
  for (const el of candidates) {
    if (el.children.length > 3 && el.scrollHeight > el.clientHeight) {
      return el;
    }
  }
  
  return null;
}

/**
 * Find all card tiles in the marketplace grid.
 */
function findCardTiles(grid) {
  if (!grid) return [];
  // Direct children of the grid are card tiles
  return Array.from(grid.children).filter(el => {
    // Must have some content and not already be an overlay element
    return el.children.length > 0 && !el.classList.contains('bpo-overlay');
  });
}

/**
 * Extract the title text from a card tile.
 */
function extractTitle(tile) {
  // Primary: .line-clamp-3 is the title node observed by Dane
  const titleNode = tile.querySelector('.line-clamp-3');
  if (titleNode) return titleNode.textContent.trim();
  
  // Fallback: look for any text node with grade company names
  const allText = tile.querySelectorAll('div, span, p');
  for (const el of allText) {
    const text = el.textContent.trim();
    if (text.length > 20 && /\b(PSA|CGC|BGS)\s+\d/i.test(text)) {
      return text;
    }
  }
  
  return null;
}

/**
 * Create the overlay DOM element.
 */
function createOverlayElement(result, parsed) {
  const overlay = document.createElement('div');
  overlay.className = 'bpo-overlay';
  
  if (result.status === 'loading') {
    overlay.classList.add('bpo-loading');
    overlay.innerHTML = '<span class="bpo-loading-text">Loading prices…</span>';
    return overlay;
  }

  if (result.status === 'error' || result.status === 'search_only') {
    const pcUrl = result.sourceUrl || buildPriceChartingSearchUrl(parsed);
    
    overlay.innerHTML = `
      <div class="bpo-footer" style="border-top:none;padding-top:0;">
        <span class="bpo-confidence bpo-weak">${parsed.confidence || 'lookup'}</span>
        <a class="bpo-source-link" href="${pcUrl}" target="_blank" rel="noopener">PriceCharting ↗</a>
        <span class="bpo-retry-btn" title="Retry lookup">🔄</span>
      </div>
    `;
    
    // Wire retry button
    overlay.querySelector('.bpo-retry-btn').addEventListener('click', async (e) => {
      e.stopPropagation();
      // Clear this card's cache
      const cacheKey = makeCacheKey(parsed);
      await chrome.storage.local.remove(cacheKey);
      // Remove overlay and re-process
      const tile = overlay.closest('.marketplace-grid > *') || overlay.parentElement;
      if (overlay._hiddenLangBar) overlay._hiddenLangBar.style.display = '';
      overlay.remove();
      processedTiles.delete(tile);
      processTile(tile);
    });
    
    return overlay;
  }

  if (result.status === 'no_match' || !result.prices || Object.keys(result.prices).length === 0) {
    const searchUrl = buildPriceChartingSearchUrl(parsed);
    overlay.innerHTML = `
      <span class="bpo-no-match">No price match found</span>
      <div class="bpo-footer">
        <span class="bpo-confidence bpo-no_match">no match</span>
        <a class="bpo-source-link" href="${searchUrl}" target="_blank" rel="noopener">Search PriceCharting ↗</a>
      </div>
    `;
    return overlay;
  }

  // Build prices display
  const prices = result.prices;
  const company = parsed.gradeCompany || 'PSA';
  const isCompanyPSA = company === 'PSA';
  const isCompanyCGC = company === 'CGC';
  
  let priceHtml = '<div class="bpo-prices">';
  
  // Raw price
  priceHtml += priceItem('Raw', prices.raw);
  
  // Primary company prices (the one matching the card's grading)
  if (isCompanyPSA || (!isCompanyCGC)) {
    priceHtml += priceItem('PSA 8', prices.psa8);
    priceHtml += priceItem('PSA 9', prices.psa9);
    priceHtml += priceItem('PSA 10', prices.psa10, true);
  }
  
  if (isCompanyCGC) {
    priceHtml += priceItem('CGC 8', prices.cgc8);
    priceHtml += priceItem('CGC 9', prices.cgc9);
    priceHtml += priceItem('CGC 10', prices.cgc10, true);
  }
  
  // Show alternate company if available and not primary
  if (isCompanyPSA && (prices.cgc9 || prices.cgc10)) {
    priceHtml += '<span class="bpo-sep">|</span>';
    priceHtml += priceItem('CGC 9', prices.cgc9);
    priceHtml += priceItem('CGC 10', prices.cgc10);
  } else if (isCompanyCGC && (prices.psa9 || prices.psa10)) {
    priceHtml += '<span class="bpo-sep">|</span>';
    priceHtml += priceItem('PSA 9', prices.psa9);
    priceHtml += priceItem('PSA 10', prices.psa10);
  }
  
  priceHtml += '</div>';

  // Footer with confidence + link
  const sourceUrl = result.sourceUrl || buildPriceChartingSearchUrl(parsed);
  const confidenceClass = result.confidence || 'weak';
  
  overlay.innerHTML = `
    ${priceHtml}
    <div class="bpo-footer">
      <span class="bpo-confidence bpo-${confidenceClass}">${confidenceClass}</span>
      ${result.matchedTitle ? `<span style="font-size:9px;color:#666;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;margin:0 4px;" title="${escapeHtml(result.matchedTitle)}">${escapeHtml(truncate(result.matchedTitle, 30))}</span>` : ''}
      <a class="bpo-source-link" href="${sourceUrl}" target="_blank" rel="noopener">PriceCharting ↗</a>
      <span class="bpo-retry-btn" title="Refresh prices">🔄</span>
    </div>
  `;

  return overlay;
}

/**
 * Helper: render a single price item.
 */
function priceItem(label, value, isPrimary = false) {
  if (value === null || value === undefined) {
    return `<span class="bpo-price-item"><span class="bpo-price-label">${label}</span><span class="bpo-price-value bpo-na">—</span></span>`;
  }
  const cls = isPrimary ? 'bpo-price-value bpo-primary' : 'bpo-price-value';
  return `<span class="bpo-price-item"><span class="bpo-price-label">${label}</span><span class="${cls}">$${value.toFixed(0)}</span></span>`;
}

function escapeHtml(str) {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function truncate(str, len) {
  return str.length > len ? str.slice(0, len) + '…' : str;
}

/**
 * Process a single card tile.
 */
async function processTile(tile) {
  if (processedTiles.has(tile)) return;
  processedTiles.add(tile);

  const title = extractTitle(tile);
  if (!title) return;

  const parsed = parseCardTitle(title);
  if (!parsed) {
    console.warn('[BoxedOverlay] Could not parse title:', title);
    return;
  }
  console.log('[BoxedOverlay] Parsed:', parsed.cardName, '#' + parsed.cardNumber, parsed.gradeCompany, parsed.gradeValue, '| confidence:', parsed.confidence, '| raw:', title.substring(0, 80));

  // Try to replace the "Pokémon (English)" / "Pokémon (Japanese)" bar with the overlay
  // Look for the language indicator element
  const langBar = tile.querySelector('.text-light-2');
  const langParent = langBar ? langBar.closest('div, span, p') : null;
  
  const loadingOverlay = createOverlayElement({ status: 'loading' }, parsed);
  
  if (langParent && langParent !== tile) {
    // Replace the language bar's parent container with our overlay
    langParent.parentNode.insertBefore(loadingOverlay, langParent);
    langParent.style.display = 'none';
    loadingOverlay._hiddenLangBar = langParent;
  } else if (langBar) {
    // Replace just the language span area
    langBar.parentNode.insertBefore(loadingOverlay, langBar);
    langBar.style.display = 'none';
    loadingOverlay._hiddenLangBar = langBar;
  } else {
    // Fallback: append to card
    tile.appendChild(loadingOverlay);
  }

  try {
    // Resolve prices
    const result = await resolvePrices(parsed);
    
    // Replace loading overlay with real data
    const realOverlay = createOverlayElement(result, parsed);
    realOverlay._hiddenLangBar = loadingOverlay._hiddenLangBar;
    loadingOverlay.replaceWith(realOverlay);
    
    // Wire retry button on successful overlays
    const retryBtn = realOverlay.querySelector('.bpo-retry-btn');
    if (retryBtn && !retryBtn._wired) {
      retryBtn._wired = true;
      retryBtn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const cacheKey = makeCacheKey(parsed);
        await chrome.storage.local.remove(cacheKey);
        const parentTile = realOverlay.closest('.marketplace-grid > *') || realOverlay.parentElement;
        if (realOverlay._hiddenLangBar) realOverlay._hiddenLangBar.style.display = '';
        realOverlay.remove();
        processedTiles.delete(parentTile);
        processTile(parentTile);
      });
    }
  } catch (err) {
    console.error('[BoxedOverlay] Error processing tile:', err);
    const errorOverlay = createOverlayElement({ status: 'error', sourceUrl: buildPriceChartingSearchUrl(parsed) }, parsed);
    loadingOverlay.replaceWith(errorOverlay);
  }
}

/**
 * Scan and process all visible cards in batches.
 */
async function scanAndProcess() {
  const grid = findMarketplaceGrid();
  if (!grid) {
    console.log('[BoxedOverlay] Marketplace grid not found, retrying in 2s...');
    setTimeout(scanAndProcess, 2000);
    return;
  }

  const tiles = findCardTiles(grid);
  if (!extensionEnabled) return;

  const unprocessed = tiles.filter(t => !processedTiles.has(t));
  
  if (unprocessed.length === 0) return;

  console.log(`[BoxedOverlay] Processing ${unprocessed.length} new card tiles`);

  // Process in batches to avoid hammering
  for (let i = 0; i < unprocessed.length; i += BATCH_SIZE) {
    const batch = unprocessed.slice(i, i + BATCH_SIZE);
    await Promise.all(batch.map(tile => processTile(tile)));
    
    if (i + BATCH_SIZE < unprocessed.length) {
      await new Promise(r => setTimeout(r, BATCH_DELAY_MS));
    }
  }
}

/**
 * Debounced scan trigger.
 */
function triggerScan() {
  if (scanTimeout) clearTimeout(scanTimeout);
  scanTimeout = setTimeout(scanAndProcess, SCAN_DEBOUNCE_MS);
}

/**
 * Set up MutationObserver to watch for new cards (infinite scroll, filtering).
 */
function setupObserver() {
  const grid = findMarketplaceGrid();
  if (!grid) {
    // Retry until grid appears
    setTimeout(setupObserver, 1000);
    return;
  }

  const observer = new MutationObserver((mutations) => {
    let hasNewNodes = false;
    for (const mutation of mutations) {
      if (mutation.addedNodes.length > 0) {
        hasNewNodes = true;
        break;
      }
    }
    if (hasNewNodes) {
      triggerScan();
    }
  });

  observer.observe(grid, { childList: true });
  console.log('[BoxedOverlay] MutationObserver attached to marketplace grid');
}

/**
 * Initialize the extension.
 */
function init() {
  console.log('[BoxedOverlay] Initializing on', window.location.href);
  
  // Watch for new cards
  setupObserver();
  
  // Retry initial scan — Boxed.gg renders cards asynchronously
  let retries = 0;
  const maxRetries = 20;
  
  function tryInitialScan() {
    const grid = findMarketplaceGrid();
    const tiles = grid ? findCardTiles(grid) : [];
    const unprocessed = tiles.filter(t => !processedTiles.has(t));
    
    if (unprocessed.length > 0) {
      console.log(`[BoxedOverlay] Found ${unprocessed.length} cards on attempt ${retries + 1}`);
      scanAndProcess();
    } else if (retries < maxRetries) {
      retries++;
      setTimeout(tryInitialScan, 800);
    } else {
      console.log('[BoxedOverlay] No cards found after', maxRetries, 'attempts — waiting for scroll/mutations');
    }
  }
  
  tryInitialScan();
  
  // Also re-scan on scroll (backup for lazy-loaded content)
  let scrollTimeout;
  window.addEventListener('scroll', () => {
    if (scrollTimeout) clearTimeout(scrollTimeout);
    scrollTimeout = setTimeout(triggerScan, 800);
  }, { passive: true });
}

// Listen for messages from popup
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'RESCAN') {
    processedTiles = new WeakSet();
    document.querySelectorAll('.bpo-overlay').forEach(el => el.remove());
    if (extensionEnabled) scanAndProcess();
    sendResponse({ ok: true });
  }
  if (message.type === 'SET_ENABLED') {
    extensionEnabled = message.enabled;
    if (!extensionEnabled) {
      // Hide all overlays, restore language bars
      document.querySelectorAll('.bpo-overlay').forEach(el => {
        el.style.display = 'none';
        if (el._hiddenLangBar) el._hiddenLangBar.style.display = '';
      });
    } else {
      // Show overlays, hide language bars again
      document.querySelectorAll('.bpo-overlay').forEach(el => {
        el.style.display = '';
        if (el._hiddenLangBar) el._hiddenLangBar.style.display = 'none';
      });
      scanAndProcess();
    }
    sendResponse({ ok: true });
  }
});

// Wait for DOM to be ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => setTimeout(init, 500));
} else {
  setTimeout(init, 500);
}
