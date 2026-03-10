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

module.exports = { pushFile, pushFiles };
