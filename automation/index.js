'use strict';
/**
 * index.js — The Hidden Reporter Automation Engine
 * 
 * Queue-based publishing system for distributed article publishing throughout the day.
 * - Fetches articles continuously and adds them to a queue
 * - Publishes 1 article at fixed intervals (default: 14 minutes)
 * - Prevents burst publishing
 *
 * Run modes:
 *   node automation/index.js          (continuous scheduler with queue)
 *   node automation/index.js --once   (legacy single run - still supported)
 */

require('dotenv').config();

const cron = require('node-cron');
const { config, validate } = require('./config');
const { fetchAllSources, markProcessed } = require('./fetcher');
const { extractArticle } = require('./extractor');
const { rewriteArticle } = require('./ai-rewriter');
const { isDuplicate } = require('./duplicate-detector');
const { publishArticle, getTodayCount, getTodayCategoryStats, rebuildAll, flushStagedArticles } = require('./publisher');
const { updateTrending } = require('./trending-detector');
const { runCleanup } = require('./cleanup');
const { generateSitemap } = require('./sitemap-generator');
const { pushFile, validateGitHub, logSessionStats } = require('./github-pusher');
const { initializeQueue, fetchArticlesToQueue, startPublisher, startQueueFetcher, getQueueStatus } = require('./article-queue');

// ── Validate config on startup ────────────────────────────────────────────────
validate();

let isRunning = false;

// ── Main pipeline (legacy - for --once mode) ─────────────────────────────────
async function runPipeline() {
  if (isRunning) {
    console.log('[Pipeline] Previous run still in progress. Skipping.');
    return;
  }

  isRunning = true;
  const startTime = Date.now();

  console.log(`\n${'═'.repeat(60)}`);
  console.log(`[Pipeline] Starting at ${new Date().toISOString()}`);
  console.log(`${'═'.repeat(60)}`);

  try {
    const todayCount = await getTodayCount();
    if (todayCount >= config.publishing.maxPerDay) {
      console.log(`[Pipeline] Daily limit reached (${todayCount}/${config.publishing.maxPerDay}). Exiting early.`);
      return;
    }

    const remaining = config.publishing.maxPerDay - todayCount;
    const delayMs = config.publishing.publishIntervalMinutes * 60 * 1000;
    console.log(`[Pipeline] ${remaining} publish slots remaining today.`);
    console.log(`[Pipeline] Publish interval: ${config.publishing.publishIntervalMinutes} minutes between articles.`);

    const categoryStats = await getTodayCategoryStats();
    let statsLog = '[Automation] Category stats today: ';
    for (const cat of config.categories) {
      statsLog += `${cat}: ${categoryStats[cat] || 0}   `;
    }
    console.log(statsLog.trim());

    const fetchedItems = await fetchAllSources(categoryStats);
    if (!fetchedItems.length) {
      console.log('[Pipeline] No new items to process.');
      return;
    }

    const itemsToProcess = fetchedItems.slice(0, remaining);
    let published = 0;
    const processedUrls = [];

    for (let i = 0; i < itemsToProcess.length; i++) {
      const item = itemsToProcess[i];

      const currentCount = await getTodayCount();
      if (currentCount >= config.publishing.maxPerDay) {
        console.log(`[Pipeline] Daily limit reached mid-run (${currentCount}/${config.publishing.maxPerDay}). Stopping.`);
        break;
      }

      console.log(`\n[Pipeline] ── Article ${i + 1}/${itemsToProcess.length} ──`);
      console.log(`[Pipeline] Processing: ${item.url}`);

      try {
        const extracted = await extractArticle(item);

        const dup = await isDuplicate(extracted.sourceUrl, extracted.title, extracted.content);
        if (dup) {
          console.log(`[Pipeline] Duplicate — skipping.`);
          processedUrls.push(item.url);
          continue;
        }

        console.log(`[Pipeline] Rewriting: "${extracted.title.slice(0, 60)}…"`);
        const rewritten = await rewriteArticle(extracted.title, extracted.content);

        const savedArticle = await publishArticle(extracted, rewritten);
        if (savedArticle) {
          published++;
          categoryStats[savedArticle.category] = (categoryStats[savedArticle.category] || 0) + 1;
          console.log(`[Pipeline] ✓ Published (${published} today): "${savedArticle.title.slice(0, 60)}" [${savedArticle.category}]`);
        }

        processedUrls.push(item.url);

        const isLast = (i === itemsToProcess.length - 1);
        const willHitLimit = (currentCount + published) >= config.publishing.maxPerDay;

        if (!isLast && !willHitLimit) {
          console.log(`[Pipeline] Waiting ${config.publishing.publishIntervalMinutes} min before next article…`);
          await sleep(delayMs);
        }

      } catch (err) {
        console.error(`[Pipeline] Error processing ${item.url}: ${err.message}`);
        processedUrls.push(item.url);
      }
    }

    await markProcessed(processedUrls);

    if (published > 0) {
      await flushStagedArticles();
    }

    if (published > 0) {
      await updateTrending();
    }

    if (published > 0) {
      try {
        const sitemap = await generateSitemap();
        await pushFile('public/sitemap.xml', sitemap, 'chore: update sitemap after publish');
        console.log('[Pipeline] Sitemap updated.');
      } catch (err) {
        console.error('[Pipeline] Sitemap update error:', err.message);
      }
    }

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`\n[Pipeline] Run complete. Published: ${published}. Time: ${elapsed}s.`);
    logSessionStats();

  } catch (err) {
    console.error('[Pipeline] Fatal error:', err.message, err.stack);
  } finally {
    isRunning = false;
  }
}

