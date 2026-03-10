'use strict';
/**
 * index.js — The Hidden Reporter Automation Engine
 *
 * Schedules and runs the full pipeline:
 *   Every 45 min : fetch → extract → rewrite → publish
 *   Daily at 3am : cleanup + sitemap update
 *
 * Run modes:
 *   node automation/index.js          (continuous scheduler)
 *   node automation/index.js --once   (single run then exit)
 */

require('dotenv').config();

const cron = require('node-cron');
const { config, validate } = require('./config');
const { fetchAllSources, markProcessed } = require('./fetcher');
const { extractArticle } = require('./extractor');
const { rewriteArticle } = require('./ai-rewriter');
const { isDuplicate } = require('./duplicate-detector');
const { publishArticle, getTodayCount, rebuildAll } = require('./publisher');
const { updateTrending } = require('./trending-detector');
const { runCleanup } = require('./cleanup');
const { generateSitemap } = require('./sitemap-generator');
const { pushFile, validateGitHub, logSessionStats } = require('./github-pusher');

// ── Validate config on startup ────────────────────────────────────────────────
validate();

let isRunning = false;

// ── Main pipeline ─────────────────────────────────────────────────────────────
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
    // Check daily limit before doing anything
    const todayCount = await getTodayCount();
    if (todayCount >= config.publishing.maxPerDay) {
      console.log(`[Pipeline] Daily limit reached (${todayCount}/${config.publishing.maxPerDay}). Exiting early.`);
      return;
    }

    const remaining = config.publishing.maxPerDay - todayCount;
    const delayMs = config.publishing.postPublishDelayMinutes * 60 * 1000;
    console.log(`[Pipeline] ${remaining} publish slots remaining today.`);
    console.log(`[Pipeline] Post-publish delay: ${config.publishing.postPublishDelayMinutes} minutes between articles.`);

    // 1. Fetch all sources
    const fetchedItems = await fetchAllSources();
    if (!fetchedItems.length) {
      console.log('[Pipeline] No new items to process.');
      return;
    }

    // Limit to remaining daily slots
    const itemsToProcess = fetchedItems.slice(0, remaining);
    let published = 0;
    const processedUrls = [];

    // 2. Process ONE article at a time — sequential, never parallel
    for (let i = 0; i < itemsToProcess.length; i++) {
      const item = itemsToProcess[i];

      // Re-check daily limit on each iteration (another process may have run)
      const currentCount = await getTodayCount();
      if (currentCount >= config.publishing.maxPerDay) {
        console.log(`[Pipeline] Daily limit reached mid-run (${currentCount}/${config.publishing.maxPerDay}). Stopping.`);
        break;
      }

      console.log(`\n[Pipeline] ── Article ${i + 1}/${itemsToProcess.length} ──`);
      console.log(`[Pipeline] Processing: ${item.url}`);

      try {
        // 2a. Extract content
        const extracted = await extractArticle(item);

        // 2b. Check for duplicates
        const dup = await isDuplicate(extracted.sourceUrl, extracted.title, extracted.content);
        if (dup) {
          console.log(`[Pipeline] Duplicate — skipping.`);
          processedUrls.push(item.url);
          continue;
        }

        // 2c. Rewrite with AI
        console.log(`[Pipeline] Rewriting: "${extracted.title.slice(0, 60)}…"`);
        const rewritten = await rewriteArticle(extracted.title, extracted.content);

        // 2d. Publish (save to DB + generate HTML + push to GitHub)
        const savedArticle = await publishArticle(extracted, rewritten);
        if (savedArticle) {
          published++;
          console.log(`[Pipeline] ✓ Published (${published} today): "${savedArticle.title.slice(0, 60)}"`);
        }

        processedUrls.push(item.url);

        // 2e. Wait AFTER the GitHub push completes — prevents deployment queue flooding.
        //     Skip the delay after the last article.
        const isLast = (i === itemsToProcess.length - 1);
        const willHitLimit = (currentCount + published) >= config.publishing.maxPerDay;

        if (!isLast && !willHitLimit) {
          console.log(`[Pipeline] Waiting ${config.publishing.postPublishDelayMinutes} min before next article…`);
          await sleep(delayMs);
        }

      } catch (err) {
        console.error(`[Pipeline] Error processing ${item.url}: ${err.message}`);
        processedUrls.push(item.url); // Mark as processed to avoid retry loops
      }
    }

    // 3. Mark all attempted URLs as processed
    await markProcessed(processedUrls);

    // 4. Update trending topics
    if (published > 0) {
      await updateTrending();
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
  const intervalMin = config.publishing.fetchIntervalMinutes;
  const cronExpr = `*/${intervalMin} * * * *`;

  console.log(`[Scheduler] Starting automation engine.`);
  console.log(`[Scheduler] Fetch interval: every ${intervalMin} minutes.`);
  console.log(`[Scheduler] Daily limit: ${config.publishing.maxPerDay} articles.`);
  console.log(`[Scheduler] Post-publish delay: ${config.publishing.postPublishDelayMinutes} minutes.`);
  console.log(`[Scheduler] Site: ${config.site.url}`);

  // ── Validate GitHub connectivity before doing anything ──
  // Retry with exponential backoff rather than crashing — prevents Railway
  // from restarting the container in a tight loop and exhausting the API rate limit.
  let ghOk = false;
  let backoffMs = 60_000; // start at 1 minute
  while (!ghOk) {
    try {
      await validateGitHub();
      ghOk = true;
    } catch (err) {
      console.error('[Scheduler] GitHub validation failed:', err.message);
      console.error(`[Scheduler] Retrying in ${backoffMs / 60_000} minute(s). Fix GITHUB_TOKEN, GITHUB_OWNER, GITHUB_REPO in Railway if needed.`);
      await sleep(backoffMs);
      backoffMs = Math.min(backoffMs * 2, 30 * 60_000); // cap at 30 minutes
    }
  }

  // Rebuild search index + category pages from existing DB articles on every startup
  rebuildAll().then(() => runPipeline());

  // Schedule recurring runs
  cron.schedule(cronExpr, runPipeline);

  // Daily maintenance at 3:00 AM
  cron.schedule('0 3 * * *', runDailyMaintenance);

  console.log(`[Scheduler] Cron scheduled: ${cronExpr}`);
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
