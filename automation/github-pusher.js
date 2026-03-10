'use strict';
/**
 * github-pusher.js
 * Pushes generated static files to GitHub via the REST API.
 *
 * Protection systems:
 *   ① Rate-limit checker  — reads headers + /rate_limit; pauses when < threshold
 *   ② Request throttle    — enforces MIN_DELAY_MS between every API call
 *   ③ Sequential queue    — all operations serialised through a single queue
 *   ④ Repo metadata cache — avoids repeated repo-info lookups (10 min TTL)
 *   ⑤ File content cache  — skips pushes when content is unchanged (local SHA)
 *   ⑥ Exponential backoff — retries on 429 / rate-limit errors
 *   ⑦ Commit-rate guard   — max N commits per rolling 60-minute window
 *   ⑧ Session stats       — logs total API calls per session
 */

const crypto = require('crypto');
const { Octokit } = require('@octokit/rest');
const { config } = require('./config');

// ─────────────────────────────────────────────────────────────────────────────
// Constants (from config, with fallbacks)
// ─────────────────────────────────────────────────────────────────────────────
const SAFE_THRESHOLD = config.github.safeThreshold || 100;
const MIN_DELAY_MS = config.github.minDelayMs || 2000;
const MAX_COMMITS_HR = config.github.maxCommitsPerHour || 20;
const REPO_CACHE_TTL = 10 * 60 * 1000;     // 10 minutes
const MAX_BACKOFF_MS = 16 * 60 * 1000;     // 16-minute max backoff

// ─────────────────────────────────────────────────────────────────────────────
// State
// ─────────────────────────────────────────────────────────────────────────────
let octokit;

// Throttle: timestamp of last API call
let lastCallTime = 0;

// Rate-limit state (updated from response headers — no extra API call needed)
let rateLimitRemaining = null;   // remaining requests
let rateLimitReset = null;   // epoch seconds when limit resets

// Repo metadata cache
let repoCache = null;
let repoCacheAt = 0;

// File SHA cache  { filePath → sha }
const fileShaCache = new Map();

// Commit-rate guard: ring buffer of commit timestamps (ms)
const commitTimestamps = [];

// Sequential queue — uses isolated promise chain
let queueTail = Promise.resolve();

// ⑧ Session stats
let sessionApiCalls = 0;
let sessionSkipped = 0;
let sessionStart = Date.now();

// ─────────────────────────────────────────────────────────────────────────────
// Octokit client (with response hook to read rate-limit headers)
// ─────────────────────────────────────────────────────────────────────────────
function getClient() {
  if (!octokit) {
    octokit = new Octokit({ auth: config.github.token });

    // ① Hook: extract rate-limit info from every response header
    octokit.hook.after('request', (response) => {
      const headers = response.headers || {};
      const rem = headers['x-ratelimit-remaining'];
      const rst = headers['x-ratelimit-reset'];
      if (rem !== undefined) {
        rateLimitRemaining = parseInt(rem, 10);
        rateLimitReset = parseInt(rst, 10);
      }
    });
  }
  return octokit;
}

const { owner, repo, branch } = config.github;

// ─────────────────────────────────────────────────────────────────────────────
// ⑧ — Git blob SHA helper (compute locally, no API call)
//    Git blob SHA = SHA1("blob <byteLength>\0<content>")
// ─────────────────────────────────────────────────────────────────────────────
function gitBlobSha(content) {
  const buf = Buffer.from(content, 'utf8');
  const header = `blob ${buf.length}\0`;
  return crypto
    .createHash('sha1')
    .update(header)
    .update(buf)
    .digest('hex');
}

