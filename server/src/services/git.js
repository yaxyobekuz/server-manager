import { run } from './exec.js';

/** Read-only status of a checkout: branch + whether there are local changes. */
export async function status(cwd) {
  const branch = await run('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd });
  const remote = await run('git', ['remote', 'get-url', 'origin'], { cwd });
  const last = await run(
    'git',
    ['log', '-1', '--pretty=format:%h|%s|%an|%ar'],
    { cwd }
  );
  const dirty = await run('git', ['status', '--porcelain'], { cwd });

  const [hash, subject, author, when] = (last.stdout || '').split('|');
  return {
    branch: branch.stdout.trim(),
    remote: remote.stdout.trim(),
    dirty: dirty.stdout.trim().length > 0,
    lastCommit: hash
      ? { hash, subject, author, when }
      : null,
  };
}

export function clone(repoUrl, targetPath, branch, onLine) {
  const args = ['clone'];
  if (branch) args.push('-b', branch);
  args.push(repoUrl, targetPath);
  return run('git', args, {}); // simple version; deploy uses streaming pull
}

/** Fetch + hard-reset to the remote branch so the working tree matches origin. */
export async function pull(cwd, branch) {
  const fetch = await run('git', ['fetch', 'origin'], { cwd });
  if (fetch.code !== 0) return fetch;
  return run('git', ['reset', '--hard', `origin/${branch}`], { cwd });
}

export function checkRemoteBranches(repoUrl) {
  return run('git', ['ls-remote', '--heads', repoUrl]);
}
