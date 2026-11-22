// OCV5-823: Sandbox unit tests for scripts/v5-worktree-new.sh --gc-stale
// Proves default dry-run safety, cleanliness + no-unpushed guards, sessions/main/branch whitelists,
// and atomic worktrees-registry.json cleanup under --apply.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const runner = path.join(root, 'scripts/v5-worktree-new.sh')
const NOW = 1_800_000_000
const OLD_EPOCH = NOW - 25 * 86400
const RECENT_EPOCH = NOW - 3 * 86400

function git(cwd: string, args: string[], env: NodeJS.ProcessEnv = {}) {
  const r = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/dev/null',
      ...env,
    },
  })
  assert.equal(r.status, 0, `git ${args.join(' ')} failed: ${r.stderr}`)
  return r.stdout.trim()
}

function runGc(args: string[], env: NodeJS.ProcessEnv = {}) {
  return spawnSync('bash', [runner, '--gc-stale', ...args], {
    cwd: root,
    encoding: 'utf8',
    env: {
      ...process.env,
      OC_V5_GC_NOW_EPOCH: String(NOW),
      ...env,
    },
  })
}

function setOldTimes(wtPath: string, epoch: number) {
  utimesSync(wtPath, epoch, epoch)
  const gitdir = git(wtPath, ['rev-parse', '--absolute-git-dir'])
  const idx = path.join(gitdir, 'index')
  if (existsSync(idx)) utimesSync(idx, epoch, epoch)
}

function makeSandbox() {
  const sandbox = mkdtempSync(path.join(tmpdir(), 'ocv5-823-wt-gc-'))
  const remote = path.join(sandbox, 'origin.git')
  const base = path.join(sandbox, 'workspace')
  const mainRepo = path.join(base, 'openclaude-v5-main')
  mkdirSync(remote, { recursive: true })
  mkdirSync(base, { recursive: true })

  git(remote, ['init', '--bare', '-b', 'feat/v5-selfhost'])
  mkdirSync(mainRepo, { recursive: true })
  git(mainRepo, ['init', '-b', 'feat/v5-selfhost'])
  git(mainRepo, ['config', 'user.name', 'gc-test'])
  git(mainRepo, ['config', 'user.email', 'gc-test@example.invalid'])
  git(mainRepo, ['remote', 'add', 'origin', remote])

  writeFileSync(path.join(mainRepo, 'README.md'), 'main repo\n')
  git(mainRepo, ['add', 'README.md'])
  git(mainRepo, ['commit', '-m', 'init'], {
    GIT_AUTHOR_DATE: `${OLD_EPOCH} +0000`,
    GIT_COMMITTER_DATE: `${OLD_EPOCH} +0000`,
  })
  git(mainRepo, ['push', '-u', 'origin', 'feat/v5-selfhost'])

  const addWorktree = (
    dirName: string,
    branch: string,
    opts: {
      push?: boolean
      extraCommitUnpushed?: boolean
      epoch?: number
      dirtyModified?: boolean
      dirtyUntracked?: boolean
      stampOnly?: boolean
      lock?: boolean
    } = {},
  ) => {
    const wt = path.join(base, dirName)
    git(mainRepo, ['worktree', 'add', '-b', branch, wt, 'feat/v5-selfhost'])
    const commitEpoch = opts.epoch ?? OLD_EPOCH
    writeFileSync(path.join(wt, `${dirName}.txt`), 'x'.repeat(4096))
    git(wt, ['add', `${dirName}.txt`])
    git(wt, ['commit', '-m', `work on ${dirName}`], {
      GIT_AUTHOR_DATE: `${commitEpoch} +0000`,
      GIT_COMMITTER_DATE: `${commitEpoch} +0000`,
    })
    if (opts.push) {
      git(wt, ['push', '-u', 'origin', branch])
    }
    if (opts.extraCommitUnpushed) {
      writeFileSync(path.join(wt, 'unpushed.txt'), 'local only\n')
      git(wt, ['add', 'unpushed.txt'])
      git(wt, ['commit', '-m', 'unpushed commit'], {
        GIT_AUTHOR_DATE: `${commitEpoch} +0000`,
        GIT_COMMITTER_DATE: `${commitEpoch} +0000`,
      })
    }
    if (opts.stampOnly) {
      writeFileSync(path.join(wt, '.v5-worktree-cache.json'), '{"donor":"test"}\n')
    }
    if (opts.dirtyModified) {
      writeFileSync(path.join(wt, 'README.md'), 'modified uncommitted\n')
    }
    if (opts.dirtyUntracked) {
      writeFileSync(path.join(wt, 'scratch.tmp'), 'untracked\n')
    }
    if (opts.lock) {
      git(mainRepo, ['worktree', 'lock', wt])
    }
    setOldTimes(wt, commitEpoch)
    return wt
  }

  return {
    sandbox,
    base,
    mainRepo,
    addWorktree,
    cleanup: () => rmSync(sandbox, { recursive: true, force: true }),
  }
}

