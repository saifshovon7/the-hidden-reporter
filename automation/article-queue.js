'use strict';
/**
 * article-queue.js
 * SMART QUEUE SYSTEM with BREAKING NEWS MODE
 * 
 * Features:
 * - Small queue buffer (max 10 articles)
 * - Always prioritizes newest articles
 * - Removes stale articles (>6 hours old)
 * - Breaking news detection (publishes immediately)
 * - Fresh news prioritized throughout the day
 */

const { createClient } = require('@supabase/supabase-js');
const { config } = require('./config');
const { fetchAllSources } = require('./fetcher');
const { extractArticle } = require('./extractor');
const { rewriteArticle } = require('./ai-rewriter');
const { isDuplicate } = require('./duplicate-detector');
const { publishArticle, getTodayCount, getTodayCategoryStats, rebuildAll } = require('./publisher');
const { flushStagedArticles } = require('./article-stager');

const supabase = createClient(config.supabase.url, config.supabase.serviceKey);

// Queue state
let articleQueue = [];
let isPublisherRunning = false;
let isFetcherRunning = false;
let lastPublishTime = null;
let lastHomepageRebuild = null;
let homepageRebuildPending = false;
let todayPublishCount = 0;

// ── BREAKING NEWS DETECTION ─────────────────────────────────────────────────
function isBreakingNews(item) {
  const keywords = config.publishing.breakingNewsKeywords || [];
  const title = (item.title || '').toLowerCase();
  const ageMinutes = item.pubDate 
    ? (Date.now() - new Date(item.pubDate).getTime()) / 60000 
    : 999;
  
  const ageLimit = config.publishing.breakingNewsAgeMinutes || 10;
  
  // Must be recent AND contain breaking keywords
  if (ageMinutes > ageLimit) return false;
  
  return keywords.some(kw => title.includes(kw.toLowerCase()));
}

// ── GET ARTICLE PRIORITY SCORE ───────────────────────────────────────────────
// Higher score = higher priority (publish sooner)
function getArticlePriority(item) {
  const now = Date.now();
  const pubTime = item.pubDate ? new Date(item.pubDate).getTime() : now;
  const ageMinutes = (now - pubTime) / 60000;
  
  // Base priority: newer = higher (inverted age)
  let score = 1000 - ageMinutes;
  
  // Bonus for breaking news
  if (isBreakingNews(item)) {
    score += 10000; // Much higher priority
  }
  
  return Math.max(0, score);
}

// ── SORT QUEUE BY PRIORITY ─────────────────────────────────────────────────
function sortQueue() {
  articleQueue.sort((a, b) => getArticlePriority(b) - getArticlePriority(a));
}

// ── CLEANUP STALE ARTICLES ─────────────────────────────────────────────────
function cleanupStaleArticles() {
  const staleHours = config.publishing.queueStaleHours || 6;
  const staleMs = staleHours * 60 * 60 * 1000;
  const now = Date.now();
  
  const beforeCount = articleQueue.length;
  
  articleQueue = articleQueue.filter(item => {
    if (item.status !== 'pending') return false;
    
    const pubTime = item.pubDate ? new Date(item.pubDate).getTime() : now;
    const ageMs = now - pubTime;
    
    // Keep if: breaking news OR not stale OR queue is small
    if (isBreakingNews(item)) return true;
    if (ageMs < staleMs) return true;
    if (articleQueue.length <= 3) return true; // Keep minimum
    
    return false;
  });
  
  if (beforeCount !== articleQueue.length) {
    console.log(`[Queue] Cleaned up ${beforeCount - articleQueue.length} stale articles`);
  }
}

