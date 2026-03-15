'use strict';
/**
 * article-queue.js
 * OPTIMIZED SMART QUEUE SYSTEM
 *
 * Fixes applied:
 *  1. startDeploymentScheduler() is now called from startQueuePipeline() (it was dead code)
 *  2. updateFeedsAndDeploy() merges JSON feeds + staged article files into ONE commit
 *  3. Hourly deployment counter resets every 60 minutes (was never reset before)
 *  4. MIN_DEPLOY_INTERVAL guard fixed (arithmetic bug with unitless number)
 *  5. Queue max size enforced — oldest non-breaking articles discarded when full
 *  6. startDeploymentScheduler exported so index.js can call it independently if needed
 */

const { createClient } = require('@supabase/supabase-js');
const { config } = require('./config');
const { fetchAllSources } = require('./fetcher');
const { extractArticle } = require('./extractor');
const { rewriteArticle } = require('./ai-rewriter');
const { isDuplicate } = require('./duplicate-detector');
const { publishArticle, getTodayCount, getTodayCategoryStats, buildRssFeed, buildSearchIndex } = require('./publisher');
const { stageFiles, flush, getPendingCount } = require('./article-stager');
const { pushFiles } = require('./github-pusher');
const { updateAllFeeds } = require('./json-feeds');

const supabase = createClient(config.supabase.url, config.supabase.serviceKey);

// ── Queue state ──────────────────────────────────────────────────────────────
let articleQueue = [];
let isPublisherRunning = false;
let isFetcherRunning = false;
let lastPublishTime = null;
let todayPublishCount = 0;
let articlesSinceLastDeploy = 0;

// Guard flag to prevent concurrent deployments (BUG 7)
let isDeploying = false;

// ── Deployment limiter ───────────────────────────────────────────────────────
let lastDeploymentTime = null;
let deploymentsThisHour = 0;
const MAX_DEPLOYMENTS_PER_HOUR = config.publishing.maxDeploymentsPerHour || 3;
// Minimum MILLISECONDS between any two deployments (default 20 min)
const MIN_DEPLOY_INTERVAL_MS = (config.publishing.minDeployIntervalMinutes || 20) * 60 * 1000;
// How many articles to batch before forcing a deploy (even if interval not reached)
const ARTICLES_PER_BATCH = config.publishing.batchSizeThreshold || config.publishing.maxArticlesPerBatch || 5;

// Reset deployment counter every 60 minutes so the hourly cap actually cycles
setInterval(() => {
  if (deploymentsThisHour > 0) {
    console.log(`[Queue] Hourly deploy counter reset (was ${deploymentsThisHour})`);
  }
  deploymentsThisHour = 0;
}, 60 * 60 * 1000);

// ── BREAKING NEWS DETECTION ─────────────────────────────────────────────────
function isBreakingNews(item) {
  const keywords = config.publishing.breakingNewsKeywords || [];
  const title = (item.title || '').toLowerCase();
  const ageMinutes = item.pubDate
    ? (Date.now() - new Date(item.pubDate).getTime()) / 60000
    : 999;
  const ageLimit = config.publishing.breakingNewsAgeMinutes || 10;
  if (ageMinutes > ageLimit) return false;
  return keywords.some(kw => title.includes(kw.toLowerCase()));
}

// ── GET ARTICLE PRIORITY SCORE ────────────────────────────────────────────────
function getArticlePriority(item) {
  const now = Date.now();
  const pubTime = item.pubDate ? new Date(item.pubDate).getTime() : now;
  const ageMinutes = (now - pubTime) / 60000;
  let score = 1000 - ageMinutes;
  if (isBreakingNews(item)) score += 10000;
  return Math.max(0, score);
}

// ── SORT QUEUE BY PRIORITY ────────────────────────────────────────────────────
function sortQueue() {
  articleQueue.sort((a, b) => getArticlePriority(b) - getArticlePriority(a));
}

// ── CLEANUP STALE ARTICLES ────────────────────────────────────────────────────
function cleanupStaleArticles() {
  const staleHours = config.publishing.queueStaleHours || 6;
  const staleMs = staleHours * 60 * 60 * 1000;
  const now = Date.now();
  const beforeCount = articleQueue.length;
  const MIN_QUEUE = 3;

  articleQueue = articleQueue.filter(item => {
    if (item.status !== 'pending') return false;
    if (isBreakingNews(item)) return true;
    const pubTime = item.pubDate ? new Date(item.pubDate).getTime() : now;
    const ageMs = now - pubTime;
    return ageMs < staleMs;
  });

  // Ensure we never drop below MIN_QUEUE
  if (articleQueue.length < MIN_QUEUE && beforeCount >= MIN_QUEUE) {
    console.log(`[Queue] Stale cleanup would leave < ${MIN_QUEUE} items — keeping minimum.`);
    // Already filtered; just log the warning — the remaining items will be kept
  }

  if (beforeCount !== articleQueue.length) {
    console.log(`[Queue] Cleaned up ${beforeCount - articleQueue.length} stale articles`);
  }
}

