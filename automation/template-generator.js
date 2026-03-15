'use strict';
/**
 * template-generator.js
 * Generates all static HTML pages: articles, categories, homepage,
 * search index, RSS feed, and sitemap.
 * Design: Modern, Bloomberg × Verge × FT inspired — v2
 */

const { config } = require('./config');
const { escapeAttr } = require('./seo-generator');

const SITE_URL = config.site.url;
const SITE_NAME = config.site.name;

// ── Shared header partial ─────────────────────────────────────────────────────
function headerPartial(activeCat = '') {
  const cats = config.categories.map(c => {
    const active = c === activeCat ? ' class="is-active"' : '';
    return `<a href="/category/${c}.html"${active}>${capitalize(c)}</a>`;
  }).join('\n          ');

  return `<header class="site-header" id="site-header">
  <div class="header-inner">
    <a href="/" class="logo-link" aria-label="${SITE_NAME}">
      <span class="logo-name">${SITE_NAME}</span>
      <span class="logo-tagline">Uncovering stories behind the headlines.</span>
    </a>

    <nav class="main-nav" id="main-nav" aria-label="Main navigation">
      <a href="/">Home</a>
      ${cats}
    </nav>

    <div class="header-actions">
      <button class="header-btn" aria-label="Search" onclick="toggleSearch()" id="search-toggle-btn">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/></svg>
      </button>
      <button class="nav-toggle" id="nav-toggle" aria-label="Toggle navigation" aria-expanded="false" onclick="toggleNav(this)">
        <span></span><span></span><span></span>
      </button>
    </div>
  </div>

  <div id="search-bar" class="header-search-bar" role="search" aria-hidden="true">
    <form action="/search.html" method="get" class="search-form">
      <input type="search" name="q" placeholder="Search articles, topics, sources…" class="search-input" id="header-search-input" autocomplete="off">
      <button type="submit" class="search-btn">Search</button>
    </form>
  </div>
</header>`;
}

// ── Shared footer partial ─────────────────────────────────────────────────────
function footerPartial(footerAdHtml = '') {
  return `<footer class="site-footer">
  ${footerAdHtml ? `<div class="footer-ad" aria-label="Advertisement">${footerAdHtml}</div>` : ''}
  <div class="footer-inner">
    <div class="footer-brand">
      <strong>${SITE_NAME}</strong><br>
      <em>Uncovering stories behind the headlines.</em>
    </div>
    <nav class="footer-nav" aria-label="Footer navigation">
      <a href="/about.html">About</a>
      <a href="/editorial-policy.html">Editorial Policy</a>
      <a href="/contact.html">Contact</a>
      <a href="/feed.xml">RSS Feed</a>
      <a href="/sitemap.xml">Sitemap</a>
    </nav>
    <p class="footer-copy">&copy; ${new Date().getFullYear()} ${SITE_NAME}. All rights reserved. AI-powered news aggregation.</p>
  </div>
</footer>`;
}

// ── Base HTML wrapper ─────────────────────────────────────────────────────────
function baseHtml({ title, meta, schema, og, body, activeCat = '', footerAd = '', canonicalPath = '/' }) {
  // Supabase public config — anon key is intentionally public (protected by RLS)
  // Stored in inline JS instead of HTML attributes to avoid scraper confusion
  const supabaseConfig = (config.supabase.url && config.supabase.anonKey)
    ? `<script>window.__THR__={supabaseUrl:${JSON.stringify(config.supabase.url)},supabaseKey:${JSON.stringify(config.supabase.anonKey)}};</script>`
    : '';

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(title)}</title>
  ${meta || ''}
  ${og || ''}
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Instrument+Serif:ital@0;1&family=Inter:wght@300;400;500;600;700&display=swap" rel="stylesheet">
  <link rel="stylesheet" href="/css/style.css">
  <link rel="alternate" type="application/rss+xml" title="${SITE_NAME}" href="/feed.xml">
  <link rel="canonical" href="${SITE_URL}${canonicalPath || '/'}">
  ${supabaseConfig}
  ${schema ? `<script type="application/ld+json">${schema}</script>` : ''}
