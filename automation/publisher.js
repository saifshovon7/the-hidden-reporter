'use strict';
/**
 * publisher.js
 * Orchestrates: save to DB → download images → generate HTML → stage for batch commit.
 *
 * Instead of pushing files directly to GitHub after each article, files are
 * staged in an in-memory batch via article-stager.js. The batch is auto-flushed
 * when the configurable threshold is reached, and the pipeline calls
 * flushStagedArticles() at the end of each run to push any remaining files.
 */

const { createClient } = require('@supabase/supabase-js');
const { config } = require('./config');
const { generateSeoMetadata } = require('./seo-generator');
const { generateArticlePage, generateCategoryPage, generateHomepage,
  generateSearchIndex, generateRssFeed, generateTopicPage } = require('./template-generator');
const { pushFiles } = require('./github-pusher');
const { getTopTrending } = require('./trending-detector');
const { stageFiles, flush, getPendingCount } = require('./article-stager');
const { downloadImage } = require('./image-handler');

// ── BREAKING NEWS CHECK (duplicated from article-queue to avoid circular dependency) ───
function checkIsBreakingNews(title, pubDate) {
  const keywords = config.publishing.breakingNewsKeywords || [];
  const titleLower = (title || '').toLowerCase();
  const ageMinutes = pubDate ? (Date.now() - new Date(pubDate).getTime()) / 60000 : 999;
  const ageLimit = config.publishing.breakingNewsAgeMinutes || 10;
  
  if (ageMinutes > ageLimit) return false;
  return keywords.some(kw => titleLower.includes(kw.toLowerCase()));
}

// ── Stage an image into the article batch (NOT as a separate commit) ────────
// Previously this committed immediately, causing 1 deploy per article.
// Now it stages the image with the rest of the article files.
async function stageImageFile(downloaded) {
  try {
    await stageFiles(
      [{ path: downloaded.localPath, content: downloaded.content, encoding: 'base64' }],
      false // not an article — don't increment article counter
    );
    return true;
  } catch (err) {
    console.warn(`[Publisher] Image staging failed: ${err.message}`);
    return false;
  }
}

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

// ── Get today's published stats per category ─────────────────────────────────
async function getTodayCategoryStats() {
  const startOfDay = new Date();
  startOfDay.setHours(0, 0, 0, 0);

  const { data, error } = await supabase
    .from('articles')
    .select('category')
    .gte('publish_date', startOfDay.toISOString());

  const stats = {};
  for (const cat of config.categories) {
    stats[cat] = 0;
  }

  if (error || !data) {
    console.error(`[Publisher] Error getting category stats: ${error?.message}`);
    return stats;
  }

  for (const row of data) {
    const c = row.category;
    if (stats[c] !== undefined) {
      stats[c]++;
    } else {
      stats[c] = 1;
    }
  }

  return stats;
}

// ── Fetch ads from database ───────────────────────────────────────────────────
async function getAds() {
  const { data } = await supabase
    .from('ads')
    .select('position, content')
    .eq('active', true);

  const ads = { sidebar: '', 'in-article': '', footer: '', 'between-articles': '' };
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
      .select('id, title, slug, category, publish_date, site_publish_date, featured_image_url, summary, source_name')
      .eq('category', category)
      .neq('slug', excludeSlug)
      .order('publish_date', { ascending: false })
      .limit(4);
    return data || [];
  }

  const { data } = await supabase
    .from('articles')
    .select('id, title, slug, category, publish_date, site_publish_date, featured_image_url, summary, source_name')
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
    url: img.url,
    credit: img.credit || '',
    alt_text: img.alt || '',
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
    .order('site_publish_date', { ascending: false })
    .limit(5);

  // Latest: 20 most recent
  const { data: latest } = await supabase
    .from('articles')
    .select('*')
    .order('site_publish_date', { ascending: false })
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
      .order('site_publish_date', { ascending: false })
      .limit(4);
    byCategory[cat] = data || [];
  }

  // Popular articles
  const { data: popular } = await supabase
    .from('articles')
    .select('title, slug, category, site_publish_date, publish_date')
    .order('view_count', { ascending: false })
    .limit(5);

  return generateHomepage({
    featured: featured || [],
    latest: latest || [],
    trending,
    byCategory,
    sidebarAd: ads.sidebar,
    footerAd: ads.footer,
    betweenArticlesAd: ads['between-articles'],
    popularArticles: popular || [],
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
      .order('site_publish_date', { ascending: false })
      .limit(30);

    const html = generateCategoryPage(cat, articles || [], ads.sidebar, ads.footer, ads['between-articles']);
    files.push({ path: `public/category/${cat}.html`, content: html });
  }
  return files;
}

