'use strict';
/**
 * sitemap-generator.js
 * Generates sitemap.xml from all published articles and static pages.
 */

const { createClient } = require('@supabase/supabase-js');
const { config } = require('./config');

const supabase = createClient(config.supabase.url, config.supabase.serviceKey);
const SITE_URL = config.site.url;

function xmlEscape(str) {
  return (str || '').replace(/&/g, '&amp;').replace(/'/g, '&apos;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function urlEntry(loc, lastmod, changefreq, priority) {
  return `  <url>
    <loc>${xmlEscape(loc)}</loc>
    <lastmod>${lastmod}</lastmod>
    <changefreq>${changefreq}</changefreq>
    <priority>${priority}</priority>
  </url>`;
}

async function generateSitemap() {
  console.log('[Sitemap] Generating sitemap.xml...');

  const now = new Date().toISOString().split('T')[0];

  // Static pages
  const staticEntries = [
    urlEntry(`${SITE_URL}/`, now, 'hourly', '1.0'),
    urlEntry(`${SITE_URL}/search.html`, now, 'monthly', '0.3'),
    urlEntry(`${SITE_URL}/about.html`, now, 'monthly', '0.4'),
    urlEntry(`${SITE_URL}/contact.html`, now, 'monthly', '0.3'),
    urlEntry(`${SITE_URL}/editorial-policy.html`, now, 'monthly', '0.3'),
  ];

  // Category pages
  const categoryEntries = config.categories.map(cat =>
    urlEntry(`${SITE_URL}/category/${cat}.html`, now, 'hourly', '0.8')
  );

  // Topic pages
  const { data: topics } = await supabase
    .from('trending_topics')
    .select('keyword, last_updated')
    .limit(50);

  const topicEntries = (topics || []).map(t => {
    const date = new Date(t.last_updated).toISOString().split('T')[0];
    return urlEntry(`${SITE_URL}/topic/${encodeURIComponent(t.keyword)}.html`, date, 'daily', '0.6');
  });

  // Article pages (last 24 months)
  // Use calendar-month arithmetic to match cleanup.js cutoff logic (setMonth - 24)
  const sinceDate = new Date();
  sinceDate.setMonth(sinceDate.getMonth() - 24);
  const since = sinceDate.toISOString();
  const { data: articles, error } = await supabase
    .from('articles')
    .select('slug, category, publish_date, updated_at')
    .gte('publish_date', since)
    .order('publish_date', { ascending: false });

  if (error) console.error('[Sitemap] Error fetching articles:', error.message);

  const articleEntries = (articles || []).map(a => {
    // updated_at is only set by DB trigger (UPDATE rows), so it may be null
    // for articles that were never updated. Fall back to publish_date.
    const rawDate = a.updated_at || a.publish_date;
    const date = rawDate ? new Date(rawDate).toISOString().split('T')[0] : now;
    const cat = a.category || 'general';
    return urlEntry(`${SITE_URL}/articles/${cat}/${a.slug}.html`, date, 'never', '0.7');
  });

  const allEntries = [
    ...staticEntries,
    ...categoryEntries,
    ...topicEntries,
    ...articleEntries,
  ];

  const sitemap = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${allEntries.join('\n')}
</urlset>`;

  console.log(`[Sitemap] Generated ${allEntries.length} URLs.`);
  return sitemap;
}

// Allow direct run: node automation/sitemap-generator.js --run
if (require.main === module && process.argv.includes('--run')) {
  const { pushFile } = require('./github-pusher');
  generateSitemap().then(xml => pushFile('public/sitemap.xml', xml, 'chore: update sitemap'));
}

module.exports = { generateSitemap };