</head>
<body>
  ${headerPartial(activeCat)}
  <main class="site-main" id="main-content">
    ${body}
  </main>
  ${footerPartial(footerAd)}
  <script src="/js/main.js" defer></script>
</body>
</html>`;
}

function articlePath(category, slug) {
  return `/articles/${category || 'general'}/${slug}.html`;
}

// ── Article card component ────────────────────────────────────────────────────
function generateArticleCard(article, size = 'small') {
  const href = articlePath(article.category, article.slug);
  const hLevel = size === 'large' ? '2' : size === 'medium' ? '3' : '4';
  const timeStr = timeAgo(new Date(article.site_publish_date || article.publish_date));
  const imgUrl = sanitizeImageUrl(article.featured_image_url);
  const imgHtml = imgUrl
    ? `<div class="card-img-wrap">
        <a href="${href}" tabindex="-1" aria-hidden="true">
          <img class="card-img" src="${escapeAttr(imgUrl)}" alt="${escapeAttr(article.title)}" loading="lazy" width="800" height="450">
        </a>
      </div>`
    : '';

  if (size === 'small') {
    return `<article class="article-card article-card--small">
  ${imgUrl ? `<div class="card-img-wrap" style="width:100px;flex-shrink:0;margin:0;aspect-ratio:unset">
    <a href="${href}" tabindex="-1" aria-hidden="true">
      <img class="card-img" src="${escapeAttr(imgUrl)}" alt="" loading="lazy" style="width:100px;height:70px;aspect-ratio:unset">
    </a>
  </div>` : ''}
  <div class="card-body">
    <a href="/category/${article.category}.html" class="card-category">${capitalize(article.category)}</a>
    <h${hLevel} class="card-title"><a href="${href}">${escapeHtml(article.title)}</a></h${hLevel}>
    <div class="card-meta">
      <span>${timeStr}</span>
      <span class="card-meta-dot">·</span>
      <span>${escapeHtml(article.source_name)}</span>
    </div>
  </div>
</article>`;
  }

  return `<article class="article-card article-card--${size} card-lift">
  ${imgHtml}
  <div class="card-body">
    <a href="/category/${article.category}.html" class="card-category">${capitalize(article.category)}</a>
    <h${hLevel} class="card-title"><a href="${href}">${escapeHtml(article.title)}</a></h${hLevel}>
    <p class="card-summary">${escapeHtml((article.summary || '').slice(0, 160))}</p>
    <div class="card-meta">
      <span>${timeStr}</span>
      <span class="card-meta-dot">·</span>
      <span>${escapeHtml(article.source_name)}</span>
    </div>
  </div>