// ── Rebuild search index ──────────────────────────────────────────────────────
async function buildSearchIndex() {
  const { data: articles, error } = await supabase
    .from('articles')
    .select('title, slug, summary, category, site_publish_date, publish_date, source_name, featured_image_url')
    .order('site_publish_date', { ascending: false })
    .limit(500);

  if (error) {
    console.error('[Publisher] buildSearchIndex DB error:', error.message);
    throw error; // Don't commit an empty search index on DB error
  }
  return generateSearchIndex(articles || []);
}

// ── Rebuild RSS feed ──────────────────────────────────────────────────────────
async function buildRssFeed() {
  const { data: articles, error } = await supabase
    .from('articles')
    .select('title, slug, summary, category, site_publish_date, publish_date, source_name')
    .order('site_publish_date', { ascending: false })
    .limit(30);

  if (error) {
    console.error('[Publisher] buildRssFeed DB error:', error.message);
    throw error; // Don't commit an empty feed on DB error
  }
  return generateRssFeed(articles || []);
}

// ── Main publish function ─────────────────────────────────────────────────────
// Now stages files instead of pushing directly. The pipeline calls
// flushStagedArticles() at the end of each run.
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
    title: rewrittenData.title,
    content: rewrittenData.content,
    tags: rewrittenData.tags,
    category: extractedData.category,
    publishDate: extractedData.publishDate,
    summary: rewrittenData.summary,
    seoTitle: rewrittenData.seoTitle,
    metaDescription: rewrittenData.metaDescription,
    featuredImageUrl: extractedData.featuredImageUrl,
    author: extractedData.sourceAuthor,
  });

  // ── Download featured image and self-host on GitHub / Cloudflare Pages ──
  // Image is committed to GitHub BEFORE the article is saved so the DB always
  // references a URL that actually exists. Falls back to external URL on failure.
  let featuredImageUrl = extractedData.featuredImageUrl || null;
  const featuredImageCredit = extractedData.featuredImageCredit || extractedData.domain;

  if (featuredImageUrl) {
    try {
      const downloaded = await downloadImage(featuredImageUrl, seo.slug);
      if (downloaded) {
        // Stage into the batch — no separate commit
        const staged = await stageImageFile(downloaded);
        if (staged) {
          featuredImageUrl = downloaded.localUrl;
          console.log(`[Publisher] Image staged for batch: ${downloaded.localUrl}`);
        } else {
          console.log('[Publisher] Image staging failed — keeping external URL.');
        }
      } else {
        console.log('[Publisher] Image download returned null — using external URL.');
      }
    } catch (err) {
      console.warn(`[Publisher] Image download error: ${err.message} — using external URL.`);
    }
  }

  // Build article record
  const articleRecord = {
    title: rewrittenData.title,
    slug: seo.slug,
    content: rewrittenData.content,
    summary: rewrittenData.summary,
    source_name: extractedData.sourceName,
    source_url: extractedData.sourceUrl,
    source_publish_date: (extractedData.publishDate || null),
    site_publish_date: new Date().toISOString(),
    publish_date: new Date().toISOString(),
    is_breaking: checkIsBreakingNews(extractedData.title, extractedData.publishDate),
    category: extractedData.category || 'general',
    tags: rewrittenData.tags || [],
    seo_title: rewrittenData.seoTitle,
    meta_description: rewrittenData.metaDescription,
    schema_markup: seo.schemaMarkup,
    featured_image_url: featuredImageUrl,
    featured_image_credit: featuredImageCredit,
    author: 'The Hidden Reporter Staff',
    view_count: 0,
    trend_score: 0,
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

  // OPTIMIZED: Only stage the article HTML file.
  // Homepage and category pages load dynamically from JSON feeds (no re-commit needed).
  // RSS feed and search index are regenerated in deployBatch() atomically with the batch.
  const filesToStage = [
    { path: `public/articles/${savedArticle.category}/${savedArticle.slug}.html`, content: articleHtml },
  ];

  // Stage files (auto-flushes when batch threshold is reached)
  await stageFiles(filesToStage, true);

  console.log(`[Publisher] Staged: ${savedArticle.slug} (article only — feeds updated at deploy time)`);
  return savedArticle;
}

