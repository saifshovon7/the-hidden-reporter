'use strict';
require('dotenv').config();

const config = {
  // ── Site ──────────────────────────────────────────────────
  site: {
    name: process.env.SITE_NAME || 'The Hidden Reporter',
    tagline: 'Uncovering stories behind the headlines.',
    url: process.env.SITE_URL || 'https://thehiddenreporter.pages.dev',
  },

  // ── Supabase ──────────────────────────────────────────────
  supabase: {
    url: process.env.SUPABASE_URL || '',
    serviceKey: process.env.SUPABASE_SERVICE_KEY || '',
    anonKey: process.env.SUPABASE_ANON_KEY || '',
  },

  // ── AI ────────────────────────────────────────────────────
  ai: {
    apiKey: process.env.AI_API_KEY || '',
    model: process.env.AI_MODEL || 'gpt-4o-mini',
    baseUrl: process.env.AI_BASE_URL || 'https://api.openai.com/v1',
  },

  // ── GitHub ────────────────────────────────────────────────
  github: {
    token: process.env.GITHUB_TOKEN || '',
    owner: process.env.GITHUB_OWNER || '',
    repo: process.env.GITHUB_REPO || 'the-hidden-reporter',
    branch: process.env.GITHUB_BRANCH || 'main',
    safeThreshold: parseInt(process.env.GITHUB_SAFE_THRESHOLD || '200', 10),
    minDelayMs: parseInt(process.env.GITHUB_MIN_DELAY_MS || '2000', 10),
    maxCommitsPerHour: parseInt(process.env.GITHUB_MAX_COMMITS_HR || '20', 10),
    pauseMinutes: parseInt(process.env.GITHUB_PAUSE_MINUTES || '30', 10),
  },

  // ── Optional APIs ─────────────────────────────────────────
  newsApi: {
    key: process.env.NEWS_API_KEY || '',
    enabled: Boolean(process.env.NEWS_API_KEY),
    country: process.env.NEWS_API_COUNTRY || 'us',
  },
  gdelt: {
    enabled: process.env.USE_GDELT === 'true',
  },
  contextualWeb: {
    apiKey: process.env.CONTEXTUAL_WEB_API_KEY || '',
    enabled: Boolean(process.env.CONTEXTUAL_WEB_API_KEY),
    country: process.env.CONTEXTUAL_WEB_COUNTRY || 'us',
  },
  googleNews: {
    enabled: process.env.USE_GOOGLE_NEWS_SCRAPER === 'true',
  },

  // ── Publishing ────────────────────────────────────────────
  publishing: {
    maxPerDay: parseInt(process.env.MAX_ARTICLES_PER_DAY || '100', 10),
    // How many articles to accumulate before a batch commit (= 1 Cloudflare deploy)
    // Higher = fewer deploys per day. Default 10 means ~10 articles per deploy.
    maxArticlesPerBatch: parseInt(process.env.MAX_ARTICLES_PER_BATCH || '10', 10),
    batchSizeThreshold: parseInt(process.env.BATCH_SIZE_THRESHOLD || '10', 10),
    // Fetch new articles every 15 minutes (was 10) — reduces API calls and queue churn
    fetchIntervalMinutes: parseInt(process.env.FETCH_INTERVAL_MINUTES || '15', 10),
    publishIntervalMinutes: parseInt(process.env.PUBLISH_INTERVAL_MINUTES || '14', 10),
    postPublishDelayMinutes: parseInt(process.env.POST_PUBLISH_DELAY_MINUTES || '5', 10),
    cleanupMonths: 24,
    maxQueueSize: parseInt(process.env.MAX_QUEUE_SIZE || '20', 10),
    // Discard articles older than 4 hours from the queue (was 6) — keeps queue fresh
    queueStaleHours: parseInt(process.env.QUEUE_STALE_HOURS || '4', 10),
    // Deployment limiter — prevents excessive Cloudflare Pages builds
    maxDeploymentsPerHour: parseInt(process.env.MAX_DEPLOYMENTS_PER_HOUR || '3', 10),
    // Minimum gap between two deployments (minutes)
    minDeployIntervalMinutes: parseInt(process.env.MIN_DEPLOY_INTERVAL_MINUTES || '20', 10),
    // Breaking news detection
    breakingNewsKeywords: ['breaking', 'urgent', 'live', 'alert', 'emergency', 'explosion', 'earthquake', 'attack', 'terror', 'shooting', 'flood', 'hurricane', 'volcano', 'crisis', 'devastating', 'breaking news'],
    breakingNewsAgeMinutes: parseInt(process.env.BREAKING_NEWS_AGE_MINUTES || '10', 10),
    // Daily target per category to prevent starvation
    categoryTargets: {
      technology: 10,
      business: 8,
      finance: 8,
      sports: 8,
      science: 6,
      politics: 6,
      world: 10,
      general: 10
    }
  },

  // ── Categories ────────────────────────────────────────────
  categories: ['general', 'technology', 'business', 'science', 'world', 'politics', 'finance', 'sports'],

  // ── Content extraction selectors (site-specific overrides) ─
  extractors: {
    default: {
      contentSelectors: [
        'article',
        '[class*="article-body"]',
        '[class*="article-content"]',
        '[class*="entry-content"]',
        '[class*="post-content"]',
        '[class*="story-body"]',
        'main',
      ],
      removeSelectors: [
        'script', 'style', 'nav', 'header', 'footer',
        '[class*="sidebar"]', '[class*="advertisement"]',
        '[class*="related"]', '[class*="newsletter"]',
        '[class*="comment"]', '[class*="social"]',
        'figure.promo', '.ad', '.ads',
      ],
    },
  },

  // ── AI rewriting ──────────────────────────────────────────
  rewriter: {
    systemPrompt: `You are a professional news editor for "The Hidden Reporter", an investigative news website.
Your task is to rewrite news articles in a clear, authoritative, and engaging style.
Rules:
- Preserve all factual information, quotes, and key details.
- Rewrite in third person, journalistic voice.
- Remove promotional language or advertiser bias.
- Do not add opinions or unsupported claims.
- Output structured JSON only.`,

    userPrompt: (title, content) => `Rewrite this news article. Return ONLY valid JSON with these fields:
{
  "title": "rewritten headline (max 90 chars)",
  "content": "rewritten article in HTML paragraphs using <p> tags. Min 300 words.",
  "summary": "2-sentence summary (max 200 chars)",
  "seo_title": "SEO-optimized title (max 60 chars)",
  "meta_description": "SEO meta description (max 155 chars)",
  "tags": ["tag1", "tag2", "tag3"]
}

Original title: ${title}
Original content: ${content.slice(0, 3000)}`,
  },
};

// Validate required config
function validate() {
  const required = [
    ['supabase.url', config.supabase.url],
    ['supabase.serviceKey', config.supabase.serviceKey],
    ['ai.apiKey', config.ai.apiKey],
    ['github.token', config.github.token],
    ['github.owner', config.github.owner],
  ];
  const missing = required.filter(([, v]) => !v).map(([k]) => k);
  if (missing.length) {
    console.error(`[Config] Missing required env vars: ${missing.join(', ')}`);
    console.error('[Config] Copy .env.example to .env and fill in the values.');
    process.exit(1);
  }
}

module.exports = { config, validate };