</article>`;
}

// ── Article page ──────────────────────────────────────────────────────────────
function generateArticlePage(article, related = [], sidebarAd = '', inArticleAd = '', footerAd = '') {
  const publishedStr = formatDisplayDate(new Date(article.publish_date));
  const relatedHtml = related.length ? generateRelatedArticles(related) : '';

  const imageUrl = sanitizeImageUrl(article.featured_image_url);
  const imageHtml = imageUrl
    ? `<figure class="article-hero">
        <img src="${escapeAttr(imageUrl)}" alt="${escapeAttr(article.title)}" loading="eager" width="1200" height="630">
        <figcaption>Image credit: ${escapeHtml(article.featured_image_credit || article.source_name)}</figcaption>
      </figure>`
    : '';

  const tagsHtml = (article.tags || []).map(tag => {
    const slug = tag.toLowerCase().replace(/[^a-z0-9]+/g, '-');
    return `<a href="/topic/${slug}.html" class="trending-tag">${escapeHtml(tag)}</a>`;
  }).join(' ');

  // Split content at midpoint for in-article ad, with null guard
  const content = article.content || '';
  const mid = Math.floor(content.length / 2);
  const pBreak = content.lastIndexOf('</p>', mid);
  const part1 = pBreak >= 0 ? content.slice(0, pBreak + 4) : content;
  const part2 = pBreak >= 0 ? content.slice(pBreak + 4) : '';
  const adBreak = inArticleAd
    ? `<aside class="in-article-ad" aria-label="Advertisement">${inArticleAd}</aside>`
    : '';

  const body = `
  <div class="layout-article">
    <article class="article-main" itemscope itemtype="https://schema.org/NewsArticle" data-slug="${escapeAttr(article.slug)}">
      <header class="article-header">
        <a href="/category/${article.category}.html" class="article-category">${capitalize(article.category)}</a>
        <h1 class="article-title" itemprop="headline">${escapeHtml(article.title)}</h1>
        ${article.summary ? `<p class="article-summary">${escapeHtml(article.summary)}</p>` : ''}
        <div class="article-meta">
          <strong itemprop="author">${escapeHtml(article.author || 'Staff Reporter')}</strong>
          <span class="article-meta-dot">·</span>
          <time datetime="${new Date(article.site_publish_date || article.publish_date).toISOString()}" itemprop="datePublished">${publishedStr}</time>
          <span class="article-meta-dot">·</span>
          <span>Source: <a href="${escapeAttr(encodeURI(article.source_url || ''))}" rel="noopener noreferrer nofollow" target="_blank" itemprop="publisher">${escapeHtml(article.source_name)}</a></span>
        </div>
      </header>

      ${imageHtml}

      <div class="article-body" itemprop="articleBody">
        ${part1}
        ${adBreak}
        ${part2}
      </div>

      ${tagsHtml ? `<div class="share-bar" style="flex-wrap:wrap;gap:8px;margin-top:24px">${tagsHtml}</div>` : ''}

      <div class="share-bar">
        <span>Share:</span>
        <a class="share-btn" href="https://twitter.com/intent/tweet?url=${encodeURIComponent(SITE_URL + articlePath(article.category, article.slug))}&text=${encodeURIComponent(article.title)}" target="_blank" rel="noopener noreferrer">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-4.714-6.231-5.401 6.231H2.742l7.737-8.835L1.254 2.25H8.08l4.259 5.622zm-1.161 17.52h1.833L7.084 4.126H5.117z"/></svg>
          X / Twitter
        </a>
        <a class="share-btn" href="https://www.facebook.com/sharer/sharer.php?u=${encodeURIComponent(SITE_URL + articlePath(article.category, article.slug))}" target="_blank" rel="noopener noreferrer">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M24 12.073c0-6.627-5.373-12-12-12s-12 5.373-12 12c0 5.99 4.388 10.954 10.125 11.854v-8.385H7.078v-3.47h3.047V9.43c0-3.007 1.792-4.669 4.533-4.669 1.312 0 2.686.235 2.686.235v2.953H15.83c-1.491 0-1.956.925-1.956 1.874v2.25h3.328l-.532 3.47h-2.796v8.385C19.612 23.027 24 18.062 24 12.073z"/></svg>
          Facebook
        </a>
        <a class="share-btn" href="https://www.linkedin.com/sharing/share-offsite/?url=${encodeURIComponent(SITE_URL + articlePath(article.category, article.slug))}" target="_blank" rel="noopener noreferrer">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M20.447 20.452h-3.554v-5.569c0-1.328-.027-3.037-1.852-3.037-1.853 0-2.136 1.445-2.136 2.939v5.667H9.351V9h3.414v1.561h.046c.477-.9 1.637-1.85 3.37-1.85 3.601 0 4.267 2.37 4.267 5.455v6.286zM5.337 7.433c-1.144 0-2.063-.926-2.063-2.065 0-1.138.92-2.063 2.063-2.063 1.14 0 2.064.925 2.064 2.063 0 1.139-.925 2.065-2.064 2.065zm1.782 13.019H3.555V9h3.564v11.452zM22.225 0H1.771C.792 0 0 .774 0 1.729v20.542C0 23.227.792 24 1.771 24h20.451C23.2 24 24 23.227 24 22.271V1.729C24 .774 23.2 0 22.222 0h.003z"/></svg>
          LinkedIn
        </a>
      </div>

      <div class="article-source">
        Originally reported by <strong>${escapeHtml(article.source_name)}</strong>.
        <a href="${escapeAttr(encodeURI(article.source_url || ''))}" rel="noopener noreferrer nofollow" target="_blank">Read the original article →</a>
      </div>
    </article>

    <aside class="article-sidebar" aria-label="Sidebar">
      ${sidebarAd ? `<div class="sidebar-ad" aria-label="Advertisement">${sidebarAd}</div>` : ''}
      <div class="widget">
        <h3 class="widget-title">Popular Articles</h3>
        <div id="popular-articles"><!-- Populated by JS --></div>
      </div>
    </aside>
  </div>
  ${relatedHtml}`;

  const metaTags = `<meta name="description" content="${escapeAttr(article.meta_description || article.summary || '')}">
  <meta name="author" content="${escapeAttr(article.author || 'Staff Reporter')}">
  <meta name="robots" content="index, follow">`;

  return baseHtml({
    title: article.seo_title || article.title,
    meta: metaTags,
    schema: article.schema_markup,
    og: article.og_tags || '',
    body,
    activeCat: article.category,
    footerAd,
    canonicalPath: articlePath(article.category, article.slug),
  });
}

// ── Related articles section ──────────────────────────────────────────────────
function generateRelatedArticles(articles) {
  const items = articles.slice(0, 3).map(a => `
    <article class="article-card article-card--medium card-lift">
      ${sanitizeImageUrl(a.featured_image_url) ? `<div class="card-img-wrap">
        <a href="${articlePath(a.category, a.slug)}" tabindex="-1" aria-hidden="true">
          <img class="card-img" src="${escapeAttr(sanitizeImageUrl(a.featured_image_url))}" alt="" loading="lazy">
        </a>
      </div>` : ''}
      <div class="card-body">
        <a href="/category/${a.category}.html" class="card-category">${capitalize(a.category)}</a>
        <h4 class="card-title"><a href="${articlePath(a.category, a.slug)}">${escapeHtml(a.title)}</a></h4>
        <div class="card-meta">
          <time>${timeAgo(new Date(a.publish_date))}</time>
          <span class="card-meta-dot">·</span>
          <span>${escapeHtml(a.source_name)}</span>
        </div>
      </div>
    </article>`).join('\n');

  return `<section class="related-articles container">
  <div class="section-header">
    <h3 class="section-title">Related Articles</h3>
  </div>
  <div class="related-grid">${items}</div>
