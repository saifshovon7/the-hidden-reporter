'use strict';
/**
 * cleanup.js
 * Deletes articles older than 24 months and prunes the processed_urls cache.
 */

const { createClient } = require('@supabase/supabase-js');
const { config }       = require('./config');

const supabase = createClient(config.supabase.url, config.supabase.serviceKey);

async function runCleanup() {
  console.log('[Cleanup] Starting daily cleanup...');

  // 1. Delete articles older than 24 months
  const cutoff = new Date();
  cutoff.setMonth(cutoff.getMonth() - config.publishing.cleanupMonths);

  const { data: deleted, error: artError } = await supabase
    .from('articles')
    .delete()
    .lt('publish_date', cutoff.toISOString())
    .select('id');

  if (artError) {
    console.error('[Cleanup] Article deletion error:', artError.message);
  } else {
    console.log(`[Cleanup] Deleted ${(deleted || []).length} old articles.`);
  }

  // 2. Prune processed_urls older than 30 days
  const urlCutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  const { error: urlError } = await supabase
    .from('processed_urls')
    .delete()
    .lt('processed_at', urlCutoff);

  if (urlError) {
    console.error('[Cleanup] URL cache cleanup error:', urlError.message);
  } else {
    console.log('[Cleanup] Pruned old processed_urls cache.');
  }

  // 3. Reset trend_scores for articles older than 7 days
  const trendCutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  await supabase
    .from('articles')
    .update({ trend_score: 0 })
    .lt('publish_date', trendCutoff)
    .gt('trend_score', 0);

  // 4. Prune trending_topics last_updated more than 48 hours ago
  const trendingCutoff = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
  await supabase
    .from('trending_topics')
    .delete()
    .lt('last_updated', trendingCutoff);

  console.log('[Cleanup] Daily cleanup complete.');
}

// Allow direct run
if (require.main === module && process.argv.includes('--run')) {
  runCleanup().catch(console.error);
}

module.exports = { runCleanup };
