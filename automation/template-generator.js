'use strict';
/**
 * template-generator.js
 * Generates all static HTML pages: articles, categories, homepage,
 * search index, RSS feed, and sitemap.
 */

const { config }    = require('./config');
const { escapeAttr } = require('./seo-generator');

const SITE_URL  = config.site.url;
const SITE_NAME = config.site.name;

// ── Shared header partial ─────────────────────────────────────────────────────
function headerPartial(activeCat = '') {
  const cats = config.categories.map(c => {
    const active = c === activeCat ? ' aria-current="page"' : '';
    return `<a href="/category/${c}.html"${active}>${capitalize(c)}</a>`;
  }).join('\n          ');

  return `<header class="site-header">
    <div class="header-inner">
      <div class="header-top">
        <div class="header-date">${formatDisplayDate(new Date())}</div>
        <div class="header-logo">
          <a href="/" class="logo-link">
            <span class="logo-name">The Hidden Reporter</span>
            <span class="logo-tagline">Uncovering stories behind the headlines.</span>
          </a>
        </div>
        <div class="header-search">
          <button class="search-toggle" aria-label="Toggle search" onclick="toggleSearch()">
            <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"></circle><line x1="21" y1="21" x2="16.65" y2="16.65"></line></svg>
          </button>
          <button class="nav-toggle" aria-label="Toggle navigation" aria-expanded="false" onclick="toggleNav(this)">
            <span></span><span></span><span></span>
          </button>
        </div>
      </div>
      <div id="search-bar" class="search-bar" hidden>
        <form action="/search.html" method="get" class="search-form">
          <input type="search" name="q" placeholder="Search articles…" class="search-input" autofocus>
          <button type="submit" class="search-btn">Search</button>
        </form>
      </div>
      <nav class="main-nav" id="main-nav" aria-label="Main navigation">
        <a href="/">Home</a>
        ${cats}
      </nav>
    </div>
  </header>`;
}

// ── Shared footer partial ─────────────────────────────────────────────────────
function footerPartial(footerAdHtml = '') {
  return `<footer class="site-footer">
    ${footerAdHtml ? `<div class="footer-ad">${footerAdHtml}</div>` : ''}
    <div class="footer-inner">
      <div class="footer-brand">
        <strong>${SITE_NAME}</strong><br>
        <em>Uncovering stories behind the headlines.</em>
      </div>
      <nav class="footer-nav">
        <a href="/about.html">About</a>
        <a href="/editorial-policy.html">Editorial Policy</a>
        <a href="/contact.html">Contact</a>
        <a href="/feed.xml">RSS Feed</a>
        <a href="/sitemap.xml">Sitemap</a>
      </nav>
      <p class="footer-copy">&copy; ${new Date().getFullYear()} ${SITE_NAME}. All rights reserved.</p>
    </div>
  </footer>`;
}

