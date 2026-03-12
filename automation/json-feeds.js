'use strict';
/**
 * json-feeds.js
 * Generates JSON feeds for dynamic homepage/category loading.
 * 
 * Instead of rebuilding HTML pages on every publish, we generate JSON feeds
 * that the frontend JavaScript uses to load articles dynamically.
 * This significantly reduces deployment frequency.
 */

const { createClient } = require('@supabase/supabase-js');
const { config } = require('./config');
const { generateSearchIndex } = require('./template-generator');
const { pushFiles } = require('./github-pusher');

const supabase = createClient(config.supabase.url, config.supabase.serviceKey);

// ── Latest Articles JSON Feed ─────────────────────────────────────────────────
async function generateLatestArticlesFeed(limit = 30) {
    const { data: articles, error } = await supabase
        .from('articles')
        .select('id, title, slug, summary, category, site_publish_date, source_name, featured_image_url, is_breaking')
        .order('site_publish_date', { ascending: false })
        .limit(limit);

    if (error) {
        console.error('[Feeds] Error fetching latest articles:', error.message);
        return null;
    }

    return JSON.stringify({
        articles: (articles || []).map(a => ({
            id: a.id,
            title: a.title,
            slug: a.slug,
            summary: a.summary,
            category: a.category,
            date: a.site_publish_date,
            source: a.source_name,
            image: a.featured_image_url,
            breaking: a.is_breaking,
            url: `/articles/${a.category}/${a.slug}.html`
        })),
        updated: new Date().toISOString()
    }, null, 0);
}

// ── Featured Articles JSON Feed ───────────────────────────────────────────────
async function generateFeaturedFeed(limit = 5) {
    const { data: articles, error } = await supabase
        .from('articles')
        .select('id, title, slug, summary, category, site_publish_date, source_name, featured_image_url, is_breaking')
        .order('trend_score', { ascending: false })
        .order('site_publish_date', { ascending: false })
        .limit(limit);

    if (error) {
        console.error('[Feeds] Error fetching featured:', error.message);
        return null;
    }

    return JSON.stringify({
        articles: (articles || []).map(a => ({
            id: a.id,
            title: a.title,
            slug: a.slug,
            summary: a.summary,
            category: a.category,
            date: a.site_publish_date,
            source: a.source_name,
            image: a.featured_image_url,
            breaking: a.is_breaking,
            url: `/articles/${a.category}/${a.slug}.html`
        })),
        updated: new Date().toISOString()
    }, null, 0);
}

// ── Category JSON Feeds ────────────────────────────────────────────────────────
async function generateCategoryFeeds() {
    const feeds = {};
    
    for (const category of config.categories) {
        const { data: articles, error } = await supabase
            .from('articles')
            .select('id, title, slug, summary, category, site_publish_date, source_name, featured_image_url')
            .eq('category', category)
            .order('site_publish_date', { ascending: false })
            .limit(30);

        if (!error && articles) {
            feeds[`category-${category}.json`] = JSON.stringify({
                category,
                articles: articles.map(a => ({
                    title: a.title,
                    slug: a.slug,
                    summary: a.summary,
                    date: a.site_publish_date,
                    source: a.source_name,
                    image: a.featured_image_url,
                    url: `/articles/${a.category}/${a.slug}.html`
                })),
                updated: new Date().toISOString()
            }, null, 0);
        }
    }
    
    return feeds;
}

// ── Trending Topics JSON Feed ────────────────────────────────────────────────
async function generateTrendingFeed(limit = 10) {
    const { data: topics, error } = await supabase
        .from('trending_topics')
        .select('topic, keyword, article_count, trend_score')
        .order('trend_score', { ascending: false })
        .limit(limit);

    if (error) {
        console.error('[Feeds] Error fetching trending:', error.message);
        return null;
    }

    return JSON.stringify({
        topics: (topics || []).map(t => ({
            topic: t.topic,
            count: t.article_count,
            score: t.trend_score,
            url: `/topic/${t.topic.toLowerCase().replace(/[^a-z0-9]+/g, '-')}.html`
        })),
        updated: new Date().toISOString()
    }, null, 0);
}

// ── Popular Articles JSON Feed ────────────────────────────────────────────────
async function generatePopularFeed(limit = 10) {
    const { data: articles, error } = await supabase
        .from('articles')
        .select('id, title, slug, category, view_count')
        .order('view_count', { ascending: false })
        .limit(limit);

    if (error) {
        console.error('[Feeds] Error fetching popular:', error.message);
        return null;
    }

    return JSON.stringify({
        articles: (articles || []).map(a => ({
            title: a.title,
            slug: a.slug,
            category: a.category,
            views: a.view_count,
            url: `/articles/${a.category}/${a.slug}.html`
        })),
        updated: new Date().toISOString()
    }, null, 0);
}

// ── Update All JSON Feeds ─────────────────────────────────────────────────────
async function updateAllFeeds() {
    console.log('[Feeds] Updating all JSON feeds...');
    
    const files = [];
    
    // Latest articles
    const latest = await generateLatestArticlesFeed();
    if (latest) {
        files.push({ path: 'public/api/latest.json', content: latest });
    }
    
    // Featured articles
    const featured = await generateFeaturedFeed();
    if (featured) {
        files.push({ path: 'public/api/featured.json', content: featured });
    }
    
    // Popular articles
    const popular = await generatePopularFeed();
    if (popular) {
        files.push({ path: 'public/api/popular.json', content: popular });
    }
    
    // Trending topics
    const trending = await generateTrendingFeed();
    if (trending) {
        files.push({ path: 'public/api/trending.json', content: trending });
    }
    
    // Category feeds
    const categoryFeeds = await generateCategoryFeeds();
    for (const [path, content] of Object.entries(categoryFeeds)) {
        files.push({ path: `public/api/${path}`, content });
    }
    
    console.log(`[Feeds] Generated ${files.length} feed files`);
    return files;
}

// ── Push Feeds to GitHub ─────────────────────────────────────────────────────
async function pushFeedsToGitHub() {
    const files = await updateAllFeeds();
    if (files.length > 0) {
        await pushFiles(files, 'chore: update JSON feeds');
        console.log('[Feeds] All feeds pushed to GitHub');
    }
}

module.exports = {
    generateLatestArticlesFeed,
    generateFeaturedFeed,
    generateCategoryFeeds,
    generateTrendingFeed,
    generatePopularFeed,
    updateAllFeeds,
    pushFeedsToGitHub
};