// ── Flush staged articles to GitHub ───────────────────────────────────────────
async function flushStagedArticles() {
  const pending = getPendingCount();
  if (pending.files === 0) return;

  console.log(`[Publisher] Flushing ${pending.articles} staged articles (${pending.files} files)...`);
  await flush(`feat: batch publish ${pending.articles} articles`);
}

// ── Republish all existing articles to new /articles/{category}/ structure ────
async function rebuildArticleFiles() {
  console.log('[Publisher] Rebuilding article HTML files to new URL structure...');

  const { data: articles, error } = await supabase
    .from('articles')
    .select('*')
    .order('site_publish_date', { ascending: false })
    .limit(500);

  if (error) throw new Error(`[Publisher] rebuildArticleFiles DB error: ${error.message}`);
  if (!articles?.length) {
    console.log('[Publisher] No articles found to rebuild.');
    return [];
  }

  const ads = await getAds();
  const files = [];

  for (const article of articles) {
    try {
      const related = await getRelatedArticles(
        article.tags, article.category, article.slug
      );
      const seo = generateSeoMetadata({
        title: article.title,
        content: article.content || '',
        tags: article.tags || [],
        category: article.category,
        publishDate: new Date(article.publish_date),
        summary: article.summary,
        seoTitle: article.seo_title,
        metaDescription: article.meta_description,
        featuredImageUrl: article.featured_image_url,
        author: article.author,
      });
      const html = generateArticlePage(
        { ...article, og_tags: seo.ogTags },
        related,
        ads.sidebar,
        ads['in-article'],
        ads.footer
      );
      const cat = article.category || 'general';
      files.push({
        path: `public/articles/${cat}/${article.slug}.html`,
        content: html,
      });
    } catch (err) {
      console.error(`[Publisher] Skipping article ${article.slug}: ${err.message}`);
    }
  }

  console.log(`[Publisher] Rebuilding ${files.length} article files...`);

  // Push in batches of 20 to avoid GitHub API rate limits
  const BATCH = 20;
  for (let i = 0; i < files.length; i += BATCH) {
    const batch = files.slice(i, i + BATCH);
    await pushFiles(batch, `chore: rebuild article files batch ${Math.floor(i / BATCH) + 1}`);
    console.log(`[Publisher] Pushed batch ${Math.floor(i / BATCH) + 1}/${Math.ceil(files.length / BATCH)}`);
    // Brief pause between batches to respect GitHub rate limits
    if (i + BATCH < files.length) await new Promise(r => setTimeout(r, 2000));
  }

  return files;
}

