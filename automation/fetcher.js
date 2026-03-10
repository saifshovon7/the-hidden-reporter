'use strict';
/**
 * fetcher.js
 * Fetches article links from Google News RSS, direct RSS feeds, and optional APIs.
 * Balances content across categories to prevent starvation.
 */

const RSSParser = require('rss-parser');
const axios = require('axios');
const { createClient } = require('@supabase/supabase-js');
const { config } = require('./config');

const parser = new RSSParser({
  timeout: 20000,
  headers: {
    'User-Agent': 'Mozilla/5.0 (compatible; TheHiddenReporter/1.0; +https://thehiddenreporter.pages.dev)',
  },
  customFields: {
    item: [['media:content', 'mediaContent'], ['enclosure', 'enclosure']],
  },
});

const supabase = createClient(config.supabase.url, config.supabase.serviceKey);

// ── Google News URL decoder ────────────────────────────────────────────────────
/**
 * Google News RSS article IDs (CBMi...) are base64-encoded protobuf messages
 * that contain the original article URL. We decode the bytes and search for
 * the embedded https:// URL pattern.
 */
function decodeGoogleNewsUrl(googleUrl) {
  try {
    const match = googleUrl.match(/articles\/(CBMi[^?&\s]+)/);
    if (!match) return null;

    const encoded = match[1];
    // base64url → Buffer
    const buf = Buffer.from(
      encoded.replace(/-/g, '+').replace(/_/g, '/'),
      'base64'
    );
    const str = buf.toString('binary');

    // Look for embedded https:// or http:// URL in the decoded bytes
    for (const prefix of ['https://', 'http://']) {
      const idx = str.indexOf(prefix);
      if (idx === -1) continue;

      let end = idx;
      while (end < str.length) {
        const code = str.charCodeAt(end);
        // Stop at non-printable or whitespace characters
        if (code < 32 || code === 127 || code > 126) break;
        end++;
      }

      const url = str.slice(idx, end);
      // Validate it looks like a real URL (not a Google URL)
      if (url.length > 20 && !url.includes('google.com')) {
        return url;
      }
    }
  } catch {
    // Fall through to HTTP redirect method
  }
  return null;
}

/**
 * Fallback: follow HTTP redirects to resolve Google News tracking URLs.
 */
async function resolveGoogleNewsUrl(googleUrl) {
  // Try fast decode first (no network request needed)
  const decoded = decodeGoogleNewsUrl(googleUrl);
  if (decoded) return decoded;

  // Fallback: follow the redirect chain
  try {
    const res = await axios.get(googleUrl, {
      maxRedirects: 10,
      timeout: 12000,
      validateStatus: () => true,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      },
    });

    // axios stores the final URL after redirects here
    const finalUrl = res.request?.res?.responseUrl
      || (res.request?._redirectable?._currentUrl)
      || res.config?.url
      || googleUrl;

    if (!finalUrl.includes('google.com')) return finalUrl;

    // Try to find og:url or canonical in the response HTML
    if (typeof res.data === 'string') {
      const ogUrl = res.data.match(/<meta[^>]+property="og:url"[^>]+content="([^"]+)"/i)?.[1];
      if (ogUrl && !ogUrl.includes('google.com')) return ogUrl;

      const canonical = res.data.match(/<link[^>]+rel="canonical"[^>]+href="([^"]+)"/i)?.[1];
      if (canonical && !canonical.includes('google.com')) return canonical;
    }
  } catch {
    // Ignore
  }

  return googleUrl;
}

// ── Deduplicate against processed_urls ────────────────────────────────────────
async function filterUnprocessed(urls) {
  if (!urls.length) return [];

  const { data, error } = await supabase
    .from('processed_urls')
    .select('url')
    .in('url', urls);

  if (error) {
    console.error('[Fetcher] Error checking processed_urls:', error.message);
    return urls;
  }

  const processed = new Set((data || []).map(r => r.url));
  return urls.filter(u => !processed.has(u));
}

