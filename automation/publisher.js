'use strict';
/**
 * publisher.js
 * Orchestrates: save to DB → generate HTML → push to GitHub.
 */

const { createClient }         = require('@supabase/supabase-js');
const { config }               = require('./config');
const { generateSeoMetadata }  = require('./seo-generator');
const { generateArticlePage, generateCategoryPage, generateHomepage,
        generateSearchIndex, generateRssFeed, generateTopicPage } = require('./template-generator');
const { pushFiles }            = require('./github-pusher');
const { getTopTrending }       = require('./trending-detector');

const supabase = createClient(config.supabase.url, config.supabase.serviceKey);

// ── Count today's published articles ─────────────────────────────────────────
async function getTodayCount() {
  const startOfDay = new Date();
  startOfDay.setHours(0, 0, 0, 0);

  const { count, error } = await supabase
    .from('articles')
    .select('id', { count: 'exact', head: true })
    .gte('publish_date', startOfDay.toISOString());

  if (error) return 0;
  return count || 0;
}

// ── Fetch ads from database ───────────────────────────────────────────────────
async function getAds() {
  const { data } = await supabase
    .from('ads')
    .select('position, content')
    .eq('active', true);

  const ads = { sidebar: '', 'in-article': '', footer: '' };
  for (const ad of (data || [])) {
    ads[ad.position] = ad.content;
  }
  return ads;
}

// ── Get related articles ──────────────────────────────────────────────────────
async function getRelatedArticles(tags, category, excludeSlug) {
  if (!tags?.length) {
    const { data } = await supabase
      .from('articles')
      .select('id, title, slug, category, publish_date, featured_image_url, summary')
      .eq('category', category)
      .neq('slug', excludeSlug)
      .order('publish_date', { ascending: false })
      .limit(4);
    return data || [];
  }

  const { data } = await supabase
    .from('articles')
    .select('id, title, slug, category, publish_date, featured_image_url, summary')
    .overlaps('tags', tags)
    .neq('slug', excludeSlug)
    .order('trend_score', { ascending: false })
    .limit(4);

  return data || [];
}

// ── Save article to Supabase ──────────────────────────────────────────────────
async function saveArticle(articleData) {
  const { data, error } = await supabase
    .from('articles')
    .insert([articleData])
    .select()
    .single();

  if (error) throw new Error(`[Publisher] DB insert error: ${error.message}`);
  return data;
}

// ── Save images to Supabase ───────────────────────────────────────────────────
async function saveImages(articleId, images) {
  if (!images?.length) return;
  const rows = images.slice(0, 10).map(img => ({
    article_id: articleId,
    url:        img.url,
    credit:     img.credit || '',
    alt_text:   img.alt   || '',
  }));
  await supabase.from('images').insert(rows);
}

// ── Rebuild homepage ──────────────────────────────────────────────────────────
async function buildHomepage(ads) {
  // Featured: 5 most recent high-scoring articles
  const { data: featured } = await supabase
    .from('articles')
    .select('*')
    .order('trend_score', { ascending: false })
    .order('publish_date', { ascending: false })
    .limit(5);

  // Latest: 20 most recent
  const { data: latest } = await supabase
    .from('articles')
    .select('*')
    .order('publish_date', { ascending: false })
    .limit(20);

  // Trending topics
  const trending = await getTopTrending(5);

  // By category (4 each)
  const byCategory = {};
  for (const cat of config.categories) {
    const { data } = await supabase
      .from('articles')
      .select('*')
      .eq('category', cat)
      .order('publish_date', { ascending: false })
      .limit(4);
    byCategory[cat] = data || [];
  }

  // Popular articles
  const { data: popular } = await supabase
    .from('articles')
    .select('title, slug, category')
    .order('view_count', { ascending: false })
    .limit(5);

  return generateHomepage({
    featured:         featured || [],
    latest:           latest   || [],
    trending,
    byCategory,
    sidebarAd:        ads.sidebar,
    footerAd:         ads.footer,
    popularArticles:  popular || [],
  });
}

// ── Rebuild all category pages ────────────────────────────────────────────────
async function buildCategoryPages(ads) {
  const files = [];
  for (const cat of config.categories) {
    const { data: articles } = await supabase
      .from('articles')
      .select('*')
      .eq('category', cat)
      .order('publish_date', { ascending: false })
      .limit(30);

    const html = generateCategoryPage(cat, articles || [], ads.sidebar, ads.footer);
    files.push({ path: `public/category/${cat}.html`, content: html });
  }
  return files;
}

// ── Rebuild search index ──────────────────────────────────────────────────────
async function buildSearchIndex() {
  const { data: articles } = await supabase
    .from('articles')
    .select('title, slug, summary, category, publish_date, source_name, featured_image_url')
    .order('publish_date', { ascending: false })
    .limit(500);

  return generateSearchIndex(articles || []);
}