// ── Rebuild missing self-hosted images ────────────────────────────────────────────────────
// Re-downloads and commits images for articles that reference /images/articles/
// paths which are missing from GitHub. Run on startup to heal any past failures.
async function rebuildImages() {
  console.log('[Publisher] Checking for missing self-hosted images...');
  const axios = require('axios');
  const cheerio = require('cheerio');

  const { data: articles, error } = await supabase
    .from('articles')
    .select('id, slug, source_url, featured_image_url')
    .like('featured_image_url', '/images/articles/%')
    .order('publish_date', { ascending: false })
    .limit(200);

  if (error) {
    console.error(`[Publisher] rebuildImages DB error: ${error.message}`);
    return;
  }
  if (!articles?.length) {
    console.log('[Publisher] No self-hosted image articles found.');
    return;
  }

  console.log(`[Publisher] Found ${articles.length} articles with self-hosted images to commit.`);
  let committed = 0;
  let failed = 0;

  for (const article of articles) {
    if (!article.source_url) { failed++; continue; }
    try {
      // Fetch og:image from the original source page
      let sourceImageUrl = null;
      try {
        const res = await axios.get(article.source_url, {
          timeout: 15000,
          headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36' },
          validateStatus: s => s < 500,
        });
        if (res.status < 400 && typeof res.data === 'string') {
          const $ = cheerio.load(res.data);
          sourceImageUrl =
            $('meta[property="og:image"]').attr('content') ||
            $('meta[name="twitter:image"]').attr('content') || null;
        }
      } catch (_) { /* page unreachable */ }

      if (!sourceImageUrl) {
        console.log(`[Publisher] rebuildImages: no source image for ${article.slug}`);
        failed++;
        continue;
      }

      // Extract the slug from the stored local path
      const m = article.featured_image_url.match(/\/images\/articles\/(.+)\.[a-z]+$/i);
      const imageSlug = m ? m[1] : article.slug;

      const downloaded = await downloadImage(sourceImageUrl, imageSlug);
      if (!downloaded) { failed++; continue; }

      const ok = await stageImageFile(downloaded);
      if (ok) {
        committed++;
        console.log(`[Publisher] rebuildImages: committed ${downloaded.localPath} (${committed}/${articles.length})`);
      } else {
        failed++;
      }

      // Pause between commits to respect rate limits
      await new Promise(r => setTimeout(r, 2000));
    } catch (err) {
      console.warn(`[Publisher] rebuildImages error for ${article.slug}: ${err.message}`);
      failed++;
    }
  }

  console.log(`[Publisher] rebuildImages done: ${committed} committed, ${failed} failed/skipped.`);
}

// ── Rebuild all topic pages from trending_topics ───────────────────────────────────────
// Fetches all trending topics and generates a topic page for each with matching articles
async function rebuildTopicPages() {
  console.log('[Publisher] Rebuilding topic pages...');

  const { data: topics, error } = await supabase
    .from('trending_topics')
    .select('topic, keyword, article_count')
    .order('trend_score', { ascending: false })
    .limit(20);

  if (error) {
    console.error('[Publisher] Error fetching trending topics:', error.message);
    return [];
  }

  if (!topics?.length) {
    console.log('[Publisher] No trending topics found.');
    return [];
  }

  console.log(`[Publisher] Found ${topics.length} trending topics.`);
  const ads = await getAds();
  const topicFiles = [];

  for (const topic of topics) {
    const keyword = topic.keyword || topic.topic;

    // matching Search articles the topic in title, summary, tags, or content
    const { data: topicArticles } = await supabase
      .from('articles')
      .select('id, title, slug, summary, category, site_publish_date, publish_date, source_name, featured_image_url, tags, content')
      .or(`title.ilike.%${keyword}%,summary.ilike.%${keyword}%,tags.cs.{"${keyword}"}`)
      .order('site_publish_date', { ascending: false })
      .limit(20);

    if (topicArticles?.length) {
      console.log(`[Publisher] Topic "${keyword}": ${topicArticles.length} articles`);
      const html = generateTopicPage(keyword, topicArticles, ads.footer);
      // Create slug-safe filename
      const slug = keyword.toLowerCase().replace(/[^a-z0-9]+/g, '-');
      topicFiles.push({ path: `public/topic/${slug}.html`, content: html });
    }
  }

  if (topicFiles.length) {
    await pushFiles(topicFiles, 'chore: rebuild topic pages');
    console.log(`[Publisher] Topic pages pushed (${topicFiles.length} files).`);
  } else {
    console.log('[Publisher] No topic pages to generate.');
  }

  return topicFiles;
}

