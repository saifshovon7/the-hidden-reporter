'use strict';
/**
 * fetcher.js
 * Hybrid news fetching using multiple sources:
 * - RSS feeds (from database)
 * - News APIs (NewsAPI, GDELT, ContextualWeb)
 * - Google News scraping
 * - Direct website scraping
 * Includes category balancing to ensure all categories receive content.
 */

const { collectAllNews, balanceByCategory, markProcessed } = require('./news-sources');

// ── Main fetch function with category balancing ──────────────────────────────────
async function fetchAllSources(categoryStats = {}) {
  const { config } = require('./config');
  
  console.log('[Fetcher] Starting hybrid news collection...');
  
  // Collect from all sources (RSS, APIs, scrapers)
  const allItems = await collectAllNews(categoryStats);
  
  if (!allItems.length) {
    console.log('[Fetcher] No articles collected.');
    return [];
  }
  
  // Apply category balancing
  const targets = config.publishing.categoryTargets || {};
  const balancedItems = balanceByCategory(allItems, categoryStats, targets);
  
  console.log(`[Fetcher] Final balanced list: ${balancedItems.length} articles`);
  
  // Log category distribution
  const distribution = {};
  for (const item of balancedItems) {
    const cat = item.category || 'general';
    distribution[cat] = (distribution[cat] || 0) + 1;
  }
  console.log('[Fetcher] Category distribution:', distribution);
  
  return balancedItems;
}

module.exports = { fetchAllSources, markProcessed };
