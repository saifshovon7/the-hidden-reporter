'use strict';
/**
 * main.js — The Hidden Reporter
 * Client-side interactions: header, search, nav, view tracking, popular articles,
 * dynamic homepage loader, dynamic category page loader.
 */

// ── Sticky header scroll effect ───────────────────────────────────────────────
(function () {
  const header = document.getElementById('site-header');
  if (!header) return;
  window.addEventListener('scroll', () => {
    header.classList.toggle('scrolled', window.scrollY > 10);
  }, { passive: true });
})();

// ── Search toggle ─────────────────────────────────────────────────────────────
function toggleSearch() {
  const bar = document.getElementById('search-bar');
  const input = document.getElementById('header-search-input');
  if (!bar) return;
  const isOpen = bar.classList.toggle('is-open');
  bar.setAttribute('aria-hidden', String(!isOpen));
  if (isOpen && input) setTimeout(() => input.focus(), 60);
}

// Close search on Escape
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') {
    const bar = document.getElementById('search-bar');
    if (bar && bar.classList.contains('is-open')) {
      bar.classList.remove('is-open');
      bar.setAttribute('aria-hidden', 'true');
    }
  }
});

// ── Nav toggle (hamburger) ────────────────────────────────────────────────────
function toggleNav(btn) {
  const nav = document.getElementById('main-nav');
  if (!nav) return;
  const isOpen = nav.classList.toggle('is-open');
  btn.classList.toggle('is-open', isOpen);
  btn.setAttribute('aria-expanded', String(isOpen));
}

// Close nav when clicking outside
document.addEventListener('click', e => {
  const nav = document.getElementById('main-nav');
  const btn = document.getElementById('nav-toggle');
  if (!nav || !nav.classList.contains('is-open')) return;
  if (!nav.contains(e.target) && (!btn || !btn.contains(e.target))) {
    nav.classList.remove('is-open');
    if (btn) { btn.classList.remove('is-open'); btn.setAttribute('aria-expanded', 'false'); }
  }
});

// ── Card renderer (used by homepage + category loaders) ──────────────────────
function renderCard(a, size) {
  const hLevel = size === 'large' ? '2' : size === 'medium' ? '3' : '4';
  const timeStr = timeAgo(new Date(a.date || a.publish_date));
  const imgHtml = a.image
    ? `<div class="card-img-wrap"><a href="${escapeHtml(a.url)}" tabindex="-1" aria-hidden="true"><img class="card-img" src="${escapeHtml(a.image)}" alt="" loading="lazy"></a></div>`
    : '';

  if (size === 'small') {
    return `<article class="article-card article-card--small">
      ${a.image ? `<div class="card-img-wrap" style="width:100px;flex-shrink:0;margin:0;aspect-ratio:unset"><a href="${escapeHtml(a.url)}" tabindex="-1" aria-hidden="true"><img class="card-img" src="${escapeHtml(a.image)}" alt="" loading="lazy" style="width:100px;height:70px;object-fit:cover"></a></div>` : ''}
      <div class="card-body">
        <a href="/category/${escapeHtml(a.category)}.html" class="card-category">${capitalize(a.category)}</a>
        <h${hLevel} class="card-title"><a href="${escapeHtml(a.url)}">${escapeHtml(a.title)}</a></h${hLevel}>
        <div class="card-meta"><span>${timeStr}</span><span class="card-meta-dot">·</span><span>${escapeHtml(a.source || '')}</span></div>
      </div>
    </article>`;
  }

  return `<article class="article-card article-card--${size} card-lift">
    ${imgHtml}
    <div class="card-body">
      <a href="/category/${escapeHtml(a.category)}.html" class="card-category">${capitalize(a.category)}</a>
      <h${hLevel} class="card-title"><a href="${escapeHtml(a.url)}">${escapeHtml(a.title)}</a></h${hLevel}>
      <p class="card-summary">${escapeHtml((a.summary || '').slice(0, 160))}</p>
      <div class="card-meta"><span>${timeStr}</span><span class="card-meta-dot">·</span><span>${escapeHtml(a.source || '')}</span></div>
    </div>
  </article>`;
}

