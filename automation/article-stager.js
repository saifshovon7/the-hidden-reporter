'use strict';
/**
 * article-stager.js
 * In-memory staging buffer for generated files before pushing to GitHub.
 *
 * Instead of pushing each article individually, files are accumulated in a
 * batch. When the batch reaches MAX_ARTICLES_PER_BATCH, it is automatically
 * flushed via a single GitHub tree commit. The pipeline also calls flush()
 * at the end of each run to push any remaining files.
 *
 * This drastically reduces GitHub API usage by combining many file changes
 * into one commit instead of one commit per article.
 */

const { config } = require('./config');
const { pushFiles } = require('./github-pusher');

const MAX_BATCH = config.publishing.maxArticlesPerBatch || 10;

// ── In-memory staged files ────────────────────────────────────────────────────
// Each entry: { path: string, content: string }
// Files with the same path are deduplicated (last write wins).
const stagedFiles = new Map();

// Track how many articles have been staged (for threshold logic)
let stagedArticleCount = 0;

// ── Stage files for a single article ──────────────────────────────────────────
/**
 * Add files to the staging buffer.
 * @param {Array<{path: string, content: string}>} files - Files to stage
 * @param {boolean} isArticle - If true, increments the article counter
 * @returns {Promise<void>} Resolves after auto-flush if threshold was hit
 */
async function stageFiles(files, isArticle = true) {
    for (const file of files) {
        // Store the FULL file object (path, content, AND encoding) so binary
        // image files don't lose their `encoding: 'base64'` flag on flush.
        stagedFiles.set(file.path, { path: file.path, content: file.content, encoding: file.encoding || null });
    }

    if (isArticle) {
        stagedArticleCount++;
        console.log(`[Stager] Staged article ${stagedArticleCount}/${MAX_BATCH} (${stagedFiles.size} files buffered)`);
    }

    // Auto-flush when batch threshold is reached
    if (stagedArticleCount >= MAX_BATCH) {
        console.log(`[Stager] Batch threshold reached (${MAX_BATCH}). Auto-flushing...`);
        await flush(`feat: batch publish ${stagedArticleCount} articles`);
    }
}

// ── Flush all staged files to GitHub ──────────────────────────────────────────
/**
 * Push all staged files to GitHub in a single tree commit, then clear the buffer.
 * @param {string} commitMessage - Git commit message
 * @returns {Promise<void>}
 */
async function flush(commitMessage = 'feat: batch publish articles') {
    if (stagedFiles.size === 0) {
        console.log('[Stager] Nothing to flush.');
        return;
    }

    const files = [];
    for (const [, fileObj] of stagedFiles) {
        // Reconstruct file entry preserving optional `encoding` for binary files
        const entry = { path: fileObj.path, content: fileObj.content };
        if (fileObj.encoding) entry.encoding = fileObj.encoding;
        files.push(entry);
    }

    console.log(`[Stager] Flushing ${files.length} files (${stagedArticleCount} articles) to GitHub...`);

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

// ── Check if a flush should happen ────────────────────────────────────────────
function shouldFlush() {
    return stagedArticleCount >= MAX_BATCH;
}

// ── Get current batch stats ───────────────────────────────────────────────────
function getPendingCount() {
    return { articles: stagedArticleCount, files: stagedFiles.size };
}

module.exports = { stageFiles, flush, shouldFlush, getPendingCount };
