/**
 * Price resolver — fetches pricing data from PriceCharting.
 * 
 * V1: Direct search + scrape approach.
 * V2: Will move to a backend resolver for better matching + caching.
 */

const CACHE_TTL_MS = 4 * 60 * 60 * 1000; // 4 hours
const MAX_CONCURRENT = 3;
const REQUEST_DELAY_MS = 800; // Be polite to PriceCharting

let requestQueue = [];
let activeRequests = 0;

/**
 * Check cache for a previously resolved card.
 */
async function getCached(cacheKey) {
  try {
    const data = await chrome.storage.local.get(cacheKey);
    if (data[cacheKey]) {
      const entry = data[cacheKey];
      if (Date.now() - entry.timestamp < CACHE_TTL_MS) {
        return entry;
      }
    }
  } catch (e) {
    console.warn('[BoxedOverlay] Cache read error:', e);
  }
  return null;
}

/**
 * Write to cache.
 */
async function setCache(cacheKey, value) {
  try {
    const entry = { ...value, timestamp: Date.now() };
    await chrome.storage.local.set({ [cacheKey]: entry });
  } catch (e) {
    console.warn('[BoxedOverlay] Cache write error:', e);
  }
}

/**
 * Generate a cache key from parsed card data.
 */
function makeCacheKey(parsed) {
  const parts = [
    parsed.year || '',
    parsed.franchise || '',
    parsed.language || '',
    parsed.setOrSeries || '',
    parsed.cardName || '',
    parsed.cardNumber || '',
  ];
  return 'bpo_' + parts.join('|').toLowerCase().replace(/\s+/g, '_');
}

/**
 * Resolve prices for a parsed card by searching PriceCharting.
 * Returns a price result object.
 */
async function resolvePrices(parsed) {
  if (!parsed || parsed.confidence === 'weak') {
    return { status: 'no_match', confidence: 'weak', prices: {} };
  }

  const cacheKey = makeCacheKey(parsed);
  const cached = await getCached(cacheKey);
  if (cached) {
    return cached;
  }

  // Build search URL
  const searchUrl = buildPriceChartingSearchUrl(parsed);
  
  try {
    // Use background script to fetch (avoids CORS)
    const response = await chrome.runtime.sendMessage({
      type: 'FETCH_URL',
      url: searchUrl
    });

    if (!response || !response.ok) {
      return { status: 'error', confidence: 'weak', prices: {}, sourceUrl: searchUrl };
    }

    const html = response.body;
    
    // Parse the search results page
    const result = parseSearchResults(html, parsed);
    result.sourceUrl = searchUrl;
    
    // If we got a direct product page URL, fetch that too for detailed prices
    if (result.productUrl) {
      const productResponse = await chrome.runtime.sendMessage({
        type: 'FETCH_URL',
        url: result.productUrl
      });
      
      if (productResponse && productResponse.ok) {
        const detailedPrices = parseProductPage(productResponse.body, parsed);
        result.prices = { ...result.prices, ...detailedPrices };
        result.sourceUrl = result.productUrl;
      }
    }

    // Cache the result
    await setCache(cacheKey, result);
    
    return result;
  } catch (e) {
    console.error('[BoxedOverlay] Resolve error:', e);
    return { status: 'error', confidence: 'weak', prices: {}, sourceUrl: searchUrl };
  }
}

/**
 * Parse PriceCharting search results HTML.
 */
function parseSearchResults(html, parsed) {
  const result = {
    status: 'no_match',
    confidence: 'weak',
    prices: {},
    productUrl: null,
    matchedTitle: null
  };

  // Create a DOM parser
  const parser = new DOMParser();
  const doc = parser.parseFromString(html, 'text/html');
  
  // Look for product links in search results
  const productLinks = doc.querySelectorAll('.offer a, .product a, table.ranking a, #games_table a');
  
  if (productLinks.length === 0) {
    // Maybe we landed directly on a product page
    const priceElements = doc.querySelectorAll('#used_price .price, #complete_price .price, .price-block .price');
    if (priceElements.length > 0) {
      result.status = 'ok';
      result.confidence = parsed.confidence;
      result.prices = extractPricesFromProductDoc(doc);
      result.matchedTitle = doc.querySelector('h1')?.textContent?.trim();
      return result;
    }
    return result;
  }

  // Find best matching result
  let bestMatch = null;
  let bestScore = 0;

  for (const link of productLinks) {
    const text = link.textContent.trim().toLowerCase();
    const score = matchScore(text, parsed);
    if (score > bestScore) {
      bestScore = score;
      bestMatch = link;
    }
  }

  if (bestMatch && bestScore > 2) {
    result.productUrl = bestMatch.href.startsWith('http') 
      ? bestMatch.href 
      : `https://www.pricecharting.com${bestMatch.getAttribute('href')}`;
    result.matchedTitle = bestMatch.textContent.trim();
    result.status = 'ok';
    result.confidence = bestScore >= 4 ? 'exact' : 'likely';
  }

  return result;
}