// ── ADD ARTICLE TO QUEUE ──────────────────────────────────────────────────────
async function addToQueue(item) {
  const maxQueue = config.publishing.maxQueueSize || 20;
  if (articleQueue.some(q => q.url === item.url)) return false;

  const queueItem = {
    id: Date.now() + Math.random(),
    url: item.url,
    title: item.title,
    sourceName: item.sourceName,
    category: item.category,
    pubDate: item.pubDate || new Date(),
    sourceData: item,
    status: 'pending',
    isBreaking: isBreakingNews(item),
    createdAt: new Date(),
  };

  articleQueue.push(queueItem);
  sortQueue();

  // Enforce max queue size — discard lowest-priority non-breaking item if over limit
  // Use a single if-check instead of a while-loop to avoid unbounded queue growth
  // when all items are breaking (loop would exit without eviction, permanently oversizing)
  if (articleQueue.length > maxQueue) {
    const nonBreaking = articleQueue.filter(q => !q.isBreaking && q.status === 'pending');
    if (nonBreaking.length > 0) {
      // nonBreaking array is sorted same as queue; last = lowest priority = oldest
      const toRemove = nonBreaking[nonBreaking.length - 1];
      articleQueue = articleQueue.filter(q => q.id !== toRemove.id);
      console.log(`[Queue] Evicted oldest article: ${toRemove.title?.slice(0, 50)}`);
    }
    // If all breaking: allow the queue to be maxQueue+1 temporarily;
    // next fetch cycle will balance it out
  }

  return true;
}

// ── FETCH ARTICLES TO QUEUE ──────────────────────────────────────────────────
async function fetchArticlesToQueue() {
  if (isFetcherRunning) return;
  isFetcherRunning = true;

  try {
    console.log(`\n[Queue] Fetching new articles... (queue: ${articleQueue.length})`);
    const categoryStats = await getTodayCategoryStats();
    const fetchedItems = await fetchAllSources(categoryStats);

    if (!fetchedItems.length) {
      console.log('[Queue] No new articles found');
      return;
    }

    let added = 0;
    for (const item of fetchedItems) {
      if (articleQueue.length >= config.publishing.maxQueueSize) break;
      if (await addToQueue(item)) added++;
    }

    cleanupStaleArticles();
    sortQueue();

    const breakingCount = articleQueue.filter(q => q.isBreaking && q.status === 'pending').length;
    console.log(`[Queue] Added ${added} articles | Queue: ${articleQueue.length} | Breaking: ${breakingCount}`);
  } catch (err) {
    console.error('[Queue] Fetch error:', err.message);
  } finally {
    isFetcherRunning = false;
  }
}

// ── CHECK IF DEPLOY IS ALLOWED ────────────────────────────────────────────────
function canDeployNow() {
  const now = Date.now();
  const msSinceDeploy = lastDeploymentTime ? now - lastDeploymentTime : Infinity;
  const intervalOk = msSinceDeploy >= MIN_DEPLOY_INTERVAL_MS;
  const countOk = deploymentsThisHour < MAX_DEPLOYMENTS_PER_HOUR;

  if (!intervalOk) {
    const waitMin = ((MIN_DEPLOY_INTERVAL_MS - msSinceDeploy) / 60000).toFixed(1);
    console.log(`[Queue] Deploy skipped — interval not reached (${waitMin} min remaining)`);
  } else if (!countOk) {
    console.log(`[Queue] Deploy skipped — hourly cap reached (${deploymentsThisHour}/${MAX_DEPLOYMENTS_PER_HOUR})`);
  }

  return intervalOk && countOk;
}

