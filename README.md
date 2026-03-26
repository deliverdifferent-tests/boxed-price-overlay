# Boxed Price Overlay

Chrome extension that overlays PriceCharting prices on Boxed.gg marketplace cards.

## What it does

When you visit `https://boxed.gg/marketplace`, the extension:

1. Detects all visible Pokémon card tiles
2. Parses the title to extract card name, set, number, grade company, and grade
3. Looks up the card on PriceCharting
4. Injects a compact price overlay showing:
   - Raw price
   - PSA 8 / 9 / 10 (or CGC equivalents)
   - Match confidence (exact / likely / weak)
   - Direct link to PriceCharting page

## Company-aware pricing

- If the card is graded PSA → PSA prices shown first
- If the card is graded CGC → CGC prices shown first
- Alternate company prices shown when available
- Raw/ungraded price always shown

## Installation

1. Open Chrome → `chrome://extensions`
2. Enable "Developer mode" (top right)
3. Click "Load unpacked"
4. Select this folder

## Usage

- Navigate to `https://boxed.gg/marketplace`
- Price overlays appear automatically on each card
- Click "PriceCharting ↗" to open the matched page
- Click the extension icon for:
  - Cache stats
  - Rescan page
  - Clear cache

## Architecture

- `src/parser.js` — Title parsing and field extraction
- `src/resolver.js` — PriceCharting search and price extraction
- `src/content.js` — DOM scanning, overlay injection, MutationObserver
- `src/background.js` — Fetch proxy (avoids CORS), cache management
- `src/overlay.css` — Dark-theme overlay styles
- `popup/` — Extension popup UI

## Caching

Lookups are cached for 4 hours in `chrome.storage.local`. Clear via the popup.

## Known limitations

- V1 uses direct PriceCharting HTML parsing — may break if their layout changes
- Title matching is heuristic-based — some cards may not match correctly
- Japanese card naming can be inconsistent across sources
- Rate-limited to avoid hammering PriceCharting (batches of 5, 1.2s delay between batches)