// ── Mark URLs as processed ────────────────────────────────────────────────────
async function markProcessed(urls) {
  if (!urls.length) return;
  const rows = urls.map(url => ({ url }));
  const { error } = await supabase.from('processed_urls').upsert(rows, { onConflict: 'url' });
  if (error) console.error('[Fetcher] Error marking processed:', error.message);
}

// ── Fetch one RSS feed ─────────────────────────────────────────────────────────
async function fetchRssFeed(source) {
  try {
    const feed = await parser.parseURL(source.rss_url);
    const isGoogleNews = source.rss_url.includes('news.google.com');

    const items = [];
    for (const item of (feed.items || []).slice(0, 20)) {
      let url = item.link || item.guid || '';
      if (!url) continue;

      if (isGoogleNews) {
        url = await resolveGoogleNewsUrl(url);
      }

      items.push({
        url: url.trim(),
        title: item.title || '',
        sourceName: source.source_name,
        category: source.category || 'general',
        pubDate: item.pubDate ? new Date(item.pubDate) : new Date(),
        imageUrl: item.mediaContent?.['$']?.url || item.enclosure?.url || null,
      });
    }

    return items;
  } catch (err) {
    console.error(`[Fetcher] RSS error for ${source.source_name}: ${err.message}`);
    return [];
  }
}

// ── Google News Fallback ───────────────────────────────────────────────────────
async function fetchFallbackGoogleNews(category) {
  console.log(`[Fetcher] Fetching Google News fallback for starved category: ${category}`);
  // Map our categories to Google News search terms
  let query = category;
  if (category === 'world') query = 'world+news';
  if (category === 'general') query = 'news';

  return fetchRssFeed({
    source_name: `Google News – fallback (${category})`,
    rss_url: `https://news.google.com/rss/search?q=${query}`,
    category: category
  });
}

// ── Optional: NewsAPI ──────────────────────────────────────────────────────────
async function fetchFromNewsApi(category) {
  if (!config.newsApi.enabled) return [];

  try {
    const endpoint = category === 'general'
      ? `https://newsapi.org/v2/top-headlines?country=us&apiKey=${config.newsApi.key}&pageSize=20`
      : `https://newsapi.org/v2/top-headlines?category=${category}&country=us&apiKey=${config.newsApi.key}&pageSize=20`;

    const res = await axios.get(endpoint, { timeout: 15000 });
    return (res.data?.articles || []).map(a => ({
      url: a.url,
      title: a.title || '',
      sourceName: a.source?.name || 'NewsAPI',
      category,
      pubDate: a.publishedAt ? new Date(a.publishedAt) : new Date(),
      imageUrl: a.urlToImage || null,
    }));
  } catch (err) {
    console.error(`[Fetcher] NewsAPI error: ${err.message}`);
    return [];
  }
}

// ── Optional: GDELT ───────────────────────────────────────────────────────────
async function fetchFromGdelt() {
  if (!config.gdelt.enabled) return [];

  try {
    const url = 'https://api.gdeltproject.org/api/v2/doc/doc?query=news&mode=artlist&maxrecords=20&format=json';
    const res = await axios.get(url, { timeout: 15000 });
    return (res.data?.articles || []).map(a => ({
      url: a.url,
      title: a.title || '',
      sourceName: a.domain || 'GDELT',
      category: 'general',
      pubDate: new Date(),
      imageUrl: null,
    }));
  } catch (err) {
    console.error(`[Fetcher] GDELT error: ${err.message}`);
    return [];
  }
}

