/**
 * Deal Scanner — auto-scans cards as you scroll and tracks best deals.
 * 
 * Throttled to avoid hammering PriceCharting.
 * Maintains a leaderboard of best deals found.
 */

const SCAN_RATE_MS = 3000; // One card every 3 seconds
const MAX_DEALS = 20; // Track top 20 deals

let scannerEnabled = false;
let scannerQueue = [];
let scannerProcessing = false;
let deals = [];
let scannedCount = 0;
let leaderboardEl = null;

// Default gem rate: 2500 gems = $20 → 1 gem = $0.008
let gemRate = 0.008;

// Load settings
chrome.storage.local.get(['bpo_scanner_enabled', 'bpo_gem_rate'], (data) => {
  scannerEnabled = data.bpo_scanner_enabled === true;
  if (data.bpo_gem_rate) gemRate = data.bpo_gem_rate;
  if (scannerEnabled) {
    createLeaderboard();
    startScanner();
  }
});

// Listen for settings changes
chrome.storage.onChanged.addListener((changes) => {
  if (changes.bpo_scanner_enabled) {
    scannerEnabled = changes.bpo_scanner_enabled.newValue === true;
    if (scannerEnabled) {
      createLeaderboard();
      startScanner();
    } else {
      removeLeaderboard();
      stopScanner();
    }
  }
  if (changes.bpo_gem_rate) {
    gemRate = changes.bpo_gem_rate.newValue || 0.008;
    // Recalculate existing deals with new rate
    recalculateDeals();
  }
});

/**
 * Extract gem price from a card tile.
 * Looks for price text containing numbers near gem icons/text.
 */
function extractGemPrice(tile) {
  // Look for elements with gem-like content
  const allEls = tile.querySelectorAll('span, div, p');
  
  for (const el of allEls) {
    const text = el.textContent.trim();
    
    // Match patterns like "2,500", "2500", "12,345" that look like gem prices
    // Usually near the bottom of the card, larger text, with comma formatting
    // Skip elements that are part of our overlay
    if (el.closest('.bpo-overlay') || el.closest('.bpo-lookup-btn')) continue;
    
    // Look for standalone numbers (gem prices are usually just a number)
    const match = text.match(/^[\s]*([0-9,]+(?:\.\d{2})?)[\s]*$/);
    if (match) {
      const num = parseFloat(match[1].replace(/,/g, ''));
      // Gem prices on boxed.gg are typically 100-500,000 range
      if (num >= 50 && num <= 1000000) {
        return num;
      }
    }
  }
  
  // Fallback: look for any large number in the tile that's not a year or card number
  for (const el of allEls) {
    if (el.closest('.bpo-overlay') || el.closest('.bpo-lookup-btn')) continue;
    const text = el.textContent.trim();
    const nums = text.match(/([0-9,]{3,})/g);
    if (nums) {
      for (const n of nums) {
        const val = parseFloat(n.replace(/,/g, ''));
        if (val >= 100 && val <= 1000000) {
          return val;
        }
      }
    }
  }
  
  return null;
}

/**
 * Queue a tile for deal scoring.
 * The scanner piggybacks off the auto-loader's cache — it does NOT fetch on its own.
 */
function queueForScan(tile) {
  if (!scannerEnabled) return;
  if (tile._scanQueued || tile._scanDone) return;
  tile._scanQueued = true;
  scannerQueue.push(tile);
}

/**
 * Process the scan queue — reads from cache only, no new fetches.
 * The auto-loader in content.js handles all fetching.
 */