</section>`;
}

// ── Between-articles ad injector ──────────────────────────────────────────────
// Inserts an ad block after every `everyN` cards in a list.
function injectBetweenArticles(articles, size, adHtml, everyN = 4) {
  if (!adHtml) return articles.map(a => generateArticleCard(a, size)).join('\n');
  const adBlock = `<div class="between-articles-ad" aria-label="Advertisement">${adHtml}</div>`;
  return articles.map((a, i) => {
    const card = generateArticleCard(a, size);
    if ((i + 1) % everyN === 0 && i < articles.length - 1) {
      return card + '\n' + adBlock;
    }
    return card;
  }).join('\n');
}

// ── Category page ─────────────────────────────────────────────────────────────
function generateCategoryPage(category, articles, sidebarAd = '', footerAd = '', betweenArticlesAd = '') {
  const displayName = capitalize(category);
  const cardHtml = injectBetweenArticles(articles, 'medium', betweenArticlesAd);

  const body = `
  <div class="layout-default">
    <div class="category-header">
      <a href="/" class="card-category">← All News</a>
      <h1 class="page-title">${displayName}</h1>
      <p class="page-desc">Latest ${displayName} stories from trusted sources worldwide.</p>
    </div>
    <div class="articles-grid">
      ${cardHtml || '<p style="color:var(--gray-500);font-family:var(--sans);padding:40px 0">No articles yet. Check back soon.</p>'}
    </div>
  </div>`;

  return baseHtml({
    title: `${displayName} News — ${SITE_NAME}`,
    meta: `<meta name="description" content="Latest ${displayName} news and analysis from ${SITE_NAME}.">`,
    body,
    activeCat: category,
    footerAd,
    canonicalPath: `/category/${category}.html`,
  });
}

// ── Topic cluster page ────────────────────────────────────────────────────────
function generateTopicPage(topic, articles, footerAd = '') {
  const displayName = capitalize(topic);
  const cardHtml = articles.map(a => generateArticleCard(a, 'medium')).join('\n');

  const body = `
  <div class="layout-default">
    <div class="category-header">
      <a href="/" class="card-category">← All News</a>
      <h1 class="page-title">#${displayName}</h1>
      <p class="page-desc">All articles covering ${displayName}.</p>
    </div>
    <div class="articles-grid">
      ${cardHtml || '<p style="color:var(--gray-500);font-family:var(--sans);padding:40px 0">No articles yet.</p>'}
    </div>
  </div>`;

  return baseHtml({
    title: `${displayName} — ${SITE_NAME}`,
    meta: `<meta name="description" content="Latest news and analysis about ${displayName} from ${SITE_NAME}.">`,
    body,
    footerAd,
    canonicalPath: `/topic/${encodeURIComponent(topic)}.html`,
  });
}

// ── Homepage ──────────────────────────────────────────────────────────────────
function generateHomepage(data) {
  const { featured, latest, trending, byCategory, sidebarAd, footerAd, popularArticles } = data;

  // Hero + side
  const [heroArticle, ...sideArticles] = featured || [];
  const heroHtml = heroArticle ? generateArticleCard(heroArticle, 'large') : '';
  const sideHtml = (sideArticles || []).slice(0, 4).map(a => generateArticleCard(a, 'medium')).join('\n');

  // Trending topics bar
  const trendingHtml = (trending || []).slice(0, 8).map(t => {
    const slug = (t.topic || t.keyword || '').toLowerCase().replace(/[^a-z0-9]+/g, '-');
    return `<a href="/topic/${encodeURIComponent(slug)}.html" class="trending-tag">#${escapeHtml(t.topic || t.keyword)}</a>`;
  }).join('\n');

  // Latest section — inject between-articles ad every 4 items
  const latestList = (latest || []).slice(0, 12);
  const latestHtml = injectBetweenArticles(latestList, 'small', data.betweenArticlesAd || '');

  // Category sections
  const categorySectionsHtml = Object.entries(byCategory || {}).map(([cat, articles]) => {
    if (!articles.length) return '';
    const cards = articles.slice(0, 4).map(a => generateArticleCard(a, 'medium')).join('\n');
    return `<section class="latest-section">
      <div class="section-header">
        <h2 class="section-title">${capitalize(cat)}</h2>
        <a href="/category/${cat}.html" class="section-link">More ${capitalize(cat)} →</a>
      </div>
      <div class="top-stories-grid">${cards}</div>
    </section>`;
  }).join('\n');

  // Popular widget
  const popularHtml = (popularArticles || []).slice(0, 5).map((a, i) => `
    <div class="popular-item">
      <span class="popular-num">${String(i + 1).padStart(2, '0')}</span>
      <div class="popular-body">
        <a href="${articlePath(a.category, a.slug)}" class="popular-title">${escapeHtml(a.title)}</a>
        <div class="popular-meta">${capitalize(a.category)} · ${timeAgo(new Date(a.publish_date))}</div>
      </div>
    </div>`).join('\n');

  const body = `
  ${trendingHtml ? `<div class="trending-bar"><span class="trending-label">Trending</span>${trendingHtml}</div>` : ''}

  <div class="layout-home">
    <div class="home-main">

      <!-- Featured Hero -->
      <section class="featured-section">
        <div class="section-header">
          <h2 class="section-title">Top Stories</h2>
        </div>
        <div class="featured-grid">
          <div class="featured-hero">${heroHtml}</div>
          <div class="featured-side">${sideHtml}</div>
        </div>
      </section>

      <!-- Latest News -->
      <section class="latest-section" style="margin-top:calc(var(--gap)*2)">
        <div class="section-header">
          <h2 class="section-title">Latest News</h2>
        </div>
        <div class="latest-list">${latestHtml || '<p style="color:var(--gray-500);font-family:var(--sans);padding:24px 0">Fresh stories loading soon…</p>'}</div>
      </section>

      <!-- Category Sections -->
      <div style="margin-top:calc(var(--gap)*2)">
        ${categorySectionsHtml}
      </div>

    </div>

    <aside class="home-sidebar" aria-label="Sidebar">
      ${sidebarAd ? `<div class="sidebar-ad" aria-label="Advertisement">${sidebarAd}</div>` : ''}
      <div class="widget">
        <h3 class="widget-title">Most Read</h3>
        ${popularHtml || '<div id="popular-articles"><!-- Populated by JS --></div>'}
      </div>
    </aside>
  </div>`;

  return baseHtml({
    title: `${SITE_NAME} — Uncovering stories behind the headlines`,
    meta: `<meta name="description" content="${SITE_NAME} — Independent AI-powered news aggregation. Uncovering stories behind the headlines.">`,
    body,
    footerAd,
    canonicalPath: '/',
  });
}

