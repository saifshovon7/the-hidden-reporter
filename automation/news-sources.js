'use strict';
/**
 * news-sources.js
 * Hybrid news collection from multiple sources:
 * - RSS Feeds
 * - News APIs (NewsAPI, GDELT, ContextualWeb)
 * - Google News scraping
 * - Direct website scraping
 */

const axios = require('axios');
const cheerio = require('cheerio');
const { createClient } = require('@supabase/supabase-js');
const { config } = require('./config');

const supabase = createClient(config.supabase.url, config.supabase.serviceKey);

// ── SOURCE TYPES ─────────────────────────────────────────────────────────────────
const SOURCE_TYPES = {
  RSS: 'rss',
  NEWS_API: 'newsapi',
  GDELT: 'gdelt',
  GNEWS: 'gnews',
  GOOGLE_NEWS: 'google_news',
  SCRAPER: 'scraper'
};

// ── CATEGORY MAPPING ──────────────────────────────────────────────────────────────
const CATEGORY_QUERIES = {
  technology: 'technology tech AI artificial intelligence',
  finance: 'finance financial markets stocks economy',
  business: 'business economy company corporate',
  science: 'science research discovery',
  sports: 'sports football basketball soccer',
  politics: 'politics government election',
  world: 'world news international',
  general: 'news latest'
};

// ── RSS PARSER ───────────────────────────────────────────────────────────────────
const RSSParser = require('rss-parser');
const rssParser = new RSSParser({
  timeout: 20000,
  headers: {
    'User-Agent': 'Mozilla/5.0 (compatible; TheHiddenReporter/1.0; +https://thehiddenreporter.pages.dev)',
  },
  customFields: {
    item: [['media:content', 'mediaContent'], ['enclosure', 'enclosure'], ['media:thumbnail', 'mediaThumbnail']],
  },
});

// ── GOOGLE NEWS URL DECODER ───────────────────────────────────────────────────────
function decodeGoogleNewsUrl(googleUrl) {
  try {
    const match = googleUrl.match(/articles\/(CBMi[^?&\s]+)/);
    if (!match) return null;
    const encoded = match[1];
    const buf = Buffer.from(encoded.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
    const str = buf.toString('binary');
    for (const prefix of ['https://', 'http://']) {
      const idx = str.indexOf(prefix);
      if (idx === -1) continue;
      let end = idx;
      while (end < str.length) {
        const code = str.charCodeAt(end);
        if (code < 32 || code === 127 || code > 126) break;
        end++;
      }
      const url = str.slice(idx, end);
      if (url.length > 20 && !url.includes('google.com')) {
        return url;
      }
    }
  } catch {}
  return null;
}

async function resolveGoogleNewsUrl(googleUrl) {
  const decoded = decodeGoogleNewsUrl(googleUrl);
  if (decoded) return decoded;
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
    const finalUrl = res.request?.res?.responseUrl || res.request?._redirectable?._currentUrl || res.config?.url || googleUrl;
    if (!finalUrl.includes('google.com')) return finalUrl;
    if (typeof res.data === 'string') {
      const ogUrl = res.data.match(/<meta[^>]+property="og:url"[^>]+content="([^"]+)"/i)?.[1];
      if (ogUrl && !ogUrl.includes('google.com')) return ogUrl;
      const canonical = res.data.match(/<link[^>]+rel="canonical"[^>]+href="([^"]+)"/i)?.[1];
      if (canonical && !canonical.includes('google.com')) return canonical;
    }
  } catch {}
  return googleUrl;
}

// ── RSS FEED FETCHER ─────────────────────────────────────────────────────────────
async function fetchRssFeed(source) {
  try {
    const feed = await rssParser.parseURL(source.rss_url);
    const isGoogleNews = source.rss_url.includes('news.google.com');
    const items = [];
    for (const item of (feed.items || []).slice(0, 25)) {
      let url = item.link || item.guid || '';
      if (!url) continue;
      if (isGoogleNews) {
        url = await resolveGoogleNewsUrl(url);
      }
      items.push({
        url: url.trim(),
        title: item.title || '',
        sourceName: source.source_name,
        sourceType: SOURCE_TYPES.RSS,
        category: source.category || 'general',
        pubDate: item.pubDate ? new Date(item.pubDate) : new Date(),
        imageUrl: item.mediaContent?.['$']?.url || item.enclosure?.url || item.mediaThumbnail?.['$']?.url || null,
      });
    }
    return items;
  } catch (err) {
    console.error(`[NewsSources] RSS error for ${source.source_name}: ${err.message}`);
    return [];
  }
}