async function processQueue() {
  if (!scannerEnabled || scannerProcessing) return;
  scannerProcessing = true;
  
  while (scannerQueue.length > 0 && scannerEnabled) {
    const tile = scannerQueue.shift();
    if (tile._scanDone) continue;
    
    const title = extractTitle(tile);
    if (!title) { tile._scanDone = true; continue; }
    
    const parsed = parseCardTitle(title);
    if (!parsed) { tile._scanDone = true; continue; }
    
    const gemPrice = extractGemPrice(tile);
    
    // Only use cached results — don't trigger new fetches
    const cacheKey = makeCacheKey(parsed);
    const cached = await getCached(cacheKey);
    
    if (cached && cached.status === 'ok' && cached.prices && gemPrice) {
      tile._scanDone = true;
      scannedCount++;
      
      const matchPrice = getMatchingPrice(cached.prices, parsed);
      
      if (matchPrice !== null && gemPrice > 0) {
        const gemUsd = gemPrice * gemRate;
        const spread = matchPrice - gemUsd;
        const pctDeviation = ((matchPrice - gemUsd) / matchPrice) * 100;
        
        const deal = {
          title: title.substring(0, 60),
          cardName: parsed.cardName || 'Unknown',
          cardNumber: parsed.cardNumber,
          gradeCompany: parsed.gradeCompany,
          gradeValue: parsed.gradeValue,
          gemPrice,
          gemUsd: Math.round(gemUsd * 100) / 100,
          marketPrice: matchPrice,
          spread: Math.round(spread * 100) / 100,
          pctDeviation: Math.round(pctDeviation * 10) / 10,
          isUnderpriced: gemUsd < matchPrice,
          tile
        };
        
        deals.push(deal);
        deals.sort((a, b) => b.pctDeviation - a.pctDeviation);
        if (deals.length > MAX_DEALS) deals = deals.slice(0, MAX_DEALS);
        
        addDealBadge(tile, deal);
      }
      
      updateLeaderboard();
    } else if (!cached) {
      // Not cached yet — re-queue to check later
      tile._scanQueued = false;
      tile._scanDone = false;
    } else {
      tile._scanDone = true;
      scannedCount++;
      updateLeaderboard();
    }
    
    // Small delay between checks
    await new Promise(r => setTimeout(r, 200));
  }
  
  scannerProcessing = false;
  
  // Re-check unfinished tiles after a delay (waiting for auto-loader to cache them)
  const unfinished = document.querySelectorAll('.marketplace-grid > *');
  let hasUnscanned = false;
  unfinished.forEach(t => {
    if (!t._scanDone && !t._scanQueued) hasUnscanned = true;
  });
  if (hasUnscanned && scannerEnabled) {
    setTimeout(() => {
      const grid = findMarketplaceGrid();
      if (grid) {
        findCardTiles(grid).forEach(t => queueForScan(t));
        processQueue();
      }
    }, 3000);
  }
}

/**
 * Get the price matching the card's grade.
 */
function getMatchingPrice(prices, parsed) {
  const company = (parsed.gradeCompany || 'PSA').toLowerCase();
  const grade = parsed.gradeValue;
  
  // Try exact match first
  const key = `${company}${grade}`;
  if (prices[key] !== undefined && prices[key] !== null) return prices[key];
  
  // Try common patterns
  const tryKeys = [
    `${company}${grade}`,
    `${company}${Math.floor(grade)}`,
  ];
  
  for (const k of tryKeys) {
    if (prices[k] !== undefined && prices[k] !== null) return prices[k];
  }
  
  // Fallback to raw
  if (prices.raw !== undefined && prices.raw !== null) return prices.raw;
  
  // Fallback to any available price
  const vals = Object.values(prices).filter(v => v !== null && v !== undefined);
  return vals.length > 0 ? vals[0] : null;
}

/**
 * Add a deal badge to a card tile.
 */
function addDealBadge(tile, deal) {
  // Remove existing badge
  const existing = tile.querySelector('.bpo-deal-badge');
  if (existing) existing.remove();
  
  const badge = document.createElement('div');
  badge.className = 'bpo-deal-badge';
  
  if (deal.isUnderpriced) {
    badge.classList.add('bpo-deal-good');
    badge.innerHTML = `↓ ${Math.abs(deal.pctDeviation)}% below <span class="bpo-deal-spread">(-$${Math.abs(deal.spread)})</span>`;
  } else {
    badge.classList.add('bpo-deal-bad');
    badge.innerHTML = `↑ ${Math.abs(deal.pctDeviation)}% above <span class="bpo-deal-spread">(+$${Math.abs(deal.spread)})</span>`;
  }
  
  tile.style.position = 'relative';
  tile.appendChild(badge);
}

/**
 * Create the floating leaderboard.
 */
function createLeaderboard() {
  if (leaderboardEl) return;
  
  leaderboardEl = document.createElement('div');
  leaderboardEl.className = 'bpo-leaderboard';
  leaderboardEl.innerHTML = `
    <div class="bpo-lb-header">
      <span class="bpo-lb-title">🔥 DEAL SCANNER</span>
      <span class="bpo-lb-minimize" title="Minimize">−</span>
    </div>
    <div class="bpo-lb-body">
      <div class="bpo-lb-stats">Scanned: 0 | Deals: 0</div>
      <div class="bpo-lb-list"></div>
    </div>
  `;
  
  document.body.appendChild(leaderboardEl);
  
  // Minimize toggle
  let minimized = false;
  leaderboardEl.querySelector('.bpo-lb-minimize').addEventListener('click', () => {
    minimized = !minimized;
    leaderboardEl.querySelector('.bpo-lb-body').style.display = minimized ? 'none' : '';
    leaderboardEl.querySelector('.bpo-lb-minimize').textContent = minimized ? '+' : '−';
  });
  
  // Make draggable
  makeDraggable(leaderboardEl, leaderboardEl.querySelector('.bpo-lb-header'));
}