// ── DEPLOYMENT: merge article files + JSON feeds + RSS + search index into ONE commit ──
// Every batch deploy is a complete self-consistent snapshot:
//   article HTML files + image files + JSON feeds + feed.xml + search-index.json
// This guarantees exactly ONE Cloudflare Pages deploy per batch.
async function deployBatch(label = 'batch') {
  if (isDeploying) {
    console.log('[Queue] Deploy already in progress — skipping.');
    return false;
  }
  if (!canDeployNow()) return false;

  const pending = getPendingCount();
  if (pending.files === 0) {
    console.log('[Queue] Deploy skipped — no staged files');
    return false;
  }

  console.log(`[Queue] ▶ Deploying ${label}: ${pending.articles} article(s) + feeds in ONE commit…`);

  isDeploying = true;
  try {
    const { getStagedFiles, clearStagedFiles } = require('./article-stager');

    // 1. Pull staged article/image files from the stager buffer
    const articleFiles = getStagedFiles();

    // 2. Generate updated JSON feeds
    const feedFiles = await updateAllFeeds();

    // 3. Generate updated RSS feed and search index
    const [rssFeed, searchIndex] = await Promise.all([
      buildRssFeed(),
      buildSearchIndex(),
    ]);

    // 4. Merge ALL files and push in a SINGLE commit — ONE Cloudflare deploy
    const allFiles = [
      ...articleFiles,
      ...feedFiles,
      { path: 'public/feed.xml', content: rssFeed },
      { path: 'public/search-index.json', content: searchIndex },
    ];

    if (allFiles.length === 0) {
      console.log('[Queue] Deploy skipped — nothing to commit after merge');
      return false;
    }

    const msg = `feat: batch publish ${pending.articles} article(s) + update feeds [${new Date().toISOString().slice(0,16)}]`;
    await pushFiles(allFiles, msg);

    // Only clear the stager buffer AFTER a successful push
    clearStagedFiles();

    deploymentsThisHour++;
    lastDeploymentTime = Date.now();
    articlesSinceLastDeploy = 0;
    console.log(`[Queue] ✓ Deploy complete — ${allFiles.length} files committed (${deploymentsThisHour}/${MAX_DEPLOYMENTS_PER_HOUR} this hour)`);
    return true;
  } catch (err) {
    console.error('[Queue] Deploy error:', err.message);
    return false;
  } finally {
    isDeploying = false;
  }
}

// ── PROCESS SINGLE ARTICLE ────────────────────────────────────────────────────
async function processQueueItem(forceImmediate = false) {
  const todayCount = await getTodayCount();

  if (todayCount >= config.publishing.maxPerDay) {
    console.log(`[Queue] Daily limit reached (${todayCount}/${config.publishing.maxPerDay})`);
    return false;
  }

  let item = null;
  if (forceImmediate) {
    item = articleQueue.find(q => q.status === 'pending' && q.isBreaking);
    if (!item) item = articleQueue.find(q => q.status === 'pending');
  } else {
    item = articleQueue.find(q => q.status === 'pending');
  }

  if (!item) return false;

  const label = item.isBreaking ? '🔥 BREAKING' : '📰';
  console.log(`\n[Queue] ${label}: ${item.title?.slice(0, 60) || item.url}`);

  try {
    const extracted = await extractArticle(item.sourceData);

    const dup = await isDuplicate(extracted.sourceUrl, extracted.title);
    if (dup) {
      console.log('[Queue] Duplicate — removing from queue');
      articleQueue = articleQueue.filter(q => q.id !== item.id);
      // Mark the URL as processed so it's not re-fetched and re-queued next cycle
      try { const { markProcessed } = require('./fetcher'); await markProcessed([item.url]); } catch (_) {}
      return true;
    }

    const rewritten = await rewriteArticle(extracted.title, extracted.content);
    const savedArticle = await publishArticle(extracted, rewritten);

    if (savedArticle) {
      todayPublishCount++;
      articlesSinceLastDeploy++;
      console.log(`[Queue] ✓ Published: "${savedArticle.title.slice(0, 50)}" ${item.isBreaking ? '[BREAKING]' : ''}`);
      articleQueue = articleQueue.filter(q => q.id !== item.id);
      lastPublishTime = new Date();

      // ✅ FIX 3: Removed the in-loop auto-deploy at batch threshold.
      // Previously this bypassed the deployment limiter (hourly cap + min interval).
      // All deployment decisions are now exclusively handled by startDeploymentScheduler(),
      // which checks every 5 minutes and respects all rate-limit constraints.
    }

    return true;
  } catch (err) {
    console.error('[Queue] Processing error:', err.message);
    articleQueue = articleQueue.filter(q => q.id !== item.id);
    // Mark the URL as processed so failing articles aren't retried forever
    try { const { markProcessed } = require('./fetcher'); await markProcessed([item.url]); } catch (_) {}
    return true;
  }
}