// ── NEWSAPI ───────────────────────────────────────────────────────────────────────
async function fetchNewsApi(category = 'general', pageSize = 25) {
  if (!config.newsApi?.key) return [];
  try {
    let endpoint;
    const country = config.newsApi.country || 'us';
    if (category === 'general') {
      endpoint = `https://newsapi.org/v2/top-headlines?country=${country}&pageSize=${pageSize}&apiKey=${config.newsApi.key}`;
    } else {
      const catMap = { technology: 'technology', business: 'business', science: 'science', sports: 'sports', entertainment: 'entertainment', health: 'health' };
      const apiCat = catMap[category] || 'general';
      endpoint = `https://newsapi.org/v2/top-headlines?country=${country}&category=${apiCat}&pageSize=${pageSize}&apiKey=${config.newsApi.key}`;
    }
    const res = await axios.get(endpoint, { timeout: 15000 });
    return (res.data?.articles || []).map(a => ({
      url: a.url,
      title: a.title || '',
      sourceName: a.source?.name || 'NewsAPI',
      sourceType: SOURCE_TYPES.NEWS_API,
      category: mapNewsApiCategory(a.source?.name, category),
      pubDate: a.publishedAt ? new Date(a.publishedAt) : new Date(),
      imageUrl: a.urlToImage || null,
      description: a.description || '',
    }));
  } catch (err) {
    console.error(`[NewsSources] NewsAPI error: ${err.message}`);
    return [];
  }
}

function mapNewsApiCategory(sourceName, fallback) {
  if (!sourceName) return fallback;
  const name = sourceName.toLowerCase();
  if (name.includes('tech') || name.includes('verge') || name.includes('techcrunch')) return 'technology';
  if (name.includes('finance') || name.includes('bloomberg') || name.includes('market')) return 'finance';
  if (name.includes('sport') || name.includes('espn') || name.includes('bbc sport')) return 'sports';
  if (name.includes('science') || name.includes('nature')) return 'science';
  if (name.includes('politics') || name.includes('political')) return 'politics';
  if (name.includes('world') || name.includes('reuters')) return 'world';
  if (name.includes('business')) return 'business';
  return fallback;
}

// ── GDELT ─────────────────────────────────────────────────────────────────────────
async function fetchGdelt(query = 'news', mode = 'artlist', maxRecords = 25) {
  if (!config.gdelt?.enabled) return [];
  try {
    const queryParam = encodeURIComponent(query);
    const url = `https://api.gdeltproject.org/api/v2/doc/doc?query=${queryParam}&mode=${mode}&maxrecords=${maxRecords}&format=json&sort=DateDesc`;
    const res = await axios.get(url, { timeout: 20000 });
    const items = (res.data?.articles || []).map(a => {
      let category = 'general';
      const title = (a.title || '').toLowerCase();
      if (title.includes('tech') || title.includes('ai') || title.includes('software')) category = 'technology';
      else if (title.includes('stock') || title.includes('market') || title.includes('econom')) category = 'finance';
      else if (title.includes('sport')) category = 'sports';
      else if (title.includes('science') || title.includes('research')) category = 'science';
      else if (title.includes('politics') || title.includes('election')) category = 'politics';
      else if (title.includes('world') || title.includes('international')) category = 'world';
      else if (title.includes('business') || title.includes('company')) category = 'business';
      return {
        url: a.url,
        title: a.title || '',
        sourceName: a.domain || 'GDELT',
        sourceType: SOURCE_TYPES.GDELT,
        category,
        pubDate: a.seendate ? new Date(a.seendate) : new Date(),
        imageUrl: a.image || null,
      };
    });
    return items;
  } catch (err) {
    console.error(`[NewsSources] GDELT error: ${err.message}`);
    return [];
  }
}

// ── GNEWS API (gnews.io) ───────────────────────────────────────────────────────
async function fetchGNews(category = 'general', pageSize = 15) {
  if (!config.gnews?.apiKey) return [];
  try {
    const country = config.gnews.country || 'us';
    const lang = config.gnews.language || 'en';
    
    // GNews uses 'technology' instead of 'tech', 'business' instead of 'finance' in some cases.
    // We can just use their built in categories
    const validCategories = ['general', 'world', 'nation', 'business', 'technology', 'entertainment', 'sports', 'science', 'health'];
    let gnewsCat = category;
    if (category === 'finance') gnewsCat = 'business';
    if (category === 'politics') gnewsCat = 'nation';
    if (!validCategories.includes(gnewsCat)) gnewsCat = 'general';

    const url = `https://gnews.io/api/v4/top-headlines?category=${gnewsCat}&lang=${lang}&country=${country}&max=${pageSize}&apikey=${config.gnews.apiKey}`;
    
    const res = await axios.get(url, { timeout: 15000 });
    
    return (res.data?.articles || []).map(a => ({
      url: a.url,
      title: a.title || '',
      sourceName: a.source?.name || 'GNews',
      sourceType: SOURCE_TYPES.GNEWS,
      category,
      pubDate: a.publishedAt ? new Date(a.publishedAt) : new Date(),
      imageUrl: a.image || null,
      description: a.description || '',
    }));
  } catch (err) {
    console.error(`[NewsSources] GNews error: ${err.message}`);
    return [];
  }
}

