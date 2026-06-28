const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const fs = require('node:fs/promises');
const path = require('node:path');
const workspace = require('./workspace-service');

const execFileAsync = promisify(execFile);

function validateRepositoryUrl(value) {
  const url = String(value || '').trim();
  if (!url || url.length > 500) throw Object.assign(new Error('Repository URL is required.'), { status: 400 });
  if (/^https:\/\//i.test(url)) {
    const parsed = new URL(url);
    if (parsed.username || parsed.password) throw Object.assign(new Error('Credentials must not be embedded in the repository URL.'), { status: 400 });
    return url;
  }
  if (/^git@[A-Za-z0-9.-]+:[A-Za-z0-9_./-]+(?:\.git)?$/.test(url)) return url;
  throw Object.assign(new Error('Only HTTPS or SSH Git repository URLs are supported.'), { status: 400 });
}

function safeBranch(value) {
  const branch = String(value || 'main');
  if (!/^[A-Za-z0-9._/-]{1,200}$/.test(branch) || branch.includes('..') || branch.startsWith('-')) {
    throw Object.assign(new Error('Invalid Git branch name.'), { status: 400 });
  }
  return branch;
}

async function git(cwd, args, options = {}) {
  const result = await execFileAsync(process.env.GIT_PATH || 'git', args, {
    cwd,
    timeout: options.timeout || 120_000,
    maxBuffer: options.maxBuffer || 20 * 1024 * 1024,
    encoding: 'utf8',
    windowsHide: true,
    env: {
      ...process.env,
      GIT_TERMINAL_PROMPT: '0',
      GIT_SSH_COMMAND: process.env.GIT_SSH_COMMAND || 'ssh -o BatchMode=yes -o StrictHostKeyChecking=yes'
    }
  });
  return `${result.stdout || ''}${result.stderr || ''}`.trim();
}

async function isRepository(directory) {
  try {
    return (await git(directory, ['rev-parse', '--is-inside-work-tree'], { timeout: 15_000 })) === 'true';
  } catch {
    return false;
  }
}

async function cloneIntoWorkspace(userId, workspaceId, repositoryUrl, branch = 'main') {
  const target = workspace.workspaceDir(userId, workspaceId);
  const url = validateRepositoryUrl(repositoryUrl);
  const selectedBranch = safeBranch(branch);
  const entries = await fs.readdir(target).catch(() => []);
  if (entries.length) throw Object.assign(new Error('Workspace must be empty before cloning.'), { status: 409 });
  await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  await git(path.dirname(target), ['clone', '--depth', '50', '--branch', selectedBranch, '--single-branch', '--', url, path.basename(target)], { timeout: 10 * 60_000, maxBuffer: 50 * 1024 * 1024 });
  return status(userId, workspaceId);
}

async function status(userId, workspaceId) {
  const cwd = workspace.workspaceDir(userId, workspaceId);
  if (!(await isRepository(cwd))) return { repository: false, branch: null, changes: [], remote: null };
  const [branch, porcelain, remote] = await Promise.all([
    git(cwd, ['branch', '--show-current'], { timeout: 15_000 }),
    git(cwd, ['status', '--porcelain=v1', '--untracked-files=all'], { timeout: 30_000 }),
    git(cwd, ['remote', 'get-url', 'origin'], { timeout: 15_000 }).catch(() => '')
  ]);
  return {
    repository: true,
    branch,
    changes: porcelain ? porcelain.split(/\r?\n/).filter(Boolean).slice(0, 5000) : [],
    remote: remote.replace(/https:\/\/[^/@]+@/i, 'https://') || null
  };
}

async function pull(userId, workspaceId, branch = null) {
  const cwd = workspace.workspaceDir(userId, workspaceId);
  if (!(await isRepository(cwd))) throw Object.assign(new Error('Workspace is not a Git repository.'), { status: 409 });
  const selected = branch ? safeBranch(branch) : await git(cwd, ['branch', '--show-current']);
  const output = await git(cwd, ['pull', '--ff-only', 'origin', selected], { timeout: 10 * 60_000, maxBuffer: 50 * 1024 * 1024 });
  return { output, status: await status(userId, workspaceId) };
}

async function log(userId, workspaceId, limit = 50) {
  const cwd = workspace.workspaceDir(userId, workspaceId);
  if (!(await isRepository(cwd))) return [];
  const count = Math.max(1, Math.min(200, Number(limit || 50)));
  const output = await git(cwd, ['log', `-${count}`, '--date=iso-strict', '--pretty=format:%H%x1f%an%x1f%ae%x1f%ad%x1f%s']);
  return output.split(/\r?\n/).filter(Boolean).map((line) => {
    const [sha, author, email, date, subject] = line.split('\x1f');
    return { sha, author, email, date, subject };
  });
}

async function commit(userId, workspaceId, input = {}) {
  const cwd = workspace.workspaceDir(userId, workspaceId);
  if (!(await isRepository(cwd))) throw Object.assign(new Error('Workspace is not a Git repository.'), { status: 409 });
  const message = String(input.message || '').trim().slice(0, 500);
  const name = String(input.authorName || '').trim().slice(0, 120);
  const email = String(input.authorEmail || '').trim().slice(0, 320);
  if (!message) throw Object.assign(new Error('Commit message is required.'), { status: 400 });
  if (!name || !email.includes('@')) throw Object.assign(new Error('Valid author name and email are required.'), { status: 400 });
  await git(cwd, ['add', '--all']);
  const output = await git(cwd, ['-c', `user.name=${name}`, '-c', `user.email=${email}`, 'commit', '-m', message], { timeout: 120_000 });
  return { output, status: await status(userId, workspaceId) };
}

async function push(userId, workspaceId, branch = null) {
  if (String(process.env.GIT_PUSH_ENABLED || 'false').toLowerCase() !== 'true') {
    throw Object.assign(new Error('Git push is disabled by the server administrator.'), { status: 403 });
  }
  const cwd = workspace.workspaceDir(userId, workspaceId);
  if (!(await isRepository(cwd))) throw Object.assign(new Error('Workspace is not a Git repository.'), { status: 409 });
  const selected = branch ? safeBranch(branch) : await git(cwd, ['branch', '--show-current']);
  const output = await git(cwd, ['push', 'origin', selected], { timeout: 10 * 60_000, maxBuffer: 50 * 1024 * 1024 });
  return { output, status: await status(userId, workspaceId) };
}

module.exports = { cloneIntoWorkspace, commit, log, pull, push, status, validateRepositoryUrl };
