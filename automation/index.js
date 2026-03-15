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
const { publishArticle, getTodayCount, getTodayCategoryStats, rebuildArticlesOnly } = require('./publisher');
const { deployBatch } = require('./article-queue');
const { updateTrending } = require('./trending-detector');
const { runCleanup } = require('./cleanup');
const { generateSitemap } = require('./sitemap-generator');
const { pushFile, validateGitHub, logSessionStats } = require('./github-pusher');
const { initializeQueue, fetchArticlesToQueue, startPublisher, startQueueFetcher, startDeploymentScheduler, getQueueStatus } = require('./article-queue');

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
    const processedUrls = [];   // Only URLs that were successfully published
    const duplicateUrls = [];   // URLs that were confirmed duplicates

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

        const dup = await isDuplicate(extracted.sourceUrl, extracted.title);
        if (dup) {
          console.log(`[Pipeline] Duplicate — skipping.`);
          duplicateUrls.push(item.url); // mark duplicate as processed so it's not re-fetched
          continue;
        }

        console.log(`[Pipeline] Rewriting: "${extracted.title.slice(0, 60)}…"`);
        const rewritten = await rewriteArticle(extracted.title, extracted.content);

        const savedArticle = await publishArticle(extracted, rewritten);
        if (savedArticle) {
          published++;
          categoryStats[savedArticle.category] = (categoryStats[savedArticle.category] || 0) + 1;
          console.log(`[Pipeline] ✓ Published (${published} today): "${savedArticle.title.slice(0, 60)}" [${savedArticle.category}]`);
          processedUrls.push(item.url); // only mark as processed on success
        }
        // If savedArticle is null (daily limit), do NOT mark as processed — allow retry

        const isLast = (i === itemsToProcess.length - 1);
        const willHitLimit = (currentCount + published) >= config.publishing.maxPerDay;

        if (!isLast && !willHitLimit) {
          console.log(`[Pipeline] Waiting ${config.publishing.publishIntervalMinutes} min before next article…`);
          await sleep(delayMs);
        }

      } catch (err) {
        console.error(`[Pipeline] Error processing ${item.url}: ${err.message}`);
        // Do NOT push to processedUrls on error — allow the article to be retried next run
      }
    }

    await markProcessed([...processedUrls, ...duplicateUrls]);

    if (published > 0) {
      // Use deployBatch for a complete commit: article HTML + JSON feeds + RSS + search index
      await deployBatch('once-mode-final');
    }

    if (published > 0) {
      await updateTrending();
    }

    // ⚠️ Sitemap is updated during nightly maintenance (3 AM) only.
    // Pushing the sitemap here triggered an extra commit/deploy after every run.
    // With the batch system, the sitemap is regenerated as part of daily cleanup.

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
  console.log(`[Scheduler] Max deploys/hr: ${config.publishing.maxDeploymentsPerHour}`);
  console.log(`[Scheduler] Min deploy interval: ${config.publishing.minDeployIntervalMinutes} minutes`);

  // Initialize queue from database
  await initializeQueue();

  // Start the continuous queue fetcher (gathers articles)
  startQueueFetcher();

  // Start the publisher (publishes articles at fixed intervals)
  await startPublisher();

  // ✅ FIX 1: Wire in the deployment scheduler — this was exported but never called,
  // meaning ALL deployment scheduling has been dead since it was written.
  // The scheduler checks every 5 min and fires a batch deploy when:
  //   (a) staged articles >= ARTICLES_PER_BATCH, OR
  //   (b) MIN_DEPLOY_INTERVAL has elapsed and there are staged files.
  startDeploymentScheduler();

  // Show queue status periodically
  setInterval(() => {
    const status = getQueueStatus();
    console.log(`[Queue] ${status.pending} pending | ${status.publishedToday}/${status.maxPerDay} today | Deploys this hour: ${status.deploymentsThisHour}/${status.maxDeploymentsPerHour}`);
  }, config.publishing.publishIntervalMinutes * 60 * 1000 / 2);
}

// ── Daily maintenance ─────────────────────────────────────────────────────────
async function runDailyMaintenance() {
  console.log('\n[Maintenance] Starting daily maintenance...');
  try {
    await runCleanup();
    // Sitemap update runs once per day only (not on every batch deploy)
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

  // ✅ FIX 4: Only rebuild article HTML files + JSON feeds on startup.
  // Homepage and category pages are now static skeletons that load content
  // dynamically from JSON feeds — they never need to be re-committed.
  // rebuildArticlesOnly() catches all its own errors internally and always resolves.
  // The .catch() below is unreachable but kept as a safety net.
  rebuildArticlesOnly().then(() => {
    // Start queue-based publishing system
    startQueuePipeline();
  }).catch(err => {
    console.error('[Scheduler] Startup rebuild error (unexpected):', err.message);
    // Start publishing even if rebuild fails
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