// ── GOOGLE NEWS SCRAPING (Not RSS) ──────────────────────────────────────────────
async function scrapeGoogleNews(category = 'general', pageSize = 25) {
  try {
    const query = CATEGORY_QUERIES[category] || 'news';
    const url = `https://news.google.com/search?q=${encodeURIComponent(query)}&hl=en-US&gl=US`;
    const res = await axios.get(url, {
      timeout: 20000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.5',
      },
    });
    const $ = cheerio.load(res.data);
    const items = [];
    $('article').each((i, el) => {
      if (i >= pageSize) return;
      const link = $(el).find('a');
      const href = link.attr('href');
      if (!href || !href.startsWith('./articles/')) return;
      const fullUrl = 'https://news.google.com' + href.substring(1);
      const title = $(el).text().trim().split('\n')[0] || '';
      if (title && fullUrl) {
        items.push({
          url: fullUrl,
          title: title.substring(0, 200),
          sourceName: `Google News - ${category}`,
          sourceType: SOURCE_TYPES.GOOGLE_NEWS,
          category,
          pubDate: new Date(),
          imageUrl: null,
        });
      }
    });
    const resolvedItems = [];
    for (const item of items.slice(0, 10)) {
      try {
        const resolved = await resolveGoogleNewsUrl(item.url);
        if (resolved && resolved !== item.url) {
          resolvedItems.push({ ...item, url: resolved });
        } else {
          resolvedItems.push(item);
        }
      } catch {
        resolvedItems.push(item);
      }
    }
    return resolvedItems;
  } catch (err) {
    console.error(`[NewsSources] Google News scraper error for ${category}: ${err.message}`);
    return [];
  }
}

// ── DIRECT WEBSITE SCRAPING ────────────────────────────────────────────────────
const SCRAPER_SOURCES = [
  { name: 'BBC News', url: 'https://www.bbc.com/news', category: 'general', articleSelector: 'article' },
  { name: 'BBC Tech', url: 'https://www.bbc.com/news/technology', category: 'technology', articleSelector: 'article' },
  { name: 'Reuters', url: 'https://www.reuters.com', category: 'general', articleSelector: 'article' },
  { name: 'TechCrunch', url: 'https://techcrunch.com', category: 'technology', articleSelector: 'article' },
  { name: 'The Verge', url: 'https://www.theverge.com', category: 'technology', articleSelector: 'article' },
];

async function scrapeWebsite(source, pageSize = 10) {
  try {
    const res = await axios.get(source.url, {
      timeout: 20000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
      },
    });
    const $ = cheerio.load(res.data);
    const items = [];
    $(source.articleSelector).each((i, el) => {
      if (i >= pageSize) return;
      const link = $(el).find('a').first();
      const href = link.attr('href');
      if (!href) return;
      const url = href.startsWith('http') ? href : new URL(href, source.url).href;
      const title = $(el).text().trim().substring(0, 200);
      if (title && url) {
        items.push({
          url,
          title,
          sourceName: source.name,
          sourceType: SOURCE_TYPES.SCRAPER,
          category: source.category,
          pubDate: new Date(),
          imageUrl: null,
        });
      }
    });
    return items;
  } catch (err) {
    console.error(`[NewsSources] Scraper error for ${source.name}: ${err.message}`);
    return [];
  }
}

// ── DATABASE SOURCES FETCHER ───────────────────────────────────────────────────
async function fetchDatabaseSources() {
  try {
    const { data, error } = await supabase
      .from('sources')
      .select('*')
      .eq('active', true);
    if (error) throw error;
    return data || [];
  } catch (err) {
    console.error(`[NewsSources] Error fetching sources: ${err.message}`);
    return [];
  }
}

// ── PROCESSED URL FILTER ─────────────────────────────────────────────────────────
async function filterUnprocessed(urls) {
  if (!urls.length) return [];
  try {
    const { data, error } = await supabase
      .from('processed_urls')
      .select('url')
      .in('url', urls);
    if (error) return urls;
    const processed = new Set((data || []).map(r => r.url));
    return urls.filter(u => !processed.has(u));
  } catch {
    return urls;
  }
}

