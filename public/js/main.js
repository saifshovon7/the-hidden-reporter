/* main.js — The Hidden Reporter
   Minimal JS: search toggle, search page, popular articles,
   view count tracking */

'use strict';

// ── Search bar toggle ─────────────────────────────────────
function toggleSearch() {
  const bar = document.getElementById('search-bar');
  if (!bar) return;
  if (bar.hasAttribute('hidden')) {
    bar.removeAttribute('hidden');
    const input = bar.querySelector('.search-input');
    if (input) input.focus();
  } else {
    bar.setAttribute('hidden', '');
  }
}

// ── Hamburger nav toggle ──────────────────────────────────
function toggleNav(btn) {
  const nav = document.getElementById('main-nav');
  if (!nav) return;
  const open = nav.classList.toggle('is-open');
  btn.classList.toggle('is-open', open);
  btn.setAttribute('aria-expanded', open ? 'true' : 'false');
}

// ── Search page ───────────────────────────────────────────
(function initSearchPage() {
  const resultsEl = document.getElementById('search-results');
  const countEl   = document.getElementById('search-results-count');
  const inputEl   = document.getElementById('search-page-input');
  if (!resultsEl) return;

  const params = new URLSearchParams(window.location.search);
  const query  = (params.get('q') || '').trim().toLowerCase();

  if (inputEl) inputEl.value = params.get('q') || '';
  if (!query)  return;

  document.title = `Search: "${params.get('q')}" — The Hidden Reporter`;

  fetch('/search-index.json')
    .then(r => r.json())
    .then(articles => {
      const results = articles.filter(a => {
        const haystack = `${a.title} ${a.summary} ${a.category}`.toLowerCase();
        return query.split(/\s+/).every(word => haystack.includes(word));
      });

      if (countEl) {
        countEl.textContent = `${results.length} result${results.length !== 1 ? 's' : ''} for "${params.get('q')}"`;
      }

      if (!results.length) {
        resultsEl.innerHTML = '<p style="color:#888;font-style:italic;">No articles found. Try a different keyword.</p>';
        return;
      }

      resultsEl.innerHTML = results.map(a => {
        const date = new Date(a.publish_date || a.date).toLocaleDateString('en-US', { year:'numeric', month:'long', day:'numeric' });
        const url  = a.url || `/articles/${a.category}/${a.slug}`;
        return `<div class="search-result-item">
          <h3><a href="${url}">${escapeHtml(a.title)}</a></h3>
          <p>${escapeHtml(a.summary || '')}</p>
          <div class="search-result-meta">
            <a href="/category/${a.category}.html" class="article-category">${capitalize(a.category)}</a>
            &nbsp;·&nbsp; ${date} &nbsp;·&nbsp; ${escapeHtml(a.source)}
          </div>
        </div>`;
      }).join('');
    })
    .catch(() => {
      if (resultsEl) resultsEl.innerHTML = '<p style="color:#888;">Search unavailable.</p>';
    });
})();

// ── Popular articles widget ───────────────────────────────
(function loadPopularArticles() {
  const containers = document.querySelectorAll('#popular-articles');
  if (!containers.length) return;

  fetch('/search-index.json')
    .then(r => r.json())
    .then(articles => {
      // The search index doesn't include view_count; show 5 most recent
      // (Supabase view_count tracking handled server-side)
      const recent = articles.slice(0, 5);
      const html = recent.map((a, i) => {
        const url = a.url || `/articles/${a.category}/${a.slug}`;
        return `<div class="popular-item">
          <span class="popular-num">${i + 1}</span>
          <a href="${url}">${escapeHtml(a.title)}</a>
        </div>`;
      }).join('');
      containers.forEach(el => { el.innerHTML = html; });
    })
    .catch(() => {});
})();

// ── View count ping ───────────────────────────────────────
(function trackView() {
  const body = document.querySelector('[itemtype="https://schema.org/NewsArticle"]');
  if (!body) return;

  // Extract slug from URL — supports /articles/{category}/{slug}
  const match = window.location.pathname.match(/\/articles\/[^/]+\/([^/]+?)(?:\.html)?$/);
  if (!match) return;
  const slug = match[1];

  // Ping the Supabase increment function via a small fetch
  const supabaseUrl = document.documentElement.dataset.supabaseUrl;
  const supabaseKey = document.documentElement.dataset.supabaseKey;
  if (!supabaseUrl || !supabaseKey) return;

  fetch(`${supabaseUrl}/rest/v1/rpc/increment_view_count`, {
    method:  'POST',
    headers: {
      'Content-Type':  'application/json',
      'apikey':         supabaseKey,
      'Authorization': `Bearer ${supabaseKey}`,
    },
    body: JSON.stringify({ article_slug: slug }),
  }).catch(() => {});
})();

// ── Helpers ───────────────────────────────────────────────
function escapeHtml(str) {
  const map = { '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' };
  return (str || '').replace(/[&<>"']/g, c => map[c]);
}

function capitalize(s) {
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : '';
}