/**
 * Score how well a search result matches our parsed card.
 */
function matchScore(resultText, parsed) {
  let score = 0;
  const text = resultText.toLowerCase();
  
  if (parsed.cardName && text.includes(parsed.cardName.toLowerCase())) score += 2;
  if (parsed.cardNumber && text.includes(parsed.cardNumber)) score += 2;
  if (parsed.year && text.includes(parsed.year.toString())) score += 1;
  if (parsed.setOrSeries) {
    const setWords = parsed.setOrSeries.toLowerCase().split(' ');
    const matchedWords = setWords.filter(w => w.length > 2 && text.includes(w));
    score += matchedWords.length * 0.5;
  }
  if (parsed.language === 'Japanese' && text.includes('japanese')) score += 1;
  
  return score;
}

/**
 * Extract prices from a PriceCharting product page.
 */
function parseProductPage(html, parsed) {
  const parser = new DOMParser();
  const doc = parser.parseFromString(html, 'text/html');
  return extractPricesFromProductDoc(doc);
}

/**
 * Extract price data from a parsed product page document.
 */
function extractPricesFromProductDoc(doc) {
  const prices = {};
  
  // PriceCharting shows prices in various formats
  // Look for specific grade prices
  const priceIds = {
    'ungraded': ['#used_price .price', '#complete_price .price'],
    'psa10': ['#graded_price .price'],
  };
  
  // Try to get the ungraded/raw price
  const rawPriceEl = doc.querySelector('#used_price .price, #complete_price .price, .price:first-of-type');
  if (rawPriceEl) {
    prices.raw = parsePriceText(rawPriceEl.textContent);
  }

  // Look for graded prices in the grade table
  const gradeRows = doc.querySelectorAll('.grade-table tr, #graded-prices tr, table tr');
  for (const row of gradeRows) {
    const cells = row.querySelectorAll('td, th');
    if (cells.length >= 2) {
      const label = cells[0].textContent.trim().toLowerCase();
      const priceText = cells[cells.length - 1].textContent.trim();
      const price = parsePriceText(priceText);
      
      if (price !== null) {
        if (label.includes('psa 10') || label.includes('psa10') || label === '10') prices.psa10 = price;
        else if (label.includes('psa 9') || label.includes('psa9') || label === '9') prices.psa9 = price;
        else if (label.includes('psa 8') || label.includes('psa8') || label === '8') prices.psa8 = price;
        else if (label.includes('psa 7') || label.includes('psa7') || label === '7') prices.psa7 = price;
        else if (label.includes('cgc 10') || label.includes('cgc10')) prices.cgc10 = price;
        else if (label.includes('cgc 9') || label.includes('cgc9')) prices.cgc9 = price;
        else if (label.includes('cgc 8') || label.includes('cgc8')) prices.cgc8 = price;
        else if (label.includes('bgs 10') || label.includes('bgs10')) prices.bgs10 = price;
        else if (label.includes('bgs 9') || label.includes('bgs9')) prices.bgs9 = price;
        else if (label.includes('ungraded') || label.includes('raw')) prices.raw = price;
      }
    }
  }

  // Also check for specific price elements by selector patterns
  const allPriceSpans = doc.querySelectorAll('.price, [class*="price"]');
  for (const span of allPriceSpans) {
    const parentText = span.parentElement?.textContent?.toLowerCase() || '';
    const price = parsePriceText(span.textContent);
    if (price !== null) {
      if (parentText.includes('psa 10') && !prices.psa10) prices.psa10 = price;
      if (parentText.includes('psa 9') && !prices.psa9) prices.psa9 = price;
      if (parentText.includes('psa 8') && !prices.psa8) prices.psa8 = price;
      if (parentText.includes('cgc 10') && !prices.cgc10) prices.cgc10 = price;
      if (parentText.includes('cgc 9') && !prices.cgc9) prices.cgc9 = price;
      if (parentText.includes('cgc 8') && !prices.cgc8) prices.cgc8 = price;
    }
  }

  return prices;
}

/**
 * Parse a price string like "$42.00" or "42" into a number.
 */
function parsePriceText(text) {
  if (!text) return null;
  const cleaned = text.replace(/[^0-9.,]/g, '').replace(',', '');
  const num = parseFloat(cleaned);
  return isNaN(num) ? null : num;
}

// Export for content script
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { resolvePrices, makeCacheKey, parsePriceText, matchScore };
}