// ── Startup rebuild ────────────────────────────────────────────────────────────
// Pushes dynamic skeleton pages (homepage + categories) + JSON feeds + search
// index + RSS feed in a SINGLE commit. This is the only commit on startup.
//
// What we DO commit on startup:
//   ① Dynamic homepage skeleton (index.html)      — uses JS to load from /api/*.json
//   ② Dynamic category page skeletons             — uses JS to load from /api/category-*.json
//   ③ JSON feeds (public/api/*.json)              — loaded by the front-end JS
//   ④ Search index (public/search-index.json)     — loaded by the search page
//   ⑤ RSS feed (public/feed.xml)                  — for external subscribers
//
// What we do NOT commit on startup (to avoid extra deploys):
//   ✗ All existing article HTML files (already committed; unchanged)
//   ✗ Topic pages (moved to daily maintenance at 3 AM)
async function rebuildArticlesOnly() {
  console.log('[Publisher] Running startup rebuild (skeletons + feeds in 1 commit)...');
  try {
    const { updateAllFeeds } = require('./json-feeds');
    const ads = await getAds();

    // ① Generate dynamic homepage skeleton (JS loads content from /api/*.json)
    const homepageHtml = generateHomepage({});

    // ② Generate dynamic category page skeletons (JS loads from /api/category-*.json)
    const categoryFiles = config.categories.map(cat => ({
      path: `public/category/${cat}.html`,
      content: generateCategoryPage(cat, [], ads.sidebar, ads.footer, ads['between-articles']),
    }));

    // ③ Generate JSON feeds for dynamic front-end loading
    const feedFiles = await updateAllFeeds();

    // ④⑤ Build search index and RSS feed
    const [searchIndex, rssFeed] = await Promise.all([
      buildSearchIndex(),
      buildRssFeed(),
    ]);

    const allFiles = [
      { path: 'public/index.html', content: homepageHtml },
      ...categoryFiles,
      ...feedFiles,
      { path: 'public/search-index.json', content: searchIndex },
      { path: 'public/feed.xml', content: rssFeed },
    ];

    // Single commit = single Cloudflare deploy on startup
    await pushFiles(allFiles, 'chore: startup — dynamic skeletons + feeds + search index');
    console.log(`[Publisher] Startup complete: ${allFiles.length} files in 1 commit.`);
    console.log('[Publisher] Homepage and category pages are now dynamic skeletons.');
    console.log('[Publisher] Article HTML files are unchanged (no rebuild needed).');
  } catch (err) {
    console.error('[Publisher] Startup rebuild error:', err.message);
  }
}

// ── Full rebuild (manual use only) ────────────────────────────────────────────────────────
// Runs once on service start. Pushes all article HTML files, JSON feeds,
// RSS feed, homepage, category pages, topic pages, and any missing self-hosted images.
// Use this ONLY for a manual full rebuild (e.g. after a template change).
async function rebuildAll() {
  console.log('[Publisher] Running startup rebuild...');
  try {
    const ads = await getAds();

    // Import JSON feeds generator
    const { updateAllFeeds } = require('./json-feeds');
    
    // Generate JSON feeds first (for dynamic homepage loading)
    const feedFiles = await updateAllFeeds();
    
    // Build homepage and category pages (for SEO and fallback)
    const [searchIndex, rssFeed, homepageHtml] = await Promise.all([
      buildSearchIndex(),
      buildRssFeed(),
      buildHomepage(ads),
    ]);
    const categoryFiles = await buildCategoryPages(ads);

    const staticFiles = [
      ...feedFiles, // JSON feeds for dynamic loading
      { path: 'public/search-index.json', content: searchIndex },
      { path: 'public/feed.xml', content: rssFeed },
      { path: 'public/index.html', content: homepageHtml },
      ...categoryFiles,
    ];
    await pushFiles(staticFiles, 'chore: startup rebuild - homepage, JSON feeds, category pages');
    console.log(`[Publisher] Static files pushed (${staticFiles.length} files).`);

    // Rebuild all article HTML files
    await rebuildArticleFiles();

    // Rebuild all topic pages from trending_topics
    await rebuildTopicPages();

    console.log('[Publisher] Startup rebuild complete.');
  } catch (err) {
    console.error('[Publisher] Startup rebuild error:', err.message);
  }
}

module.exports = { publishArticle, getTodayCount, getTodayCategoryStats, rebuildAll, rebuildArticlesOnly, rebuildImages, flushStagedArticles, buildRssFeed, buildSearchIndex };
