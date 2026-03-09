'use strict';
/**
 * extractor.js
 * Fetches an article page and extracts the title, clean text content, and images.
 */

const axios  = require('axios');
const cheerio = require('cheerio');
const { config } = require('./config');

const HTTP = axios.create({
  timeout: 20000,
  headers: {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.5',
  },
  maxRedirects: 5,
  validateStatus: status => status < 500,
});

// ── Extract the site's domain name for credit labelling ───────────────────────
function extractDomain(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}

// ── Strip unwanted elements ───────────────────────────────────────────────────
function removeNoise($, selectors) {
  selectors.forEach(sel => {
    try { $(sel).remove(); } catch { /* ignore */ }
  });
}

// ── Find the best content block ───────────────────────────────────────────────
function findContentBlock($, selectors) {
  for (const sel of selectors) {
    const el = $(sel).first();
    const text = el.text().trim();
    if (text.length > 200) return el.html() || '';
  }
  // Fallback: largest <div> by text length
  let best = '', bestLen = 0;
  $('div, section').each((_, el) => {
    const text = $(el).text().trim();
    if (text.length > bestLen) {
      bestLen = text.length;
      best    = $(el).html() || '';
    }
  });
  return best;
}

// ── Clean extracted HTML to just paragraphs ───────────────────────────────────
function cleanContent($, rawHtml) {
  const $content = cheerio.load(rawHtml);

  // Remove scripts, styles, buttons, forms, ads
  removeNoise($content, config.extractors.default.removeSelectors);

  // Convert headings to bold text (keeps structure, avoids design conflicts)
  $content('h1, h2, h3, h4, h5, h6').each((_, el) => {
    const text = $content(el).text().trim();
    $content(el).replaceWith(`<p><strong>${text}</strong></p>`);
  });

  // Remove empty elements
  $content('p, li').each((_, el) => {
    if (!$content(el).text().trim()) $content(el).remove();
  });

  // Extract just paragraph text to avoid embedded junk
  const paragraphs = [];
  $content('p').each((_, el) => {
    const text = $content(el).text().trim();
    if (text.length > 30) paragraphs.push(`<p>${text}</p>`);
  });

  return paragraphs.join('\n');
}

// ── Extract images ────────────────────────────────────────────────────────────
function extractImages($, domain) {
  const images = [];
  const seen   = new Set();

  $('article img, [class*="article"] img, [class*="content"] img, figure img, .post img').each((_, el) => {
    let src = $(el).attr('src') || $(el).attr('data-src') || $(el).attr('data-lazy-src') || '';
    if (!src || src.startsWith('data:')) return;

    // Make relative URLs absolute (best-effort)
    if (src.startsWith('//')) src = 'https:' + src;

    if (seen.has(src)) return;
    seen.add(src);

    const alt    = $(el).attr('alt') || '';
    const credit = $(el).closest('figure').find('figcaption').text().trim() || domain;

    // Skip tiny icons / tracking pixels
    const width  = parseInt($(el).attr('width')  || '0', 10);
    const height = parseInt($(el).attr('height') || '0', 10);
    if (width && width < 100) return;
    if (height && height < 100) return;

    images.push({ url: src, alt, credit });
  });

  return images;
}

// ── Main extraction function ──────────────────────────────────────────────────
async function extractArticle(item) {
  const { url, title: rssTitle, category, pubDate } = item;
  const domain = extractDomain(url);

  let html;
  try {
    const res = await HTTP.get(url);
    if (res.status >= 400) throw new Error(`HTTP ${res.status}`);
    html = res.data;
  } catch (err) {
    throw new Error(`[Extractor] Failed to fetch ${url}: ${err.message}`);
  }

  const $ = cheerio.load(html);

  // ── Title ──────────────────────────────────────────────────
  const title =
    $('meta[property="og:title"]').attr('content') ||
    $('meta[name="twitter:title"]').attr('content') ||
    $('h1').first().text().trim() ||
    rssTitle ||
    '';

  if (!title) throw new Error('[Extractor] No title found');

  // ── Published date ─────────────────────────────────────────
  const rawDate =
    $('meta[property="article:published_time"]').attr('content') ||
    $('time[datetime]').attr('datetime') ||
    $('time').attr('datetime') ||
    null;

  const publishDate = rawDate ? new Date(rawDate) : (pubDate || new Date());

  // ── Content ───────────────────────────────────────────────
  const cfg     = config.extractors.default;
  const rawHtml = findContentBlock($, cfg.contentSelectors);
  removeNoise($, cfg.removeSelectors);

  const content = cleanContent($, rawHtml);

  if (!content || content.length < 100) {
    throw new Error('[Extractor] Insufficient content extracted');
  }

  // ── Images ────────────────────────────────────────────────
  const images = extractImages($, domain);
  const featuredImageUrl =
    $('meta[property="og:image"]').attr('content') ||
    $('meta[name="twitter:image"]').attr('content') ||
    (images.length ? images[0].url : null);

  const featuredImageCredit =
    images.length ? images[0].credit : domain;

  // ── Source author ─────────────────────────────────────────
  const sourceAuthor =
    $('meta[name="author"]').attr('content') ||
    $('[rel="author"]').first().text().trim() ||
    $('[class*="author"]').first().text().trim() ||
    domain;

  return {
    url,
    title:               title.trim(),
    content,
    sourceName:          item.sourceName || domain,
    sourceUrl:           url,
    category:            category || 'general',
    publishDate,
    featuredImageUrl,
    featuredImageCredit: featuredImageCredit.slice(0, 200),
    images,
    sourceAuthor,
    domain,
  };
}

module.exports = { extractArticle };
