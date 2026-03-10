'use strict';
/**
 * github-pusher.js
 * Pushes generated static files to GitHub via the REST API.
 * No git CLI required — uses Octokit to create/update file blobs.
 */

const { Octokit } = require('@octokit/rest');
const { config } = require('./config');

let octokit;

function getClient() {
  if (!octokit) {
    octokit = new Octokit({ auth: config.github.token });
  }
  return octokit;
}

const { owner, repo, branch } = config.github;

// ── Startup validation: verify repo exists and token has write access ─────────
async function validateGitHub() {
  const client = getClient();

  // Fail fast if env vars are blank
  if (!owner || !repo || !config.github.token) {
    console.error('[GitHub] MISSING env vars: GITHUB_TOKEN, GITHUB_OWNER, or GITHUB_REPO are empty.');
    console.error(`[GitHub]   GITHUB_OWNER  = "${owner}"`);
    console.error(`[GitHub]   GITHUB_REPO   = "${repo}"`);
    console.error(`[GitHub]   GITHUB_TOKEN  = "${config.github.token ? '***set***' : '(empty)'}"`);
    throw new Error('[GitHub] Configuration incomplete — check Railway env vars.');
  }

  try {
    // Check repo exists and token can read it
    const { data } = await client.repos.get({ owner, repo });
    console.log(`[GitHub] ✓ Repo found: ${data.full_name} (${data.private ? 'private' : 'public'})`);
    console.log(`[GitHub] ✓ Default branch: ${data.default_branch}`);
  } catch (err) {
    if (err.status === 404) {
      console.error(`[GitHub] ✗ Repository NOT FOUND: ${owner}/${repo}`);
      console.error('[GitHub]   Possible causes:');
      console.error(`[GitHub]   1. The repo "${owner}/${repo}" does not exist on GitHub.`);
      console.error('[GitHub]   2. GITHUB_TOKEN does not have access to this private repo.');
      console.error('[GitHub]   3. GITHUB_OWNER is wrong — check it in Railway env vars.');
      console.error(`[GitHub]   4. Token scopes: needs "repo" (full) or "contents: write".`);
    } else if (err.status === 401) {
      console.error('[GitHub] ✗ Authentication failed — GITHUB_TOKEN is invalid or expired.');
    } else {
      console.error(`[GitHub] ✗ Unexpected error checking repo: ${err.message}`);
    }
    throw err;
  }
}

// ── Get current SHA of a file (needed to update it) ──────────────────────────
async function getFileSha(path) {
  try {
    const { data } = await getClient().repos.getContent({ owner, repo, path, ref: branch });
    return data.sha || null;
  } catch (err) {
    if (err.status === 404) return null;
    throw err;
  }
}

// ── Push a single file ────────────────────────────────────────────────────────
async function pushFile(filePath, content, commitMessage) {
  const client = getClient();
  const encoded = Buffer.from(content, 'utf8').toString('base64');
  const sha = await getFileSha(filePath);

  try {
    await client.repos.createOrUpdateFileContents({
      owner,
      repo,
      path: filePath,
      message: commitMessage || `chore: update ${filePath}`,
      content: encoded,
      sha: sha || undefined,
      branch,
    });
    console.log(`[GitHub] Pushed: ${filePath}`);
  } catch (err) {
    console.error(`[GitHub] Failed to push ${filePath}: ${err.message}`);
    throw err;
  }
}

// ── Push multiple files in a single tree commit (batching) ───────────────────
async function pushFiles(files, commitMessage) {
  if (!files.length) return;

  const client = getClient();

  let latestCommitSha;
  let baseTreeSha;

  // Try to get the latest commit SHA for the branch.
  // If the repo is empty (branch doesn't exist yet), bootstrap it.
  try {
    const { data: refData } = await client.git.getRef({ owner, repo, ref: `heads/${branch}` });
    latestCommitSha = refData.object.sha;

    const { data: commitData } = await client.git.getCommit({ owner, repo, commit_sha: latestCommitSha });
    baseTreeSha = commitData.tree.sha;
  } catch (err) {
    if (err.status !== 404) throw err;

    // ── Empty repository: create a root commit to bootstrap the branch ──
    console.log(`[GitHub] Branch '${branch}' not found. Bootstrapping empty repository...`);

    // Create an initial README blob
    const { data: readmeBlob } = await client.git.createBlob({
      owner, repo,
      content: Buffer.from('# The Hidden Reporter\n\nAutomated news publishing.\n', 'utf8').toString('base64'),
      encoding: 'base64',
    });

    // Create a root tree with the README
    const { data: rootTree } = await client.git.createTree({
      owner, repo,
      tree: [{
        path: 'README.md',
        mode: '100644',
        type: 'blob',
        sha: readmeBlob.sha,
      }],
    });

    // Create the initial (root) commit — no parents
    const { data: rootCommit } = await client.git.createCommit({
      owner, repo,
      message: 'chore: initial commit',
      tree: rootTree.sha,
      parents: [],
    });

    // Create the branch reference pointing to the root commit
    await client.git.createRef({
      owner, repo,
      ref: `refs/heads/${branch}`,
      sha: rootCommit.sha,
    });

    console.log(`[GitHub] Branch '${branch}' created at ${rootCommit.sha.slice(0, 8)}.`);

    latestCommitSha = rootCommit.sha;
    baseTreeSha = rootTree.sha;
  }

  // Create blobs for each file
  const treeItems = await Promise.all(
    files.map(async ({ path: filePath, content }) => {
      const { data: blob } = await client.git.createBlob({
        owner, repo,
        content: Buffer.from(content, 'utf8').toString('base64'),
        encoding: 'base64',
      });
      return {
        path: filePath,
        mode: '100644',
        type: 'blob',
        sha: blob.sha,
      };
    })
  );

  // Create new tree
  const { data: newTree } = await client.git.createTree({
    owner, repo,
    base_tree: baseTreeSha,
    tree: treeItems,
  });

  // Create commit
  const { data: newCommit } = await client.git.createCommit({
    owner, repo,
    message: commitMessage || 'chore: automated content update',
    tree: newTree.sha,
    parents: [latestCommitSha],
  });

  // Update branch reference
  await client.git.updateRef({
    owner, repo,
    ref: `heads/${branch}`,
    sha: newCommit.sha,
    force: false,
  });

  console.log(`[GitHub] Batch commit: ${files.length} files → ${newCommit.sha.slice(0, 8)}`);
}

module.exports = { pushFile, pushFiles, validateGitHub };