// ── ADD ARTICLE TO QUEUE ───────────────────────────────────────────────────
async function addToQueue(item) {
  const maxQueue = config.publishing.maxQueueSize || 10;
  
  // Check for duplicates
  if (articleQueue.some(q => q.url === item.url)) {
    return false;
  }
  
  // Add new article
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
    createdAt: new Date()
  };
  
  articleQueue.push(queueItem);
  
  // Sort by priority (newest first, breaking news priority)
  sortQueue();
  
  // Remove oldest if queue exceeds max
  if (articleQueue.length > maxQueue) {
    // Keep breaking news, remove oldest regular articles
    const nonBreaking = articleQueue.filter(q => !q.isBreaking && q.status === 'pending');
    if (nonBreaking.length > 0) {
      // Remove the oldest non-breaking
      const toRemove = nonBreaking[0];
      articleQueue = articleQueue.filter(q => q.id !== toRemove.id);
      console.log(`[Queue] Removed stale article: ${toRemove.title?.slice(0, 40)}`);
    }
  }
  
  return true;
}

// ── FETCH ARTICLES ───────────────────────────────────────────────────────────
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
      if (articleQueue.length >= config.publishing.maxQueueSize) {
        break;
      }
      
      const wasAdded = await addToQueue(item);
      if (wasAdded) added++;
    }
    
    // Cleanup stale articles
    cleanupStaleArticles();
    
    // Sort queue
    sortQueue();
    
    // Show breaking news count
    const breakingCount = articleQueue.filter(q => q.isBreaking && q.status === 'pending').length;
    console.log(`[Queue] Added ${added} articles | Queue: ${articleQueue.length} | Breaking: ${breakingCount}`);
    
  } catch (err) {
    console.error('[Queue] Fetch error:', err.message);
  } finally {
    isFetcherRunning = false;
  }
}

// ── PROCESS SINGLE ARTICLE ───────────────────────────────────────────────────
async function processQueueItem(forceImmediate = false) {
  const todayCount = await getTodayCount();
  
  if (todayCount >= config.publishing.maxPerDay) {
    console.log(`[Queue] Daily limit reached (${todayCount}/${config.publishing.maxPerDay})`);
    return false;
  }
  
  // Find highest priority pending article
  // If forceImmediate (breaking news), find the newest one
  let item = null;
  
  if (forceImmediate) {
    // Find newest breaking news
    item = articleQueue.find(q => q.status === 'pending' && q.isBreaking);
    if (!item) {
      // No breaking news, just get newest
      item = articleQueue.find(q => q.status === 'pending');
    }
  } else {
    // Regular: get highest priority
    item = articleQueue.find(q => q.status === 'pending');
  }
  
  if (!item) {
    return false;
  }
  
  const label = item.isBreaking ? '🔥 BREAKING' : '📰';
  console.log(`\n[Queue] ${label}: ${item.title?.slice(0, 60) || item.url}`);
  
  try {
    // Extract content
    const extracted = await extractArticle(item.sourceData);
    
    // Check duplicates
    const dup = await isDuplicate(extracted.sourceUrl, extracted.title, extracted.content);
    if (dup) {
      console.log('[Queue] Duplicate - removing from queue');
      articleQueue = articleQueue.filter(q => q.id !== item.id);
      return true;
    }
    
    // Rewrite with AI
    const rewritten = await rewriteArticle(extracted.title, extracted.content);
    
    // Publish
    const savedArticle = await publishArticle(extracted, rewritten);
    if (savedArticle) {
      todayPublishCount++;
      console.log(`[Queue] ✓ Published: "${savedArticle.title.slice(0, 50)}" ${item.isBreaking ? '[BREAKING]' : ''}`);
      
      // Flush staged files to GitHub immediately
      await flushStagedArticles();
      
      // Mark as published and remove from queue
      articleQueue = articleQueue.filter(q => q.id !== item.id);
      lastPublishTime = new Date();
      
      // Trigger homepage rebuild after publish (async, don't wait)
      triggerHomepageRebuild();
    }
    
    return true;
    
  } catch (err) {
    console.error('[Queue] Processing error:', err.message);
    // Mark as error, remove from queue to prevent stuck
    articleQueue = articleQueue.filter(q => q.id !== item.id);
    return true;
  }
}