// ── HYBRID COLLECTOR MAIN FUNCTION ──────────────────────────────────────────────
async function collectAllNews(categoryStats = {}) {
  const allItems = [];
  const CONCURRENCY = 5;
  
  console.log('[NewsSources] Starting hybrid news collection...');
  
  // 1. Fetch from database RSS sources
  console.log('[NewsSources] Fetching RSS feeds from database...');
  const dbSources = await fetchDatabaseSources();
  const rssSources = dbSources.filter(s => s.rss_url);
  for (let i = 0; i < rssSources.length; i += CONCURRENCY) {
    const batch = rssSources.slice(i, i + CONCURRENCY);
    const results = await Promise.all(batch.map(s => fetchRssFeed(s)));
    results.forEach(items => allItems.push(...items));
  }
  console.log(`[NewsSources] RSS feeds: ${allItems.length} articles`);
  
  // 2. Fetch from NewsAPI if enabled
  if (config.newsApi?.key) {
    console.log('[NewsSources] Fetching from NewsAPI...');
    for (const cat of config.categories) {
      const items = await fetchNewsApi(cat, 15);
      allItems.push(...items);
    }
  }
  
  // 3. Fetch from GDELT if enabled
  if (config.gdelt?.enabled) {
    console.log('[NewsSources] Fetching from GDELT...');
    for (const cat of config.categories) {
      const items = await fetchGdelt(CATEGORY_QUERIES[cat], 'artlist', 15);
      allItems.push(...items);
    }
  }
  
  // 4. Fetch from GNews if enabled
  if (config.gnews?.apiKey) {
    console.log('[NewsSources] Fetching from GNews...');
    for (const cat of config.categories) {
      const items = await fetchGNews(cat, 15);
      allItems.push(...items);
    }
  }
  
  // 5. Scrape Google News for fallback categories
  const targets = config.publishing.categoryTargets || {};
  for (const cat of config.categories) {
    const publishedToday = categoryStats[cat] || 0;
    const target = targets[cat] || 3;
    const currentCount = allItems.filter(i => i.category === cat).length;
    if (publishedToday + currentCount < target) {
      console.log(`[NewsSources] Google News fallback for ${cat} (need ${target - currentCount})`);
      const fallbackItems = await scrapeGoogleNews(cat, 15);
      allItems.push(...fallbackItems);
    }
  }
  
  // 6. Direct website scraping as last resort
  for (const source of SCRAPER_SOURCES) {
    const items = await scrapeWebsite(source, 10);
    allItems.push(...items);
  }
  
  // Deduplicate by URL
  const seen = new Set();
  const uniqueItems = allItems.filter(item => {
    if (!item.url || seen.has(item.url)) return false;
    seen.add(item.url);
    return true;
  });
  
  // Filter against processed URLs
  const urls = uniqueItems.map(i => i.url);
  const freshUrls = await filterUnprocessed(urls);
  const freshSet = new Set(freshUrls);
  const freshItems = uniqueItems.filter(i => freshSet.has(i.url));
  
  console.log(`[NewsSources] Total unique articles: ${uniqueItems.length}, Fresh: ${freshItems.length}`);
  return freshItems;
}

// ── CATEGORY BALANCING ───────────────────────────────────────────────────────────
function balanceByCategory(items, categoryStats = {}, targets = {}) {
  const categoriesMap = new Map();
  for (const cat of config.categories) {
    categoriesMap.set(cat, []);
  }
  for (const item of items) {
    const cat = item.category || 'general';
    if (!categoriesMap.has(cat)) categoriesMap.set(cat, []);
    categoriesMap.get(cat).push(item);
  }
  
  // Sort categories by deficit (furthest from target first)
  const prioritizedCategories = [...config.categories].sort((a, b) => {
    const targetA = targets[a] || 3;
    const statsA = categoryStats[a] || 0;
    const deficitA = Math.max(0, targetA - statsA);
    const targetB = targets[b] || 3;
    const statsB = categoryStats[b] || 0;
    const deficitB = Math.max(0, targetB - statsB);
    return deficitB - deficitA;
  });
  
  // Rotate through categories
  const balanced = [];
  let continueRotating = true;
  while (continueRotating) {
    continueRotating = false;
    for (const cat of prioritizedCategories) {
      const catItems = categoriesMap.get(cat);
      if (catItems && catItems.length > 0) {
        balanced.push(catItems.shift());
        continueRotating = true;
      }
    }
  }
  
  return balanced;
}

// ── MARK PROCESSED ────────────────────────────────────────────────────────────────
async function markProcessed(urls) {
  if (!urls.length) return;
  try {
    const rows = urls.map(url => ({ url }));
    await supabase.from('processed_urls').upsert(rows, { onConflict: 'url' });
  } catch (err) {
    console.error(`[NewsSources] Error marking processed: ${err.message}`);
  }
}

module.exports = {
  collectAllNews,
  balanceByCategory,
  markProcessed,
  fetchRssFeed,
  fetchNewsApi,
  fetchGdelt,
  fetchGNews,
  scrapeGoogleNews,
  scrapeWebsite,
  SOURCE_TYPES,
  CATEGORY_QUERIES,
};