test('--gc-stale rejects conflicting --dry-run and --apply flags and bad --days', () => {
  const sb = makeSandbox()
  try {
    const conflict = runGc(['--base-dir', sb.base, '--donor', sb.mainRepo, '--dry-run', '--apply'])
    assert.equal(conflict.status, 2)
    assert.match(conflict.stderr, /不能同时指定/)

    const badDays = runGc(['--base-dir', sb.base, '--donor', sb.mainRepo, '--days', 'abc'])
    assert.equal(badDays.status, 2)
    assert.match(badDays.stderr, /非负整数/)
  } finally {
    sb.cleanup()
  }
})

test('--gc-stale defaults to dry-run, enforces every safety guard, and --apply deletes only eligible stale worktrees + syncs registry', () => {
  const sb = makeSandbox()
  try {
    // Whitelisted sessions/ folder with old mtime
    const sessionsDir = path.join(sb.base, 'sessions')
    mkdirSync(path.join(sessionsDir, 'abc'), { recursive: true })
    writeFileSync(path.join(sessionsDir, 'abc/data.txt'), 'session data\n')
    utimesSync(sessionsDir, OLD_EPOCH, OLD_EPOCH)

    // 1. Eligible stale clean pushed worktree (with only .v5-worktree-cache.json untracked)
    const wtStaleOk = sb.addWorktree('ocv5-stale-ok', 'feat/v5-stale-ok', {
      push: true,
      epoch: OLD_EPOCH,
      stampOnly: true,
    })
    // 2. Dirty modified worktree (stale + pushed, but dirty) -> MUST SKIP
    const wtDirtyMod = sb.addWorktree('ocv5-dirty-mod', 'feat/v5-dirty-mod', {
      push: true,
      epoch: OLD_EPOCH,
      dirtyModified: true,
    })
    // 3. Dirty untracked worktree -> MUST SKIP
    const wtDirtyUntracked = sb.addWorktree('ocv5-dirty-untracked', 'feat/v5-dirty-untracked', {
      push: true,
      epoch: OLD_EPOCH,
      dirtyUntracked: true,
    })
    // 4. Local unpushed worktree (never pushed) -> MUST SKIP
    const wtUnpushedNoRemote = sb.addWorktree('ocv5-unpushed-local', 'feat/v5-unpushed-local', {
      push: false,
      epoch: OLD_EPOCH,
    })
    // 5. Tracked branch ahead of upstream by 1 commit -> MUST SKIP
    const wtAhead = sb.addWorktree('ocv5-unpushed-ahead', 'feat/v5-unpushed-ahead', {
      push: true,
      extraCommitUnpushed: true,
      epoch: OLD_EPOCH,
    })
    // 6. Recent clean pushed worktree (3 days < 14 days, no registry entry) -> MUST SKIP as recent
    const wtRecent = sb.addWorktree('ocv5-recent-ok', 'feat/v5-recent-ok', {
      push: true,
      epoch: RECENT_EPOCH,
    })
    // 6b. Registry-active recent worktree -> MUST SKIP as registry-active-recent
    const wtRegActive = sb.addWorktree('ocv5-reg-active', 'feat/v5-reg-active', {
      push: true,
      epoch: OLD_EPOCH,
    })
    // 7. Protected branch worktree -> MUST SKIP
    const wtProtectedBranch = sb.addWorktree('ocv5-protected-br', 'feat/v5-keep-branch', {
      push: true,
      epoch: OLD_EPOCH,
    })
    // 8. Protected name worktree -> MUST SKIP
    const wtProtectedName = sb.addWorktree('ocv5-822-ui-redesign', 'feat/v5-ui-redesign', {
      push: true,
      epoch: OLD_EPOCH,
    })
    // 9. Locked worktree -> MUST SKIP
    const wtLocked = sb.addWorktree('ocv5-locked', 'feat/v5-locked', {
      push: true,
      epoch: OLD_EPOCH,
      lock: true,
    })

    // Create worktrees-registry.json with 0600 permissions
    const regPath = path.join(sb.base, 'worktrees-registry.json')
    const ghostPath = path.join(sb.base, 'ocv5-already-gone')
    const externalPath = '/opt/external-other-root/keep-me'
    writeFileSync(
      regPath,
      JSON.stringify(
        {
          worktrees: {
            [wtStaleOk]: { branch: 'feat/v5-stale-ok', status: 'retired', updated: '2026-07-01T00:00:00Z' },
            [wtRegActive]: { branch: 'feat/v5-reg-active', status: 'active', updated: '2027-01-12T00:00:00Z' },
            [wtDirtyMod]: { branch: 'feat/v5-dirty-mod', status: 'active', updated: '2026-07-01T00:00:00Z' },
            [ghostPath]: { branch: 'feat/v5-ghost', status: 'removed', updated: '2026-07-01T00:00:00Z' },
            [externalPath]: { branch: 'feat/external', status: 'active', updated: '2026-07-01T00:00:00Z' },
          },
        },
        null,
        1,
      ) + '\n',
    )
    chmodSync(regPath, 0o600)

    const commonArgs = [
      '--base-dir', sb.base,
      '--donor', sb.mainRepo,
      '--days', '14',
      '--registry', regPath,
      '--protected-branch', 'feat/v5-keep-branch',
      '--protected-name', 'ocv5-822-ui-redesign',
    ]

    // Step 1: Default invocation (implicit --dry-run) must NOT delete anything or touch registry
    const dryRes = runGc([...commonArgs, '--json'])
    assert.equal(dryRes.status, 0, dryRes.stderr + dryRes.stdout)
    const dry = JSON.parse(dryRes.stdout)
    assert.equal(dry.mode, 'dry-run')
    assert.equal(dry.candidateCount, 1)
    assert.equal(dry.candidates[0].path, wtStaleOk)
    assert.ok(dry.estimatedReclaimBytes >= 4096, `expected >= 4096 bytes, got ${dry.estimatedReclaimBytes}`)
    assert.equal(dry.deletedCount, 0)
    assert.equal(dry.registryCleaned.length, 0)
    assert.ok(existsSync(wtStaleOk), 'dry-run must never delete worktree')

    const skipByName = Object.fromEntries(dry.skipped.map((s: { name: string; reason: string }) => [s.name, s.reason]))
    assert.equal(skipByName['sessions'], 'whitelisted-name')
    assert.equal(skipByName['openclaude-v5-main'], 'main-repository')
    assert.match(skipByName['ocv5-dirty-mod'], /^dirty-working-tree:/)
    assert.match(skipByName['ocv5-dirty-untracked'], /^dirty-working-tree:/)
    assert.equal(skipByName['ocv5-unpushed-local'], 'unpushed-commits:no-remote-ref')
    assert.equal(skipByName['ocv5-unpushed-ahead'], 'unpushed-commits:1')
    assert.match(skipByName['ocv5-recent-ok'], /^recent:/)
    assert.equal(skipByName['ocv5-reg-active'], 'registry-active-recent')
    assert.equal(skipByName['ocv5-protected-br'], 'protected-branch:feat/v5-keep-branch')
    assert.equal(skipByName['ocv5-822-ui-redesign'], 'whitelisted-name')
    assert.equal(skipByName['ocv5-locked'], 'worktree-locked')

    // Human-readable output also works in default dry-run mode
    const humanDry = runGc(commonArgs)
    assert.equal(humanDry.status, 0, humanDry.stderr)
    assert.match(humanDry.stdout, /DRY-RUN\(只列不删\)/)
    assert.match(humanDry.stdout, /CANDIDATE/)
    assert.match(humanDry.stdout, /reclaimable_bytes=/)

    // Step 2: --apply deletes ONLY wtStaleOk and syncs worktrees-registry.json
    const applyRes = runGc([...commonArgs, '--apply', '--json'])
    assert.equal(applyRes.status, 0, applyRes.stderr + applyRes.stdout)
    const applied = JSON.parse(applyRes.stdout)
    assert.equal(applied.mode, 'apply')
    assert.equal(applied.deletedCount, 1)
    assert.deepEqual(applied.deletedPaths, [wtStaleOk])
    assert.ok(applied.reclaimedBytes >= 4096)
    assert.equal(existsSync(wtStaleOk), false, 'eligible stale worktree must be removed')

    // Every single protected/unsafe/recent directory MUST still exist!
    for (const keep of [
      sessionsDir,
      sb.mainRepo,
      wtDirtyMod,
      wtDirtyUntracked,
      wtUnpushedNoRemote,
      wtAhead,
      wtRecent,
      wtRegActive,
      wtProtectedBranch,
      wtProtectedName,
      wtLocked,
    ]) {
      assert.ok(existsSync(keep), `must NOT delete ${keep}`)
    }

    // Registry synced cleanly, permissions preserved (0600)
    assert.equal(statSync(regPath).mode & 0o777, 0o600)
    const updatedReg = JSON.parse(readFileSync(regPath, 'utf8'))
    assert.equal(updatedReg.worktrees[wtStaleOk], undefined, 'deleted worktree must be removed from registry')
    assert.equal(updatedReg.worktrees[ghostPath], undefined, 'missing worktree under base-dir must be pruned from registry')
    assert.ok(updatedReg.worktrees[wtRegActive], 'surviving recent active worktree stays in registry')
    assert.ok(updatedReg.worktrees[wtDirtyMod], 'surviving dirty worktree stays in registry')
    assert.ok(updatedReg.worktrees[externalPath], 'external registry entry outside base-dir must not be touched')

    // git worktree list no longer references wtStaleOk
    const wtList = git(sb.mainRepo, ['worktree', 'list', '--porcelain'])
    assert.ok(!wtList.includes(wtStaleOk), 'git worktree metadata must be pruned')
  } finally {
    sb.cleanup()
  }
})
