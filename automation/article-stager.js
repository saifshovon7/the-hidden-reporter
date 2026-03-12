'use strict';
/**
 * article-stager.js
 * In-memory staging buffer for generated files before pushing to GitHub.
 *
 * Files are accumulated in a batch. When the batch reaches MAX_ARTICLES_PER_BATCH,
 * it is automatically flushed via a single GitHub tree commit. The pipeline also
 * calls flush() at the end of each run to push any remaining files.
 *
 * New exports:
 *   getStagedFiles()   — returns current staged files array (for merged commits)
 *   clearStagedFiles() — clears the buffer after a successful external push
 */

const { config } = require('./config');
const { pushFiles } = require('./github-pusher');

const MAX_BATCH = config.publishing.batchSizeThreshold || config.publishing.maxArticlesPerBatch || 5;

// ── In-memory staged files ────────────────────────────────────────────────────
// Each entry: { path: string, content: string, encoding?: string }
// Files with the same path are deduplicated (last write wins).
const stagedFiles = new Map();

// Track how many articles have been staged (for threshold logic)
let stagedArticleCount = 0;

// ── Stage files for a single article ─────────────────────────────────────────
/**
 * Add files to the staging buffer.
 * @param {Array<{path: string, content: string, encoding?: string}>} files
 * @param {boolean} isArticle - If true, increments the article counter
 * @returns {Promise<void>} Resolves after auto-flush if threshold was hit
 */
async function stageFiles(files, isArticle = true) {
  for (const file of files) {
    stagedFiles.set(file.path, {
      path: file.path,
      content: file.content,
      encoding: file.encoding || null,
    });
  }

  if (isArticle) {
    stagedArticleCount++;
    console.log(`[Stager] Staged article ${stagedArticleCount}/${MAX_BATCH} (${stagedFiles.size} files buffered)`);
  }

  // NOTE: Auto-flush removed intentionally.
  // Previously stageFiles() called flush() directly when the threshold was hit,
  // bypassing the deployment scheduler's hourly cap + min-interval guards.
  // All deployment decisions are now exclusively made by startDeploymentScheduler()
  // in article-queue.js, which checks every 5 minutes and respects all rate limits.
  // The scheduler will trigger deployBatch() when: articles >= MAX_BATCH OR interval elapsed.
}

// ── Flush all staged files to GitHub ─────────────────────────────────────────
/**
 * Push all staged files to GitHub in a single tree commit, then clear the buffer.
 * @param {string} commitMessage
 * @returns {Promise<void>}
 */
async function flush(commitMessage = 'feat: batch publish articles') {
  if (stagedFiles.size === 0) {
    console.log('[Stager] Nothing to flush.');
    return;
  }

  const files = [];
  for (const [, fileObj] of stagedFiles) {
    const entry = { path: fileObj.path, content: fileObj.content };
    if (fileObj.encoding) entry.encoding = fileObj.encoding;
    files.push(entry);
  }

  console.log(`[Stager] Flushing ${files.length} files (${stagedArticleCount} articles) to GitHub…`);

  try {
    await pushFiles(files, commitMessage);
    console.log(`[Stager] Flush complete: ${files.length} files committed.`);
  } catch (err) {
    console.error(`[Stager] Flush error: ${err.message}`);
    // Don't clear the buffer on error — allows retry on next flush
    throw err;
  }

  // Clear buffer on success
  stagedFiles.clear();
  stagedArticleCount = 0;
}

// ── Return all staged files as an array (for merged external commits) ─────────
function getStagedFiles() {
  const files = [];
  for (const [, fileObj] of stagedFiles) {
    const entry = { path: fileObj.path, content: fileObj.content };
    if (fileObj.encoding) entry.encoding = fileObj.encoding;
    files.push(entry);
  }
  return files;
}

// ── Clear staged buffer without pushing (called after external merged commit) ─
function clearStagedFiles() {
  stagedFiles.clear();
  stagedArticleCount = 0;
  console.log('[Stager] Buffer cleared (merged external commit).');
}

// ── Check if a flush should happen ────────────────────────────────────────────
function shouldFlush() {
  return stagedArticleCount >= MAX_BATCH;
}

// ── Get current batch stats ───────────────────────────────────────────────────
function getPendingCount() {
  return { articles: stagedArticleCount, files: stagedFiles.size };
}

module.exports = { stageFiles, flush, shouldFlush, getPendingCount, getStagedFiles, clearStagedFiles };
