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
const { config, validate }    = require('./config');
const { fetchAllSources, markProcessed } = require('./fetcher');
const { extractArticle }      = require('./extractor');
const { rewriteArticle }      = require('./ai-rewriter');
const { isDuplicate }         = require('./duplicate-detector');
const { publishArticle, getTodayCount, rebuildAll } = require('./publisher');
const { updateTrending }      = require('./trending-detector');
const { runCleanup }          = require('./cleanup');
const { generateSitemap }     = require('./sitemap-generator');
const { pushFile }            = require('./github-pusher');

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
    console.log(`[Pipeline] ${remaining} publish slots remaining today.`);

    // 1. Fetch all sources
    const fetchedItems = await fetchAllSources();
    if (!fetchedItems.length) {
      console.log('[Pipeline] No new items to process.');
      return;
    }

    let published = 0;
    const processedUrls = [];

    // 2. Process each item
    for (const item of fetchedItems) {
      if (published >= remaining) {
        console.log(`[Pipeline] Reached today's limit during this run.`);
        break;
      }

      console.log(`\n[Pipeline] Processing: ${item.url}`);

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

        // 2d. Publish
        const savedArticle = await publishArticle(extracted, rewritten);
        if (savedArticle) {
          published++;
          console.log(`[Pipeline] ✓ Published (${published}/${remaining}): "${savedArticle.title.slice(0, 60)}"`);
        }

        processedUrls.push(item.url);

        // Throttle: wait 3 seconds between articles to respect rate limits
        await sleep(3000);

      } catch (err) {
        console.error(`[Pipeline] Error processing ${item.url}: ${err.message}`);
        processedUrls.push(item.url); // Mark as processed even on error to avoid retry loops
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
function startScheduler() {
  const intervalMin = config.publishing.fetchIntervalMinutes;
  const cronExpr    = `*/${intervalMin} * * * *`;

  console.log(`[Scheduler] Starting automation engine.`);
  console.log(`[Scheduler] Fetch interval: every ${intervalMin} minutes.`);
  console.log(`[Scheduler] Daily limit: ${config.publishing.maxPerDay} articles.`);
  console.log(`[Scheduler] Site: ${config.site.url}`);

  // Rebuild search index + category pages from existing DB articles on every startup
  // This ensures the site is never empty after a Railway restart or redeploy.
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
  // Single run mode (for testing)
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
