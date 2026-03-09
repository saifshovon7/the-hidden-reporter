'use strict';
/**
 * trending-detector.js
 * Detects trending topics based on keyword frequency, source count,
 * and publication recency. Updates the trending_topics table.
 */

const { createClient } = require('@supabase/supabase-js');
const { config } = require('./config');

const supabase = createClient(config.supabase.url, config.supabase.serviceKey);

// Common words to exclude from keyword analysis
const STOP_WORDS = new Set([
  'the','a','an','and','or','but','in','on','at','to','for','of','with',
  'by','from','is','was','are','were','be','been','being','have','has','had',
  'do','does','did','will','would','could','should','may','might','shall',
  'this','that','these','those','it','its','he','she','they','we','you','i',
  'not','as','if','so','up','out','about','into','after','before','between',
  'over','under','through','during','new','more','most','also','their','our',
  'his','her','than','then','now','just','said','says','say','news','report',
  'officials','government','according','told','amid','after','while',
]);

// ── Tokenize text to significant keywords ─────────────────────────────────────
function tokenize(text) {
  return text
    .toLowerCase()
    .replace(/[^a-z\s]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length >= 4 && !STOP_WORDS.has(w));
}

// ── Extract bigrams (two-word phrases) ───────────────────────────────────────
function bigrams(tokens) {
  const pairs = [];
  for (let i = 0; i < tokens.length - 1; i++) {
    pairs.push(`${tokens[i]} ${tokens[i + 1]}`);
  }
  return pairs;
}

// ── Recency weight: newer articles score higher ───────────────────────────────
function recencyWeight(publishDate) {
  const hoursAgo = (Date.now() - new Date(publishDate).getTime()) / 3_600_000;
  return Math.max(0, 1 - hoursAgo / 48); // Decays to 0 over 48 hours
}

// ── Main: analyse recent articles and update trending_topics ─────────────────
async function updateTrending() {
  console.log('[Trending] Analysing recent articles...');

  // Fetch articles from last 24 hours
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const { data: articles, error } = await supabase
    .from('articles')
    .select('title, summary, tags, publish_date, category')
    .gte('publish_date', since);

  if (error || !articles?.length) {
    console.log('[Trending] No recent articles to analyse.');
    return;
  }

  // Count keyword + bigram frequencies weighted by recency
  const freq = {};

  for (const article of articles) {
    const text   = `${article.title} ${article.summary || ''}`;
    const weight = recencyWeight(article.publish_date);
    const tokens = tokenize(text);
    const phrases = [...tokens, ...bigrams(tokens)];

    for (const phrase of phrases) {
      if (!freq[phrase]) freq[phrase] = { count: 0, score: 0, articles: 0 };
      freq[phrase].count   += 1;
      freq[phrase].score   += weight;
      freq[phrase].articles += 1;
    }

    // Also count tags directly
    for (const tag of (article.tags || [])) {
      const t = tag.toLowerCase();
      if (!freq[t]) freq[t] = { count: 0, score: 0, articles: 0 };
      freq[t].count   += 3; // Tags weighted higher
      freq[t].score   += weight * 3;
      freq[t].articles += 1;
    }
  }

  // Sort by score and take top 20
  const sorted = Object.entries(freq)
    .filter(([, v]) => v.articles >= 2) // Must appear in at least 2 articles
    .sort(([, a], [, b]) => b.score - a.score)
    .slice(0, 20);

  if (!sorted.length) {
    console.log('[Trending] Not enough cross-source topics yet.');
    return;
  }

  // Upsert trending_topics
  const upsertData = sorted.map(([topic, v]) => ({
    topic,
    keyword:       topic,
    article_count: v.articles,
    trend_score:   parseFloat(v.score.toFixed(4)),
    last_updated:  new Date().toISOString(),
  }));

  const { error: upsertError } = await supabase
    .from('trending_topics')
    .upsert(upsertData, { onConflict: 'topic' });

  if (upsertError) {
    console.error('[Trending] Upsert error:', upsertError.message);
  } else {
    console.log(`[Trending] Updated ${upsertData.length} trending topics.`);
  }

  // Also update trend_score on articles
  for (const [topic, v] of sorted.slice(0, 5)) {
    await supabase
      .from('articles')
      .update({ trend_score: v.score })
      .ilike('title', `%${topic}%`)
      .gte('publish_date', since);
  }
}

// ── Fetch top 5 trending topics ───────────────────────────────────────────────
async function getTopTrending(limit = 5) {
  const { data, error } = await supabase
    .from('trending_topics')
    .select('topic, article_count, trend_score')
    .order('trend_score', { ascending: false })
    .limit(limit);

  if (error) return [];
  return data || [];
}

module.exports = { updateTrending, getTopTrending };