// ── Homepage dynamic loader ───────────────────────────────────────────────────
(async function initHomepage() {
  const heroCont = document.querySelector('.featured-hero');
  const sideCont = document.querySelector('.featured-side');
  const latestCont = document.querySelector('.latest-list');
  // Only run on homepage
  if (!heroCont && !latestCont) return;

  try {
    const [latestRes, featuredRes] = await Promise.all([
      fetch('/api/latest.json'),
      fetch('/api/featured.json'),
    ]);

    if (!latestRes.ok || !featuredRes.ok) throw new Error('Feed fetch failed');

    const latestData = await latestRes.json();
    const featuredData = await featuredRes.json();

    const featured = featuredData.articles || [];
    const latest = latestData.articles || [];

    // Hero — first featured article (large card)
    if (heroCont && featured.length) {
      heroCont.innerHTML = renderCard(featured[0], 'large');
    }

    // Side — next 4 featured articles
    if (sideCont && featured.length > 1) {
      sideCont.innerHTML = featured.slice(1, 5).map(a => renderCard(a, 'medium')).join('');
    }

    // Latest list — most recent 12 articles
    if (latestCont) {
      const items = latest.slice(0, 12);
      if (items.length) {
        latestCont.innerHTML = items.map(a => renderCard(a, 'small')).join('');
      } else {
        latestCont.innerHTML = '<p style="color:var(--gray-500);font-family:var(--sans);padding:24px 0">Fresh stories loading soon…</p>';
      }
    }

    // Category sections — load each category feed
    const catSections = document.querySelectorAll('.top-stories-grid');
    if (catSections.length) {
      const catRes = await Promise.all(
        ['general','technology','business','science','world','politics','finance','sports'].map(cat =>
          fetch(`/api/category-${cat}.json`).then(r => r.ok ? r.json() : { category: cat, articles: [] }).catch(() => ({ category: cat, articles: [] }))
        )
      );
      catRes.forEach(data => {
        const articles = data.articles || [];
        if (!articles.length) return;
        const section = document.querySelector(`.latest-section a[href="/category/${data.category}.html"]`);
        if (!section) return;
        const grid = section.closest('.latest-section')?.querySelector('.top-stories-grid');
        if (grid) {
          grid.innerHTML = articles.slice(0, 4).map(a => renderCard(a, 'medium')).join('');
        }
      });
    }

  } catch (e) {
    console.error('[Homepage] Load error:', e);
    if (latestCont) {
      latestCont.innerHTML = '<p style="color:var(--gray-500);font-family:var(--sans);padding:24px 0">Fresh stories loading soon…</p>';
    }
  }
})();

// ── Category page dynamic loader ──────────────────────────────────────────────
(async function initCategoryPage() {
  const grid = document.querySelector('.articles-grid');
  if (!grid) return;
  const path = window.location.pathname;
  const match = path.match(/\/category\/(\w+)\.html/);
  if (!match) return;
  const cat = match[1];

  try {
    const res = await fetch(`/api/category-${cat}.json`);
    if (!res.ok) throw new Error('Feed not found');
    const data = await res.json();
    const articles = data.articles || [];
    if (articles.length) {
      grid.innerHTML = articles.map(a => renderCard(a, 'medium')).join('');
    } else {
      grid.innerHTML = '<p style="color:var(--gray-500);font-family:var(--sans);padding:40px 0">No articles yet. Check back soon.</p>';
    }
  } catch (e) {
    console.error('[Category] Load error:', e);
  }
})();

