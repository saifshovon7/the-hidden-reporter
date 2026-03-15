'use strict';
/**
 * duplicate-detector.js
 * Checks for duplicate articles via:
 *   1. Exact source URL match (database)
 *   2. Headline similarity (Levenshtein / Jaro-Winkler)
 *   3. Content fingerprint (simple hash)
 */

const { createClient } = require('@supabase/supabase-js');
const natural = require('natural');
const { config } = require('./config');

const supabase = createClient(config.supabase.url, config.supabase.serviceKey);
const JaroWinkler = natural.JaroWinklerDistance;

// ── Simple string hash ────────────────────────────────────────────────────────
function hashString(str) {
  let hash = 5381;
  for (let i = 0; i < str.length; i++) {
    hash = (hash * 33) ^ str.charCodeAt(i);
  }
  return (hash >>> 0).toString(16);
}

// ── Normalize title for comparison ───────────────────────────────────────────
function normalizeTitle(title) {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// ── 1. URL duplicate check ─────────────────────────────────────────────────────
async function isUrlDuplicate(sourceUrl) {
  const { data, error } = await supabase
    .from('articles')
    .select('id')
    .eq('source_url', sourceUrl)
    .maybeSingle();

  if (error) {
    console.error('[DuplicateDetector] URL check error:', error.message);
    return false;
  }
  return Boolean(data);
}

// ── 2. Headline similarity check ──────────────────────────────────────────────
async function isTitleDuplicate(title, threshold = 0.92) {
  const normalized = normalizeTitle(title);

  // Fetch recent titles (last 7 days) to compare
  const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const { data, error } = await supabase
    .from('articles')
    .select('title')
    .gte('publish_date', since)
    .order('publish_date', { ascending: false })
    .limit(500);

  if (error) {
    console.error('[DuplicateDetector] Title check error:', error.message);
    return false;
  }

  for (const row of (data || [])) {
    const existing = normalizeTitle(row.title);
    const similarity = JaroWinkler(normalized, existing);
    if (similarity >= threshold) {
      console.log(`[DuplicateDetector] Similar title found (${(similarity * 100).toFixed(1)}%): "${row.title}"`);
      return true;
    }
  }
  return false;
}

// ── 3. Content fingerprint check ─────────────────────────────────────────────
async function isContentDuplicate(content) {
  const plainText = content.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

  // Use first 500 chars as a fingerprint
  const fingerprint = hashString(plainText.slice(0, 500));

  // We store the fingerprint in the slug field as part of the slug for lookup
  // Actually let's just check summaries — content hash is stored nowhere yet.
  // This is a lightweight check against the first paragraph.
  const firstParagraph = plainText.slice(0, 200);
  const { data, error } = await supabase
    .from('articles')
    .select('id')
    .ilike('content', `%${firstParagraph.slice(0, 100)}%`)
    .limit(1);

  if (error) return false;
  return Boolean(data?.length);
}

// ── Main duplicate check ──────────────────────────────────────────────────────
// Two checks are sufficient:
//   1. Exact source URL (covers same article from same source)
//   2. Title similarity ≥ 92% Jaro-Winkler (covers same story reposted under slightly different headline)
// Content fingerprint via ILIKE was removed — it performed a full table scan
// on the TEXT content column, creating O(n) DB cost per article processed.
async function isDuplicate(sourceUrl, title) {
  // Check 1: Exact URL
  if (await isUrlDuplicate(sourceUrl)) {
    console.log(`[DuplicateDetector] URL duplicate: ${sourceUrl}`);
    return true;
  }

  // Check 2: Title similarity
  if (await isTitleDuplicate(title)) {
    return true;
  }

  return false;
}

module.exports = { isDuplicate };