// ── Queue-based publishing (default mode) ────────────────────────────────────
async function startQueuePipeline() {
  console.log(`\n${'═'.repeat(60)}`);
  console.log(`[Scheduler] Starting Queue-Based Publisher`);
  console.log(`${'═'.repeat(60)}`);
  
  console.log(`[Scheduler] Daily limit: ${config.publishing.maxPerDay} articles`);
  console.log(`[Scheduler] Publish interval: ${config.publishing.publishIntervalMinutes} minutes`);
  console.log(`[Scheduler] Fetch interval: ${config.publishing.fetchIntervalMinutes} minutes`);
  console.log(`[Scheduler] Max queue size: ${config.publishing.maxQueueSize} articles`);

  // Initialize queue from database
  await initializeQueue();

  // Start the continuous queue fetcher (gathers articles)
  startQueueFetcher();

  // Start the publisher (publishes at fixed intervals)
  await startPublisher();

  // Show queue status periodically
  setInterval(() => {
    const status = getQueueStatus();
    console.log(`[Queue] ${status.pending} pending | ${status.publishedToday}/${status.maxPerDay} today | Next: ${status.nextPublishTime.toLocaleTimeString()}`);
  }, config.publishing.publishIntervalMinutes * 60 * 1000 / 2);
}

// ── Daily maintenance ─────────────────────────────────────────────────────────
async function runDailyMaintenance() {
  console.log('\n[Maintenance] Starting daily maintenance...');
  try {
    await runCleanup();
    const sitemap = await generateSitemap();
    await pushFile('public/sitemap.xml', sitemap, 'chore: daily sitemap update');
    console.log('[Maintenance] Daily maintenance complete.');
  } catch (err) {
    console.error('[Maintenance] Error:', err.message);
  }
}

// ── Scheduler ─────────────────────────────────────────────────────────────────
async function startScheduler() {
  console.log(`[Scheduler] Starting automation engine.`);
  console.log(`[Scheduler] Site: ${config.site.url}`);

  // Validate GitHub connectivity
  let ghOk = false;
  let backoffMs = 60_000;
  while (!ghOk) {
    try {
      await validateGitHub();
      ghOk = true;
    } catch (err) {
      console.error('[Scheduler] GitHub validation failed:', err.message);
      console.error(`[Scheduler] Retrying in ${backoffMs / 60_000} minute(s).`);
      await sleep(backoffMs);
      backoffMs = Math.min(backoffMs * 2, 30 * 60_000);
    }
  }

  // Run startup rebuild
  rebuildAll().then(() => {
    // Start queue-based publishing system
    startQueuePipeline();
  });

  // Daily maintenance at 3:00 AM
  cron.schedule('0 3 * * *', runDailyMaintenance);

  console.log('[Scheduler] Daily maintenance: 3:00 AM');
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ── Entry point ───────────────────────────────────────────────────────────────
if (process.argv.includes('--once')) {
  runPipeline().then(() => {
    console.log('[Pipeline] --once mode: exiting.');
    process.exit(0);
  }).catch(err => {
    console.error(err);
    process.exit(1);
  });
} else {
  startScheduler();
}
