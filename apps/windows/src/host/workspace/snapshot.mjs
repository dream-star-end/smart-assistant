import { execFile as defaultExecFile } from 'node:child_process'

function runGit(execFile, args) {
  return new Promise((resolve) => {
    execFile('git', args, { timeout: 8_000, windowsHide: true }, (error, stdout, stderr) => {
      if (error && (error.code === 'ENOENT' || error.code === 127)) {
        resolve({ ok: false, warning: 'git-not-found', stdout: '', stderr: String(stderr || '') })
        return
      }
      resolve({
        ok: !error,
        stdout: String(stdout || '').trim(),
        stderr: String(stderr || '').trim(),
        error,
      })
    })
  })
}

function snapshotTimestamp(now) {
  const date = now instanceof Date ? now : new Date(now)
  return date.toISOString().replace(/[:.]/g, '-')
}

/**
 * Write refs/clarvy/pre-session-<ts> to the current HEAD.
 * Does not checkout, create a branch, or stash (design §7.2.4).
 */
export async function snapshotWorkspace(workspacePath, options = {}) {
  if (typeof workspacePath !== 'string' || workspacePath.length === 0) {
    return { ok: false, warning: 'invalid-workspace' }
  }
  const execFile = options.execFile || defaultExecFile
  const now = options.now || (() => new Date())
  const git = (args) => runGit(execFile, ['-C', workspacePath, ...args])

  const inside = await git(['rev-parse', '--is-inside-work-tree'])
  if (inside.warning === 'git-not-found') {
    return { ok: false, warning: 'git-not-found' }
  }
  if (!inside.ok || inside.stdout !== 'true') {
    return { ok: false, warning: 'not-a-git-repository' }
  }

  const beforeHead = await git(['rev-parse', 'HEAD'])
  if (!beforeHead.ok || !beforeHead.stdout) {
    return { ok: false, warning: 'snapshot-failed' }
  }
  const beforeRef = await git(['symbolic-ref', '--quiet', 'HEAD'])
  const ts = snapshotTimestamp(typeof now === 'function' ? now() : now)
  const ref = `refs/clarvy/pre-session-${ts}`
  const updated = await git(['update-ref', ref, 'HEAD'])
  if (!updated.ok) {
    return { ok: false, warning: 'snapshot-failed', ref }
  }

  const afterHead = await git(['rev-parse', 'HEAD'])
  const afterRef = await git(['symbolic-ref', '--quiet', 'HEAD'])
  if (afterHead.stdout !== beforeHead.stdout) {
    return { ok: false, warning: 'head-moved', ref, head: afterHead.stdout }
  }
  if (beforeRef.stdout !== afterRef.stdout) {
    return { ok: false, warning: 'branch-moved', ref }
  }
  return {
    ok: true,
    ref,
    head: beforeHead.stdout,
    branch: beforeRef.ok ? beforeRef.stdout : null,
  }
}