// ── Base HTML wrapper ─────────────────────────────────────────────────────────
function baseHtml({ title, meta, schema, og, body, activeCat = '', footerAd = '', canonicalPath = '/' }) {
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
  <link href="https://fonts.googleapis.com/css2?family=Instrument+Serif:ital@0;1&display=swap" rel="stylesheet">
  <link rel="stylesheet" href="/css/style.css">
  <link rel="alternate" type="application/rss+xml" title="${SITE_NAME}" href="/feed.xml">
  <link rel="canonical" href="${SITE_URL}${canonicalPath || '/'}">
  ${schema ? `<script type="application/ld+json">${schema}</script>` : ''}
</head>
<body>
  ${headerPartial(activeCat)}
  <main class="site-main">
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

// ── Article page ──────────────────────────────────────────────────────────────
function generateArticlePage(article, related = [], sidebarAd = '', inArticleAd = '', footerAd = '') {
  const publishedStr  = formatDisplayDate(new Date(article.publish_date));
  const relatedHtml   = related.length ? generateRelatedArticles(related) : '';
  const imageHtml     = article.featured_image_url
    ? `<figure class="article-hero">
        <img src="${escapeAttr(article.featured_image_url)}" alt="${escapeAttr(article.title)}" loading="lazy">
        <figcaption>Image credit: ${escapeHtml(article.featured_image_credit || article.source_name)}</figcaption>
      </figure>`
    : '';

  const tagsHtml = (article.tags || []).map(tag =>
    `<a href="/search.html?q=${encodeURIComponent(tag)}" class="tag">${escapeHtml(tag)}</a>`
  ).join(' ');

  // Split content at midpoint to insert in-article ad
  const mid     = Math.floor(article.content.length / 2);
  const pBreak  = article.content.lastIndexOf('</p>', mid);
  const part1   = article.content.slice(0, pBreak + 4);
  const part2   = article.content.slice(pBreak + 4);
  const adBreak = inArticleAd ? `<aside class="in-article-ad" aria-label="Advertisement">${inArticleAd}</aside>` : '';

  const body = `
  <div class="layout-article">
    <article class="article-main" itemscope itemtype="https://schema.org/NewsArticle">
      <header class="article-header">
        <a href="/category/${article.category}.html" class="article-category">${capitalize(article.category)}</a>
        <h1 class="article-title" itemprop="headline">${escapeHtml(article.title)}</h1>
        <div class="article-meta">
          <span class="article-author" itemprop="author">${escapeHtml(article.author || 'Staff Reporter')}</span>
          <time class="article-date" datetime="${new Date(article.publish_date).toISOString()}" itemprop="datePublished">${publishedStr}</time>
          <span class="article-source">Source: <a href="${escapeAttr(article.source_url)}" rel="noopener noreferrer nofollow" target="_blank">${escapeHtml(article.source_name)}</a></span>
        </div>
      </header>
      ${imageHtml}
      <div class="article-body" itemprop="articleBody">
        ${part1}
        ${adBreak}
        ${part2}
      </div>
      ${tagsHtml ? `<div class="article-tags">${tagsHtml}</div>` : ''}
      <div class="article-source-credit">
        <p>Originally reported by <strong>${escapeHtml(article.source_name)}</strong>. <a href="${escapeAttr(article.source_url)}" rel="noopener noreferrer nofollow" target="_blank">Read the original article</a>.</p>
      </div>
    </article>
    <aside class="article-sidebar">
      ${sidebarAd ? `<div class="sidebar-ad" aria-label="Advertisement">${sidebarAd}</div>` : ''}
      <div class="sidebar-widget">
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
    title:         article.seo_title || article.title,
    meta:          metaTags,
    schema:        article.schema_markup,
    og:            article.og_tags || '',
    body,
    activeCat:     article.category,
    footerAd,
    canonicalPath: articlePath(article.category, article.slug),
  });
}

// ── Related articles section ──────────────────────────────────────────────────
function generateRelatedArticles(articles) {
  const items = articles.slice(0, 4).map(a => `
    <article class="related-card">
      ${a.featured_image_url
        ? `<a href="${articlePath(a.category, a.slug)}"><img src="${escapeAttr(a.featured_image_url)}" alt="${escapeAttr(a.title)}" loading="lazy"></a>`
        : ''}
      <div class="related-card-body">
        <a href="/category/${a.category}.html" class="article-category">${capitalize(a.category)}</a>
        <h4><a href="${articlePath(a.category, a.slug)}">${escapeHtml(a.title)}</a></h4>
        <time>${formatDisplayDate(new Date(a.publish_date))}</time>
      </div>
    </article>`).join('\n');

  return `<section class="related-articles">
    <h3 class="section-title">Related Articles</h3>
    <div class="related-grid">${items}</div>
  </section>`;
}

// ── Category page ─────────────────────────────────────────────────────────────
function generateCategoryPage(category, articles, sidebarAd = '', footerAd = '') {
  const cardHtml = articles.map(a => generateArticleCard(a, 'medium')).join('\n');
  const displayName = capitalize(category);

  const body = `
  <div class="layout-default">
    <section class="category-section">
      <h1 class="page-title">${displayName} News</h1>
      <p class="page-subtitle">Latest ${displayName} stories from trusted sources.</p>
      <div class="articles-grid">
        ${cardHtml || '<p class="empty-state">No articles yet. Check back soon.</p>'}
      </div>
    </section>
    <aside class="sidebar">
      ${sidebarAd ? `<div class="sidebar-ad">${sidebarAd}</div>` : ''}
      <div class="sidebar-widget">
        <h3 class="widget-title">Popular Articles</h3>
        <div id="popular-articles"><!-- Populated by JS --></div>
      </div>
    </aside>
  </div>`;

  return baseHtml({
    title:         `${displayName} News — ${SITE_NAME}`,
    meta:          `<meta name="description" content="Latest ${displayName} news and analysis from ${SITE_NAME}.">`,
    body,
    activeCat:     category,
    footerAd,
    canonicalPath: `/category/${category}.html`,
  });
}

// ── Topic cluster page ────────────────────────────────────────────────────────
function generateTopicPage(topic, articles, footerAd = '') {
  const cardHtml = articles.map(a => generateArticleCard(a, 'medium')).join('\n');
  const displayName = capitalize(topic);

  const body = `
  <div class="layout-default">
    <section class="topic-section">
      <h1 class="page-title">#${displayName}</h1>
      <p class="page-subtitle">All articles about ${displayName}.</p>
      <div class="articles-grid">
        ${cardHtml || '<p class="empty-state">No articles yet.</p>'}
      </div>
    </section>
  </div>`;

  return baseHtml({
    title:         `${displayName} — ${SITE_NAME}`,
    meta:          `<meta name="description" content="Latest news and analysis about ${displayName} from ${SITE_NAME}.">`,
    body,
    footerAd,
    canonicalPath: `/topic/${encodeURIComponent(topic)}.html`,
  });
}

// ── Article card ──────────────────────────────────────────────────────────────
function generateArticleCard(article, size = 'small') {
  const href   = articlePath(article.category, article.slug);
  const hLevel = size === 'large' ? '2' : size === 'medium' ? '3' : '4';
  const imgHtml = article.featured_image_url
    ? `<a href="${href}" class="card-image-link">
        <img src="${escapeAttr(article.featured_image_url)}" alt="${escapeAttr(article.title)}" loading="lazy">
       </a>`
    : '';

  return `<article class="article-card article-card--${size}">
    ${imgHtml}
    <div class="card-body">
      <a href="/category/${article.category}.html" class="article-category">${capitalize(article.category)}</a>
      <h${hLevel} class="card-title">
        <a href="${href}">${escapeHtml(article.title)}</a>
      </h${hLevel}>
      <p class="card-summary">${escapeHtml((article.summary || '').slice(0, 150))}${(article.summary || '').length > 150 ? '…' : ''}</p>
      <div class="card-meta">
        <time datetime="${new Date(article.publish_date).toISOString()}">${formatDisplayDate(new Date(article.publish_date))}</time>
        <span class="card-source">${escapeHtml(article.source_name)}</span>
      </div>
    </div>
  </article>`;
}

// ── Homepage ──────────────────────────────────────────────────────────────────
function generateHomepage(data) {
  const { featured, latest, trending, byCategory, sidebarAd, footerAd, popularArticles } = data;

  // Featured section: 1 large + 4 small
  const [heroArticle, ...sideArticles] = featured || [];
  const heroHtml  = heroArticle ? generateArticleCard(heroArticle, 'large') : '';
  const sideHtml  = (sideArticles || []).slice(0, 4).map(a => generateArticleCard(a, 'small')).join('\n');

  // Trending topics bar
  const trendingHtml = (trending || []).slice(0, 5).map(t =>
    `<a href="/topic/${encodeURIComponent(t.topic)}.html" class="trending-tag">#${escapeHtml(t.topic)}</a>`
  ).join('\n');

  // Latest section (20 articles)
  const latestHtml = (latest || []).slice(0, 20).map(a => generateArticleCard(a, 'small')).join('\n');

  // Category sections
  const categorySectionsHtml = Object.entries(byCategory || {}).map(([cat, articles]) => {
    if (!articles.length) return '';
    const cards = articles.slice(0, 4).map(a => generateArticleCard(a, 'small')).join('\n');
    return `<section class="home-category-section">
      <div class="section-header">
        <h2 class="section-title">${capitalize(cat)}</h2>
        <a href="/category/${cat}.html" class="section-more">More ${capitalize(cat)} →</a>
      </div>
      <div class="articles-row">${cards}</div>
    </section>`;
  }).join('\n');

  // Popular articles widget
  const popularHtml = (popularArticles || []).slice(0, 5).map((a, i) =>
    `<div class="popular-item">
      <span class="popular-num">${i + 1}</span>
      <a href="${articlePath(a.category, a.slug)}">${escapeHtml(a.title)}</a>
    </div>`
  ).join('\n');

  const body = `
  <section class="trending-bar">
    <span class="trending-label">Trending:</span>
    ${trendingHtml || '<span>Loading…</span>'}
  </section>

  <div class="layout-home">
    <div class="home-main">
      <!-- Featured Section -->
      <section class="featured-section">
        <div class="section-header">
          <h2 class="section-title">Featured Stories</h2>
        </div>
        <div class="featured-grid">
          <div class="featured-hero">${heroHtml}</div>
          <div class="featured-side">${sideHtml}</div>
        </div>
      </section>

      <hr class="section-divider">

      <!-- Latest News -->
      <section class="latest-section">
        <div class="section-header">
          <h2 class="section-title">Latest News</h2>
        </div>
        <div class="articles-grid">
          ${latestHtml || '<p class="empty-state">Fresh stories loading soon…</p>'}
        </div>
      </section>

      <hr class="section-divider">

      <!-- Category Sections -->
      ${categorySectionsHtml}
    </div>

    <aside class="home-sidebar">
      ${sidebarAd ? `<div class="sidebar-ad">${sidebarAd}</div>` : ''}
      <div class="sidebar-widget">
        <h3 class="widget-title">Popular Articles</h3>
        ${popularHtml || '<div id="popular-articles"><!-- Populated by JS --></div>'}
      </div>
    </aside>
  </div>`;

  return baseHtml({
    title:         `${SITE_NAME} — Uncovering stories behind the headlines.`,
    meta:          `<meta name="description" content="The Hidden Reporter — Independent news aggregation. Uncovering stories behind the headlines.">`,
    body,
    footerAd,
    canonicalPath: '/',
  });
}

// ── Search index JSON ─────────────────────────────────────────────────────────
function generateSearchIndex(articles) {
  return JSON.stringify(
    articles.map(a => ({
      title:        a.title,
      slug:         a.slug,
      summary:      (a.summary || '').slice(0, 200),
      category:     a.category,
      publish_date: a.publish_date,
      source:       a.source_name,
      image:        a.featured_image_url || null,
      url:          articlePath(a.category, a.slug),
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
    year:  'numeric',
    month: 'long',
    day:   'numeric',
  });
}

module.exports = {
  generateArticlePage,
  generateCategoryPage,
  generateTopicPage,
  generateHomepage,
  generateSearchIndex,
  generateRssFeed,
};