// ── Rebuild RSS feed ──────────────────────────────────────────────────────────
async function buildRssFeed() {
  const { data: articles } = await supabase
    .from('articles')
    .select('title, slug, summary, category, publish_date, source_name')
    .order('publish_date', { ascending: false })
    .limit(30);

  return generateRssFeed(articles || []);
}

// ── Main publish function ─────────────────────────────────────────────────────
async function publishArticle(extractedData, rewrittenData) {
  // Check daily limit
  const todayCount = await getTodayCount();
  if (todayCount >= config.publishing.maxPerDay) {
    console.log(`[Publisher] Daily limit reached (${todayCount}/${config.publishing.maxPerDay}). Skipping.`);
    return null;
  }

  const ads = await getAds();

  // Generate SEO metadata
  const seo = generateSeoMetadata({
    title:       rewrittenData.title,
    content:     rewrittenData.content,
    tags:        rewrittenData.tags,
    category:    extractedData.category,
    publishDate: extractedData.publishDate,
    summary:     rewrittenData.summary,
    seoTitle:    rewrittenData.seoTitle,
    metaDescription: rewrittenData.metaDescription,
    featuredImageUrl: extractedData.featuredImageUrl,
    author:      extractedData.sourceAuthor,
  });

  // Build article record
  const articleRecord = {
    title:                rewrittenData.title,
    slug:                 seo.slug,
    content:              rewrittenData.content,
    summary:              rewrittenData.summary,
    source_name:          extractedData.sourceName,
    source_url:           extractedData.sourceUrl,
    publish_date:         (extractedData.publishDate || new Date()).toISOString(),
    category:             extractedData.category || 'general',
    tags:                 rewrittenData.tags || [],
    seo_title:            rewrittenData.seoTitle,
    meta_description:     rewrittenData.metaDescription,
    schema_markup:        seo.schemaMarkup,
    featured_image_url:   extractedData.featuredImageUrl || null,
    featured_image_credit: extractedData.featuredImageCredit || extractedData.domain,
    author:               'The Hidden Reporter Staff',
    view_count:           0,
    trend_score:          0,
  };

  // Save to database
  const savedArticle = await saveArticle(articleRecord);
  await saveImages(savedArticle.id, extractedData.images || []);

  console.log(`[Publisher] Saved article: "${savedArticle.title}" (${savedArticle.slug})`);

  // Fetch related articles
  const related = await getRelatedArticles(savedArticle.tags, savedArticle.category, savedArticle.slug);

  // Generate HTML pages
  const articleHtml = generateArticlePage(
    { ...savedArticle, og_tags: seo.ogTags },
    related,
    ads.sidebar,
    ads['in-article'],
    ads.footer
  );

  // Rebuild global files (homepage is now dynamic — no rebuild needed)
  const [searchIndex, rssFeed] = await Promise.all([
    buildSearchIndex(),
    buildRssFeed(),
  ]);

  const categoryFiles = await buildCategoryPages(ads);

  // Build topic pages for detected topics
  const topicFiles = [];
  for (const topic of seo.topics) {
    const { data: topicArticles } = await supabase
      .from('articles')
      .select('*')
      .ilike('title', `%${topic}%`)
      .order('publish_date', { ascending: false })
      .limit(20);

    if (topicArticles?.length) {
      const html = generateTopicPage(topic, topicArticles, ads.footer);
      topicFiles.push({ path: `public/topic/${topic}.html`, content: html });
    }
  }

  // Batch push all files to GitHub
  const filesToPush = [
    { path: `public/articles/${savedArticle.category}/${savedArticle.slug}.html`, content: articleHtml },
    { path: 'public/search-index.json',                 content: searchIndex  },
    { path: 'public/feed.xml',                          content: rssFeed      },
    ...categoryFiles,
    ...topicFiles,
  ];

  await pushFiles(filesToPush, `feat: publish "${savedArticle.title.slice(0, 60)}"`);

  console.log(`[Publisher] Published: ${savedArticle.slug}`);
  return savedArticle;
}

// ── Startup rebuild ───────────────────────────────────────────────────────────
// Runs once on service start. Pushes search-index.json + category pages + RSS
// from ALL existing Supabase articles so the site is never empty after a restart.
async function rebuildAll() {
  console.log('[Publisher] Running startup rebuild...');
  try {
    const ads = await getAds();
    const [searchIndex, rssFeed] = await Promise.all([
      buildSearchIndex(),
      buildRssFeed(),
    ]);
    const categoryFiles = await buildCategoryPages(ads);

    const filesToPush = [
      { path: 'public/search-index.json', content: searchIndex },
      { path: 'public/feed.xml',          content: rssFeed     },
      ...categoryFiles,
    ];

    await pushFiles(filesToPush, 'chore: startup rebuild of index and category pages');
    console.log(`[Publisher] Startup rebuild complete. Pushed ${filesToPush.length} files.`);
  } catch (err) {
    console.error('[Publisher] Startup rebuild error:', err.message);
  }
}

module.exports = { publishArticle, getTodayCount, rebuildAll };