// ── Search index JSON ─────────────────────────────────────────────────────────
function generateSearchIndex(articles) {
  return JSON.stringify(
    articles.map(a => ({
      title: a.title,
      slug: a.slug,
      summary: (a.summary || '').slice(0, 200),
      category: a.category,
      publish_date: a.publish_date,
      view_count: a.view_count || 0,
      source: a.source_name,
      image: sanitizeImageUrl(a.featured_image_url) || null,
      url: articlePath(a.category, a.slug),
    })),
    null,
    0
  );
}

// ── RSS Feed ──────────────────────────────────────────────────────────────────
function generateRssFeed(articles) {
  const items = articles.slice(0, 30).map(a => {
    const url = `${SITE_URL}${articlePath(a.category, a.slug)}`;
    return `  <item>
    <title><![CDATA[${a.title}]]></title>
    <link>${url}</link>
    <guid isPermaLink="true">${url}</guid>
    <description><![CDATA[${a.summary || ''}]]></description>
    <pubDate>${new Date(a.publish_date).toUTCString()}</pubDate>
    <category>${a.category}</category>
  </item>`;
  }).join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>${SITE_NAME}</title>
    <link>${SITE_URL}</link>
    <description>Uncovering stories behind the headlines.</description>
    <language>en-us</language>
    <lastBuildDate>${new Date().toUTCString()}</lastBuildDate>
    <atom:link href="${SITE_URL}/feed.xml" rel="self" type="application/rss+xml"/>
${items}
  </channel>
</rss>`;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Sanitize image URL.
 * - Self-hosted paths (/images/articles/...) are committed to GitHub and served
 *   by Cloudflare Pages — allow them.
 * - External https:// fallback URLs are also allowed.
 * - Reject bare relative paths or anything without a valid prefix.
 */
function sanitizeImageUrl(url) {
  if (!url) return null;
  if (url.startsWith('/images/')) return url;                          // self-hosted ✓
  if (url.startsWith('https://') || url.startsWith('http://')) return url; // external ✓
  if (url.startsWith('//')) return url;                                // protocol-relative ✓
  return null;                                                         // reject everything else
}


function capitalize(str) {
  return str ? str.charAt(0).toUpperCase() + str.slice(1) : '';
}

function escapeHtml(str) {
  return (str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatDisplayDate(date) {
  return date.toLocaleDateString('en-US', {
    year: 'numeric', month: 'long', day: 'numeric',
  });
}

function timeAgo(date) {
  const seconds = Math.floor((Date.now() - date) / 1000);
  if (seconds < 60) return 'Just now';
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  if (seconds < 604800) return `${Math.floor(seconds / 86400)}d ago`;
  return formatDisplayDate(date);
}

module.exports = {
  generateArticlePage,
  generateCategoryPage,
  generateTopicPage,
  generateHomepage,
  generateSearchIndex,
  generateRssFeed,
};