// ── Search page: load results from search-index.json ─────────────────────────
(async function initSearch() {
  const input = document.getElementById('search-page-input');
  const resultsEl = document.getElementById('search-results');
  const countEl = document.getElementById('search-results-count');
  if (!input || !resultsEl) return;

  const params = new URLSearchParams(window.location.search);
  const query = params.get('q') || '';
  if (!query) return;

  input.value = query;

  try {
    const res = await fetch('/search-index.json');
    const index = await res.json();
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean);

    const results = index.filter(a => {
      const text = `${a.title} ${a.summary} ${a.category}`.toLowerCase();
      return terms.every(t => text.includes(t));
    });

    if (countEl) countEl.textContent = `${results.length} result${results.length !== 1 ? 's' : ''} for "${query}"`;

    if (!results.length) {
      resultsEl.innerHTML = `<p style="color:var(--gray-500);font-family:var(--sans);padding:32px 0">No results found. Try different keywords.</p>`;
      return;
    }

    resultsEl.innerHTML = `<div class="articles-grid">${results.slice(0, 40).map(a => `
      <article class="article-card article-card--medium card-lift">
        ${a.image ? `<div class="card-img-wrap"><a href="${escapeHtml(a.url)}"><img class="card-img" src="${escapeHtml(a.image)}" alt="" loading="lazy"></a></div>` : ''}
        <div class="card-body">
          <a href="/category/${escapeHtml(a.category)}.html" class="card-category">${capitalize(a.category)}</a>
          <h3 class="card-title"><a href="${escapeHtml(a.url)}">${escapeHtml(a.title)}</a></h3>
          <p class="card-summary">${escapeHtml((a.summary || '').slice(0, 140))}</p>
          <div class="card-meta"><span>${timeAgo(new Date(a.publish_date))}</span><span class="card-meta-dot">·</span><span>${escapeHtml(a.source || '')}</span></div>
        </div>
      </article>`).join('')}</div>`;
  } catch {
    if (countEl) countEl.textContent = 'Search index unavailable. Please try again later.';
  }
})();

// ── Popular articles widget ───────────────────────────────────────────────────
(async function initPopular() {
  const container = document.getElementById('popular-articles');
  if (!container) return;
  try {
    const res = await fetch('/search-index.json');
    const index = await res.json();
    const top5 = [...index].sort((a, b) => (b.view_count || 0) - (a.view_count || 0)).slice(0, 5);
    if (!top5.length) return;
    container.innerHTML = top5.map((a, i) => `
      <div class="popular-item">
        <span class="popular-num">${String(i + 1).padStart(2, '0')}</span>
        <div class="popular-body">
          <a class="popular-title" href="${escapeHtml(a.url)}">${escapeHtml(a.title)}</a>
          <div class="popular-meta">${capitalize(a.category)} · ${timeAgo(new Date(a.publish_date))}</div>
        </div>
      </div>`).join('');
  } catch { /* silent */ }
})();

// ── View tracking (article pages) ─────────────────────────────────────────────
(function trackView() {
  const articleSlug = document.querySelector('article[itemtype="https://schema.org/NewsArticle"]')
    ?.getAttribute('data-slug');
  if (!articleSlug) return;

  const cfg = window.__THR__;
  if (!cfg || !cfg.supabaseUrl || !cfg.supabaseKey) return;

  fetch(`${cfg.supabaseUrl}/rest/v1/rpc/increment_view_count`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'apikey': cfg.supabaseKey,
      'Authorization': `Bearer ${cfg.supabaseKey}`,
    },
    body: JSON.stringify({ article_slug: articleSlug }),
  }).catch(() => { /* silent */ });
})();

// ── Helpers ───────────────────────────────────────────────────────────────────
function escapeHtml(str) {
  return (str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function capitalize(str) {
  return str ? str.charAt(0).toUpperCase() + str.slice(1) : '';
}
function timeAgo(date) {
  const s = Math.floor((Date.now() - date) / 1000);
  if (s < 60) return 'Just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  if (s < 604800) return `${Math.floor(s / 86400)}d ago`;
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

// ── Footer year ───────────────────────────────────────────────────────────────
const yearEl = document.getElementById('footer-year');
if (yearEl) yearEl.textContent = new Date().getFullYear();