// ── PUBLISHER LOOP ───────────────────────────────────────────────────────────
async function startPublisher() {
  if (isPublisherRunning) return;
  isPublisherRunning = true;
  
  const intervalMs = config.publishing.publishIntervalMinutes * 60 * 1000;
  
  console.log(`\n[Publisher] Publisher started | Interval: ${config.publishing.publishIntervalMinutes}min | Max/day: ${config.publishing.maxPerDay}`);
  
  const publishLoop = async () => {
    const todayCount = await getTodayCount();
    const pending = articleQueue.filter(q => q.status === 'pending');
    const breaking = pending.filter(q => q.isBreaking).length;
    
    // Show status
    const nextPublish = new Date(Date.now() + intervalMs);
    console.log(`[Queue] ${pending.length} pending | ${breaking} breaking | ${todayCount}/${config.publishing.maxPerDay} today | Next: ${nextPublish.toLocaleTimeString()}`);
    
    if (todayCount < config.publishing.maxPerDay && pending.length > 0) {
      // Check for breaking news - publish immediately
      const hasBreaking = pending.some(q => q.isBreaking);
      
      if (hasBreaking) {
        console.log('[Queue] 🚨 BREAKING NEWS DETECTED - Publishing immediately!');
        await processQueueItem(true); // force immediate
      } else {
        // Regular publish
        await processQueueItem(false);
      }
    }
  };
  
  // Run immediately on start
  await publishLoop();
  
  // Then run at fixed intervals
  setInterval(publishLoop, intervalMs);
}

// ── QUEUE FETCHER ───────────────────────────────────────────────────────────
function startQueueFetcher() {
  const fetchIntervalMs = config.publishing.fetchIntervalMinutes * 60 * 1000;
  
  console.log(`[Queue] Fetcher started | Interval: ${config.publishing.fetchIntervalMinutes}min | Max queue: ${config.publishing.maxQueueSize}`);
  
  // Run immediately
  fetchArticlesToQueue();
  
  // Then run at intervals
  setInterval(fetchArticlesToQueue, fetchIntervalMs);
}

// ── INITIALIZE ───────────────────────────────────────────────────────────────
async function initializeQueue() {
  console.log('[Queue] Initializing smart queue...');
  
  const todayCount = await getTodayCount();
  todayPublishCount = todayCount;
  
  articleQueue = [];
  
  console.log(`[Queue] Ready | Queue: 0 | Published today: ${todayCount}/${config.publishing.maxPerDay}`);
}

// ── GET STATUS ───────────────────────────────────────────────────────────────
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
    nextPublishTime: nextPublish
  };
}

// ── TRIGGER HOMEPAGE REBUILD ─────────────────────────────────────────────────
// Rebuild homepage every 5 minutes or after 3 articles
let articlesSinceRebuild = 0;
async function triggerHomepageRebuild() {
  articlesSinceRebuild++;
  const now = Date.now();
  const timeSinceRebuild = lastHomepageRebuild ? now - lastHomepageRebuild.getTime() : 999999;
  const rebuildEveryMinutes = 5;
  const rebuildAfterArticles = 3;
  
  // Rebuild if enough time passed OR enough articles published
  if (timeSinceRebuild > rebuildEveryMinutes * 60 * 1000 || articlesSinceRebuild >= rebuildAfterArticles) {
    if (!homepageRebuildPending) {
      homepageRebuildPending = true;
      console.log('[Queue] Triggering homepage rebuild...');
      try {
        await rebuildAll();
        lastHomepageRebuild = new Date();
        articlesSinceRebuild = 0;
        console.log('[Queue] Homepage rebuild complete.');
      } catch (err) {
        console.error('[Queue] Homepage rebuild error:', err.message);
      } finally {
        homepageRebuildPending = false;
      }
    }
  }
}

module.exports = {
  initializeQueue,
  fetchArticlesToQueue,
  startPublisher,
  startQueueFetcher,
  getQueueStatus,
  isBreakingNews,
  addToQueue
};