// ─────────────────────────────────────────────────────────────────────────────
// ① + ② — Rate-limit check + per-call throttle
//    Every API call MUST go through this before executing.
// ─────────────────────────────────────────────────────────────────────────────
async function preCallGuard(label = 'request') {
  // Throttle: enforce MIN_DELAY_MS between calls
  const now = Date.now();
  const waited = now - lastCallTime;
  if (waited < MIN_DELAY_MS) {
    await sleep(MIN_DELAY_MS - waited);
  }

  // If we've never seen rate-limit data yet (first call), do a one-time fetch
  if (rateLimitRemaining === null) {
    try {
      const { data } = await getClient().rateLimit.get();
      rateLimitRemaining = data.rate.remaining;
      rateLimitReset = data.rate.reset;
      console.log(`[GitHub] Rate limit remaining: ${rateLimitRemaining}/${data.rate.limit}`);
    } catch (_) {
      // If /rate_limit itself fails, proceed cautiously
    }
  }

  // Check if we need to pause
  if (rateLimitRemaining !== null && rateLimitRemaining < SAFE_THRESHOLD) {
    const resetMs = (rateLimitReset || 0) * 1000;
    const waitMs = Math.max(0, resetMs - Date.now()) + 5000; // +5s buffer
    const waitMins = (waitMs / 60000).toFixed(1);
    console.log(`[GitHub] Pausing requests — rate limit low (${rateLimitRemaining} remaining). Resuming in ${waitMins} min.`);
    await sleep(waitMs);
    // Force re-read on next call
    rateLimitRemaining = null;
    rateLimitReset = null;
  }

  lastCallTime = Date.now();
  sessionApiCalls++;
  console.log(`[GitHub] Request executing: ${label}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// ③ — Sequential queue wrapper (error-isolated)
//    Ensures no two pushFile/pushFiles calls run concurrently.
//    A failed task does NOT break the chain for subsequent tasks.
// ─────────────────────────────────────────────────────────────────────────────
function enqueue(label, fn) {
  console.log(`[GitHub] Queueing request: ${label}`);
  const task = queueTail.then(() => fn()).catch(err => {
    console.error(`[GitHub] Queue error (${label}): ${err.message}`);
    // Return undefined instead of re-throwing — isolates failure
    // so the next queued task can still execute.
  });
  queueTail = task;
  return task;
}

// ─────────────────────────────────────────────────────────────────────────────
// ⑥ — Exponential backoff wrapper for a single API operation
// ─────────────────────────────────────────────────────────────────────────────
async function withBackoff(fn, label = 'op') {
  let delay = 60_000; // 1 minute
  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const isRateLimit = err.status === 429 ||
        err.status === 403 ||
        (err.message && err.message.toLowerCase().includes('rate limit'));

      if (isRateLimit && attempt < 5) {
        console.error(`[GitHub] Rate limit hit on "${label}". Backoff ${Math.round(delay / 60000)} min (attempt ${attempt}/5).`);
        await sleep(Math.min(delay, MAX_BACKOFF_MS));
        delay *= 2;
        // Force re-read of rate limit
        rateLimitRemaining = null;
        rateLimitReset = null;
      } else {
        throw err;
      }
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// ⑦ — Commit-rate guard  (max MAX_COMMITS_HR per rolling hour)
// ─────────────────────────────────────────────────────────────────────────────
async function commitRateGuard() {
  const now = Date.now();
  const oneHourAgo = now - 60 * 60 * 1000;

  // Prune old timestamps
  while (commitTimestamps.length && commitTimestamps[0] < oneHourAgo) {
    commitTimestamps.shift();
  }

  if (commitTimestamps.length >= MAX_COMMITS_HR) {
    const oldestInWindow = commitTimestamps[0];
    const waitMs = (oldestInWindow + 60 * 60 * 1000) - now + 1000;
    const waitMins = (waitMs / 60000).toFixed(1);
    console.log(`[GitHub] Commit-rate limit reached (${MAX_COMMITS_HR}/hr). Waiting ${waitMins} min.`);
    await sleep(waitMs);
  }

  commitTimestamps.push(Date.now());
}

// ─────────────────────────────────────────────────────────────────────────────
// ④ — Repo metadata cache
// ─────────────────────────────────────────────────────────────────────────────
async function getRepoMeta() {
  if (repoCache && (Date.now() - repoCacheAt) < REPO_CACHE_TTL) {
    return repoCache;
  }
  await preCallGuard('repos.get');
  const { data } = await withBackoff(
    () => getClient().repos.get({ owner, repo }),
    'repos.get'
  );
  repoCache = data;
  repoCacheAt = Date.now();
  console.log(`[GitHub] Repo cache refreshed: ${data.full_name}`);
  return data;
}

// ─────────────────────────────────────────────────────────────────────────────
// ⑤ — File SHA helper (with local cache)
// ─────────────────────────────────────────────────────────────────────────────
async function getFileSha(path) {
  // Cache hit
  if (fileShaCache.has(path)) {
    return fileShaCache.get(path);
  }
  try {
    await preCallGuard(`getContent(${path})`);
    const { data } = await withBackoff(
      () => getClient().repos.getContent({ owner, repo, path, ref: branch }),
      `getContent(${path})`
    );
    const sha = data.sha || null;
    fileShaCache.set(path, sha);
    return sha;
  } catch (err) {
    if (err.status === 404) {
      fileShaCache.set(path, null);
      return null;
    }
    throw err;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Startup validator — exported for index.js to call at boot
// ─────────────────────────────────────────────────────────────────────────────
async function validateGitHub() {
  const { token } = config.github;
  if (!owner || !repo || !token) {
    console.error('[GitHub] MISSING env vars:');
    console.error(`[GitHub]   GITHUB_OWNER = "${owner}"`);
    console.error(`[GitHub]   GITHUB_REPO  = "${repo}"`);
    console.error(`[GitHub]   GITHUB_TOKEN = "${token ? '***set***' : '(empty)'}"`);
    throw new Error('[GitHub] Configuration incomplete — check Railway env vars.');
  }

  try {
    const data = await getRepoMeta();
    console.log(`[GitHub] ✓ Repo found: ${data.full_name} (${data.private ? 'private' : 'public'})`);
    console.log(`[GitHub] ✓ Default branch: ${data.default_branch}`);
    console.log(`[GitHub] ✓ Rate-limit protection active (threshold: ${SAFE_THRESHOLD}, delay: ${MIN_DELAY_MS}ms, max commits/hr: ${MAX_COMMITS_HR})`);
  } catch (err) {
    if (err.status === 404) {
      console.error(`[GitHub] ✗ Repository NOT FOUND: ${owner}/${repo}`);
      console.error('[GitHub]   1. Repo does not exist, OR');
      console.error('[GitHub]   2. Token has no access, OR');
      console.error('[GitHub]   3. GITHUB_OWNER is wrong.');
      console.error('[GitHub]   Token needs: repo (full) scope or Contents: Read+Write.');
    } else if (err.status === 401) {
      console.error('[GitHub] ✗ Auth failed — GITHUB_TOKEN is invalid or expired.');
    } else {
      console.error(`[GitHub] ✗ Unexpected error checking repo: ${err.message}`);
    }
    throw err;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Push a single file (used by daily-maintenance sitemap push)
// ─────────────────────────────────────────────────────────────────────────────
async function pushFile(filePath, content, commitMessage) {
  return enqueue(`pushFile(${filePath})`, async () => {
    // ⑤ Check if content is unchanged before doing anything
    const cachedSha = fileShaCache.get(filePath);
    if (cachedSha) {
      const localSha = gitBlobSha(content);
      if (localSha === cachedSha) {
        console.log(`[GitHub] Skipping unchanged: ${filePath}`);
        sessionSkipped++;
        return;
      }
    }

    await preCallGuard(`pushFile(${filePath})`);

    const encoded = Buffer.from(content, 'utf8').toString('base64');
    const sha = await getFileSha(filePath);

    await withBackoff(async () => {
      await preCallGuard(`createOrUpdateFile(${filePath})`);
      const { data } = await getClient().repos.createOrUpdateFileContents({
        owner, repo,
        path: filePath,
        message: commitMessage || `chore: update ${filePath}`,
        content: encoded,
        sha: sha || undefined,
        branch,
      });
      // Store the new SHA in cache
      if (data && data.content && data.content.sha) {
        fileShaCache.set(filePath, data.content.sha);
      } else {
        fileShaCache.delete(filePath);
      }
    }, `createOrUpdateFile(${filePath})`);

    logRateLimit();
    console.log(`[GitHub] Pushed: ${filePath}`);
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Push multiple files in a single tree commit (main batch operation)
// ─────────────────────────────────────────────────────────────────────────────
async function pushFiles(files, commitMessage) {
  if (!files.length) return;

  return enqueue(`pushFiles(${files.length} files)`, async () => {
    await commitRateGuard();

    const client = getClient();
    let latestCommitSha;
    let baseTreeSha;

    // ── Get or bootstrap the branch ──────────────────────────────────────
    try {
      await preCallGuard('git.getRef');
      const { data: refData } = await withBackoff(
        () => client.git.getRef({ owner, repo, ref: `heads/${branch}` }),
        'git.getRef'
      );
      latestCommitSha = refData.object.sha;

      await preCallGuard('git.getCommit');
      const { data: commitData } = await withBackoff(
        () => client.git.getCommit({ owner, repo, commit_sha: latestCommitSha }),
        'git.getCommit'
      );
      baseTreeSha = commitData.tree.sha;

    } catch (err) {
      if (err.status !== 404) throw err;

      // Empty repo — bootstrap
      console.log(`[GitHub] Branch '${branch}' not found. Bootstrapping empty repository...`);

      await preCallGuard('git.createBlob(README)');
      const { data: readmeBlob } = await withBackoff(
        () => client.git.createBlob({
          owner, repo,
          content: Buffer.from('# The Hidden Reporter\n\nAutomated news publishing.\n', 'utf8').toString('base64'),
          encoding: 'base64',
        }),
        'git.createBlob(README)'
      );

      await preCallGuard('git.createTree(root)');
      const { data: rootTree } = await withBackoff(
        () => client.git.createTree({
          owner, repo,
          tree: [{ path: 'README.md', mode: '100644', type: 'blob', sha: readmeBlob.sha }],
        }),
        'git.createTree(root)'
      );

      await preCallGuard('git.createCommit(initial)');
      const { data: rootCommit } = await withBackoff(
        () => client.git.createCommit({
          owner, repo,
          message: 'chore: initial commit',
          tree: rootTree.sha,
          parents: [],
        }),
        'git.createCommit(initial)'
      );

      await preCallGuard('git.createRef');
      await withBackoff(
        () => client.git.createRef({
          owner, repo,
          ref: `refs/heads/${branch}`,
          sha: rootCommit.sha,
        }),
        'git.createRef'
      );

      console.log(`[GitHub] Branch '${branch}' created at ${rootCommit.sha.slice(0, 8)}.`);
      latestCommitSha = rootCommit.sha;
      baseTreeSha = rootTree.sha;
    }

    // ── ⑤ Filter out files whose content has not changed ─────────────────
    const changedFiles = [];
    for (const file of files) {
      const cachedSha = fileShaCache.get(file.path);
      if (cachedSha) {
        const localSha = gitBlobSha(file.content);
        if (localSha === cachedSha) {
          console.log(`[GitHub] Skipping unchanged: ${file.path}`);
          sessionSkipped++;
          continue;
        }
      }
      changedFiles.push(file);
    }

    if (!changedFiles.length) {
      console.log('[GitHub] All files unchanged — skipping commit.');
      return;
    }

    // ── Create blobs ──────────────────────────────────────────────────────
    const treeItems = [];
    for (const { path: filePath, content } of changedFiles) {
      await preCallGuard(`git.createBlob(${filePath})`);
      const { data: blob } = await withBackoff(
        () => client.git.createBlob({
          owner, repo,
          content: Buffer.from(content, 'utf8').toString('base64'),
          encoding: 'base64',
        }),
        `git.createBlob(${filePath})`
      );
      treeItems.push({ path: filePath, mode: '100644', type: 'blob', sha: blob.sha });
      // Store blob SHA in cache for future change detection
      fileShaCache.set(filePath, blob.sha);
    }

    // ── Create tree ───────────────────────────────────────────────────────
    await preCallGuard('git.createTree');
    const { data: newTree } = await withBackoff(
      () => client.git.createTree({ owner, repo, base_tree: baseTreeSha, tree: treeItems }),
      'git.createTree'
    );

    // ── Create commit ─────────────────────────────────────────────────────
    await preCallGuard('git.createCommit');
    const { data: newCommit } = await withBackoff(
      () => client.git.createCommit({
        owner, repo,
        message: commitMessage || 'chore: automated content update',
        tree: newTree.sha,
        parents: [latestCommitSha],
      }),
      'git.createCommit'
    );

    // ── Update branch ref ─────────────────────────────────────────────────
    await preCallGuard('git.updateRef');
    await withBackoff(
      () => client.git.updateRef({ owner, repo, ref: `heads/${branch}`, sha: newCommit.sha, force: false }),
      'git.updateRef'
    );

    logRateLimit();
    console.log(`[GitHub] Batch commit: ${changedFiles.length} files → ${newCommit.sha.slice(0, 8)}`);
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// ⑧ — Log session stats + current rate limit
// ─────────────────────────────────────────────────────────────────────────────
function logRateLimit() {
  if (rateLimitRemaining !== null) {
    console.log(`[GitHub] Rate limit remaining: ${rateLimitRemaining}`);
  }
}

function logSessionStats() {
  const elapsed = ((Date.now() - sessionStart) / 1000 / 60).toFixed(1);
  console.log(`[GitHub] Session stats — API calls: ${sessionApiCalls}, skipped (unchanged): ${sessionSkipped}, uptime: ${elapsed} min`);
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

module.exports = { pushFile, pushFiles, validateGitHub, logSessionStats };