// ── Main fetch function ────────────────────────────────────────────────────────
async function fetchAllSources(categoryStats = {}) {
  console.log('[Fetcher] Loading active sources from database...');

  const { data: sources, error } = await supabase
    .from('sources')
    .select('*')
    .eq('active', true);

  if (error || !sources?.length) {
    console.error('[Fetcher] Could not load sources:', error?.message);
    return [];
  }

  console.log(`[Fetcher] Fetching from ${sources.length} active sources...`);

  // Fetch all feeds in parallel (with concurrency limit)
  const CONCURRENCY = 5;
  const allItems = [];

  for (let i = 0; i < sources.length; i += CONCURRENCY) {
    const batch = sources.slice(i, i + CONCURRENCY);
    const results = await Promise.all(batch.map(s => fetchRssFeed(s)));
    results.forEach(items => allItems.push(...items));
  }

  // Optional API sources
  if (config.newsApi.enabled) {
    for (const cat of config.categories.slice(0, 3)) {
      const items = await fetchFromNewsApi(cat);
      allItems.push(...items);
    }
  }

  if (config.gdelt.enabled) {
    const gdeltItems = await fetchFromGdelt();
    allItems.push(...gdeltItems);
  }

  // De-duplicate by URL within this batch
  const seen = new Set();
  const uniqueItems = allItems.filter(item => {
    if (!item.url || seen.has(item.url)) return false;
    seen.add(item.url);
    return true;
  });

  // Filter against already-processed URLs
  const urls = uniqueItems.map(i => i.url);
  const freshUrls = await filterUnprocessed(urls);
  const freshUrlSet = new Set(freshUrls);
  const freshItems = uniqueItems.filter(i => freshUrlSet.has(i.url));

  console.log(`[Fetcher] ${freshItems.length} new articles found originally (${uniqueItems.length - freshItems.length} already processed).`);

  // --------- CATEGORY BALANCING & FALLBACK SYSTEM ---------
  // 1. Group items by category
  const categoriesMap = new Map();
  for (const cat of config.categories) {
    categoriesMap.set(cat, []);
  }

  for (const item of freshItems) {
    const cat = item.category || 'general';
    if (!categoriesMap.has(cat)) {
      categoriesMap.set(cat, []);
    }
    categoriesMap.get(cat).push(item);
  }

  // 2. Check for starvation and fetch fallback if needed
  const targets = config.publishing.categoryTargets || {};
  for (const cat of config.categories) {
    const publishedToday = categoryStats[cat] || 0;
    const target = targets[cat] || 3;
    const available = categoriesMap.get(cat).length;

    // If we've published less than target, and we don't have enough fresh items to reach the target...
    if (publishedToday + available < target) {
      const fallbackItems = await fetchFallbackGoogleNews(cat);
      for (const fItem of fallbackItems) {
        if (!seen.has(fItem.url)) {
          seen.add(fItem.url);
          categoriesMap.get(cat).push(fItem);
        }
      }
    }
  }

  // Refilter just in case fallback brought in processed items
  // (We do this as a batch to minimize DB calls)
  const allCurrentUrls = [];
  for (const items of categoriesMap.values()) {
    allCurrentUrls.push(...items.map(i => i.url));
  }
  const verifiedFreshUrlList = await filterUnprocessed(allCurrentUrls);
  const verifiedFreshSet = new Set(verifiedFreshUrlList);

  for (const cat of categoriesMap.keys()) {
    const validItems = categoriesMap.get(cat).filter(i => verifiedFreshSet.has(i.url));
    categoriesMap.set(cat, validItems);
  }

  // 3. Prioritize categories that are furthest from their daily targets
  const prioritizedCategories = [...config.categories].sort((a, b) => {
    const targetA = config.publishing.categoryTargets?.[a] || 3;
    const statsA = categoryStats[a] || 0;
    const deficitA = Math.max(0, targetA - statsA);

    const targetB = config.publishing.categoryTargets?.[b] || 3;
    const statsB = categoryStats[b] || 0;
    const deficitB = Math.max(0, targetB - statsB);

    return deficitB - deficitA; // highest deficit first
  });

  // 4. Implement rotation system: pick 1 from each category sequentially
  const finalRotatedList = [];
  let continueRotating = true;

  while (continueRotating) {
    continueRotating = false;
    for (const cat of prioritizedCategories) {
      const items = categoriesMap.get(cat);
      if (items && items.length > 0) {
        // Take the freshest item from this category
        finalRotatedList.push(items.shift());
        continueRotating = true; // Still have items to process
      }
    }
  }

  console.log(`[Fetcher] Balancing complete. Final fetch list contains ${finalRotatedList.length} articles across categories.`);
  return finalRotatedList;
}

module.exports = { fetchAllSources, markProcessed };