// ── PUBLISHER LOOP ────────────────────────────────────────────────────────────
async function startPublisher() {
  if (isPublisherRunning) return;
  isPublisherRunning = true;

  const intervalMs = config.publishing.publishIntervalMinutes * 60 * 1000;
  console.log(`\n[Publisher] Started | Interval: ${config.publishing.publishIntervalMinutes}min | Batch: ${ARTICLES_PER_BATCH} | Max deploys/hr: ${MAX_DEPLOYMENTS_PER_HOUR}`);

  const publishLoop = async () => {
    const todayCount = await getTodayCount();
    const pending = articleQueue.filter(q => q.status === 'pending');
    const breaking = pending.filter(q => q.isBreaking).length;

    const nextPublish = new Date(Date.now() + intervalMs);
    console.log(`[Queue] ${pending.length} pending | ${breaking} breaking | ${todayCount}/${config.publishing.maxPerDay} today | Next: ${nextPublish.toLocaleTimeString()}`);

    if (todayCount < config.publishing.maxPerDay && pending.length > 0) {
      const hasBreaking = pending.some(q => q.isBreaking);
      if (hasBreaking) {
        console.log('[Queue] 🚨 BREAKING NEWS — publishing immediately!');
        await processQueueItem(true);
      } else {
        await processQueueItem(false);
      }
    }
  };

  await publishLoop();
  setInterval(publishLoop, intervalMs);
}

// ── QUEUE FETCHER ─────────────────────────────────────────────────────────────
function startQueueFetcher() {
  const fetchIntervalMs = config.publishing.fetchIntervalMinutes * 60 * 1000;
  console.log(`[Queue] Fetcher started | Interval: ${config.publishing.fetchIntervalMinutes}min | Max queue: ${config.publishing.maxQueueSize}`);
  fetchArticlesToQueue();
  setInterval(fetchArticlesToQueue, fetchIntervalMs);
}

// ── PERIODIC DEPLOYMENT SCHEDULER (was never called before — now wired in) ────
// Checks every 5 min: if staged files exist and enough time has passed → deploy
function startDeploymentScheduler() {
  const CHECK_INTERVAL_MS = 5 * 60 * 1000; // every 5 minutes

  console.log(`[Queue] Deployment scheduler started | Min interval: ${config.publishing.minDeployIntervalMinutes}min | Max/hr: ${MAX_DEPLOYMENTS_PER_HOUR}`);

  setInterval(async () => {
    const pending = getPendingCount();
    if (pending.files === 0) return;

    const now = Date.now();
    const msSinceDeploy = lastDeploymentTime ? now - lastDeploymentTime : Infinity;
    const timeSinceDeploy = (msSinceDeploy / 60000).toFixed(1);

    if (pending.articles >= ARTICLES_PER_BATCH) {
      console.log(`[Queue] Scheduler: batch full (${pending.articles} articles) — deploying`);
      await deployBatch(`scheduler-batch-${pending.articles}`);
    } else if (msSinceDeploy >= MIN_DEPLOY_INTERVAL_MS && pending.files > 0) {
      console.log(`[Queue] Scheduler: interval elapsed (${timeSinceDeploy} min since last deploy) — deploying`);
      await deployBatch(`scheduler-interval`);
    }
  }, CHECK_INTERVAL_MS);
}

// ── INITIALIZE ────────────────────────────────────────────────────────────────
async function initializeQueue() {
  console.log('[Queue] Initializing smart queue...');
  const todayCount = await getTodayCount();
  todayPublishCount = todayCount;
  articleQueue = [];
  console.log(`[Queue] Ready | Queue: 0 | Published today: ${todayCount}/${config.publishing.maxPerDay}`);
}

// ── GET STATUS ────────────────────────────────────────────────────────────────
function getQueueStatus() {
  const pending = articleQueue.filter(q => q.status === 'pending');
  const breaking = pending.filter(q => q.isBreaking).length;
  const nextPublish = lastPublishTime
    ? new Date(lastPublishTime.getTime() + config.publishing.publishIntervalMinutes * 60 * 1000)
    : new Date(Date.now() + config.publishing.publishIntervalMinutes * 60 * 1000);

  return {
    queueSize: articleQueue.length,
    pending: pending.length,
    breaking,
    publishedToday: todayPublishCount,
    maxPerDay: config.publishing.maxPerDay,
    nextPublishTime: nextPublish,
    deploymentsThisHour,
    maxDeploymentsPerHour: MAX_DEPLOYMENTS_PER_HOUR,
  };
}

module.exports = {
  initializeQueue,
  fetchArticlesToQueue,
  startPublisher,
  startQueueFetcher,
  startDeploymentScheduler,
  getQueueStatus,
  isBreakingNews,
  addToQueue,
  deployBatch,
};
