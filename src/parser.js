/**
 * Title parser for Boxed.gg marketplace card titles.
 * 
 * Extracts structured fields from titles like:
 *   "1999 Pokemon Japanese Bandai Carddass Vending Series 5 Misty #192 PSA 10 GEM MINT"
 *   "2023 Pokemon Scarlet & Violet Promo 151 Elite Trainer Box Full Art Snorlax #51 PSA 10 GEM MINT"
 */

const GRADE_COMPANIES = ['PSA', 'CGC', 'BGS', 'SGC', 'ACE', 'TAG', 'MNT', 'AGS', 'GMA', 'ISA', 'PCA'];
const GRADE_FLUFF = ['GEM', 'MINT', 'GEM MINT', 'PRISTINE', 'PERFECT', 'NEAR MINT', 'NM', 'EX', 'EXCELLENT'];
const LANGUAGES = ['Japanese', 'English', 'Korean', 'Chinese', 'French', 'German', 'Italian', 'Spanish', 'Portuguese'];

/**
 * Parse a Boxed.gg card title into structured fields.
 * @param {string} rawTitle - The raw title text from the DOM
 * @returns {object} Parsed card data
 */
function parseCardTitle(rawTitle) {
  if (!rawTitle || typeof rawTitle !== 'string') {
    return null;
  }

  const title = rawTitle.trim();
  const result = {
    rawTitle: title,
    year: null,
    franchise: null,
    language: null,
    setOrSeries: null,
    cardName: null,
    cardNumber: null,
    gradeCompany: null,
    gradeValue: null,
    confidence: 'weak'
  };

  // --- Extract year (4-digit number at the start or near start) ---
  const yearMatch = title.match(/\b(19[5-9]\d|20[0-3]\d)\b/);
  if (yearMatch) {
    result.year = parseInt(yearMatch[1], 10);
  }

  // --- Extract franchise ---
  if (/\bPok[eé]mon\b/i.test(title) || /\bPokemon\b/i.test(title)) {
    result.franchise = 'Pokemon';
  }

  // --- Extract language ---
  for (const lang of LANGUAGES) {
    if (title.toLowerCase().includes(lang.toLowerCase())) {
      result.language = lang;
      break;
    }
  }
  if (!result.language) {
    result.language = 'English'; // default assumption
  }

  // --- Extract card number ---
  const cardNumMatch = title.match(/#(\d+)/);
  if (cardNumMatch) {
    result.cardNumber = cardNumMatch[1];
  }

  // --- Extract grading company and grade ---
  for (const company of GRADE_COMPANIES) {
    const gradeRegex = new RegExp(`\\b${company}\\s+(\\d+(?:\\.\\d+)?)\\b`, 'i');
    const gradeMatch = title.match(gradeRegex);
    if (gradeMatch) {
      result.gradeCompany = company.toUpperCase();
      result.gradeValue = parseFloat(gradeMatch[1]);
      break;
    }
  }

  // --- Extract card name and set ---
  // Strategy: everything between language/franchise markers and #number is set+name
  // Everything between #number and grade company is potential extra info
  let workingTitle = title;

  // Remove year
  if (result.year) {
    workingTitle = workingTitle.replace(result.year.toString(), '').trim();
  }

  // Remove franchise
  workingTitle = workingTitle.replace(/\bPok[eé]mon\b/gi, '').trim();

  // Remove language
  if (result.language && result.language !== 'English') {
    workingTitle = workingTitle.replace(new RegExp(`\\b${result.language}\\b`, 'gi'), '').trim();
  }

  // Remove grade section (company + number + fluff)
  if (result.gradeCompany) {
    const gradePattern = new RegExp(
      `\\b${result.gradeCompany}\\s+${result.gradeValue}\\b[\\s]*(${GRADE_FLUFF.join('|')})*`,
      'gi'
    );
    workingTitle = workingTitle.replace(gradePattern, '').trim();
  }

  // Remove card number
  if (result.cardNumber) {
    workingTitle = workingTitle.replace(`#${result.cardNumber}`, '').trim();
  }

  // Clean up extra whitespace
  workingTitle = workingTitle.replace(/\s+/g, ' ').trim();

  // The remaining text is set + card name
  // Heuristic: last 1-3 words before the card number position are likely the card name
  // Everything before that is the set/series
  const words = workingTitle.split(' ').filter(w => w.length > 0);
  
  if (words.length > 0) {
    // Try to identify card name vs set
    // Common patterns: set words tend to include series names, numbers, "Promo", "Elite", "Box"
    // Card names tend to be proper nouns (Pokemon names, trainer names)
    if (words.length <= 2) {
      result.cardName = words.join(' ');
      result.setOrSeries = '';
    } else {
      // Heuristic: last word or last two words are usually the card name
      // unless they're set-like words
      const setLikeWords = ['Series', 'Set', 'Box', 'Pack', 'Promo', 'Trainer', 'Elite', 'Collection', 'Tin', 'Art', 'Full', 'Illustration', 'Rare', 'Special', 'Booster', 'Theme', 'Deck'];
      
      let nameStartIdx = words.length - 1;
      
      // Walk backwards to find where the card name starts
      // Card names are typically 1-2 words that aren't set-like
      for (let i = words.length - 1; i >= Math.max(0, words.length - 3); i--) {
        if (setLikeWords.some(sw => words[i].toLowerCase() === sw.toLowerCase())) {
          nameStartIdx = i + 1;
          break;
        }
      }
      
      if (nameStartIdx >= words.length) {
        // All trailing words are set-like, take last word as name
        nameStartIdx = words.length - 1;
      }

      result.cardName = words.slice(nameStartIdx).join(' ');
      result.setOrSeries = words.slice(0, nameStartIdx).join(' ');
    }
  }

  // --- Confidence scoring ---
  let score = 0;
  if (result.year) score++;
  if (result.franchise) score++;
  if (result.cardNumber) score++;
  if (result.cardName) score++;
  if (result.gradeCompany) score++;
  if (result.gradeValue !== null) score++;

  if (score >= 5) result.confidence = 'exact';
  else if (score >= 3) result.confidence = 'likely';
  else result.confidence = 'weak';

  return result;
}

/**
 * Build a PriceCharting search query from parsed card data.
 * @param {object} parsed - Output from parseCardTitle
 * @returns {string} Search query string
 */
function buildSearchQuery(parsed) {
  if (!parsed) return '';
  
  const parts = [];
  if (parsed.year) parts.push(parsed.year.toString());
  if (parsed.franchise) parts.push(parsed.franchise);
  if (parsed.language && parsed.language !== 'English') parts.push(parsed.language);
  if (parsed.setOrSeries) parts.push(parsed.setOrSeries);
  if (parsed.cardName) parts.push(parsed.cardName);
  if (parsed.cardNumber) parts.push(`#${parsed.cardNumber}`);
  
  return parts.join(' ').replace(/\s+/g, ' ').trim();
}

/**
 * Build a PriceCharting URL for searching.
 * @param {object} parsed - Output from parseCardTitle
 * @returns {string} PriceCharting search URL
 */
function buildPriceChartingSearchUrl(parsed) {
  const query = buildSearchQuery(parsed);
  return `https://www.pricecharting.com/search-products?q=${encodeURIComponent(query)}&type=prices`;
}

// Export for use in content script
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { parseCardTitle, buildSearchQuery, buildPriceChartingSearchUrl, GRADE_COMPANIES, LANGUAGES };
}