/**
 * Remove the leaderboard.
 */
function removeLeaderboard() {
  if (leaderboardEl) {
    leaderboardEl.remove();
    leaderboardEl = null;
  }
}

/**
 * Update the leaderboard display.
 */
function updateLeaderboard() {
  if (!leaderboardEl) return;
  
  const statsEl = leaderboardEl.querySelector('.bpo-lb-stats');
  const listEl = leaderboardEl.querySelector('.bpo-lb-list');
  
  const dealCount = deals.filter(d => d.isUnderpriced).length;
  statsEl.textContent = `Scanned: ${scannedCount} | Deals: ${dealCount}`;
  
  // Show top 5 deals
  const topDeals = deals.filter(d => d.isUnderpriced).slice(0, 5);
  
  if (topDeals.length === 0) {
    listEl.innerHTML = '<div class="bpo-lb-empty">No deals found yet…</div>';
    return;
  }
  
  listEl.innerHTML = topDeals.map((d, i) => `
    <div class="bpo-lb-deal" data-idx="${i}">
      <span class="bpo-lb-rank">${i + 1}.</span>
      <span class="bpo-lb-name">${escapeHtml(d.cardName)}${d.cardNumber ? ' #' + d.cardNumber : ''}</span>
      <span class="bpo-lb-pct">↓${Math.abs(d.pctDeviation)}%</span>
      <span class="bpo-lb-spread">-$${Math.abs(d.spread)}</span>
    </div>
  `).join('');
  
  // Click to scroll to card
  listEl.querySelectorAll('.bpo-lb-deal').forEach(el => {
    el.addEventListener('click', () => {
      const idx = parseInt(el.dataset.idx);
      const deal = topDeals[idx];
      if (deal && deal.tile) {
        deal.tile.scrollIntoView({ behavior: 'smooth', block: 'center' });
        deal.tile.style.outline = '2px solid #ef4444';
        setTimeout(() => { deal.tile.style.outline = ''; }, 3000);
      }
    });
  });
}

/**
 * Make an element draggable.
 */
function makeDraggable(el, handle) {
  let isDragging = false;
  let offsetX, offsetY;
  
  handle.style.cursor = 'grab';
  
  handle.addEventListener('mousedown', (e) => {
    if (e.target.classList.contains('bpo-lb-minimize')) return;
    isDragging = true;
    offsetX = e.clientX - el.getBoundingClientRect().left;
    offsetY = e.clientY - el.getBoundingClientRect().top;
    handle.style.cursor = 'grabbing';
    e.preventDefault();
  });
  
  document.addEventListener('mousemove', (e) => {
    if (!isDragging) return;
    el.style.left = (e.clientX - offsetX) + 'px';
    el.style.top = (e.clientY - offsetY) + 'px';
    el.style.right = 'auto';
    el.style.bottom = 'auto';
  });
  
  document.addEventListener('mouseup', () => {
    isDragging = false;
    handle.style.cursor = 'grab';
  });
}

/**
 * Recalculate deals with updated gem rate.
 */
function recalculateDeals() {
  for (const deal of deals) {
    deal.gemUsd = Math.round(deal.gemPrice * gemRate * 100) / 100;
    deal.spread = Math.round((deal.marketPrice - deal.gemUsd) * 100) / 100;
    deal.pctDeviation = Math.round(((deal.marketPrice - deal.gemUsd) / deal.marketPrice) * 1000) / 10;
    deal.isUnderpriced = deal.gemUsd < deal.marketPrice;
  }
  deals.sort((a, b) => b.pctDeviation - a.pctDeviation);
  updateLeaderboard();
}

/**
 * Start the scanner — queue visible cards and watch for new ones.
 */
function startScanner() {
  if (!scannerEnabled) return;
  
  // Queue all existing unscanned tiles
  const grid = findMarketplaceGrid();
  if (grid) {
    const tiles = findCardTiles(grid);
    tiles.forEach(t => queueForScan(t));
  }
  
  // Start processing
  processQueue();
  
  // Watch for scroll to queue newly visible cards
  window.addEventListener('scroll', onScannerScroll, { passive: true });
}

function stopScanner() {
  window.removeEventListener('scroll', onScannerScroll);
  scannerQueue = [];
}

let scannerScrollTimeout;
function onScannerScroll() {
  if (!scannerEnabled) return;
  if (scannerScrollTimeout) clearTimeout(scannerScrollTimeout);
  scannerScrollTimeout = setTimeout(() => {
    const grid = findMarketplaceGrid();
    if (grid) {
      const tiles = findCardTiles(grid);
      tiles.forEach(t => queueForScan(t));
      if (!scannerProcessing) processQueue();
    }
  }, 500);
}

// Export
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { extractGemPrice, getMatchingPrice };
}
